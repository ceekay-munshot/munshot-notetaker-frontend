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
  "https://courtesy-nightlife-lawyer-pharmacies.trycloudflare.com/public/join";
const DEFAULT_LEAVE_ENDPOINT =
  "https://courtesy-nightlife-lawyer-pharmacies.trycloudflare.com/public/leave";

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
      if (method === "POST" && pathname === "/api/calendar/sync") return handleCalendarSync(request, env);
      if (method === "GET" && pathname === "/api/calendar/meetings") return handleCalendarMeetings(request, env);
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

// Origin of the bot API (derived from the join endpoint) — the /calendar/*
// routes live on the same host alongside /public/join, so a tunnel swap of
// JOIN_ENDPOINT moves them too.
function apiBase(env) {
  try {
    return new URL(joinEndpoint(env)).origin;
  } catch {
    return new URL(DEFAULT_JOIN_ENDPOINT).origin;
  }
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

/* ------------------------------ calendar ------------------------------ */

async function readUpstreamJson(upstream) {
  const text = await upstream.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Calendar is per-email. The email is always the signed-in user's, taken from
// the session — never the request body/query — and the API key is attached
// server-side. Mirrors the curl: POST /calendar/sync {email}.
async function handleCalendarSync(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (session.isAdmin) return json({ error: "Admin accounts have no calendar" }, 403);
  if (!env.API_KEY) return json({ error: "Server is missing the API_KEY secret" }, 500);
  try {
    const upstream = await fetch(apiBase(env) + "/calendar/sync", {
      method: "POST",
      headers: { "X-API-Key": env.API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: session.identity }),
    });
    const result = await readUpstreamJson(upstream);
    return json({ ok: upstream.ok, status: upstream.status, result }, upstream.ok ? 200 : 502);
  } catch (err) {
    return json({ error: "Failed to reach the calendar service", detail: String((err && err.message) || err) }, 502);
  }
}

// GET /calendar/meetings?email=<session email>.
async function handleCalendarMeetings(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (session.isAdmin) return json({ error: "Admin accounts have no calendar" }, 403);
  if (!env.API_KEY) return json({ error: "Server is missing the API_KEY secret" }, 500);
  try {
    const upstream = await fetch(
      apiBase(env) + "/calendar/meetings?email=" + encodeURIComponent(session.identity),
      { headers: { "X-API-Key": env.API_KEY } }
    );
    const calendar = await readUpstreamJson(upstream);
    return json({ ok: upstream.ok, status: upstream.status, calendar }, upstream.ok ? 200 : 502);
  } catch (err) {
    return json({ error: "Failed to reach the calendar service", detail: String((err && err.message) || err) }, 502);
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
    timeZone: s.timeZone || "UTC",
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
  const recurrence = RECURRENCES.includes(body.recurrence) ? body.recurrence : "once";
  const timeZone = body.time_zone;
  const local = parseLocalDateTime(body.local_datetime);

  if (!meetingUrl) return json({ error: "Meeting URL is required" }, 400);
  try {
    new URL(meetingUrl);
  } catch {
    return json({ error: "Enter a valid meeting URL" }, 400);
  }
  if (!isValidTimeZone(timeZone)) return json({ error: "Pick a valid time zone" }, 400);
  if (!local) return json({ error: "Pick a date and time" }, 400);

  const now = Date.now();
  // The wall-clock time the user picked, resolved to a real UTC instant in their
  // chosen zone (DST-aware). `weekday` anchors weekly routines.
  const firstUtc = wallTimeToUtc(local, timeZone);
  const weekday = addDays(local.year, local.month, local.day, 0).dow;

  let nextRun;
  if (recurrence === "once") {
    if (firstUtc < now - 60000) return json({ error: "Pick a time in the future" }, 400);
    nextRun = firstUtc;
  } else {
    // First occurrence at or after the picked time that obeys the repeat rule —
    // e.g. a Saturday pick for a weekdays routine rolls forward to Monday.
    const anchor = Math.max(now, firstUtc - 1);
    nextRun = nextRecurringRun(anchor, { recurrence, hour: local.hour, minute: local.minute, weekday, timeZone });
    if (!nextRun) return json({ error: "Could not compute the next run time" }, 400);
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
    timeZone,
    hour: local.hour,
    minute: local.minute,
    weekday,
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

// Parses a browser <input type="datetime-local"> value ("YYYY-MM-DDTHH:MM")
// into bare wall-clock fields. No zone is implied — that comes from time_zone.
function parseLocalDateTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(s || ""));
  if (!m) return null;
  return { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] };
}

// True if `tz` is a real IANA zone this runtime understands.
function isValidTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// The offset (ms, local − UTC) that `timeZone` had at a given UTC instant.
// Derived by formatting the instant in the zone and reading the wall clock back.
function zoneOffsetMs(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  const asIfUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asIfUtc - utcMs;
}

// Converts a wall-clock time in `timeZone` to its UTC epoch ms. Two passes
// resolve DST: the second uses the offset that actually applies at the result.
function wallTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = naive - zoneOffsetMs(naive, timeZone);
  utc = naive - zoneOffsetMs(utc, timeZone);
  return utc;
}

// The local calendar/clock fields of a UTC instant in `timeZone`.
function zoneParts(utcMs, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute };
}

// A calendar date `n` days after y/m/d, with its day-of-week (0 = Sun … 6 = Sat).
function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + n);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

// The next UTC instant strictly after `afterMs` whose local wall clock in
// `timeZone` is hour:minute on a day the recurrence allows (weekly matches
// `weekday`). Recomputing wall-clock → UTC each time keeps routines correct
// across DST: the local time stays put while the UTC instant shifts.
function nextRecurringRun(afterMs, { recurrence, hour, minute, weekday, timeZone }) {
  const start = zoneParts(afterMs, timeZone);
  for (let i = 0; i <= 372; i++) {
    const cal = addDays(start.year, start.month, start.day, i);
    const ok =
      recurrence === "daily" ||
      (recurrence === "weekdays" && cal.dow >= 1 && cal.dow <= 5) ||
      (recurrence === "weekly" && cal.dow === weekday);
    if (!ok) continue;
    const utc = wallTimeToUtc({ year: cal.y, month: cal.m, day: cal.d, hour, minute }, timeZone);
    if (utc > afterMs) return utc;
  }
  return null;
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
      // Fire once now, then recompute the next occurrence strictly after now so a
      // long-overdue routine doesn't re-fire every minute until it catches up.
      s.attempts = 0;
      const next = nextRecurringRun(now, {
        recurrence: s.recurrence,
        hour: s.hour,
        minute: s.minute,
        weekday: s.weekday,
        timeZone: s.timeZone,
      });
      if (next) {
        s.nextRun = next;
        await env.KV.put(s._key, JSON.stringify(stripMeta(s)));
      } else {
        await env.KV.delete(s._key); // unreachable in practice; never loop forever
      }
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
  :root {
    color-scheme: light;
    --bg: #f6f7f9;
    --card: #ffffff;
    --border: #e8eaed;
    --border-strong: #d7dadf;
    --text: #1a1d21;
    --muted: #5d636e;
    --faint: #6b7280;
    --accent: #4f46e5;
    --accent-hover: #4338ca;
    --accent-soft: #eef2ff;
    --shadow: 0 1px 2px rgba(16,24,40,.04), 0 10px 28px rgba(16,24,40,.06);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: var(--bg); color: var(--text); padding: 48px 20px; line-height: 1.5;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  .card {
    width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--border);
    border-radius: 16px; padding: 32px; box-shadow: var(--shadow);
  }
  .card.wide { max-width: 760px; }
  h1 { margin: 0 0 4px; font-size: 22px; font-weight: 650; letter-spacing: -.015em; }
  .sub { margin: 0 0 24px; color: var(--muted); font-size: 14px; }
  .badge { display: inline-block; margin-left: 8px; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: .03em; background: var(--accent-soft); color: var(--accent); vertical-align: middle; }
  label { display: block; font-size: 13px; font-weight: 500; margin: 16px 0 6px; color: #3a3f47; }
  input, select {
    width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--border-strong);
    background: #fff; color: var(--text); font-size: 14px;
    transition: border-color .15s ease, box-shadow .15s ease;
  }
  input::placeholder { color: var(--faint); }
  input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  button {
    width: 100%; margin-top: 20px; padding: 11px 14px; border: 0; border-radius: 10px;
    background: var(--accent); color: #fff; font-weight: 600; font-size: 14px; cursor: pointer;
    transition: background .15s ease, box-shadow .15s ease, opacity .15s ease;
  }
  button:hover { background: var(--accent-hover); }
  button:active { transform: translateY(1px); }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .toggle { margin-top: 20px; text-align: center; font-size: 13px; color: var(--muted); }
  .toggle a { color: var(--accent); cursor: pointer; text-decoration: none; font-weight: 500; }
  .toggle a:hover { text-decoration: underline; }
  .msg { margin-top: 16px; padding: 11px 12px; border-radius: 10px; font-size: 13px; display: none; white-space: pre-wrap; word-break: break-word; }
  .msg.err { display: block; background: #fef3f2; border: 1px solid #fecdca; color: #b42318; }
  .msg.ok { display: block; background: #ecfdf3; border: 1px solid #abefc6; color: #067647; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .linkbtn { background: transparent; color: var(--muted); width: auto; margin: 0; padding: 6px 10px; font-weight: 500; }
  .linkbtn:hover { background: #f1f2f4; color: var(--text); }
  .hint { font-size: 12px; color: var(--faint); margin-top: 6px; }
  .btnrow { display: flex; gap: 10px; margin-top: 20px; }
  .btnrow button { margin-top: 0; }
  /* Secondary / "stop" — soft rose, a light pop of colour */
  .btn-stop { background: #fff; color: #b42318; border: 1px solid #fbc9c4; }
  .btn-stop:hover { background: #fef3f2; }
  /* Calendar sync — soft teal accent, a different light colour */
  #cal-sync { background: #0d9488; }
  #cal-sync:hover { background: #0f766e; }
  hr { border: 0; border-top: 1px solid var(--border); margin: 28px 0 20px; }
  .sect { display: flex; justify-content: space-between; align-items: center; }
  .sect h2 { font-size: 16px; font-weight: 600; margin: 0; letter-spacing: -.01em; }
  .search { margin: 14px 0 10px; }
  .tstatus { color: var(--muted); font-size: 13px; padding: 8px 0; }
  .mcard { border: 1px solid var(--border); border-radius: 12px; margin-bottom: 10px; overflow: hidden; }
  .mhead { width: 100%; text-align: left; margin: 0; border-radius: 0; background: #fafbfc; color: var(--text); font-weight: 600; font-size: 13px; padding: 12px 14px; }
  .mhead:hover { background: #f1f2f4; }
  .mbody { padding: 6px 14px 12px; border-top: 1px solid var(--border); }
  .seg { font-size: 13px; line-height: 1.55; padding: 6px 0; border-bottom: 1px solid #f1f2f4; color: #3a3f47; }
  .seg:last-child { border-bottom: 0; }
  .ts { color: var(--faint); font-variant-numeric: tabular-nums; }
  .sp { color: var(--accent); font-weight: 600; }
  .refresh { width: auto; margin: 0; padding: 6px 12px; background: transparent; color: var(--muted); font-weight: 500; border: 1px solid var(--border); }
  .refresh:hover { background: #f1f2f4; color: var(--text); }
  .row2 { display: flex; gap: 12px; }
  .row2 > div { flex: 1; min-width: 0; }
  .schedule { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; gap: 10px; background: #fff; }
  .schedule .info { font-size: 13px; line-height: 1.5; min-width: 0; }
  .schedule .when { color: var(--text); font-weight: 600; }
  .schedule .rec { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 999px; font-size: 11px; background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .schedule .tzlabel { color: var(--faint); font-size: 12px; margin-left: 6px; }
  .schedule .url { color: var(--muted); word-break: break-all; }
  .schedule .last { color: var(--faint); font-size: 12px; }
  .cancel { width: auto; margin: 0; padding: 7px 12px; background: #fff; color: #3a3f47; border: 1px solid var(--border-strong); font-weight: 500; font-size: 13px; flex-shrink: 0; }
  .cancel:hover { background: #f1f2f4; }
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
      <label for="sched-tz">Time zone</label>
      <select id="sched-tz"></select>
      <button type="submit" id="sched-btn">Schedule it</button>
    </form>
    <div class="msg" id="sched-msg"></div>
    <div id="sched-list"></div>

    <hr />

    <div class="sect"><h2>Calendar</h2><button class="refresh" id="cal-refresh">Refresh</button></div>
    <p class="hint">Sync your Google Calendar to see upcoming meetings, then send any of them to the notetaker.</p>
    <button type="button" id="cal-sync">Sync calendar</button>
    <div class="msg" id="cal-msg"></div>
    <div id="cal-list"></div>

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
    var tzSelect = document.getElementById('sched-tz');
    var recNames = { once: 'One time', daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly' };

    // Detect the browser's zone, then offer the full IANA list (falling back to
    // just the detected zone on older browsers without supportedValuesOf).
    var detectedZone = 'UTC';
    try { detectedZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) {}
    (function fillZones() {
      var zones = [];
      try { if (Intl.supportedValuesOf) zones = Intl.supportedValuesOf('timeZone'); } catch (e) {}
      if (!zones.length) zones = ['UTC'];
      if (zones.indexOf(detectedZone) === -1) zones.unshift(detectedZone);
      zones.forEach(function (z) {
        var o = document.createElement('option');
        o.value = z; o.textContent = z;
        if (z === detectedZone) o.selected = true;
        tzSelect.appendChild(o);
      });
    })();

    // Render an instant in a specific zone, so each schedule reads in its own.
    function fmtIn(ms, tz) {
      try {
        return new Date(ms).toLocaleString([], {
          timeZone: tz, year: 'numeric', month: 'short', day: 'numeric',
          hour: '2-digit', minute: '2-digit',
        });
      } catch (e) {
        return new Date(ms).toLocaleString();
      }
    }

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
        w.textContent = s.nextRun ? fmtIn(s.nextRun, s.timeZone) : '—';
        var rec = document.createElement('span'); rec.className = 'rec';
        rec.textContent = recNames[s.recurrence] || s.recurrence;
        var tz = document.createElement('span'); tz.className = 'tzlabel';
        tz.textContent = s.timeZone || '';
        when.appendChild(w); when.appendChild(rec); when.appendChild(tz);

        var url = document.createElement('div'); url.className = 'url'; url.textContent = s.meetingUrl;
        info.appendChild(when); info.appendChild(url);

        if (s.lastRun) {
          var last = document.createElement('div'); last.className = 'last';
          last.textContent = 'Last run ' + fmtIn(s.lastRun, s.timeZone) + (s.lastStatus ? ' · ' + s.lastStatus : '');
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
      var tz = tzSelect.value || detectedZone;
      if (!url || !whenVal) { showSched('Enter a meeting link and a time.', 'err'); return; }
      schedBtn.disabled = true;
      showSched('Scheduling…', '');
      try {
        var res = await fetch('/api/schedules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            meeting_url: url,
            local_datetime: whenVal,
            recurrence: rec,
            time_zone: tz,
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

  /* ---- calendar ---- */
  var calSync = document.getElementById('cal-sync');
  if (calSync) {
    var calMsg = document.getElementById('cal-msg');
    var calList = document.getElementById('cal-list');
    var calRefresh = document.getElementById('cal-refresh');

    var showCal = function (text, kind) {
      calMsg.textContent = text;
      calMsg.className = 'msg' + (kind ? ' ' + kind : '');
    };

    function fmtWhen(iso) {
      if (!iso) return '';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function renderEvents(events) {
      calList.innerHTML = '';
      if (!events.length) {
        var empty = document.createElement('div'); empty.className = 'tstatus';
        empty.textContent = 'No upcoming calendar meetings.';
        calList.appendChild(empty);
        return;
      }
      events.forEach(function (ev) {
        var row = document.createElement('div'); row.className = 'schedule';
        var info = document.createElement('div'); info.className = 'info';
        var title = document.createElement('div'); title.className = 'when';
        title.textContent = ev.title || 'Untitled meeting';
        var meta = document.createElement('div'); meta.className = 'last';
        meta.textContent = fmtWhen(ev.start_time) + (ev.platform ? ' · ' + ev.platform : '') + (ev.status ? ' · ' + ev.status : '');
        info.appendChild(title); info.appendChild(meta);
        if (ev.meeting_url) {
          var url = document.createElement('div'); url.className = 'url'; url.textContent = ev.meeting_url;
          info.appendChild(url);
        }
        var btn = document.createElement('button'); btn.className = 'cancel'; btn.textContent = 'Send bot';
        if (!ev.meeting_url) btn.disabled = true;
        btn.onclick = function () { sendEvent(ev.meeting_url, btn); };
        row.appendChild(info); row.appendChild(btn);
        calList.appendChild(row);
      });
    }

    async function sendEvent(url, btn) {
      if (!url) return;
      btn.disabled = true;
      var old = btn.textContent; btn.textContent = 'Sending…';
      try {
        var res = await fetch('/api/join', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ meeting_url: url }),
        });
        if (res.status === 401) { window.location.href = '/'; return; }
        var data = await res.json().catch(function () { return {}; });
        if (res.ok && data.ok) {
          showCal('Sent to notetaker: ' + url, 'ok');
          btn.textContent = 'Sent';
        } else {
          showCal('Failed: ' + (data.error || 'Request failed.'), 'err');
          btn.textContent = old; btn.disabled = false;
        }
      } catch (e) {
        showCal('Network error. Please try again.', 'err');
        btn.textContent = old; btn.disabled = false;
      }
    }

    async function loadMeetings() {
      try {
        var res = await fetch('/api/calendar/meetings');
        if (res.status === 401) { window.location.href = '/'; return; }
        var data = await res.json().catch(function () { return {}; });
        if (res.ok && data.ok) {
          renderEvents((data.calendar && data.calendar.calendar_events) || []);
        } else {
          showCal(data.error || 'Could not load calendar.', 'err');
        }
      } catch (e) { /* leave the list as-is on a transient error */ }
    }

    calSync.onclick = async function () {
      calSync.disabled = true;
      showCal('Syncing…', '');
      try {
        var res = await fetch('/api/calendar/sync', { method: 'POST' });
        if (res.status === 401) { window.location.href = '/'; return; }
        var data = await res.json().catch(function () { return {}; });
        if (res.ok && data.ok) {
          var r = data.result || {};
          if (r.connected === false) {
            showCal('Calendar not connected for your account yet.', 'err');
          } else {
            showCal('Synced' + (typeof r.events_synced === 'number' ? ' ' + r.events_synced + ' events' : '') + '.', 'ok');
          }
          await loadMeetings();
        } else {
          showCal(data.error || 'Sync failed.', 'err');
        }
      } catch (e) {
        showCal('Network error. Please try again.', 'err');
      } finally {
        calSync.disabled = false;
      }
    };

    calRefresh.onclick = loadMeetings;
    loadMeetings();
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
