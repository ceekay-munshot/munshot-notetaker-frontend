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
  "https://mortgage-competitive-angels-anonymous.trycloudflare.com/public/join";
const DEFAULT_LEAVE_ENDPOINT =
  "https://mortgage-competitive-angels-anonymous.trycloudflare.com/public/leave";

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
      if (method === "GET" && pathname === "/api/me") return handleMe(request, env);
      if (method === "POST" && pathname === "/api/register") return handleRegister(request, env);
      if (method === "POST" && pathname === "/api/login") return handleLogin(request, env);
      if (method === "POST" && pathname === "/api/logout") return handleLogout(request, env);
      if (method === "POST" && pathname === "/api/join") return handleBot(request, env, "join");
      if (method === "POST" && pathname === "/api/leave") return handleBot(request, env, "leave");
      if (method === "GET" && pathname === "/api/transcripts") return handleTranscripts(request, env);
      if (method === "POST" && pathname === "/api/ai") return handleAiChat(request, env);
      if (method === "GET" && pathname === "/api/schedules") return handleListSchedules(request, env);
      if (method === "POST" && pathname === "/api/schedules") return handleCreateSchedule(request, env);
      if (method === "POST" && pathname === "/api/schedules/delete") return handleDeleteSchedule(request, env);
      if (method === "POST" && pathname === "/api/calendar/sync") return handleCalendarSync(request, env);
      if (method === "GET" && pathname === "/api/calendar/meetings") return handleCalendarMeetings(request, env);
      // Unknown API path → JSON 404 (never the SPA shell, so fetch() callers
      // always get JSON back).
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        return json({ error: "Not found" }, 404);
      }
      // Everything else is the React SPA: serve the static asset if one matches,
      // otherwise fall back to index.html so client-side routes (e.g. /meetings/42)
      // load. The app itself enforces auth by calling /api/me on boot.
      return serveSpa(request, env);
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

// Identity probe for the SPA. Returns the signed-in user (and whether signups
// require a code, so the register form can show the field) or 401 when there is
// no session — the React app boots on this and shows login vs. dashboard.
async function handleMe(request, env) {
  const session = await getSession(request, env);
  if (!session) {
    return json({ authenticated: false, codeRequired: !!env.SIGNUP_CODE }, 401);
  }
  return json({
    authenticated: true,
    email: session.identity,
    isAdmin: !!session.isAdmin,
    codeRequired: !!env.SIGNUP_CODE,
  });
}

// Serve the built React SPA from the ASSETS binding. A request that matches a
// real file (hashed JS/CSS, fonts, the logo) is returned as-is; anything else
// (a client-side route, or "/") falls back to index.html so the SPA router can
// take over.
async function serveSpa(request, env) {
  if (!env.ASSETS) {
    return html(
      "<!doctype html><meta charset=utf-8><title>Munshot Notetaker</title>" +
        "<body style=\"font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem\">" +
        "<h1>Build the dashboard</h1><p>The React app hasn't been built yet. Run " +
        "<code>npm run build</code> (or <code>npm run deploy</code>) so <code>./dist</code> exists, " +
        "then reload.</p>",
      200,
    );
  }
  const url = new URL(request.url);
  // A real built file (it has an extension: .js/.css/.png/.woff2 …) → serve as-is.
  if (/\.[a-zA-Z0-9]+$/.test(url.pathname)) {
    return env.ASSETS.fetch(request);
  }
  // Otherwise it's a navigation ("/", "/meetings", "/meetings/42") → always
  // return the SPA shell so the client router can take over (deep links and
  // refreshes work). Don't rely on the asset layer's not-found behaviour.
  const indexUrl = new URL(request.url);
  indexUrl.pathname = "/index.html";
  return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
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

/* ------------------------------ AI assistant ------------------------------ */

// Builds a readable, length-bounded transcript for the model. Keeps the start
// and (when long) the tail, where decisions and action items usually land.
function buildTranscriptText(rows) {
  const MAX = 30000;
  const lines = rows.map((r) => {
    const t = Math.max(0, Math.floor(Number(r.start_time) || 0));
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = String(t % 60).padStart(2, "0");
    return `[${mm}:${ss}] ${r.speaker || "Unknown"}: ${r.text || ""}`;
  });
  const full = lines.join("\n");
  if (full.length <= MAX) return full;
  const head = Math.floor(MAX * 0.7);
  const tail = MAX - head;
  return full.slice(0, head) + "\n…[transcript truncated]…\n" + full.slice(full.length - tail);
}

// Chat over a single meeting's transcript with OpenAI. The transcript is loaded
// server-side and scoped to the session (all meetings for admin), and the OpenAI
// key is a Worker secret that never reaches the browser. Same ACL as transcripts.
async function handleAiChat(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  const apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
  if (!apiKey) return json({ error: "AI isn't configured (set the OPENAI_API_KEY secret)" }, 503);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);

  const body = await request.json().catch(() => ({}));
  const meetingId = String(body.meeting_id || "").trim();
  if (!meetingId) return json({ error: "Pick a meeting first" }, 400);
  const summarize = !!body.summarize;
  const clientMessages = Array.isArray(body.messages) ? body.messages : [];
  // The dashboard groups meetings by owner + meeting_id, so scope by owner too:
  // admin passes the selected meeting's owner (two owners can share a meeting_id),
  // and a normal user is always scoped to their own session email.
  const ownerScope = session.isAdmin ? String(body.owner || "").trim() : session.identity;

  let res;
  try {
    if (session.isAdmin && !ownerScope) {
      res = await env.DB.prepare(
        "SELECT start_time, text, speaker FROM transcriptions WHERE meeting_id = ?1 ORDER BY start_time"
      ).bind(meetingId).all();
    } else {
      res = await env.DB.prepare(
        "SELECT start_time, text, speaker FROM transcriptions WHERE owner_email = ?1 AND meeting_id = ?2 ORDER BY start_time"
      ).bind(ownerScope, meetingId).all();
    }
  } catch (err) {
    return json({ error: "Failed to load the transcript", detail: String((err && err.message) || err) }, 500);
  }
  const rows = (res && res.results) || [];
  if (!rows.length) return json({ error: "No transcript found for that meeting yet" }, 404);

  const messages = [
    {
      role: "system",
      content:
        "You are a concise meeting assistant. You are given the transcript of a single meeting. " +
        "Answer only from what the transcript supports; if something isn't covered, say so briefly. " +
        "Prefer short paragraphs and bullet points, and do not invent names, numbers, or decisions.\n\n" +
        "MEETING TRANSCRIPT:\n" + buildTranscriptText(rows),
    },
  ];
  for (const m of clientMessages.slice(-12)) {
    const role = m && m.role === "assistant" ? "assistant" : "user";
    const content = String((m && m.content) || "").slice(0, 4000);
    if (content) messages.push({ role, content });
  }
  // First open (or an explicit summarize): ask for a per-person breakdown.
  if (summarize || messages.length === 1) {
    messages.push({
      role: "user",
      content:
        "Summarize this meeting as a per-person breakdown, not one block of text. " +
        "Start with a one-line overall context. Then add a short section for each participant " +
        "who spoke or was discussed, headed by their name, covering:\n" +
        "- Working on: the project(s)/task(s) they are currently handling.\n" +
        "- About: a one-line plain description of what that work is.\n" +
        "- Update: what happened with them in this meeting — progress, blockers, decisions, and any " +
        "action items or next steps (include deadlines and owners when mentioned).\n" +
        "Close with a short \"Decisions & action items\" list across the team. " +
        "Use the names from the transcript, keep each point tight, write in clear English, and only " +
        "include what the transcript supports (say \"not discussed\" if a person's work is unclear).",
    });
  }

  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 700 }),
    });
  } catch (err) {
    return json({ error: "Failed to reach the AI service", detail: String((err && err.message) || err) }, 502);
  }
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const detail = (data && data.error && data.error.message) || `HTTP ${upstream.status}`;
    return json({ error: "AI request failed", detail }, 502);
  }
  const reply =
    data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return json({ ok: true, reply: String(reply || "").trim() });
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

