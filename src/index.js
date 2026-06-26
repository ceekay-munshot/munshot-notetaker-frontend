// Munshot Notetaker — Cloudflare Worker
// - KV-backed logins (one user = one `user:<email>` key)
// - KV-backed sessions via HttpOnly cookie
// - Admin login (username from env, password from the ADMIN_PASSWORD secret):
//   sees ALL users' transcripts
// - Join/leave the notetaker bot (email is taken from the session, never the body)
// - D1-backed transcripts view, scoped to the signed-in user (all rows for admin)

const COOKIE_NAME = "session";
const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
const DEFAULT_JOIN_ENDPOINT =
  "https://ranging-fur-southampton-troubleshooting.trycloudflare.com/public/join";
const DEFAULT_LEAVE_ENDPOINT =
  "https://ranging-fur-southampton-troubleshooting.trycloudflare.com/public/leave";

const SCHEDULE_PREFIX = "schedule:";
const MAX_SCHEDULES_PER_USER = 50;
const MAX_SCHEDULE_ATTEMPTS = 3; // give up on a failing one-time send after this many cron ticks
const RECURRENCES = ["once", "daily", "weekdays", "weekly"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      if (method === "GET" && pathname === "/") return handleHome(request, env);
      if (method === "GET" && pathname === "/dashboard") return handleDashboard(request, env);
      if (method === "POST" && pathname === "/api/register") return handleRegister(request, env);
      if (method === "POST" && pathname === "/api/login") return handleLogin(request, env);
      if (method === "POST" && pathname === "/api/logout") return handleLogout(request, env);
      if (method === "POST" && pathname === "/api/join") return handleBot(request, env, "join");
      if (method === "POST" && pathname === "/api/leave") return handleBot(request, env, "leave");
      if (method === "GET" && pathname === "/api/transcripts") return handleTranscripts(request, env);
      if (method === "GET" && pathname === "/api/schedules") return handleListSchedules(request, env);
      if (method === "POST" && pathname === "/api/schedules") return handleCreateSchedule(request, env);
      if (method === "POST" && pathname === "/api/schedules/delete") return handleDeleteSchedule(request, env);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ error: "Server error", detail: String((err && err.message) || err) }, 500);
    }
  },

  // Cron-triggered (see [triggers] in wrangler.toml). Fires every schedule whose
  // time has arrived, regardless of whether the user has the dashboard open.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDueSchedules(env));
  },
};

/* ------------------------------ routes ------------------------------ */

async function handleHome(request, env) {
  if (await getSession(request, env)) {
    return Response.redirect(new URL("/dashboard", request.url).toString(), 302);
  }
  return html(loginPage({ codeRequired: !!env.SIGNUP_CODE }));
}

async function handleDashboard(request, env) {
  const session = await getSession(request, env);
  if (!session) return Response.redirect(new URL("/", request.url).toString(), 302);
  return html(dashboardPage(session.identity, session.isAdmin));
}

async function handleRegister(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");

  if (!email || !password) return json({ error: "Email and password are required" }, 400);
  if (!isValidEmail(email)) return json({ error: "Enter a valid email address" }, 400);
  if (password.length < 6) return json({ error: "Password must be at least 6 characters" }, 400);
  if (email === adminUsername(env).toLowerCase()) {
    return json({ error: "That username is reserved" }, 409);
  }
  if (env.SIGNUP_CODE && body.code !== env.SIGNUP_CODE) {
    return json({ error: "Invalid signup code" }, 403);
  }

  if (await env.KV.get(`user:${email}`)) {
    return json({ error: "An account with that email already exists" }, 409);
  }

  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const user = {
    email,
    salt: toHex(saltBytes),
    hash: await deriveHash(password, saltBytes),
    createdAt: Date.now(),
  };
  await env.KV.put(`user:${email}`, JSON.stringify(user));

  const cookie = await createSession(env, email);
  return json({ ok: true, email }, 200, { "Set-Cookie": cookie });
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const identifier = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!identifier || !password) return json({ error: "Email and password are required" }, 400);

  // Admin login — username from env (default ADMIN), password from secret.
  if (identifier.toLowerCase() === adminUsername(env).toLowerCase()) {
    if (!env.ADMIN_PASSWORD) {
      return json({ error: "Admin login isn't configured (set the ADMIN_PASSWORD secret)" }, 403);
    }
    if (!timingSafeEqual(password, env.ADMIN_PASSWORD)) {
      return json({ error: "Invalid email or password" }, 401);
    }
    const cookie = await createAdminSession(env, adminUsername(env));
    return json({ ok: true, admin: true }, 200, { "Set-Cookie": cookie });
  }

  const email = normalizeEmail(identifier);
  const raw = await env.KV.get(`user:${email}`);
  if (!raw) return json({ error: "Invalid email or password" }, 401);

  const user = JSON.parse(raw);
  const hash = await deriveHash(password, fromHex(user.salt));
  if (!timingSafeEqual(hash, user.hash)) {
    return json({ error: "Invalid email or password" }, 401);
  }

  const cookie = await createSession(env, email);
  return json({ ok: true, email }, 200, { "Set-Cookie": cookie });
}

async function handleLogout(request, env) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (token) await env.KV.delete(`session:${token}`);
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
}

function joinEndpoint(env) {
  return env.JOIN_ENDPOINT || DEFAULT_JOIN_ENDPOINT;
}

function leaveEndpoint(env) {
  if (env.LEAVE_ENDPOINT) return env.LEAVE_ENDPOINT;
  if (env.JOIN_ENDPOINT) return env.JOIN_ENDPOINT.replace(/\/join\/?$/, "/leave");
  return DEFAULT_LEAVE_ENDPOINT;
}

// Asks the notetaker bot to join or leave a meeting. The email is always taken
// from the authenticated session — never from the request body.
async function handleBot(request, env, action) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (session.isAdmin) return json({ error: "Admin accounts can't send or stop meetings" }, 403);
  const email = session.identity;

  const body = await request.json().catch(() => ({}));
  const meetingUrl = String(body.meeting_url || "").trim();
  if (!meetingUrl) return json({ error: "Meeting URL is required" }, 400);
  try {
    new URL(meetingUrl);
  } catch {
    return json({ error: "Enter a valid meeting URL" }, 400);
  }
  if (!env.API_KEY) {
    return json({ error: "Server is missing the API_KEY secret" }, 500);
  }

  let result;
  try {
    result = await dispatchBot(env, action, email, meetingUrl);
  } catch (err) {
    return json({ error: "Failed to reach the notetaker service", detail: String((err && err.message) || err) }, 502);
  }
  return json({ ok: result.ok, status: result.status, response: result.data }, result.ok ? 200 : 502);
}

// Calls the munshot bot's join/leave endpoint with the server-held API key.
// Returns { ok, status, data }; throws only on a network failure. Shared by the
// interactive /api/join|leave routes and the cron-driven schedule runner.
async function dispatchBot(env, action, email, meetingUrl) {
  const endpoint = action === "leave" ? leaveEndpoint(env) : joinEndpoint(env);
  const upstream = await fetch(endpoint, {
    method: "POST",
    headers: {
      "X-API-Key": env.API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, meeting_url: meetingUrl }),
  });
  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { ok: upstream.ok, status: upstream.status, data };
}

// Returns transcripts from D1. A normal user sees only rows whose owner_email
// matches their session email (derived server-side). Admin sees every row.
async function handleTranscripts(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);

  try {
    let res;
    if (session.isAdmin) {
      res = await env.DB.prepare(
        "SELECT meeting_id, segment_id, start_time, end_time, text, speaker, created_at, owner_email " +
        "FROM transcriptions ORDER BY meeting_id, start_time"
      ).all();
    } else {
      res = await env.DB.prepare(
        "SELECT meeting_id, segment_id, start_time, end_time, text, speaker, created_at " +
        "FROM transcriptions WHERE owner_email = ?1 ORDER BY meeting_id, start_time"
      ).bind(session.identity).all();
    }
    return json({ ok: true, admin: session.isAdmin, segments: res.results || [] });
  } catch (err) {
    return json({ error: "Failed to load transcripts", detail: String((err && err.message) || err) }, 500);
  }
}

/* ------------------------------ schedules ------------------------------ */

// Schedules live in KV under `schedule:<owner>:<id>`. Keying by owner lets a
// user list/cancel only their own, and lets the cron scan every owner's at once.
function scheduleKey(owner, id) {
  return `${SCHEDULE_PREFIX}${encodeURIComponent(owner)}:${id}`;
}

// Reads every schedule under a KV prefix (one get per schedule), soonest first.
// A bare SCHEDULE_PREFIX scans all owners; `${SCHEDULE_PREFIX}<owner>:` one user.
async function readSchedules(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix, cursor });
    for (const k of page.keys) {
      const raw = await env.KV.get(k.name);
      if (!raw) continue;
      try {
        const s = JSON.parse(raw);
        s._key = k.name;
        out.push(s);
      } catch {
        /* skip a corrupt entry */
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  out.sort((a, b) => (a.nextRun || 0) - (b.nextRun || 0));
  return out;
}

function listSchedulesFor(env, owner) {
  return readSchedules(env, `${SCHEDULE_PREFIX}${encodeURIComponent(owner)}:`);
}

// Only the safe, client-facing fields — never the owner or internal counters.
function publicSchedule(s) {
  return {
    id: s.id,
    meetingUrl: s.meetingUrl,
    nextRun: s.nextRun,
    recurrence: s.recurrence,
    lastRun: s.lastRun || null,
    lastStatus: s.lastStatus || null,
  };
}

async function handleListSchedules(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (session.isAdmin) return json({ ok: true, schedules: [] });
  const schedules = await listSchedulesFor(env, session.identity);
  return json({ ok: true, schedules: schedules.map(publicSchedule) });
}

async function handleCreateSchedule(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (session.isAdmin) return json({ error: "Admin accounts can't schedule meetings" }, 403);
  const owner = session.identity;

  const body = await request.json().catch(() => ({}));
  const meetingUrl = String(body.meeting_url || "").trim();
  const runAt = Number(body.run_at);
  const recurrence = RECURRENCES.includes(body.recurrence) ? body.recurrence : "once";
  const tzOffset = Number.isFinite(Number(body.tz_offset)) ? Number(body.tz_offset) : 0;

  if (!meetingUrl) return json({ error: "Meeting URL is required" }, 400);
  try {
    new URL(meetingUrl);
  } catch {
    return json({ error: "Enter a valid meeting URL" }, 400);
  }
  if (!Number.isFinite(runAt)) return json({ error: "Pick a date and time" }, 400);

  const now = Date.now();
  let nextRun = runAt;
  if (recurrence === "once") {
    if (nextRun < now - 60000) return json({ error: "Pick a time in the future" }, 400);
  } else {
    // Roll a routine's first run forward until it lands in the future, so a
    // start time earlier today doesn't fire a backlog the moment it's saved.
    let guard = 0;
    while (nextRun <= now && guard++ < 4000) nextRun = advanceRun(nextRun, recurrence, tzOffset);
  }

  const existing = await listSchedulesFor(env, owner);
  if (existing.length >= MAX_SCHEDULES_PER_USER) {
    return json({ error: `You can have at most ${MAX_SCHEDULES_PER_USER} schedules` }, 409);
  }

  const id = crypto.randomUUID();
  const schedule = {
    id,
    owner,
    meetingUrl,
    recurrence,
    tzOffset,
    nextRun,
    createdAt: now,
    lastRun: null,
    lastStatus: null,
    attempts: 0,
  };
  await env.KV.put(scheduleKey(owner, id), JSON.stringify(schedule));
  return json({ ok: true, schedule: publicSchedule(schedule) }, 201);
}

async function handleDeleteSchedule(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (session.isAdmin) return json({ error: "Admin accounts can't schedule meetings" }, 403);
  const body = await request.json().catch(() => ({}));
  const id = String(body.id || "").trim();
  if (!id) return json({ error: "Schedule id is required" }, 400);
  // The key embeds the session owner, so a user can only ever delete their own.
  await env.KV.delete(scheduleKey(session.identity, id));
  return json({ ok: true });
}

// Advances a run time to the next occurrence for a recurring schedule. tzOffset
// is the browser's getTimezoneOffset() (minutes), so "weekdays" is judged in the
// user's local time rather than UTC. (DST shifts are not tracked.)
function advanceRun(ms, recurrence, tzOffset) {
  const DAY = 86400000;
  if (recurrence === "daily") return ms + DAY;
  if (recurrence === "weekly") return ms + 7 * DAY;
  if (recurrence === "weekdays") {
    let next = ms + DAY;
    for (let i = 0; i < 7; i++) {
      const localDow = new Date(next - tzOffset * 60000).getUTCDay();
      if (localDow !== 0 && localDow !== 6) break; // 0 = Sun, 6 = Sat
      next += DAY;
    }
    return next;
  }
  return ms; // "once" never recurs
}

function stripMeta(s) {
  const { _key, ...rest } = s;
  return rest;
}

// Cron entry point: fires every schedule whose time has come, then advances it
// (recurring) or removes it (one-time). Server-side, so it works whether or not
// the user has the dashboard open.
async function runDueSchedules(env) {
  const now = Date.now();
  const due = (await readSchedules(env, SCHEDULE_PREFIX)).filter((s) => (s.nextRun || 0) <= now);
  for (const s of due) {
    let ok = false;
    try {
      if (!env.API_KEY) throw new Error("missing API_KEY");
      const r = await dispatchBot(env, "join", s.owner, s.meetingUrl);
      ok = r.ok;
      s.lastStatus = r.ok ? "sent" : `error ${r.status}`;
    } catch (err) {
      s.lastStatus = `error: ${String((err && err.message) || err)}`;
    }
    s.lastRun = now;

    if (s.recurrence !== "once") {
      // Fire once now, then skip ahead to the next future occurrence so a
      // long-overdue routine doesn't re-fire every minute until it catches up.
      s.attempts = 0;
      let next = advanceRun(s.nextRun, s.recurrence, s.tzOffset || 0);
      let guard = 0;
      while (next <= now && guard++ < 4000) next = advanceRun(next, s.recurrence, s.tzOffset || 0);
      s.nextRun = next;
      await env.KV.put(s._key, JSON.stringify(stripMeta(s)));
    } else if (ok) {
      await env.KV.delete(s._key);
    } else {
      // One-time send failed — retry on the next tick, but give up eventually.
      s.attempts = (s.attempts || 0) + 1;
      if (s.attempts >= MAX_SCHEDULE_ATTEMPTS) {
        await env.KV.delete(s._key);
      } else {
        await env.KV.put(s._key, JSON.stringify(stripMeta(s)));
      }
    }
  }
}

/* ------------------------------ auth helpers ------------------------------ */

function adminUsername(env) {
  return env.ADMIN_USERNAME || "ADMIN";
}

async function createSession(env, email) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  await env.KV.put(`session:${token}`, email, { expirationTtl: SESSION_TTL });
  return sessionCookie(token);
}

async function createAdminSession(env, name) {
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, "");
  await env.KV.put(`session:${token}`, JSON.stringify({ admin: true, name }), { expirationTtl: SESSION_TTL });
  return sessionCookie(token);
}

// Resolves the current session to { isAdmin, identity }. Admin sessions are
// stored as JSON ({admin:true,...}); user sessions are the plain email string.
// A user's session value is always their own email, so it can never be parsed
// into an admin marker.
async function getSession(request, env) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return null;
  const value = await env.KV.get(`session:${token}`);
  if (!value) return null;
  if (value.charCodeAt(0) === 123 /* '{' */) {
    try {
      const o = JSON.parse(value);
      if (o && o.admin) return { isAdmin: true, identity: o.name || "ADMIN" };
    } catch {
      /* fall through to user */
    }
  }
  return { isAdmin: false, identity: value };
}

function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL}`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function deriveHash(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(bits);
}

/* ------------------------------ utils ------------------------------ */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

function parseCookies(request) {
  const out = {};
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function normalizeEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function isValidEmail(v) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v);
}

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

/* ------------------------------ pages ------------------------------ */

const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: linear-gradient(135deg, #1e293b, #0f172a); color: #e2e8f0; padding: 24px;
  }
  .card {
    width: 100%; max-width: 420px; background: #1e293b; border: 1px solid #334155;
    border-radius: 14px; padding: 28px; box-shadow: 0 12px 40px rgba(0,0,0,.35);
  }
  .card.wide { max-width: 720px; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  .sub { margin: 0 0 22px; color: #94a3b8; font-size: 14px; }
  .badge { display: inline-block; margin-left: 8px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; background: #38bdf8; color: #04263a; vertical-align: middle; }
  label { display: block; font-size: 13px; margin: 14px 0 6px; color: #cbd5e1; }
  input {
    width: 100%; padding: 11px 12px; border-radius: 9px; border: 1px solid #475569;
    background: #0f172a; color: #e2e8f0; font-size: 14px;
  }
  input:focus { outline: none; border-color: #38bdf8; }
  select {
    width: 100%; padding: 11px 12px; border-radius: 9px; border: 1px solid #475569;
    background: #0f172a; color: #e2e8f0; font-size: 14px;
  }
  select:focus { outline: none; border-color: #38bdf8; }
  button {
    width: 100%; margin-top: 20px; padding: 12px; border: 0; border-radius: 9px;
    background: #38bdf8; color: #04263a; font-weight: 600; font-size: 15px; cursor: pointer;
  }
  button:hover { background: #7dd3fc; }
  button:disabled { opacity: .6; cursor: not-allowed; }
  .toggle { margin-top: 18px; text-align: center; font-size: 13px; color: #94a3b8; }
  .toggle a { color: #38bdf8; cursor: pointer; text-decoration: none; }
  .msg { margin-top: 16px; padding: 11px 12px; border-radius: 9px; font-size: 13px; display: none; white-space: pre-wrap; word-break: break-word; }
  .msg.err { display: block; background: #450a0a; border: 1px solid #7f1d1d; color: #fecaca; }
  .msg.ok { display: block; background: #052e16; border: 1px solid #166534; color: #bbf7d0; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .linkbtn { background: transparent; color: #94a3b8; width: auto; margin: 0; padding: 6px 8px; font-weight: 500; }
  .linkbtn:hover { background: #334155; color: #e2e8f0; }
  .hint { font-size: 12px; color: #64748b; margin-top: 6px; }
  .btnrow { display: flex; gap: 10px; margin-top: 20px; }
  .btnrow button { margin-top: 0; }
  .btn-stop { background: #475569; color: #e2e8f0; }
  .btn-stop:hover { background: #64748b; }
  hr { border: 0; border-top: 1px solid #334155; margin: 26px 0 18px; }
  .sect { display: flex; justify-content: space-between; align-items: center; }
  .sect h2 { font-size: 16px; margin: 0; }
  .search { margin: 14px 0 10px; }
  .tstatus { color: #94a3b8; font-size: 13px; padding: 8px 0; }
  .mcard { border: 1px solid #334155; border-radius: 10px; margin-bottom: 10px; overflow: hidden; }
  .mhead { width: 100%; text-align: left; margin: 0; border-radius: 0; background: #0f172a; color: #e2e8f0; font-weight: 600; font-size: 13px; padding: 12px 14px; }
  .mhead:hover { background: #162033; }
  .mbody { padding: 6px 14px 12px; border-top: 1px solid #334155; }
  .seg { font-size: 13px; line-height: 1.5; padding: 5px 0; border-bottom: 1px solid #1e293b; color: #cbd5e1; }
  .seg:last-child { border-bottom: 0; }
  .ts { color: #64748b; font-variant-numeric: tabular-nums; }
  .sp { color: #38bdf8; font-weight: 600; }
  .refresh { width: auto; margin: 0; padding: 6px 10px; background: transparent; color: #94a3b8; font-weight: 500; }
  .refresh:hover { background: #334155; color: #e2e8f0; }
  .row2 { display: flex; gap: 12px; }
  .row2 > div { flex: 1; min-width: 0; }
  .schedule { border: 1px solid #334155; border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .schedule .info { font-size: 13px; line-height: 1.5; min-width: 0; }
  .schedule .when { color: #e2e8f0; font-weight: 600; }
  .schedule .rec { display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px; font-size: 11px; background: #334155; color: #cbd5e1; font-weight: 600; }
  .schedule .url { color: #94a3b8; word-break: break-all; }
  .schedule .last { color: #64748b; font-size: 12px; }
  .cancel { width: auto; margin: 0; padding: 6px 10px; background: #475569; color: #e2e8f0; font-weight: 500; font-size: 13px; flex-shrink: 0; }
  .cancel:hover { background: #64748b; }
`;

function loginPage({ codeRequired }) {
  const codeField = codeRequired
    ? '<div id="code-wrap"><label for="r-code">Signup code</label><input id="r-code" type="text" autocomplete="off" /></div>'
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Munshot Notetaker — Sign in</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card">
    <h1>Munshot Notetaker</h1>
    <p class="sub" id="subtitle">Sign in to send a meeting to the notetaker.</p>

    <form id="login-form">
      <label for="l-email">Email or username</label>
      <input id="l-email" type="text" autocomplete="username" required />
      <label for="l-pass">Password</label>
      <input id="l-pass" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>

    <form id="register-form" style="display:none">
      <label for="r-email">Email</label>
      <input id="r-email" type="email" autocomplete="username" required />
      <label for="r-pass">Password</label>
      <input id="r-pass" type="password" autocomplete="new-password" required />
      <p class="hint">At least 6 characters.</p>
      ${codeField}
      <button type="submit">Create account</button>
    </form>

    <div class="msg" id="msg"></div>
    <div class="toggle" id="toggle">
      No account? <a id="toggle-link">Create one</a>
    </div>
  </div>

<script>
  var loginForm = document.getElementById('login-form');
  var registerForm = document.getElementById('register-form');
  var toggle = document.getElementById('toggle');
  var toggleLink = document.getElementById('toggle-link');
  var msg = document.getElementById('msg');
  var subtitle = document.getElementById('subtitle');
  var mode = 'login';

  toggleLink.onclick = function () {
    mode = mode === 'login' ? 'register' : 'login';
    var login = mode === 'login';
    loginForm.style.display = login ? 'block' : 'none';
    registerForm.style.display = login ? 'none' : 'block';
    subtitle.textContent = login ? 'Sign in to send a meeting to the notetaker.' : 'Create an account to get started.';
    toggle.innerHTML = login ? 'No account? <a id="toggle-link">Create one</a>' : 'Have an account? <a id="toggle-link">Sign in</a>';
    document.getElementById('toggle-link').onclick = toggleLink.onclick;
    showMsg('', '');
  };

  function showMsg(text, kind) {
    msg.textContent = text;
    msg.className = 'msg' + (kind ? ' ' + kind : '');
  }

  async function submit(path, payload, btn) {
    btn.disabled = true;
    showMsg('', '');
    try {
      var res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.ok && data.ok) {
        window.location.href = '/dashboard';
        return;
      }
      showMsg(data.error || 'Something went wrong.', 'err');
    } catch (e) {
      showMsg('Network error. Please try again.', 'err');
    } finally {
      btn.disabled = false;
    }
  }

  loginForm.onsubmit = function (e) {
    e.preventDefault();
    submit('/api/login', {
      email: document.getElementById('l-email').value,
      password: document.getElementById('l-pass').value,
    }, loginForm.querySelector('button'));
  };

  registerForm.onsubmit = function (e) {
    e.preventDefault();
    var codeEl = document.getElementById('r-code');
    submit('/api/register', {
      email: document.getElementById('r-email').value,
      password: document.getElementById('r-pass').value,
      code: codeEl ? codeEl.value : undefined,
    }, registerForm.querySelector('button'));
  };
</script>
</body>
</html>`;
}

function dashboardPage(identity, isAdmin) {
  const safe = escapeHtml(identity);
  const formSection = isAdmin
    ? ""
    : `
    <form id="join-form">
      <label for="meeting">Meeting link</label>
      <input id="meeting" type="url" placeholder="https://meet.google.com/your-live-meet" required />
      <div class="btnrow">
        <button type="submit" id="send-btn">Send to notetaker</button>
        <button type="button" id="stop-btn" class="btn-stop">Stop bot</button>
      </div>
    </form>
    <div class="msg" id="msg"></div>

    <hr />

    <div class="sect"><h2>Scheduled &amp; routines</h2></div>
    <p class="hint">Pick a time and the notetaker joins on its own — you don't need to be online. Choose a repeat to turn it into a routine.</p>
    <form id="sched-form">
      <label for="sched-url">Meeting link</label>
      <input id="sched-url" type="url" placeholder="https://meet.google.com/your-live-meet" required />
      <div class="row2">
        <div>
          <label for="sched-when">When</label>
          <input id="sched-when" type="datetime-local" required />
        </div>
        <div>
          <label for="sched-rec">Repeat</label>
          <select id="sched-rec">
            <option value="once">One time</option>
            <option value="daily">Every day</option>
            <option value="weekdays">Weekdays (Mon–Fri)</option>
            <option value="weekly">Every week</option>
          </select>
        </div>
      </div>
      <button type="submit" id="sched-btn">Schedule it</button>
    </form>
    <div class="msg" id="sched-msg"></div>
    <div id="sched-list"></div>

    <hr />
`;
  const subline = isAdmin
    ? `Signed in as ${safe} <span class="badge">ADMIN</span>`
    : `Signed in as ${safe}`;
  const transcriptsTitle = isAdmin ? "All transcripts" : "Your transcripts";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Munshot Notetaker — Dashboard</title>
<style>${STYLE}</style>
</head>
<body>
  <div class="card wide">
    <div class="row">
      <h1>Notetaker</h1>
      <button class="linkbtn" id="logout">Log out</button>
    </div>
    <p class="sub">${subline}</p>
${formSection}
    <div class="sect">
      <h2>${transcriptsTitle}</h2>
      <button class="refresh" id="refresh">Refresh</button>
    </div>
    <input class="search" id="tq" type="search" placeholder="Search transcript text…" />
    <div class="tstatus" id="tstatus"></div>
    <div id="tlist"></div>
  </div>

<script>
  document.getElementById('logout').onclick = async function () {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/';
  };

  var joinForm = document.getElementById('join-form');
  if (joinForm) {
    var msg = document.getElementById('msg');
    var meetingInput = document.getElementById('meeting');
    var sendBtn = document.getElementById('send-btn');
    var stopBtn = document.getElementById('stop-btn');

    var showMsg = function (text, kind) {
      msg.textContent = text;
      msg.className = 'msg' + (kind ? ' ' + kind : '');
    };

    var callBot = async function (path, okText) {
      var url = meetingInput.value.trim();
      if (!url) { showMsg('Enter the meeting link first.', 'err'); return; }
      sendBtn.disabled = true; stopBtn.disabled = true;
      showMsg('Working…', '');
      try {
        var res = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meeting_url: url }),
        });
        var data = await res.json().catch(function () { return {}; });
        if (res.status === 401) { window.location.href = '/'; return; }
        if (res.ok && data.ok) {
          showMsg(okText, 'ok');
        } else {
          var detail = data.error || (data.response ? JSON.stringify(data.response) : 'Request failed.');
          showMsg('Failed: ' + detail, 'err');
        }
      } catch (e) {
        showMsg('Network error. Please try again.', 'err');
      } finally {
        sendBtn.disabled = false; stopBtn.disabled = false;
      }
    };

    joinForm.onsubmit = function (e) {
      e.preventDefault();
      callBot('/api/join', 'Sent! The notetaker has been asked to join.');
    };
    stopBtn.onclick = function () {
      callBot('/api/leave', 'Stop requested. The notetaker is leaving the meeting.');
    };
  }

  /* ---- schedules & routines ---- */
  var schedForm = document.getElementById('sched-form');
  if (schedForm) {
    var schedMsg = document.getElementById('sched-msg');
    var schedList = document.getElementById('sched-list');
    var schedBtn = document.getElementById('sched-btn');
    var recNames = { once: 'One time', daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' };

    var showSched = function (text, kind) {
      schedMsg.textContent = text;
      schedMsg.className = 'msg' + (kind ? ' ' + kind : '');
    };

    function renderSchedules(items) {
      schedList.innerHTML = '';
      items.forEach(function (s) {
        var row = document.createElement('div'); row.className = 'schedule';
        var info = document.createElement('div'); info.className = 'info';

        var when = document.createElement('div');
        var w = document.createElement('span'); w.className = 'when';
        w.textContent = s.nextRun ? new Date(s.nextRun).toLocaleString() : '—';
        var rec = document.createElement('span'); rec.className = 'rec';
        rec.textContent = recNames[s.recurrence] || s.recurrence;
        when.appendChild(w); when.appendChild(rec);

        var url = document.createElement('div'); url.className = 'url'; url.textContent = s.meetingUrl;
        info.appendChild(when); info.appendChild(url);

        if (s.lastRun) {
          var last = document.createElement('div'); last.className = 'last';
          last.textContent = 'Last run ' + new Date(s.lastRun).toLocaleString() + (s.lastStatus ? ' · ' + s.lastStatus : '');
          info.appendChild(last);
        }

        var btn = document.createElement('button'); btn.className = 'cancel'; btn.textContent = 'Cancel';
        btn.onclick = function () { cancelSchedule(s.id, btn); };
        row.appendChild(info); row.appendChild(btn);
        schedList.appendChild(row);
      });
    }

    async function loadSchedules() {
      try {
        var res = await fetch('/api/schedules');
        if (res.status === 401) { window.location.href = '/'; return; }
        var data = await res.json().catch(function () { return {}; });
        if (res.ok && data.ok) renderSchedules(data.schedules || []);
      } catch (e) { /* leave the list as-is on a transient error */ }
    }

    async function cancelSchedule(id, btn) {
      btn.disabled = true;
      try {
        var res = await fetch('/api/schedules/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: id }),
        });
        if (res.status === 401) { window.location.href = '/'; return; }
        await loadSchedules();
      } catch (e) { btn.disabled = false; }
    }

    schedForm.onsubmit = async function (e) {
      e.preventDefault();
      var url = document.getElementById('sched-url').value.trim();
      var whenVal = document.getElementById('sched-when').value;
      var rec = document.getElementById('sched-rec').value;
      if (!url || !whenVal) { showSched('Enter a meeting link and a time.', 'err'); return; }
      var runAt = new Date(whenVal).getTime();
      if (!runAt) { showSched('That date and time looks invalid.', 'err'); return; }
      schedBtn.disabled = true;
      showSched('Scheduling…', '');
      try {
        var res = await fetch('/api/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            meeting_url: url,
            run_at: runAt,
            recurrence: rec,
            tz_offset: new Date().getTimezoneOffset(),
          }),
        });
        if (res.status === 401) { window.location.href = '/'; return; }
        var data = await res.json().catch(function () { return {}; });
        if (res.ok && data.ok) {
          showSched('Scheduled. The notetaker will join on time.', 'ok');
          document.getElementById('sched-url').value = '';
          document.getElementById('sched-when').value = '';
          await loadSchedules();
        } else {
          showSched(data.error || 'Could not schedule.', 'err');
        }
      } catch (e) {
        showSched('Network error. Please try again.', 'err');
      } finally {
        schedBtn.disabled = false;
      }
    };

    loadSchedules();
  }

  /* ---- transcripts ---- */
  var tq = document.getElementById('tq');
  var tlist = document.getElementById('tlist');
  var tstatus = document.getElementById('tstatus');
  var meetings = [];
  var hasSegments = false;

  function fmtTime(s) {
    s = Math.max(0, Math.floor(Number(s) || 0));
    var m = Math.floor(s / 60), x = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (x < 10 ? '0' : '') + x;
  }

  function group(segs) {
    var map = {};
    segs.forEach(function (seg) {
      var owner = seg.owner_email || '';
      var key = owner + '#' + seg.meeting_id;
      if (!map[key]) map[key] = { meeting_id: seg.meeting_id, owner: owner, segments: [], latest: '' };
      map[key].segments.push(seg);
      if ((seg.created_at || '') > map[key].latest) map[key].latest = seg.created_at || '';
    });
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    arr.sort(function (a, b) {
      if (a.latest !== b.latest) return a.latest < b.latest ? 1 : -1;
      return Number(b.meeting_id) - Number(a.meeting_id);
    });
    arr.forEach(function (m) {
      m.segments.sort(function (a, b) { return (Number(a.start_time) || 0) - (Number(b.start_time) || 0); });
    });
    return arr;
  }

  function render() {
    var filter = (tq.value || '').trim().toLowerCase();
    tlist.innerHTML = '';
    if (!hasSegments) { tstatus.textContent = 'No transcripts yet.'; return; }
    var shown = 0;
    meetings.forEach(function (m) {
      var segs = m.segments;
      if (filter) segs = segs.filter(function (s) { return (s.text || '').toLowerCase().indexOf(filter) > -1; });
      if (!segs.length) return;
      shown++;
      var card = document.createElement('div'); card.className = 'mcard';
      var head = document.createElement('button'); head.type = 'button'; head.className = 'mhead';
      var when = m.latest ? new Date(m.latest).toLocaleString() : '';
      var parts = ['Meeting ' + m.meeting_id];
      if (m.owner) parts.push(m.owner);
      parts.push(segs.length + ' segment' + (segs.length === 1 ? '' : 's'));
      if (when) parts.push(when);
      head.textContent = parts.join('  ·  ');
      var body = document.createElement('div'); body.className = 'mbody';
      body.style.display = filter ? 'block' : 'none';
      head.onclick = function () { body.style.display = body.style.display === 'none' ? 'block' : 'none'; };
      segs.forEach(function (s) {
        var rowEl = document.createElement('div'); rowEl.className = 'seg';
        var ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = '[' + fmtTime(s.start_time) + '] ';
        var sp = document.createElement('span'); sp.className = 'sp'; sp.textContent = (s.speaker || 'Unknown') + ': ';
        var tx = document.createElement('span'); tx.textContent = s.text || '';
        rowEl.appendChild(ts); rowEl.appendChild(sp); rowEl.appendChild(tx);
        body.appendChild(rowEl);
      });
      card.appendChild(head); card.appendChild(body); tlist.appendChild(card);
    });
    tstatus.textContent = shown ? '' : (filter ? 'No segments match your search.' : 'No transcripts yet.');
  }

  async function loadTranscripts() {
    tstatus.textContent = 'Loading transcripts…';
    try {
      var res = await fetch('/api/transcripts');
      if (res.status === 401) { window.location.href = '/'; return; }
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) { hasSegments = false; meetings = []; tlist.innerHTML = ''; tstatus.textContent = data.error || 'Could not load transcripts.'; return; }
      var segs = data.segments || [];
      hasSegments = segs.length > 0;
      meetings = group(segs);
      render();
    } catch (e) {
      tstatus.textContent = 'Network error loading transcripts.';
    }
  }

  tq.oninput = render;
  document.getElementById('refresh').onclick = loadTranscripts;
  loadTranscripts();
</script>
</body>
</html>`;
}
