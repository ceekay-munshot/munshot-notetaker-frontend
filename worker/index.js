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
  "http://65.1.101.15.nip.io:8080/public/join";
const DEFAULT_LEAVE_ENDPOINT =
  "http://65.1.101.15.nip.io:8080/public/leave";
// The calendar Google-auth entry point. Unlike the API base (http, :8080), this
// is a browser-facing HTTPS endpoint on the default port — the tested, working
// URL the user is sent to. Override with the CALENDAR_CONNECT_ENDPOINT var.
const DEFAULT_CALENDAR_CONNECT_ENDPOINT =
  "https://65.1.101.15.nip.io/calendar/connect/start";

const SCHEDULE_PREFIX = "schedule:";
const MAX_SCHEDULES_PER_USER = 50;
const MAX_SCHEDULE_ATTEMPTS = 3; // give up on a failing one-time send after this many cron ticks
const RESET_CODE_TTL = 15 * 60; // password-reset code lifetime, seconds (15 min)
const RESET_MAX_ATTEMPTS = 5; // wrong-code tries before a reset code is burned
const RESET_RESEND_COOLDOWN_MS = 60_000; // ignore a repeat "send code" within this window
const RECURRENCES = ["once", "daily", "weekdays", "weekly"];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      // CSRF guard for state-changing requests. The session cookie is
      // SameSite=None (see sessionCookie() below — required so it still works
      // when this app is embedded as a cross-site iframe inside the Munshot
      // host; SameSite=Strict/Lax cookies are silently dropped in that
      // context), so an Origin check stands in as the CSRF backstop. A
      // legitimate fetch's Origin header always reflects THIS app's own
      // script origin, whether the page is loaded standalone or embedded in
      // another site's iframe — so this holds in both cases. Requests with no
      // Origin header (curl, same-site top-level navigations) pass through.
      if (pathname.startsWith("/api/") && method !== "GET" && method !== "OPTIONS" && method !== "HEAD") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) {
          return json({ error: "Cross-site request rejected" }, 403);
        }
      }

      if (method === "GET" && pathname === "/api/me") return handleMe(request, env);
      if (method === "POST" && pathname === "/api/register") return handleRegister(request, env);
      if (method === "POST" && pathname === "/api/login") return handleLogin(request, env);
      if (method === "POST" && pathname === "/api/host-login") return handleHostLogin(request, env);
      if (method === "POST" && pathname === "/api/forgot-password") return handleForgotPassword(request, env);
      if (method === "POST" && pathname === "/api/reset-password") return handleResetPassword(request, env);
      if (method === "POST" && pathname === "/api/logout") return handleLogout(request, env);
      if (method === "POST" && pathname === "/api/join") return handleBot(request, env, "join");
      if (method === "POST" && pathname === "/api/leave") return handleBot(request, env, "leave");
      if (method === "GET" && pathname === "/api/transcripts") return handleTranscripts(request, env);
      if (method === "GET" && pathname === "/api/admin/users") return handleAdminUsers(request, env);
      if (method === "POST" && pathname === "/api/ai") return handleAiChat(request, env);
      if (method === "POST" && pathname === "/api/meetings/sync-titles") return handleSyncMeetingTitles(request, env);
      if (method === "POST" && pathname === "/api/weekly/people") return handleWeeklyPeople(request, env);
      if (method === "POST" && pathname === "/api/weekly/summary") return handleWeeklySummary(request, env);
      if (method === "POST" && pathname === "/api/weekly/chat") return handleWeeklyChat(request, env);
      if (method === "POST" && pathname === "/api/weekly/meetings") return handleWeeklyMeetings(request, env);
      if (method === "GET" && pathname === "/api/schedules") return handleListSchedules(request, env);
      if (method === "POST" && pathname === "/api/schedules") return handleCreateSchedule(request, env);
      if (method === "POST" && pathname === "/api/schedules/delete") return handleDeleteSchedule(request, env);
      if (method === "POST" && pathname === "/api/schedules/migrate-kv-to-d1") return handleMigrateSchedulesToD1(request, env);
      if (method === "POST" && pathname === "/api/calendar/sync") return handleCalendarSync(request, env);
      if (method === "GET" && pathname === "/api/calendar/connect") return handleCalendarConnect(request, env);
      if (method === "GET" && pathname === "/api/calendar/meetings") return handleCalendarMeetings(request, env);
      if (method === "POST" && pathname === "/api/calendar/meetings/remove") return handleCalendarRemove(request, env);
      if (method === "POST" && pathname === "/api/calendar/meetings/restore") return handleCalendarRestore(request, env);
      if (method === "GET" && pathname === "/api/config") return handleGetConfig(request, env);
      if (method === "POST" && pathname === "/api/config") return handleSetConfig(request, env);
      if (method === "GET" && pathname === "/api/tracking/directory") return handleTrackingDirectory(request, env);
      if (method === "GET" && pathname === "/api/debug/meetings-schema") return handleDebugMeetingsSchema(request, env);
      if (method === "GET" && pathname === "/api/tracking") return handleGetTracking(request, env);
      if (method === "POST" && pathname === "/api/tracking") return handleSaveTracking(request, env);
      if (method === "POST" && pathname === "/api/weekly/tracking") return handleWeeklyTracking(request, env);
      // Public, key-gated (not session-gated) so an external dashboard can call
      // it directly — see TRACKING_CORS_HEADERS / handlePublicTracking below.
      if (method === "OPTIONS" && pathname === "/api/public/tracking") return handleTrackingPreflight();
      if (method === "GET" && pathname === "/api/public/tracking") return handlePublicTracking(request, env);
      // Unknown API path → JSON 404 (never the SPA shell, so fetch() callers
      // always get JSON back).
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        return json({ error: "Not found" }, 404);
      }
      // Everything else is the React SPA: serve the static asset if one matches,
      // otherwise fall back to index.html so client-side routes (e.g. /meetings/42)
      // load. The app itself enforces auth by calling /api/me on boot.
      if (method === "GET" && pathname === "/__apihead") return handleApiHeadPage(request, env);
      return serveSpa(request, env);
    } catch (err) {
      return json({ error: "Server error", detail: String((err && err.message) || err) }, 500);
    }
  },

  // Cron-triggered (see [triggers] in wrangler.toml). Fires every schedule whose
  // time has arrived, regardless of whether the user has the dashboard open.
  // Auto-summaries and people-tracking run as their OWN waitUntil calls (not
  // chained after runDueSchedules) so slow OpenAI generation never delays the
  // latency-critical bot-join dispatch.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDueSchedules(env));
    ctx.waitUntil(runAutoSummaries(env));
    ctx.waitUntil(runTrackingRollups(env));
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

// Exchanges a Munshot host JWT (the embedded dashboard's session.token, handed
// over postMessage by the parent Munshot host) for our own Worker session
// cookie, so /api/* calls made from inside the host iframe are authenticated.
//
// SECURITY CAVEAT: this does NOT verify the JWT's signature — we don't have
// the host's signing secret configured, so we trust the `email` claim as-is,
// mirroring the frontend's decode-only trust model (see src/lib/hostToken.ts).
// This means anyone who can reach this endpoint can mint a session for ANY
// email by handing it a self-signed token. Revisit this once the shared
// signing secret is available: add it as a Worker secret (e.g.
// MUNSHOT_JWT_SECRET) and verify the HS256 signature here before trusting the
// payload.
async function handleHostLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const claims = decodeJwtPayloadUnverified(body.token);
  if (!claims || !isValidEmail(String(claims.email || ""))) {
    return json({ error: "Invalid host token" }, 400);
  }
  if (typeof claims.exp === "number" && Date.now() >= claims.exp * 1000) {
    return json({ error: "Host token expired" }, 401);
  }

  const email = normalizeEmail(claims.email);
  const cookie = await createSession(env, email);
  return json({ ok: true, email }, 200, { "Set-Cookie": cookie });
}

// Decodes a JWT payload WITHOUT verifying its signature. Only handleHostLogin
// uses this — see the security caveat there.
function decodeJwtPayloadUnverified(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

// KV key holding a pending password-reset code for an email (hashed, TTL'd).
function resetCodeKey(email) {
  return `reset:${normalizeEmail(email)}`;
}

// "Forgot password" step 1 — email a short-lived, single-use reset CODE. The
// account's existing password is left untouched; the code only authorizes a
// password change via /api/reset-password. Codes are stored HASHED in KV with a
// hard TTL, so a KV leak never exposes a usable code and a stale code self-
// destructs. Responds the same way whether or not the account exists, so it can't
// be used to probe which emails are registered.
async function handleForgotPassword(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: "Email is required" }, 400);
  if (!isValidEmail(email)) return json({ error: "Enter a valid email address" }, 400);

  const raw = await env.KV.get(`user:${email}`);
  if (raw) {
    if (!env.MUNS_TOKEN) {
      return json({ error: "Email isn't configured on the server yet" }, 500);
    }

    // Throttle repeat sends so the reset can't be used to email-bomb an address:
    // if a code was issued moments ago, don't mint/send another.
    const existing = await env.KV.get(resetCodeKey(email));
    if (existing) {
      try {
        const prev = JSON.parse(existing);
        if (prev && typeof prev.createdAt === "number" && Date.now() - prev.createdAt < RESET_RESEND_COOLDOWN_MS) {
          return json({ ok: true });
        }
      } catch {
        /* corrupt entry — fall through and mint a fresh one */
      }
    }

    const code = generateResetCode();
    try {
      await sendMunsEmail(env, {
        email,
        subject: "Your Munshot password reset code",
        text:
          "Use this code to reset your Munshot Notetaker password:\n\n" +
          `Reset code: ${code}\n\n` +
          "Enter it on the reset screen along with your new password. The code " +
          "expires in 15 minutes and can be used once. If you didn't request this, " +
          "you can ignore this email — your password hasn't changed.",
      });
    } catch (err) {
      return json({ error: "Couldn't send the email. Please try again." }, 502);
    }

    // Delivery succeeded — store the code HASHED (PBKDF2 + per-code salt) with a
    // hard TTL so it can't outlive its window even if it's never used.
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const entry = {
      salt: toHex(saltBytes),
      hash: await deriveHash(code, saltBytes),
      expiresAt: Date.now() + RESET_CODE_TTL * 1000,
      attempts: 0,
      createdAt: Date.now(),
    };
    await env.KV.put(resetCodeKey(email), JSON.stringify(entry), { expirationTtl: RESET_CODE_TTL });
  }

  // Generic response regardless of whether the account existed.
  return json({ ok: true });
}

// "Forgot password" step 2 — verify the emailed code and set a NEW password. The
// code is single-use and attempt-limited; on success we swap the account's hash
// and burn the code. Every "can't use this code" case returns the same generic
// message, so a wrong email and a wrong code are indistinguishable (no
// enumeration). The new password must meet the same policy as registration.
async function handleResetPassword(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = normalizeEmail(body.email);
  const code = String(body.code || "").trim();
  const password = String(body.password || "");

  if (!email || !code || !password) return json({ error: "Email, code, and new password are required" }, 400);
  if (!isValidEmail(email)) return json({ error: "Enter a valid email address" }, 400);
  if (password.length < 6) return json({ error: "Password must be at least 6 characters" }, 400);

  const key = resetCodeKey(email);
  const rawEntry = await env.KV.get(key);
  const rawUser = await env.KV.get(`user:${email}`);
  const invalid = () => json({ error: "Invalid or expired reset code" }, 400);
  if (!rawEntry || !rawUser) return invalid();

  let entry;
  try {
    entry = JSON.parse(rawEntry);
  } catch {
    await env.KV.delete(key);
    return invalid();
  }
  if (!entry || typeof entry.expiresAt !== "number" || Date.now() > entry.expiresAt) {
    await env.KV.delete(key);
    return invalid();
  }
  if ((entry.attempts || 0) >= RESET_MAX_ATTEMPTS) {
    await env.KV.delete(key);
    return json({ error: "Too many attempts. Request a new reset code." }, 429);
  }

  const computed = await deriveHash(code, fromHex(String(entry.salt || "")));
  if (!timingSafeEqual(computed, String(entry.hash || ""))) {
    // Wrong code — count the attempt and keep the code alive (still self-
    // destructing) with its remaining TTL, until it's burned through or expires.
    entry.attempts = (entry.attempts || 0) + 1;
    const remaining = Math.max(1, Math.ceil((entry.expiresAt - Date.now()) / 1000));
    await env.KV.put(key, JSON.stringify(entry), { expirationTtl: remaining });
    return invalid();
  }

  // Code is good — set the new password and burn the code (single use).
  let user;
  try {
    user = JSON.parse(rawUser);
  } catch {
    await env.KV.delete(key);
    return invalid();
  }
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  user.salt = toHex(saltBytes);
  user.hash = await deriveHash(password, saltBytes);
  await env.KV.put(`user:${email}`, JSON.stringify(user));
  await env.KV.delete(key);

  return json({ ok: true });
}

async function handleLogout(request, env) {
  const token = parseCookies(request)[COOKIE_NAME];
  if (token) await env.KV.delete(`session:${token}`);
  return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
}

// KV key holding a runtime override of the backend base URL (the "API head").
// When an admin sets it via /api/config it wins over the wrangler.toml vars, so
// the head can be repointed at a new tunnel/host without a redeploy.
const API_BASE_KEY = "config:apiBase";

// The configured fallback base — origin of JOIN_ENDPOINT (or the built-in
// default) — used when no runtime override is set.
function fallbackApiBase(env) {
  const full = env.JOIN_ENDPOINT || DEFAULT_JOIN_ENDPOINT;
  try {
    return new URL(full).origin;
  } catch {
    return new URL(DEFAULT_JOIN_ENDPOINT).origin;
  }
}

// The effective base URL the bot/schedule calls are sent to: the KV override if an
// admin set one, else the configured fallback. The notetaker endpoints
// (/public/join, /public/leave) are built from this head. Calendar calls do NOT
// use this base — the calendar service runs on its own HTTPS host (see
// calendarApiBase / calendarConnectEndpoint below).

// The calendar connect-start URL (browser-facing). Configurable so the host can
// change without a redeploy; defaults to the tested endpoint.
function calendarConnectEndpoint(env) {
  return env.CALENDAR_CONNECT_ENDPOINT || DEFAULT_CALENDAR_CONNECT_ENDPOINT;
}

// The calendar SERVICE's API base for the server-side sync / meetings calls. The
// calendar service runs on its own HTTPS host on the default port — a DIFFERENT
// origin from the bot API (http, :8080) — so we derive it from the connect
// endpoint's origin (verified against the live box: POST
// https://65.1.101.15.nip.io/calendar/sync). This keeps every calendar call (OAuth
// connect, sync, meetings) pointed at the same host.
function calendarApiBase(env) {
  try {
    return new URL(calendarConnectEndpoint(env)).origin;
  } catch {
    return new URL(DEFAULT_CALENDAR_CONNECT_ENDPOINT).origin;
  }
}

async function resolveApiBase(env) {
  try {
    const override = await env.KV.get(API_BASE_KEY);
    if (override) return override.replace(/\/+$/, "");
  } catch {
    /* KV read hiccup → fall back to the configured base */
  }
  return fallbackApiBase(env);
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
  const base = await resolveApiBase(env);
  const endpoint = base + (action === "leave" ? "/public/leave" : "/public/join");
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

// Returns transcripts from D1. A normal user sees every meeting they own via
// the meeting_owners table (every calendar attendee is a co-owner now), plus a
// fallback to legacy rows still tagged with their transcriptions.owner_email so
// meetings created before the backend started mirroring ownership still show.
// Admin sees every row.
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
      // owner_email is stored lowercased/trimmed, so match the normalized email.
      const email = normalizeEmail(session.identity);
      res = await env.DB.prepare(
        "SELECT meeting_id, segment_id, start_time, end_time, text, speaker, created_at " +
        "FROM transcriptions " +
        "WHERE meeting_id IN (SELECT meeting_id FROM meeting_owners WHERE owner_email = ?1) " +
        "OR owner_email = ?1 " +
        "ORDER BY meeting_id, start_time"
      ).bind(email).all();
    }
    const segments = res.results || [];
    const titles = await loadTitlesFor(env, segments);
    return json({ ok: true, admin: session.isAdmin, segments, titles });
  } catch (err) {
    return json({ error: "Failed to load transcripts", detail: String((err && err.message) || err) }, 500);
  }
}

// GET /api/admin/users — admin-only. Every distinct email that could have
// upcoming meetings: D1 meeting_owners (co-owners of recorded meetings) plus
// legacy transcriptions.owner_email rows, unioned with the owners of any KV
// schedule — so a user with only a pending schedule (no recordings yet) still
// shows up. Feeds the admin "Scheduled Meetings" picker.
async function handleAdminUsers(request, env) {
  const session = await getSession(request, env);
  if (!session || !session.isAdmin) return json({ error: "Forbidden" }, 403);
  const emails = new Set();
  if (env.DB) {
    try {
      const res = await env.DB.prepare(
        "SELECT DISTINCT owner_email FROM meeting_owners WHERE owner_email IS NOT NULL AND owner_email != '' " +
        "UNION SELECT DISTINCT owner_email FROM transcriptions WHERE owner_email IS NOT NULL AND owner_email != ''"
      ).all();
      for (const row of (res && res.results) || []) {
        const email = normalizeEmail(row && row.owner_email);
        if (email) emails.add(email);
      }
    } catch {
      /* meeting_owners/transcriptions not ready yet — schedules below still work */
    }
  }
  const schedules = schedulesOnD1(env)
    ? await d1ListSchedules(env, null)
    : await readSchedules(env, SCHEDULE_PREFIX);
  for (const s of schedules) {
    const email = normalizeEmail(s.owner);
    if (email) emails.add(email);
  }
  return json({ ok: true, users: [...emails].sort() });
}

// Which `meetings` column to join transcriptions.meeting_id against. Confirmed
// live (via GET /api/debug/meetings-schema against production): the real
// `meetings` schema is meeting_id, user_id, platform, native_meeting_id, status,
// bot_name, language, transcribe_enabled, recording_enabled, segment_count,
// started_at, ended_at, created_at, updated_at, completion_reason, failure_stage,
// name — i.e. `meetings.meeting_id` is the SAME column name (and value) as
// `transcriptions.meeting_id`, a direct 1:1 join. There is no `id` column, and
// `native_meeting_id` (the platform's own room code, e.g. a Google Meet code) is
// a separate field, not the join key. Resolved once per warm isolate via PRAGMA
// table_info (cheap, side-effect-free) rather than hardcoded, so a future schema
// change still resolves: prefer an exact `meeting_id` match, then any *code*
// column, then `id` as a last resort. undefined = not yet resolved this isolate;
// [] = table/columns not found.
let meetingsJoinColumns;

async function resolveMeetingsJoinColumns(env) {
  if (meetingsJoinColumns !== undefined) return meetingsJoinColumns;
  try {
    const res = await env.DB.prepare("PRAGMA table_info(meetings)").all();
    const cols = ((res && res.results) || []).map((r) => String((r && r.name) || "")).filter(Boolean);
    const candidates = [
      cols.includes("meeting_id") ? "meeting_id" : null,
      cols.find((c) => /code/i.test(c)),
      cols.includes("id") ? "id" : null,
    ];
    meetingsJoinColumns = [...new Set(candidates.filter(Boolean))];
  } catch {
    meetingsJoinColumns = []; // no `meetings` table (yet) — never throw for this
  }
  return meetingsJoinColumns;
}

// The bot backend's own `meetings` table (D1) now carries a real `name` column —
// the actual meeting name (e.g. the calendar invite title captured at join time),
// never AI-generated. It takes priority over EVERYTHING else this Worker knows
// about a meeting's title: a synced browser calendar name and especially any
// AI-minted one. Best-effort and defensive throughout: an older D1 snapshot
// without the `meetings` table (or without a `name` column yet) must never break
// a caller — missing names just leave the map empty and callers fall back to
// what they had.
async function d1MeetingNames(env, meetingIds) {
  const out = {};
  if (!env.DB || !meetingIds || !meetingIds.length) return out;
  const ids = [...new Set(meetingIds.map((v) => String(v).trim()).filter(Boolean))];
  if (!ids.length) return out;
  const columns = await resolveMeetingsJoinColumns(env);
  const CHUNK = 100; // stay under D1's bound-parameter ceiling
  for (const col of columns) {
    const remaining = ids.filter((id) => !out[id]);
    if (!remaining.length) break;
    for (let i = 0; i < remaining.length; i += CHUNK) {
      const chunk = remaining.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, j) => `?${j + 1}`).join(",");
      try {
        const res = await env.DB.prepare(
          `SELECT ${col} AS join_key, name FROM meetings WHERE CAST(${col} AS TEXT) IN (${placeholders})`
        ).bind(...chunk).all();
        for (const row of (res && res.results) || []) {
          const name = String((row && row.name) || "").trim();
          const key = String((row && row.join_key) || "").trim();
          if (name && key) out[key] = name;
        }
      } catch {
        /* this column (or chunk) didn't resolve — the next candidate column,
           if any, still gets a chance */
      }
    }
  }
  return out;
}

// GET /api/debug/meetings-schema — admin-only, read-only diagnostic for the D1
// `meetings` table wiring: does it exist, what columns does it have, which one
// did we resolve as the join key, and — for a sample of real transcriptions.
// meeting_id values — does that join actually find a name. Exists because this
// Worker's coding environment has no live D1 access to verify the join key
// against the real schema; hit this from the browser (signed in as admin)
// instead. Safe to remove once the naming rollout is confirmed working.
async function handleDebugMeetingsSchema(request, env) {
  const session = await getSession(request, env);
  if (!session || !session.isAdmin) return json({ error: "Admin only" }, 403);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);

  const out = { hasMeetingsTable: false, columns: [], joinColumns: [], meetingsRowCount: null, sampleMeetingsRows: [], sampleTranscriptionMeetingIds: [], resolvedNames: {} };
  try {
    const cols = await env.DB.prepare("PRAGMA table_info(meetings)").all();
    out.columns = ((cols && cols.results) || []).map((r) => r.name);
    out.hasMeetingsTable = out.columns.length > 0;
  } catch (err) {
    out.columnsError = String((err && err.message) || err);
  }
  out.joinColumns = await resolveMeetingsJoinColumns(env);
  if (out.hasMeetingsTable) {
    try {
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM meetings").all();
      out.meetingsRowCount = Number((count.results && count.results[0] && count.results[0].n) || 0);
    } catch {
      /* best-effort */
    }
    try {
      // `rowid` always exists on an ordinary SQLite table regardless of the
      // declared columns (unlike guessing a column name to sort by).
      const sample = await env.DB.prepare("SELECT * FROM meetings ORDER BY rowid DESC LIMIT 5").all();
      out.sampleMeetingsRows = (sample && sample.results) || [];
    } catch {
      /* best-effort */
    }
  }
  try {
    const ids = await env.DB.prepare("SELECT DISTINCT meeting_id FROM transcriptions ORDER BY meeting_id DESC LIMIT 10").all();
    out.sampleTranscriptionMeetingIds = ((ids && ids.results) || []).map((r) => String(r.meeting_id));
  } catch {
    /* best-effort */
  }
  out.resolvedNames = await d1MeetingNames(env, out.sampleTranscriptionMeetingIds);
  return json(out);
}

// Fetches the real title for the meetings in these rows, as a { meeting_id: title }
// map, so the dashboard can show real names instead of "Meeting <id>". Priority:
// the D1 `meetings.name` (real, server-side, never AI) beats whatever's already
// cached (a synced calendar name, or a stale AI-minted title) — and a resolved D1
// name is written back into the KV title cache so it self-heals for every other
// reader (weekly synthesis, the cached-summary return path) without their own D1
// round-trip. Scoped to the caller's own (already-authorized) meetings, and capped
// so a huge history can't blow the Worker's subrequest budget — meetings past the
// cap keep the "Meeting <id>" fallback until they're opened.
async function loadTitlesFor(env, segments) {
  const out = {};
  if (!env.KV || !segments || !segments.length) return out;
  const ids = [];
  const seen = new Set();
  for (const s of segments) {
    const id = String(s.meeting_id);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  const pick = ids.slice(0, 200);
  try {
    const vals = await Promise.all(pick.map((id) => env.KV.get(titleCacheKey(id)).catch(() => null)));
    pick.forEach((id, i) => {
      if (vals[i]) out[id] = vals[i];
    });
  } catch {
    /* best-effort — return whatever resolved */
  }

  const d1Names = await d1MeetingNames(env, pick);
  for (const [id, name] of Object.entries(d1Names)) {
    if (out[id] !== name) {
      out[id] = name;
      env.KV.put(titleCacheKey(id), name).catch(() => {});
    }
  }
  return out;
}

// POST /api/meetings/sync-titles { names: [{ meeting_id, calendar_name }] } —
// lets a signed-in user's browser push the real calendar names it already
// knows (built client-side from ITS OWN calendar sync) into the shared title
// cache. Without this, a meeting only self-heals from a stale/AI title when
// its owner happens to individually reopen it (see handleAiChat); a viewer
// with no calendar of their own — chiefly admin, who is denied calendar access
// entirely — would otherwise keep seeing the stale title indefinitely. Admin
// never calls this (it has no calendar names to push). Same per-meeting ACL as
// transcripts/summarize: a meeting_id the caller isn't an owner of is skipped.
// The bot backend's own D1 `meetings.name` outranks a synced calendar name (see
// d1MeetingNames) — a meeting D1 already has a real name for is left alone here
// (and corrected to the D1 name if the cache is stale) rather than overwritten
// with the browser's calendar_name.
async function handleSyncMeetingTitles(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (session.isAdmin || !env.KV || !env.DB) return json({ ok: true, updated: 0 });

  const body = await request.json().catch(() => ({}));
  const entries = Array.isArray(body.names) ? body.names.slice(0, 200) : [];
  if (!entries.length) return json({ ok: true, updated: 0 });

  const email = normalizeEmail(session.identity);
  const d1Names = await d1MeetingNames(env, entries.map((e) => (e && e.meeting_id) || ""));
  let updated = 0;
  for (const entry of entries) {
    const meetingId = String((entry && entry.meeting_id) || "").trim();
    const calendarName = String((entry && entry.calendar_name) || "").trim();
    if (!meetingId || !calendarName) continue;
    const authoritative = d1Names[meetingId] || calendarName;
    try {
      const owns = await env.DB.prepare(
        "SELECT 1 FROM transcriptions WHERE meeting_id = ?2 AND (" +
        "EXISTS (SELECT 1 FROM meeting_owners WHERE meeting_id = ?2 AND owner_email = ?1) " +
        "OR owner_email = ?1) LIMIT 1"
      ).bind(email, meetingId).all();
      if (!owns.results || !owns.results.length) continue;
      const key = titleCacheKey(meetingId);
      const stored = await env.KV.get(key);
      if (stored !== authoritative) {
        await env.KV.put(key, authoritative);
        updated++;
      }
    } catch {
      /* best-effort per entry — one bad row shouldn't sink the batch */
    }
  }
  return json({ ok: true, updated });
}

/* ------------------------------ AI assistant ------------------------------ */

// KV key under which a meeting's generated summary is cached. Keyed by meeting_id
// only (shared across all co-owners); bump the version suffix to invalidate every
// cached summary at once after a summary-format change.
function summaryCacheKey(meetingId) {
  return `summary:v2:${String(meetingId).trim()}`;
}

// KV key for a meeting's display title. Holds either the meeting's real
// calendar name (set once the client discovers it — see calendar_name in
// handleAiChat) or, for an ad-hoc meeting with no name (the UI otherwise shows
// "Meeting <id>"), a short AI-minted title. Cached here so every user —
// including ones without their own calendar view of the meeting — sees the
// same name everywhere.
function titleCacheKey(meetingId) {
  return `title:v1:${String(meetingId).trim()}`;
}

// Normalizes the model's title output: strips quotes / a "Title:" prefix / a
// trailing period, and hard-caps it at 5 words. Returns "" for junk so callers
// fall back to "Meeting <id>".
function cleanTitle(raw) {
  let t = String(raw || "").trim();
  t = t.replace(/^["'“”\s]+|["'“”\s]+$/g, "").replace(/^title\s*[:\-–]\s*/i, "").trim();
  t = t.replace(/[.。]+$/g, "").trim();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 5) t = words.slice(0, 5).join(" ");
  if (!t || t.length > 80) return "";
  return t;
}

// Mints a short, human title (≤5 words) for an otherwise-unnamed meeting from the
// opening of its transcript (where the topic is usually set), keeping the call
// cheap. Returns "" on any failure so summarizing never breaks over a title.
async function generateMeetingTitle(rows, apiKey, model) {
  const text = buildTranscriptText(rows).slice(0, 6000);
  if (!text.trim()) return "";
  const raw = await openaiChat(
    apiKey,
    model,
    [
      {
        role: "system",
        content:
          "You name meetings. Given a transcript, reply with a specific, natural title of AT MOST 5 " +
          "words that captures what the meeting was about. Use Title Case. No quotes, no trailing " +
          "punctuation, and do not start with the word \"Meeting\". Reply with the title only.",
      },
      { role: "user", content: "TRANSCRIPT:\n" + text },
    ],
    24,
    0.3,
  );
  return cleanTitle(raw);
}

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

// ── Detailed summary (multi-call) ──────────────────────────────────────────────
// The summary is assembled from several OpenAI calls, mirroring the structure of a
// NotebookLM-style briefing: (1) a one-line meeting classification + a rich
// narrative overview, (2) one thematic, per-participant breakdown per speaker, and
// (3) the action items organised BY OWNER (the "task tracking" view). The pieces are
// stitched into the light Markdown (bold **titles**, "- " bullets) that the
// dashboard, PDF, Word, and email renderers all understand.

// Every call gets the same guardrails: the transcript is auto-generated from mixed
// Hindi/English speech, so it carries speech-to-text errors — especially in proper
// nouns. The model must repair those from context and never invent anything.
const TRANSCRIPT_CAVEAT =
  "Work ONLY from the transcript — never invent names, numbers, decisions, deadlines, or owners. " +
  "The transcript is auto-generated from mixed Hindi/English speech and contains speech-to-text errors, " +
  "especially in proper nouns (people, companies, products, tools, clients): infer the most likely intended " +
  "spelling from context and use it consistently. Translate everything into clear, professional English.";

async function openaiChat(apiKey, model, messages, maxTokens, temperature = 0.2) {
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    throw new Error((data && data.error && data.error.message) || `HTTP ${upstream.status}`);
  }
  return String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "").trim();
}

// Distinct named speakers, most-talkative first (skips blank / "Unknown").
function distinctSpeakers(rows, max = 8) {
  const counts = new Map();
  for (const r of rows) {
    const s = String(r.speaker || "").trim();
    if (!s || s.toLowerCase() === "unknown") continue;
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([s]) => s);
}

async function generateDetailedSummary(rows, apiKey, model) {
  const transcript = buildTranscriptText(rows);
  const speakers = distinctSpeakers(rows);

  // 1) A one-line meeting classification + a rich, narrative overview.
  const overviewPromise = openaiChat(apiKey, model, [
    {
      role: "system",
      content:
        "You are an expert meeting analyst who writes crisp, information-dense briefings in the style of a top " +
        "research assistant. " + TRANSCRIPT_CAVEAT + " Use **bold** for emphasis and section titles; never use # headings.",
    },
    {
      role: "user",
      content:
        "Write two things from the meeting transcript:\n\n" +
        "1) ONE opening sentence that classifies the meeting and states its focus, with the meeting type in " +
        '**bold** — e.g. "This was an **Internal Operations & Dashboard Sync** focused on reviewing client ' +
        'dashboards and standardising customer reporting." No header before this sentence.\n\n' +
        "2) A blank line, then exactly this section:\n\n" +
        "**Meeting Summary**\n" +
        "A flowing 4–6 sentence narrative covering the context and purpose, the main topics with the specific " +
        "tools / products / dashboards / clients named, the key protocols or decisions established, and the " +
        "outcome. Prose, not bullets.\n\n" +
        "Output only those two parts.\n\nTRANSCRIPT:\n" + transcript,
    },
  ], 700);

  // 2) One thematic, per-participant breakdown per speaker (run in parallel).
  const perPersonPrompt = (name) => [
    {
      role: "system",
      content:
        "You summarize one participant's contribution to a meeting as tight, thematic notes, in your own words " +
        "from the transcript only — never quote or transcribe. " + TRANSCRIPT_CAVEAT + " Keep every specific " +
        "(features, tools, numbers, clients, decisions, deadlines); cut filler. Use **bold** only for the short " +
        "label that opens each bullet.",
    },
    {
      role: "user",
      content:
        `Summarize everything ${name} contributed, grouped by theme.\n\n` +
        "Style:\n" +
        "- Format every bullet exactly as: - **<Theme>:** <note>\n" +
        "- <Theme> is a 1–3 word label naming the topic (e.g. Data Correction, CG Checklist, Storage Strategy, New Projects).\n" +
        "- Merge related remarks under one theme; one theme per bullet; keep the order they arose.\n" +
        "- Keep all substance — tools, numbers, clients, reasons, decisions — but drop pleasantries and hedging. " +
        "No quotes. Don't repeat the person's name.\n" +
        `- If ${name} barely spoke, a single bullet is fine.\n\n` +
        'Output: Markdown "- " bullets only. No heading, no preamble.\n\n' +
        "TRANSCRIPT:\n" + transcript,
    },
  ];

  let peoplePromise;
  if (speakers.length) {
    peoplePromise = Promise.all(
      speakers.map((name) =>
        openaiChat(apiKey, model, perPersonPrompt(name), 700)
          .then((notes) => ({ name, notes }))
          .catch((e) => ({ name, notes: `- (Notes unavailable: ${String((e && e.message) || e)})` }))
      )
    );
  } else {
    peoplePromise = openaiChat(
      apiKey,
      model,
      [
        { role: "system", content: "You write tight, thematic meeting notes from the transcript only; never quote or transcribe. " + TRANSCRIPT_CAVEAT },
        {
          role: "user",
          content:
            "In thematic note form, summarize what happened — group by topic, each bullet as - **<Theme>:** <note>, " +
            "in the order things arose. Keep every specific; no filler, no quotes.\n\nTRANSCRIPT:\n" + transcript,
        },
      ],
      900
    )
      .then((notes) => [{ name: "", notes }])
      .catch(() => [{ name: "", notes: "- (Notes unavailable)" }]);
  }

  // 3) The action items, organised BY OWNER — the task-tracking view.
  const todosPromise = openaiChat(apiKey, model, [
    {
      role: "system",
      content:
        "You extract the concrete action items from a meeting and organise them BY OWNER. " + TRANSCRIPT_CAVEAT +
        " Use **bold** for the owner sub-headers and for each task's short label.",
    },
    {
      role: "user",
      content:
        "List the actionable to-dos from the transcript, grouped by the person responsible.\n\n" +
        "Format:\n" +
        "- For each owner, a sub-header line on its own: **For <Name>:**\n" +
        "- Under it, one or more bullets, each exactly: - **<Task>:** <specific action, including any deadline, " +
        "client, or condition stated>.\n" +
        "- <Task> is a 1–4 word label. Keep tasks concrete; include timing verbatim when stated (e.g. by tonight, " +
        "before Thursday's call, 9 PM daily).\n" +
        "- Separate each owner group with a blank line. Order owners by how much they were assigned; include only " +
        "people actually given tasks.\n" +
        "- If the whole team was given a shared task, end with a **General Team Requirement** sub-header and its bullet(s).\n" +
        "- If no action items were recorded at all, output exactly: - None recorded.\n\n" +
        "Start directly with the first **For <Name>:** line — no other heading, no preamble.\n\n" +
        "TRANSCRIPT:\n" + transcript,
    },
  ], 1100);

  const [overviewMd, people, todosMd] = await Promise.all([overviewPromise, peoplePromise, todosPromise]);

  let md = String(overviewMd || "").trim();
  if (speakers.length) {
    md += "\n\n**Discussion by Person**";
    for (const p of people) md += `\n\n**${p.name}**\n${String(p.notes || "").trim()}`;
  } else {
    md += `\n\n**Detailed Discussion**\n${String((people[0] && people[0].notes) || "").trim()}`;
  }
  const todos = String(todosMd || "").trim();
  if (todos) md += `\n\n**Actionable To-Dos**\n\n${todos}`;
  return md.trim();
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
      // Authorize per-meeting: if this client is an owner of the meeting in
      // meeting_owners they may read ALL of its transcript rows (co-viewers see
      // the whole meeting, not just their own rows); otherwise fall back to the
      // legacy per-row owner_email match for meetings not yet mirrored.
      const email = normalizeEmail(ownerScope);
      res = await env.DB.prepare(
        "SELECT start_time, text, speaker FROM transcriptions " +
        "WHERE meeting_id = ?2 AND (" +
        "EXISTS (SELECT 1 FROM meeting_owners WHERE meeting_id = ?2 AND owner_email = ?1) " +
        "OR owner_email = ?1) " +
        "ORDER BY start_time"
      ).bind(email, meetingId).all();
    }
  } catch (err) {
    return json({ error: "Failed to load the transcript", detail: String((err && err.message) || err) }, 500);
  }
  const rows = (res && res.results) || [];
  if (!rows.length) return json({ error: "No transcript found for that meeting yet" }, 404);

  const model = env.OPENAI_MODEL || "gpt-4o";
  // A summary request runs the richer multi-call pipeline (overview + decisions,
  // then detailed per-person notes) for far more depth than a single call.
  if (summarize) {
    // A meeting is summarized ONCE and the result is cached server-side, keyed by
    // meeting_id (a meeting's transcript is identical for every co-owner). Every
    // user who opens the meeting then sees the exact same summary and we never pay
    // to re-summarize. The dashboard's Refresh button sends force:true to
    // regenerate and overwrite the cache. Authorization already happened above
    // (an unauthorized user gets 0 rows → 404 before reaching this point).
    const cacheKey = summaryCacheKey(meetingId);
    const titleKey = titleCacheKey(meetingId);
    const force = !!body.force;
    // A real name — the bot backend's own D1 `meetings.name` (never AI-generated),
    // else the client-sent calendar_name (synced from the browser's own calendar)
    // — is authoritative: D1 wins when both exist. Either way it's persisted as
    // the meeting's title, overwriting any AI title minted before it was known,
    // and an AI title is never minted once a real one exists.
    const d1Name = (await d1MeetingNames(env, [meetingId]))[meetingId] || "";
    const realName = d1Name || String(body.calendar_name || "").trim();
    const hasName = !!realName || !!body.has_name;
    if (!force && env.KV) {
      try {
        const cached = await env.KV.get(cacheKey);
        if (cached) {
          let title = realName;
          try {
            if (realName) {
              await env.KV.put(titleKey, realName);
            } else {
              // Summary is cached; return the stored title too. If this meeting was
              // summarized before titles existed, mint one now (once) so it still
              // gets a name — but never for a meeting that already has a real name.
              title = (await env.KV.get(titleKey)) || "";
              if (!title && !hasName) {
                title = await generateMeetingTitle(rows, apiKey, model);
                if (title) await env.KV.put(titleKey, title);
              }
            }
          } catch {
            /* title is best-effort */
          }
          return json({ ok: true, reply: cached, title: title || undefined, cached: true });
        }
      } catch {
        /* KV hiccup — fall through and generate fresh */
      }
    }
    try {
      // Summary + a short display title are minted together (title generation is
      // best-effort — a title failure must never sink the summary). A meeting
      // with a real name (D1 or calendar) stores THAT instead of minting one.
      const [reply, title] = await Promise.all([
        generateDetailedSummary(rows, apiKey, model),
        hasName ? Promise.resolve(realName) : generateMeetingTitle(rows, apiKey, model).catch(() => ""),
      ]);
      if (env.KV) {
        try {
          await env.KV.put(cacheKey, reply);
        } catch {
          /* best-effort cache write — still return the summary we just made */
        }
        if (title) {
          try {
            await env.KV.put(titleKey, title);
          } catch {
            /* best-effort */
          }
        }
      }
      return json({ ok: true, reply, title: title || undefined });
    } catch (err) {
      return json({ error: "AI request failed", detail: String((err && err.message) || err) }, 502);
    }
  }

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
  // Chat opened with no user message yet: seed with a quick per-person breakdown.
  if (messages.length === 1) {
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

// Best-effort epoch-ms parse of a created_at value, which may be an ISO string
// (with or without a trailing Z/offset), a SQLite datetime ("YYYY-MM-DD
// HH:MM:SS", always UTC — this backend never stores a zone on it), or epoch ms
// already. Returns 0 (never NaN, never throws) when unparseable, so callers can
// use it directly in a max()/comparison without a separate guard.
//
// A bare `new Date(raw)` is NOT safe for the zone-less formats: V8 parses a
// SQLite-style "YYYY-MM-DD HH:MM:SS" (space, no "Z") as LOCAL time rather than
// UTC, so on any host whose local zone isn't UTC (local `wrangler dev`, a test
// runner, or a future non-Workers host) that parse would silently produce the
// WRONG instant — production Workers happen to run in UTC, which is the only
// reason a naive parse could look fine there. Every zone-less input is
// normalized to an explicit "...Z" before parsing so the result never depends
// on the host's local timezone.
function parseCreatedAt(createdAt) {
  const raw = String(createdAt || "").trim();
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? 0 : d.getTime();
  }
  const normalized = raw.includes(" ") ? raw.replace(" ", "T") : raw;
  const withTime = /T\d{2}:\d{2}/.test(normalized) ? normalized : `${normalized}T00:00:00`;
  const d = new Date(`${withTime}Z`);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

// Builds a combined, length-bounded transcript across MANY meetings, each under
// a "Meeting <id>" header, newest meetings first. Used by the weekly per-person
// rollup so the model can reason across the whole week.
function buildMultiMeetingText(rows, maxChars = 42000) {
  const byMeeting = new Map();
  for (const r of rows) {
    const id = String(r.meeting_id);
    if (!byMeeting.has(id)) byMeeting.set(id, []);
    byMeeting.get(id).push(r);
  }
  // created_at desc per meeting → newest meetings first. Compared as parsed
  // epoch values, not raw strings: created_at can be an ISO string, a SQLite
  // datetime ("YYYY-MM-DD HH:MM:SS"), or epoch ms depending on which insert
  // path wrote the row, and a lexical string compare across mixed formats can
  // put a genuinely later meeting before an earlier one (e.g. the "T" in an
  // ISO string sorts differently than the space in a SQLite datetime at the
  // same position) — comparing real epoch values is format-agnostic.
  const order = [...byMeeting.entries()].sort((a, b) => {
    const la = a[1].reduce((m, r) => Math.max(m, parseCreatedAt(r.created_at) || 0), 0);
    const lb = b[1].reduce((m, r) => Math.max(m, parseCreatedAt(r.created_at) || 0), 0);
    return lb - la;
  });
  let out = "";
  for (const [id, segs] of order) {
    segs.sort((a, b) => (Number(a.start_time) || 0) - (Number(b.start_time) || 0));
    let block = `\n=== Meeting ${id} ===\n`;
    for (const s of segs) block += `${s.speaker || "Unknown"}: ${s.text || ""}\n`;
    if (out.length + block.length > maxChars) {
      out += block.slice(0, Math.max(0, maxChars - out.length));
      out += "\n…[transcripts truncated]…\n";
      break;
    }
    out += block;
  }
  return out.trim();
}

// Per-person weekly rollup. Loads every transcript the signed-in user can see
// (own rows; all rows for admin), then reconciles each participant's
// structured to-do items against whatever meetings haven't been processed yet
// — see the reconcile engine above. The OpenAI key stays a server-side secret.
// Same ACL as /api/transcripts.
async function handleWeeklyPeople(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  const apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
  if (!apiKey) return json({ error: "AI isn't configured (set the OPENAI_API_KEY secret)" }, 503);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);

  let res;
  try {
    if (session.isAdmin) {
      res = await env.DB.prepare(
        "SELECT meeting_id, start_time, text, speaker, created_at FROM transcriptions ORDER BY meeting_id, start_time"
      ).all();
    } else {
      // Same visibility rule as /api/transcripts: meetings owned via
      // meeting_owners, plus legacy owner_email rows for un-mirrored meetings.
      const email = normalizeEmail(session.identity);
      res = await env.DB.prepare(
        "SELECT meeting_id, start_time, text, speaker, created_at FROM transcriptions " +
        "WHERE meeting_id IN (SELECT meeting_id FROM meeting_owners WHERE owner_email = ?1) " +
        "OR owner_email = ?1 " +
        "ORDER BY meeting_id, start_time"
      ).bind(email).all();
    }
  } catch (err) {
    return json({ error: "Failed to load transcripts", detail: String((err && err.message) || err) }, 500);
  }
  const rows = (res && res.results) || [];
  if (!rows.length) return json({ ok: true, people: [] });

  // Persist reconciled state per user, keyed by which meetings have already
  // been folded in — a normal revisit with no new meetings is instant and
  // free (aging-only, no AI call). The page's "Regenerate" button sends
  // force:true to re-reconcile everything from scratch.
  const body = await request.json().catch(() => ({}));
  const force = !!(body && body.force);
  const cacheKey = `weekly:people:v2:${weeklyScopeEmail(session)}`;
  let state = { peopleByKey: {}, processedMeetingIds: [] };
  if (env.KV) {
    try {
      const cached = await env.KV.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && typeof parsed === "object") {
          state = { peopleByKey: parsed.peopleByKey || {}, processedMeetingIds: parsed.processedMeetingIds || [] };
        }
      }
    } catch {
      state = { peopleByKey: {}, processedMeetingIds: [] };
    }
  }

  const now = Date.now();
  const processed = new Set(force ? [] : state.processedMeetingIds);
  const newRows = rows.filter((r) => !processed.has(String(r.meeting_id)));

  if (!newRows.length) {
    const people = Object.values(state.peopleByKey)
      .map((p) => {
        const items = applyAging(p.items || [], now);
        const derived = deriveRollup(items, now);
        return { name: p.name, overall: p.overall || "", accomplished: derived.accomplished, todo: derived.todo, items };
      })
      .filter((p) => p.overall || p.accomplished.length || p.todo.length);
    return json({ ok: true, people, cached: true });
  }

  const model = env.OPENAI_MODEL || "gpt-4o";
  try {
    const priorItemsByName = {};
    for (const p of Object.values(state.peopleByKey)) {
      priorItemsByName[p.name] = (p.items || []).filter((it) => it.status === "open");
    }
    const newMeetingText = buildMultiMeetingText(newRows);
    const decisions = await reconcileItems(priorItemsByName, newMeetingText, apiKey, model);
    const decisionByKey = new Map(decisions.map((d) => [personKey(d.name), d]));
    const newMeetingIds = [...new Set(newRows.map((r) => String(r.meeting_id)))];
    const repMeetingId = newMeetingIds[newMeetingIds.length - 1];

    const keys = new Set([...Object.keys(state.peopleByKey), ...decisions.map((d) => personKey(d.name))]);
    const nextPeopleByKey = {};
    for (const key of keys) {
      const prior = state.peopleByKey[key];
      const priorItems = (prior && prior.items) || [];
      const decision = decisionByKey.get(key) || {
        name: prior && prior.name,
        overall: prior && prior.overall,
        reaffirm: [],
        complete: [],
        cancel: [],
        new: [],
      };
      const displayName = decision.name || (prior && prior.name) || key;
      const items = applyReconcile(priorItems, decision, { meetingId: repMeetingId, now, slug: slugifyName(displayName) });
      nextPeopleByKey[key] = { name: displayName, overall: decision.overall || (prior && prior.overall) || "", items };
    }

    const nextProcessed = [...processed, ...newMeetingIds];
    if (env.KV) {
      try {
        await env.KV.put(
          cacheKey,
          JSON.stringify({ peopleByKey: nextPeopleByKey, processedMeetingIds: nextProcessed, generatedAt: now })
        );
      } catch {
        /* best-effort persist */
      }
    }

    const people = Object.values(nextPeopleByKey)
      .map((p) => {
        const derived = deriveRollup(p.items, now);
        return { name: p.name, overall: p.overall, accomplished: derived.accomplished, todo: derived.todo, items: p.items };
      })
      .filter((p) => p.overall || p.accomplished.length || p.todo.length);
    return json({ ok: true, people });
  } catch (err) {
    return json({ error: "AI request failed", detail: String((err && err.message) || err) }, 502);
  }
}

/* ------------------------------ structured to-do reconcile engine ------------------------------ */
// Replaces "regenerate the whole rollup from scratch every tick" with an
// incremental reconcile: each tick, only the transcript text from meetings not
// yet processed for a person is shown to the model, together with that
// person's current OPEN items (id/text/priority/dueDate). The model returns
// explicit decisions (reaffirm / complete / cancel / new) instead of a fresh
// free-text list, so an item's identity survives across ticks, "done" requires
// transcript evidence, and an item that simply isn't mentioned again is aged
// (missCount) rather than silently vanishing. The legacy `accomplished`/`todo`
// string arrays (the shape the UI and the public API already understand) are
// DERIVED from these structured items — see deriveRollup — so existing
// renderers and the external API keep working unchanged.

const TODO_STALE_MISS_CAP = 6; // ticks open w/o reaffirmation before eligible for staleness auto-drop
const TODO_STALE_MIN_AGE_MS = 90 * 24 * 60 * 60 * 1000; // ...and only once this old
const TODO_RECENT_DONE_MS = 30 * 24 * 60 * 60 * 1000; // "accomplished" window shown in the derived view

function mintTodoId(slug) {
  return `${slug || "item"}-${crypto.randomUUID().slice(0, 8)}`;
}

function todayIso(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function personKey(name) {
  return String(name || "").trim().toLowerCase();
}

// Pure — recomputes `overdue` and applies the long-horizon staleness drop. Runs
// every tick (even the AI-free fast path) so overdue flags never go stale.
function applyAging(items, now) {
  const today = todayIso(now);
  return items.map((it) => {
    if (it.status !== "open") return { ...it, overdue: false };
    const stale =
      (it.missCount || 0) >= TODO_STALE_MISS_CAP &&
      !it.dueDate &&
      now - it.firstSeenAt >= TODO_STALE_MIN_AGE_MS;
    if (stale) {
      return {
        ...it,
        status: "dropped",
        overdue: false,
        evidence: it.evidence || "Auto-archived: not mentioned in any meeting for a long time.",
      };
    }
    return { ...it, overdue: !!(it.dueDate && it.dueDate < today) };
  });
}

// Pure — applies one reconcile decision (from reconcileItems) onto a person's
// prior item list. Every status change carries evidence or an explicit reason;
// an item that isn't mentioned this tick is left `open` with missCount bumped,
// never silently dropped.
function applyReconcile(priorItems, decision, ctx) {
  const { meetingId, now, slug } = ctx;
  const byId = new Map(priorItems.map((it) => [it.id, it]));
  const touched = new Set();

  for (const id of (decision && decision.reaffirm) || []) {
    const it = byId.get(id);
    if (!it) continue;
    touched.add(id);
    byId.set(id, { ...it, lastSeenAt: now, missCount: 0 });
  }
  for (const c of (decision && decision.complete) || []) {
    const it = byId.get(c && c.id);
    if (!it) continue;
    touched.add(it.id);
    byId.set(it.id, {
      ...it,
      status: "done",
      lastSeenAt: now,
      missCount: 0,
      completedMeetingId: meetingId,
      completedAt: now,
      evidence: String((c && c.evidence) || "").trim() || it.evidence,
    });
  }
  for (const c of (decision && decision.cancel) || []) {
    const it = byId.get(c && c.id);
    if (!it) continue;
    touched.add(it.id);
    byId.set(it.id, {
      ...it,
      status: "dropped",
      lastSeenAt: now,
      missCount: 0,
      evidence: String((c && c.evidence) || "").trim() || it.evidence,
    });
  }
  for (const it of priorItems) {
    if (it.status !== "open" || touched.has(it.id)) continue;
    byId.set(it.id, { ...it, missCount: (it.missCount || 0) + 1 });
  }
  for (const n of (decision && decision.new) || []) {
    const text = String((n && n.text) || "").trim();
    if (!text) continue;
    const priority = ["high", "medium", "low"].includes(n && n.priority) ? n.priority : "medium";
    const dueDate = n && n.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(n.dueDate) ? n.dueDate : null;
    const id = mintTodoId(slug);
    byId.set(id, {
      id,
      text,
      status: "open",
      priority,
      dueDate,
      owner: (decision && decision.name) || "",
      firstSeenMeetingId: meetingId,
      firstSeenAt: now,
      lastSeenAt: now,
      missCount: 0,
    });
  }

  return applyAging([...byId.values()], now);
}

// Upgrades a pre-reconcile record (plain todo/accomplished strings, no
// structured items) into seeded TodoItems, so switching a person over to this
// scheme loses nothing already on screen.
function seedItemsFromLegacy(record, now) {
  const seenAt = (record && record.updatedAt) || now;
  const slug = (record && record.slug) || "";
  const owner = (record && record.name) || "";
  const open = ((record && record.todo) || []).map((text) => ({
    id: mintTodoId(slug),
    text: String(text),
    status: "open",
    priority: "medium",
    dueDate: null,
    owner,
    firstSeenMeetingId: "",
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    missCount: 0,
  }));
  const done = ((record && record.accomplished) || []).map((text) => ({
    id: mintTodoId(slug),
    text: String(text),
    status: "done",
    priority: "medium",
    dueDate: null,
    owner,
    firstSeenMeetingId: "",
    firstSeenAt: seenAt,
    lastSeenAt: seenAt,
    completedAt: seenAt,
    missCount: 0,
  }));
  return [...open, ...done];
}

// Derives the legacy `{ todo, accomplished }` string-array view the UI, public
// API, and downstream weekly synthesis already understand from the structured
// items — open items sorted overdue-first then by priority/due date;
// "accomplished" shows recent completions so the card doesn't grow forever.
function deriveRollup(items, now) {
  const priorityRank = { high: 0, medium: 1, low: 2 };
  const todo = items
    .filter((it) => it.status === "open")
    .sort((a, b) => {
      if (!!a.overdue !== !!b.overdue) return a.overdue ? -1 : 1;
      const pr = (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1);
      if (pr) return pr;
      if (a.dueDate && b.dueDate) return a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0;
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return (b.firstSeenAt || 0) - (a.firstSeenAt || 0);
    })
    .map((it) => it.text);
  const accomplished = items
    .filter((it) => it.status === "done" && now - (it.completedAt || 0) <= TODO_RECENT_DONE_MS)
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    .map((it) => it.text);
  return { todo, accomplished };
}

// One JSON model call that reconciles NEW transcript evidence against each
// person's current OPEN items instead of re-deriving everyone's whole list.
// `priorItemsByName` maps a person's display name -> their open items
// (id/text/priority/dueDate); an absent/empty entry is fine for someone with no
// prior state. `focusName` restricts the reconcile to one person (used by the
// tracked-people cron); omit it to reconcile everyone the new transcripts
// actually surface (used by the weekly per-person rollup, which tracks the
// whole team rather than a curated roster).
async function reconcileItems(priorItemsByName, newMeetingText, apiKey, model, focusName) {
  const priorList = Object.entries(priorItemsByName).map(([name, items]) => ({
    name,
    openItems: items.map((it) => ({ id: it.id, text: it.text, priority: it.priority, dueDate: it.dueDate })),
  }));
  const focusInstruction = focusName
    ? `Only report on "${focusName}" (match case-insensitively, tolerate speech-to-text misspellings) — ignore ` +
      "everyone else, even if they have prior open items listed below."
    : "Report on every person who actually spoke or was substantively discussed in the NEW TRANSCRIPTS below.";
  const messages = [
    {
      role: "system",
      content:
        "You maintain a per-person action-item tracker across a team's meetings. You are given each person's " +
        "CURRENT OPEN ITEMS (from earlier meetings) and NEW TRANSCRIPT excerpts the tracker hasn't seen yet. " +
        "Reconcile — do not restate. Use ONLY what the new transcripts support; never invent names, tasks, or " +
        "outcomes. Respond with STRICT JSON only.",
    },
    {
      role: "user",
      content:
        "PRIOR STATE (each person's current open items, with stable ids):\n" +
        JSON.stringify(priorList) +
        "\n\nNEW TRANSCRIPTS (not yet reconciled):\n" + newMeetingText +
        "\n\n" + focusInstruction + "\n" +
        "For each relevant person, return an object with:\n" +
        '- "name": their name exactly as it appears in the transcript (match to an existing PRIOR STATE name ' +
        "when it's clearly the same person, even with spelling differences).\n" +
        '- "overall": one or two sentences on their current role / focus (an updated version of any prior summary).\n' +
        '- "reaffirm": ids from their prior open items that are still pending, unchanged by this new evidence.\n' +
        '- "complete": [{"id","evidence"}] — prior open items the new transcripts show were FINISHED. "evidence" ' +
        "is a short quote or paraphrase proving it, not a guess.\n" +
        '- "cancel": [{"id","evidence"}] — prior open items explicitly dropped / no longer needed, with evidence.\n' +
        '- "new": [{"text","priority":"high"|"medium"|"low","dueDate":"YYYY-MM-DD"|null}] — concrete NEW action ' +
        "items for this person that do not already match a prior item (if it's the same task reworded, put its " +
        "id in reaffirm instead of duplicating it here). Infer dueDate only when a real date or day is stated; " +
        "otherwise null.\n" +
        "A prior open item not mentioned in the new transcripts at all should be left out of every list — do not " +
        "reaffirm items you have no new evidence for, and do not invent an id.\n" +
        'Return JSON of the exact shape: {"people":[{"name":"","overall":"","reaffirm":[],"complete":[],' +
        '"cancel":[],"new":[]}]}. Omit a person entirely if the new transcripts say nothing about them.',
    },
  ];
  const parsed = await openaiJson(apiKey, model, messages, 1800);
  return Array.isArray(parsed && parsed.people)
    ? parsed.people
        .map((p) => ({
          name: String((p && p.name) || "").trim(),
          overall: String((p && p.overall) || "").trim(),
          reaffirm: Array.isArray(p && p.reaffirm) ? p.reaffirm.map((x) => String(x)) : [],
          complete: Array.isArray(p && p.complete)
            ? p.complete.map((c) => ({ id: String((c && c.id) || ""), evidence: String((c && c.evidence) || "").trim() }))
            : [],
          cancel: Array.isArray(p && p.cancel)
            ? p.cancel.map((c) => ({ id: String((c && c.id) || ""), evidence: String((c && c.evidence) || "").trim() }))
            : [],
          new: Array.isArray(p && p.new)
            ? p.new.map((n) => ({ text: String((n && n.text) || "").trim(), priority: n && n.priority, dueDate: n && n.dueDate }))
            : [],
        }))
        .filter((p) => p.name)
    : [];
}

/* ------------------------------ weekly master summary ("summary of summaries") ------------------------------ */
// The Weekly Summary is a synthesis ACROSS a week's meetings — a summary built on
// the individual meeting summaries. The per-meeting detailed summaries are already
// generated and cached in KV (summary:v2:<id>) by /api/ai and the auto-summary
// cron; this endpoint reads those, feeds them to one model call, and produces the
// cross-meeting narrative (overview + thematic key points + open questions). The
// result is persisted per USER, per WEEK (weekly:summary:v1:<email>:<weekKey>), so
// once a week's summary exists it is served as-is on every later visit and is
// NEVER regenerated on a normal load — only an explicit Refresh (force) rebuilds
// it. The [n] citations reuse the client's source order (each meeting carries its
// 1-based `index`) so they line up with the on-screen "Sources" list.

// KV key for a user's saved weekly master summary for one week bucket. Admin's
// all-meetings view is scoped under "__admin".
function weeklySummaryKey(scopeEmail, week) {
  return `weekly:summary:v1:${scopeEmail}:${week}`;
}

// The email (or admin marker) a weekly summary / per-person rollup is saved under.
function weeklyScopeEmail(session) {
  return session.isAdmin ? "__admin" : normalizeEmail(session.identity);
}

// A JSON-mode OpenAI call — like openaiChat, but forces a strict-JSON response and
// returns the parsed object (or {} on unparseable output). Used by the weekly
// synthesis, which needs structured overview / themes / questions back.
async function openaiJson(apiKey, model, messages, maxTokens) {
  const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: maxTokens, response_format: { type: "json_object" } }),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error((data && data.error && data.error.message) || `HTTP ${upstream.status}`);
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "{}";
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

// Load the cached detailed summary for each requested meeting the caller may see.
// `meetings` is [{ meeting_id, owner?, index? }] in the client's source order.
// Admin sees every meeting; a normal user must own the meeting (same ACL as
// /api/ai). Meetings with no cached summary yet are skipped (the weekly is a
// summary OF summaries — it never re-transcribes). Returns
// [{ index, meetingId, title, summary }], deduped, capped by the caller.
async function loadWeeklyMeetingSummaries(env, session, meetings) {
  const out = [];
  const seen = new Set();
  for (const m of meetings) {
    const meetingId = String((m && m.meeting_id) || "").trim();
    if (!meetingId || seen.has(meetingId)) continue;
    seen.add(meetingId);
    if (!session.isAdmin) {
      const email = normalizeEmail(session.identity);
      try {
        const owns = await env.DB.prepare(
          "SELECT 1 FROM transcriptions WHERE meeting_id = ?2 AND (" +
          "EXISTS (SELECT 1 FROM meeting_owners WHERE meeting_id = ?2 AND owner_email = ?1) " +
          "OR owner_email = ?1) LIMIT 1"
        ).bind(email, meetingId).all();
        if (!owns.results || !owns.results.length) continue;
      } catch {
        continue; // one bad lookup shouldn't sink the batch
      }
    }
    let summary = "";
    try {
      summary = (await env.KV.get(summaryCacheKey(meetingId))) || "";
    } catch {
      /* KV hiccup — treat as no summary */
    }
    if (!summary.trim()) continue;
    let title = "";
    try {
      title = (await env.KV.get(titleCacheKey(meetingId))) || "";
    } catch {
      /* title is best-effort */
    }
    const index = Number(m && m.index);
    out.push({
      index: Number.isFinite(index) && index > 0 ? index : out.length + 1,
      meetingId,
      title: (title && title.trim()) || `Meeting ${meetingId}`,
      summary: summary.trim(),
    });
  }
  return out;
}

// The cross-meeting synthesis call. Feeds each meeting's cached summary (numbered
// [n] for citations) to the model and asks for a structured weekly briefing.
// Returns the WeeklyAi shape the client merges over its deterministic base
// (quantTable / episodeReadouts stay empty — they're podcast-only modules).
async function synthesizeWeekly(sources, range, apiKey, model) {
  const MAX = 42000;
  let text = "";
  let used = 0;
  for (const s of sources) {
    const block = `\n[${s.index}] ${s.title}\n${s.summary}\n`;
    if (text.length + block.length > MAX) {
      text += `\n…[${sources.length - used} more meeting summaries omitted]…\n`;
      break;
    }
    text += block;
    used++;
  }
  const messages = [
    {
      role: "system",
      content:
        "You are an expert chief-of-staff who writes a team's WEEKLY MASTER BRIEFING by synthesizing across " +
        "several individual meeting summaries — a summary of summaries. Work ONLY from the summaries provided; " +
        "never invent names, decisions, numbers, or owners. Each summary is numbered like [1], [2]; cite the " +
        "source meeting(s) for every claim with those bracketed numbers. Group insights by THEME across " +
        "meetings, not meeting-by-meeting. Write clear, professional English. Respond with STRICT JSON only.",
    },
    {
      role: "user",
      content:
        `Produce the weekly cross-meeting synthesis${range ? ` for ${range}` : ""} from the ${sources.length} ` +
        "meeting summaries below.\n\n" +
        "Return a JSON object with EXACTLY these keys:\n" +
        '- "overview": an array of 2-4 paragraph strings — the narrative of the week: the main workstreams, how ' +
        "they progressed, the key decisions, and where things stand. Weave in [n] citations.\n" +
        '- "keyThemes": an array (max 6) of {"heading": string, "points": string[]}. Each heading is a short ' +
        'theme, decision area, or workstream (e.g. "Product & Dashboard", "Key Decisions", "Risks & Blockers"). ' +
        "Each point is a concrete, claim-first bullet that ends with its [n] citation(s). Include a " +
        '"Key Decisions" cluster, and — when the meetings surface them — a "Risks & Blockers" cluster.\n' +
        '- "questions": an array (max 6) of the open questions / unresolved items across the week.\n\n' +
        "Keep every specific — people, projects, tools, clients, numbers, deadlines. Omit a section (empty " +
        "array) rather than pad it. Return JSON of the exact shape: " +
        '{"overview":[],"keyThemes":[{"heading":"","points":[]}],"questions":[]}.\n\n' +
        "MEETING SUMMARIES:\n" + text,
    },
  ];
  const parsed = await openaiJson(apiKey, model, messages, 2000);
  const overview = Array.isArray(parsed.overview)
    ? parsed.overview.map((p) => String(p || "").trim()).filter(Boolean)
    : [];
  const keyThemes = Array.isArray(parsed.keyThemes)
    ? parsed.keyThemes
        .map((t) => ({
          heading: String((t && t.heading) || "").trim(),
          points: Array.isArray(t && t.points) ? t.points.map((p) => String(p || "").trim()).filter(Boolean) : [],
        }))
        .filter((t) => t.heading && t.points.length)
    : [];
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions.map((q) => String(q || "").trim()).filter(Boolean)
    : [];
  return { overview, keyThemes, quantTable: [], episodeReadouts: [], questions };
}

// POST /api/weekly/summary — build (or return the saved) weekly master summary for
// the signed-in user and a week bucket. Body: { week, range?, force?, meetings:
// [{ meeting_id, owner?, index? }] }. Returns { ok, cached, ai, usedCount,
// skipped, generatedAt, meetingIds }. `ai` is null when none of the week's
// meetings have a summary yet (the UI keeps its deterministic edition then).
async function handleWeeklySummary(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  const apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
  if (!apiKey) return json({ error: "AI isn't configured (set the OPENAI_API_KEY secret)" }, 503);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);
  if (!env.KV) return json({ error: "Storage is not connected yet" }, 503);

  const body = await request.json().catch(() => ({}));
  const week = String(body.week || "all").trim() || "all";
  const range = String(body.range || "").trim();
  const force = !!body.force;
  const meetings = Array.isArray(body.meetings) ? body.meetings.slice(0, 40) : [];

  const scopeEmail = weeklyScopeEmail(session);
  const cacheKey = weeklySummaryKey(scopeEmail, week);

  // Once a week's summary exists for this user it is served as-is — never
  // regenerated on a normal visit. Only an explicit Refresh (force) rebuilds it.
  if (!force) {
    try {
      const cached = await env.KV.get(cacheKey);
      if (cached) return json({ ok: true, cached: true, ...JSON.parse(cached) });
    } catch {
      /* fall through and rebuild */
    }
  }

  const sources = await loadWeeklyMeetingSummaries(env, session, meetings);
  if (!sources.length) {
    return json({ ok: true, cached: false, ai: null, usedCount: 0, skipped: meetings.length, generatedAt: null });
  }

  let ai;
  try {
    ai = await synthesizeWeekly(sources, range, apiKey, env.OPENAI_MODEL || "gpt-4o");
  } catch (err) {
    return json({ error: "AI request failed", detail: String((err && err.message) || err) }, 502);
  }

  const payload = {
    ai,
    usedCount: sources.length,
    skipped: meetings.length - sources.length,
    generatedAt: Date.now(),
    meetingIds: sources.map((s) => s.meetingId),
  };
  try {
    await env.KV.put(cacheKey, JSON.stringify(payload));
  } catch {
    /* best-effort persist — still return what we just built */
  }
  return json({ ok: true, cached: false, ...payload });
}

// POST /api/weekly/meetings — peek the already-cached detailed summary for each
// requested meeting the caller may see, WITHOUT generating anything. Body:
// { meetings: [{ meeting_id, owner? }] }. Lets the Weekly page hydrate its episode
// model from the summaries the auto-summary cron (or prior opens) already made, so
// the weekly populates without the user opening every meeting one by one. No
// OpenAI key needed — it only reads what's cached.
async function handleWeeklyMeetings(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);
  if (!env.KV) return json({ error: "Storage is not connected yet" }, 503);

  const body = await request.json().catch(() => ({}));
  const meetings = Array.isArray(body.meetings) ? body.meetings.slice(0, 80) : [];
  const sources = await loadWeeklyMeetingSummaries(env, session, meetings);
  return json({
    ok: true,
    summaries: sources.map((s) => ({ meeting_id: s.meetingId, title: s.title, summary: s.summary })),
  });
}

// Flatten a saved WeeklyAi into plain text, so the chat can ground its answers on
// the master synthesis as well as the raw meeting summaries.
function weeklyAiToText(ai) {
  if (!ai || typeof ai !== "object") return "";
  const parts = [];
  const overview = Array.isArray(ai.overview) ? ai.overview : [];
  if (overview.length) parts.push("OVERVIEW:\n" + overview.join("\n\n"));
  for (const t of Array.isArray(ai.keyThemes) ? ai.keyThemes : []) {
    if (!t) continue;
    const points = Array.isArray(t.points) ? t.points : [];
    parts.push(`${t.heading || "Theme"}:\n` + points.map((p) => `- ${p}`).join("\n"));
  }
  const questions = Array.isArray(ai.questions) ? ai.questions : [];
  if (questions.length) parts.push("OPEN QUESTIONS:\n" + questions.map((q) => `- ${q}`).join("\n"));
  return parts.join("\n\n");
}

// The grounding context for the weekly chat: the master synthesis (when saved)
// plus the individual meeting summaries, length-bounded so a big week stays a
// single model call.
function buildWeeklyChatContext(sources, master) {
  const MAX = 40000;
  let out = "";
  if (master) out += "WEEKLY MASTER SUMMARY:\n" + master + "\n\n";
  out += "MEETING SUMMARIES:\n";
  let used = 0;
  for (const s of sources) {
    const block = `\n=== ${s.title} ===\n${s.summary}\n`;
    if (out.length + block.length > MAX) {
      out += `\n…[${sources.length - used} more meeting summaries omitted]…\n`;
      break;
    }
    out += block;
    used++;
  }
  return out.trim();
}

// POST /api/weekly/chat — free-form Q&A grounded on a week's meeting summaries
// (and the saved master summary). Body: { week, meetings: [{ meeting_id, owner? }],
// messages: [{ role, content }] }. Same per-meeting ACL as /api/ai.
async function handleWeeklyChat(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  const apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
  if (!apiKey) return json({ error: "AI isn't configured (set the OPENAI_API_KEY secret)" }, 503);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);
  if (!env.KV) return json({ error: "Storage is not connected yet" }, 503);

  const body = await request.json().catch(() => ({}));
  const week = String(body.week || "all").trim() || "all";
  const meetings = Array.isArray(body.meetings) ? body.meetings.slice(0, 40) : [];
  const clientMessages = Array.isArray(body.messages) ? body.messages : [];

  const sources = await loadWeeklyMeetingSummaries(env, session, meetings);
  let master = "";
  try {
    const cached = await env.KV.get(weeklySummaryKey(weeklyScopeEmail(session), week));
    if (cached) master = weeklyAiToText(JSON.parse(cached).ai);
  } catch {
    /* master is optional extra grounding */
  }
  if (!sources.length && !master) {
    return json({ error: "No summarized meetings for this week yet — analyse some meetings first." }, 404);
  }

  const messages = [
    {
      role: "system",
      content:
        "You are a helpful assistant that answers questions about a team's week of meetings. You are given a " +
        "weekly master summary and the individual meeting summaries it was built from. Answer ONLY from that " +
        "material; if something isn't covered, say so briefly. Prefer short paragraphs and bullet points, and " +
        "never invent names, numbers, decisions, or owners.\n\n" + buildWeeklyChatContext(sources, master),
    },
  ];
  for (const m of clientMessages.slice(-12)) {
    const role = m && m.role === "assistant" ? "assistant" : "user";
    const content = String((m && m.content) || "").slice(0, 4000);
    if (content) messages.push({ role, content });
  }
  if (messages.length === 1) {
    messages.push({ role: "user", content: "Give me a concise recap of this week across all the meetings." });
  }

  try {
    const reply = await openaiChat(apiKey, env.OPENAI_MODEL || "gpt-4o", messages, 800, 0.3);
    return json({ ok: true, reply });
  } catch (err) {
    return json({ error: "AI request failed", detail: String((err && err.message) || err) }, 502);
  }
}

/* ------------------------------ people tracking (admin) ------------------------------ */
// Admin picks a set of people to "track" (a name from any meeting's speaker
// list, or one typed manually for someone who's only ever mentioned). For each
// tracked person the cron below maintains a durable, auto-updating rollup —
// what they've done, what's next — mined from every meeting where they spoke
// OR were mentioned by someone else. Selection lives in KV (small, admin-only,
// no D1 write access needed); rollups are regenerated wholesale per person
// (not incrementally patched) so they stay internally consistent. A denormalized
// blob (tracking:public) is rebuilt after each regen pass so the external,
// key-gated API can serve it with a single cheap KV read.

const TRACKING_SELECTION_KEY = "tracking:selection";
const TRACKING_PUBLIC_KEY = "tracking:public";
const TRACKING_WATERMARK_KEY = "tracking:watermark";
const SUMMARY_SNAPSHOT_KEY = "summary:snapshot";
const SUMMARY_LOCK_KEY = "cron:lock:summary";
const TRACKING_LOCK_KEY = "cron:lock:tracking";
const LOCK_TTL_SECONDS = 120; // > the 60s cron cadence, so an overrun tick blocks the next one
const MAX_TRACKED = 25;
const AUTO_SUMMARY_BATCH = 2; // meetings summarized per cron tick
const TRACKING_REGEN_INTERVAL_MS = 15 * 60 * 1000; // re-check tracked people at most this often
// Coarse daily ceiling on background generation units (1 meeting summary = 1
// unit, 1 person regen = 1 unit) — a cost safety net, not the primary rate
// limiter (the lock + per-tick batch cap + regen interval already do that).
const DAILY_AI_BUDGET = 300;

function trackingPersonKey(slug) {
  return `tracking:person:${slug}`;
}

// Drops Unicode combining marks (U+0300-U+036F) left behind by NFKD
// normalization, e.g. turning "é" (NFKD: "e" + combining acute) into "e".
function stripCombiningMarks(s) {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0) || 0;
    if (code >= 0x0300 && code <= 0x036f) continue;
    out += ch;
  }
  return out;
}

// Lowercase, whitespace-collapsed, diacritic-stripped, URL-safe key for a
// person's KV record — display casing is kept inside the record itself.
function slugifyName(name) {
  const cleaned = stripCombiningMarks(String(name || "").normalize("NFKD"))
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  return cleaned.replace(/[^a-z0-9 ]/g, "").trim().replace(/ /g, "-");
}

// Escapes SQL LIKE metacharacters so a name search matches the literal name,
// not a wildcard pattern the name happens to contain.
function escapeLike(s) {
  return String(s || "").replace(/[\\%_]/g, "\\$&");
}

async function readTrackingSelection(env) {
  try {
    const raw = await env.KV.get(TRACKING_SELECTION_KEY);
    if (!raw) return { names: [], updatedAt: 0 };
    const parsed = JSON.parse(raw);
    return { names: Array.isArray(parsed.names) ? parsed.names : [], updatedAt: parsed.updatedAt || 0 };
  } catch {
    return { names: [], updatedAt: 0 };
  }
}

// A short-lived KV "lease" so the once-a-minute cron can't run two overlapping
// heavy (OpenAI-calling) passes if a prior tick is still in flight. Not a true
// atomic compare-and-swap (KV has none), but adequate at this cadence/TTL.
async function acquireLock(env, key) {
  const existing = await env.KV.get(key);
  if (existing) return false;
  await env.KV.put(key, String(Date.now()), { expirationTtl: LOCK_TTL_SECONDS });
  return true;
}

async function releaseLock(env, key) {
  try {
    await env.KV.delete(key);
  } catch {
    /* best-effort */
  }
}

async function withinDailyBudget(env, cost) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `tracking:budget:${day}`;
  let used = 0;
  try {
    used = Number((await env.KV.get(key)) || 0);
  } catch {
    used = 0;
  }
  if (used + cost > DAILY_AI_BUDGET) return false;
  if (cost > 0) {
    try {
      await env.KV.put(key, String(used + cost), { expirationTtl: 60 * 60 * 26 });
    } catch {
      /* best-effort */
    }
  }
  return true;
}

// Every distinct named speaker across every meeting — feeds the admin people
// picker. Free-text diarization labels: drops blanks and "Unknown"/"Speaker N"
// placeholders, but otherwise trusts whatever the transcript pipeline produced.
async function handleTrackingDirectory(request, env) {
  const session = await getSession(request, env);
  if (!session || !session.isAdmin) return json({ error: "Forbidden" }, 403);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);
  let res;
  try {
    res = await env.DB.prepare(
      "SELECT DISTINCT speaker FROM transcriptions WHERE speaker IS NOT NULL AND TRIM(speaker) <> '' ORDER BY speaker"
    ).all();
  } catch (err) {
    return json({ error: "Failed to load speakers", detail: String((err && err.message) || err) }, 500);
  }
  const names = ((res && res.results) || [])
    .map((r) => String(r.speaker || "").trim())
    .filter((s) => s && !/^unknown$/i.test(s) && !/^speaker\s*\d+$/i.test(s));
  return json({ ok: true, people: [...new Set(names)] });
}

// Current tracked selection plus each person's latest stored rollup (or a
// pending placeholder for a just-added name the cron hasn't reached yet).
async function handleGetTracking(request, env) {
  const session = await getSession(request, env);
  if (!session || !session.isAdmin) return json({ error: "Forbidden" }, 403);
  const selection = await readTrackingSelection(env);
  const people = await Promise.all(
    selection.names.map(async (name) => {
      const slug = slugifyName(name);
      let stored = null;
      if (slug && env.KV) {
        try {
          const raw = await env.KV.get(trackingPersonKey(slug));
          stored = raw ? JSON.parse(raw) : null;
        } catch {
          stored = null;
        }
      }
      return (
        stored || { name, slug, overall: "", accomplished: [], todo: [], meetingCount: 0, pending: true, updatedAt: null }
      );
    })
  );
  let watermark = null;
  try {
    const raw = await env.KV.get(TRACKING_WATERMARK_KEY);
    watermark = raw ? JSON.parse(raw) : null;
  } catch {
    watermark = null;
  }
  return json({ ok: true, selection: selection.names, people, watermark });
}

// Persists the tracked-people selection. Returns immediately — it does NOT
// call OpenAI inline (a synchronous regen of a whole tracked roster can take
// 30-90s and blow past client timeouts). Newly-added names are seeded as
// `pending`; the cron below fills in real rollups on its next pass.
async function handleSaveTracking(request, env) {
  const session = await getSession(request, env);
  if (!session || !session.isAdmin) return json({ error: "Forbidden" }, 403);
  const body = await request.json().catch(() => ({}));
  const raw = Array.isArray(body.names) ? body.names : [];

  const seen = new Set();
  const names = [];
  for (const n of raw) {
    const trimmed = String(n || "").trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(trimmed);
    if (names.length >= MAX_TRACKED) break;
  }

  await env.KV.put(TRACKING_SELECTION_KEY, JSON.stringify({ names, updatedAt: Date.now() }));

  for (const name of names) {
    const slug = slugifyName(name);
    if (!slug) continue;
    const key = trackingPersonKey(slug);
    const existing = await env.KV.get(key);
    if (!existing) {
      await env.KV.put(
        key,
        JSON.stringify({ name, slug, overall: "", accomplished: [], todo: [], meetingCount: 0, pending: true, updatedAt: null })
      );
    }
  }

  return json({ ok: true, selection: names });
}

// Admin-only "Tracked People" weekly section: buckets each tracked person's
// already-reconciled structured items (see the reconcile engine above) into a
// week's completed / newly-opened / carried-over-and-overdue view. Pure
// bucketing over state the cron already computed — no OpenAI call, so it's
// instant and free every time the Weekly page is opened. Body:
// { weekStartMs, weekEndMs }.
async function handleWeeklyTracking(request, env) {
  const session = await getSession(request, env);
  if (!session || !session.isAdmin) return json({ error: "Forbidden" }, 403);
  if (!env.KV) return json({ error: "Storage isn't connected yet" }, 503);
  const body = await request.json().catch(() => ({}));
  const weekStart = Number(body && body.weekStartMs) || 0;
  const weekEnd = Number(body && body.weekEndMs) || Date.now();

  const selection = await readTrackingSelection(env);
  const people = await Promise.all(
    selection.names.map(async (name) => {
      const slug = slugifyName(name);
      let stored = null;
      try {
        const raw = slug ? await env.KV.get(trackingPersonKey(slug)) : null;
        stored = raw ? JSON.parse(raw) : null;
      } catch {
        stored = null;
      }
      const items = stored && Array.isArray(stored.items) ? stored.items : [];
      const completedThisWeek = items
        .filter((it) => it.status === "done" && it.completedAt >= weekStart && it.completedAt <= weekEnd)
        .map((it) => it.text);
      const openedThisWeek = items
        .filter((it) => it.status === "open" && it.firstSeenAt >= weekStart && it.firstSeenAt <= weekEnd)
        .map((it) => it.text);
      const carriedOverdue = items.filter((it) => it.status === "open" && it.overdue).map((it) => it.text);
      return { name, slug, completedThisWeek, openedThisWeek, carriedOverdue };
    })
  );
  return json({
    ok: true,
    weekStart,
    weekEnd,
    people: people.filter((p) => p.completedThisWeek.length || p.openedThisWeek.length || p.carriedOverdue.length),
  });
}

// Every row where a person is the speaker OR is mentioned by name in someone
// else's line — this is how a meeting that only *discusses* a tracked person
// (never has them speak) still surfaces evidence about them. The speaker match
// is the precise, primary signal — compared case/whitespace-insensitively
// (LOWER+TRIM on both sides) so diarization drift ("John Smith" vs
// "john smith " across meetings) doesn't silently drop a person's own
// meetings. (D1's SQLite has no ICU extension, so LOWER() only folds ASCII —
// a name with accented characters diarized with different casing, e.g. "José"
// vs "JOSÉ", still won't match; that's unfixed here.) The LIKE mention is
// secondary and deliberately permissive (the reconcile prompt is told to use
// only what the transcript actually supports, so a meeting that merely
// name-drops the person yields no new items rather than a hallucinated one).
async function personTranscriptRows(env, name) {
  const like = escapeLike(name);
  const res = await env.DB.prepare(
    "SELECT meeting_id, start_time, text, speaker, created_at FROM transcriptions " +
    "WHERE LOWER(TRIM(speaker)) = LOWER(TRIM(?1)) OR text LIKE '%' || ?2 || '%' ESCAPE '\\' " +
    "ORDER BY meeting_id, start_time"
  ).bind(name, like).all();
  return (res && res.results) || [];
}

// Cheap check for whether a person has any transcript evidence not yet folded
// into their stored rollup — lets the cron skip the AI reconcile call (and its
// budget cost) for people with nothing new to report this tick.
async function personHasNewEvidence(env, name, prior) {
  let rows;
  try {
    rows = await personTranscriptRows(env, name);
  } catch {
    return true; // fail open — let the full reconcile path raise/handle the error
  }
  if (!rows.length) return false;
  const processed = new Set((prior && prior.processedMeetingIds) || []);
  return rows.some((r) => !processed.has(String(r.meeting_id)));
}

// Incrementally updates one tracked person's rollup: only the transcript rows
// from meetings not yet in `prior.processedMeetingIds` are shown to the model,
// reconciled against their current open items (see reconcileItems above). A
// legacy record (pre-upgrade, plain todo/accomplished strings) is seeded into
// structured items first so nothing already on screen is lost.
async function rollupForPerson(env, name, prior, apiKey, model, now) {
  let rows;
  try {
    rows = await personTranscriptRows(env, name);
  } catch (err) {
    throw new Error(`Failed to load transcripts for ${name}: ${String((err && err.message) || err)}`);
  }
  const slug = (prior && prior.slug) || slugifyName(name);
  const priorItems =
    prior && Array.isArray(prior.items) && prior.items.length ? prior.items : seedItemsFromLegacy(prior, now);
  const processed = new Set((prior && prior.processedMeetingIds) || []);
  const meetingCount = new Set(rows.map((r) => String(r.meeting_id))).size;
  const newRows = rows.filter((r) => !processed.has(String(r.meeting_id)));

  if (!newRows.length) {
    return {
      overall: (prior && prior.overall) || "",
      items: applyAging(priorItems, now),
      meetingCount,
      processedMeetingIds: [...processed],
    };
  }

  const newMeetingText = buildMultiMeetingText(newRows);
  const openByName = { [name]: priorItems.filter((it) => it.status === "open") };
  const decisions = await reconcileItems(openByName, newMeetingText, apiKey, model, name);
  const decision = decisions[0] || {
    name,
    overall: (prior && prior.overall) || "",
    reaffirm: [],
    complete: [],
    cancel: [],
    new: [],
  };
  const newMeetingIds = [...new Set(newRows.map((r) => String(r.meeting_id)))];
  const nextProcessed = new Set([...processed, ...newMeetingIds]);
  const items = applyReconcile(priorItems, decision, { meetingId: newMeetingIds[newMeetingIds.length - 1], now, slug });
  return {
    overall: decision.overall || (prior && prior.overall) || "",
    items,
    meetingCount,
    processedMeetingIds: [...nextProcessed],
  };
}

// Cron pass 1: gradually summarizes the whole meeting history AND every new
// meeting, without ever caching a summary of a still-recording meeting. A
// meeting is "settled" when its transcript segment count hasn't grown since
// the previous tick — this needs only an integer COUNT(*), never a parse of
// created_at (whose exact format is owned by an external, unmirrored backend).
async function runAutoSummaries(env) {
  const apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
  if (!apiKey || !env.DB || !env.KV) return;
  if (!(await acquireLock(env, SUMMARY_LOCK_KEY))) return;
  try {
    let res;
    try {
      res = await env.DB.prepare("SELECT meeting_id, COUNT(*) AS n FROM transcriptions GROUP BY meeting_id").all();
    } catch {
      return;
    }
    const rows = (res && res.results) || [];
    if (!rows.length) return;

    let snapshot = {};
    try {
      const raw = await env.KV.get(SUMMARY_SNAPSHOT_KEY);
      if (raw) snapshot = JSON.parse(raw) || {};
    } catch {
      snapshot = {};
    }

    const settledUnsummarized = [];
    const nextSnapshot = {};
    for (const r of rows) {
      const id = String(r.meeting_id);
      const n = Number(r.n) || 0;
      nextSnapshot[id] = n;
      const settled = snapshot[id] !== undefined && snapshot[id] === n;
      if (settled && !(await env.KV.get(summaryCacheKey(id)))) settledUnsummarized.push(id);
    }
    // Persist the fresh snapshot every tick (even an empty-work tick) so the
    // next tick can still tell what's still growing.
    await env.KV.put(SUMMARY_SNAPSHOT_KEY, JSON.stringify(nextSnapshot));
    if (!settledUnsummarized.length) return;

    const model = env.OPENAI_MODEL || "gpt-4o";
    for (const meetingId of settledUnsummarized.slice(0, AUTO_SUMMARY_BATCH)) {
      if (!(await withinDailyBudget(env, 1))) break;
      try {
        let transcriptRes;
        try {
          transcriptRes = await env.DB.prepare(
            "SELECT start_time, text, speaker FROM transcriptions WHERE meeting_id = ?1 ORDER BY start_time"
          ).bind(meetingId).all();
        } catch {
          continue;
        }
        const transcriptRows = (transcriptRes && transcriptRes.results) || [];
        if (!transcriptRows.length) continue;
        // Re-check right before writing: an overlapping tick or a user opening
        // this meeting may have summarized it while we were working.
        if (await env.KV.get(summaryCacheKey(meetingId))) continue;
        // Title minting stays out of the cron: it has no session, so it can never
        // know whether a meeting already carries a real calendar name (only the
        // browser, via its signed-in user's calendar sync, knows that). Minting
        // one here would risk permanently overwriting a real name with an AI
        // guess. Titles are only ever minted in handleAiChat, where the client
        // supplies calendar_name when the meeting already has a real name.
        const summaryMd = await generateDetailedSummary(transcriptRows, apiKey, model);
        await env.KV.put(summaryCacheKey(meetingId), summaryMd);
      } catch {
        /* best-effort — move on to the next meeting */
      }
    }
  } finally {
    await releaseLock(env, SUMMARY_LOCK_KEY);
  }
}

// Cron pass 2: updates every tracked person's rollup, throttled so it only
// does per-person work when the transcript table has actually grown (a cheap
// COUNT(*) probe) or the throttle interval has elapsed (periodic refresh even
// if the count-based signal was missed). Within that window, a person only
// costs an AI call (and daily budget) when they actually have new transcript
// evidence to reconcile — everyone else just gets a free aging pass (overdue
// flags recomputed, no AI). Rebuilds the public blob afterward from each
// person's latest stored record — including ones skipped this tick by the
// budget cap — so the external API never regresses to older data.
async function runTrackingRollups(env) {
  const apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
  if (!apiKey || !env.DB || !env.KV) return;
  const selection = await readTrackingSelection(env);
  if (!selection.names.length) return;
  if (!(await acquireLock(env, TRACKING_LOCK_KEY))) return;
  try {
    let countRes;
    try {
      countRes = await env.DB.prepare("SELECT COUNT(*) AS n FROM transcriptions").all();
    } catch {
      return;
    }
    const n = Number((countRes && countRes.results && countRes.results[0] && countRes.results[0].n) || 0);

    let watermark = { n: -1, lastRegenAt: 0 };
    try {
      const raw = await env.KV.get(TRACKING_WATERMARK_KEY);
      if (raw) watermark = { ...watermark, ...JSON.parse(raw) };
    } catch {
      /* use default */
    }

    const now = Date.now();
    const dataChanged = n !== watermark.n;
    const throttleElapsed = now - (watermark.lastRegenAt || 0) >= TRACKING_REGEN_INTERVAL_MS;
    if (!dataChanged && !throttleElapsed) return;

    const model = env.OPENAI_MODEL || "gpt-4o";
    for (const name of selection.names) {
      const slug = slugifyName(name);
      if (!slug) continue;
      let prior = null;
      try {
        const raw = await env.KV.get(trackingPersonKey(slug));
        prior = raw ? JSON.parse(raw) : null;
      } catch {
        prior = null;
      }

      let hasNewEvidence = true;
      try {
        hasNewEvidence = await personHasNewEvidence(env, name, prior);
      } catch {
        hasNewEvidence = true;
      }
      if (!hasNewEvidence) {
        if (prior && Array.isArray(prior.items) && prior.items.length) {
          const items = applyAging(prior.items, now);
          const derived = deriveRollup(items, now);
          await env.KV.put(
            trackingPersonKey(slug),
            JSON.stringify({
              name,
              slug,
              overall: prior.overall || "",
              accomplished: derived.accomplished,
              todo: derived.todo,
              items,
              processedMeetingIds: prior.processedMeetingIds || [],
              meetingCount: prior.meetingCount || 0,
              updatedAt: prior.updatedAt || now,
            })
          );
        }
        continue;
      }

      if (!(await withinDailyBudget(env, 1))) break;
      try {
        const result = await rollupForPerson(env, name, prior, apiKey, model, now);
        const derived = deriveRollup(result.items, now);
        await env.KV.put(
          trackingPersonKey(slug),
          JSON.stringify({
            name,
            slug,
            overall: result.overall,
            accomplished: derived.accomplished,
            todo: derived.todo,
            items: result.items,
            processedMeetingIds: result.processedMeetingIds,
            meetingCount: result.meetingCount,
            updatedAt: now,
          })
        );
      } catch {
        /* best-effort — leave this person's previous rollup in place */
      }
    }

    const allRecords = await Promise.all(
      selection.names.map(async (name) => {
        const slug = slugifyName(name);
        if (!slug) return null;
        try {
          const raw = await env.KV.get(trackingPersonKey(slug));
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      })
    );
    const publicPeople = allRecords
      .filter(Boolean)
      .map((r) => ({ name: r.name, overall: r.overall, accomplished: r.accomplished, todo: r.todo }));
    await env.KV.put(TRACKING_PUBLIC_KEY, JSON.stringify({ generatedAt: now, people: publicPeople }));
    await env.KV.put(TRACKING_WATERMARK_KEY, JSON.stringify({ n, lastRegenAt: now }));
  } finally {
    await releaseLock(env, TRACKING_LOCK_KEY);
  }
}

const TRACKING_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, X-API-Key, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function handleTrackingPreflight() {
  return new Response(null, { status: 204, headers: TRACKING_CORS_HEADERS });
}

// External read-only API for another dashboard: any caller holding
// TRACKING_API_KEY can pull the tracked-people list. Never triggers
// generation — reads the pre-built tracking:public blob only, so it's cheap
// and can't be abused into extra AI spend. `*` origin is fine here because
// auth is a bearer/key header, not a cookie; Allow-Credentials must never be
// paired with it.
async function handlePublicTracking(request, env) {
  if (!env.TRACKING_API_KEY) return json({ error: "Tracking API isn't configured" }, 503, TRACKING_CORS_HEADERS);
  const authHeader = request.headers.get("Authorization") || "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const apiKeyHeader = (request.headers.get("X-API-Key") || "").trim();
  const provided = bearer || apiKeyHeader;
  if (!provided || !timingSafeEqual(provided, env.TRACKING_API_KEY)) {
    return json({ error: "Unauthorized" }, 401, TRACKING_CORS_HEADERS);
  }
  let data = { generatedAt: null, people: [] };
  try {
    const raw = await env.KV.get(TRACKING_PUBLIC_KEY);
    if (raw) data = JSON.parse(raw);
  } catch {
    /* corrupt cache — serve the safe default rather than error */
  }
  return json({ ok: true, ...data }, 200, TRACKING_CORS_HEADERS);
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
    const base = calendarApiBase(env);
    const upstream = await fetch(base + "/calendar/sync", {
      method: "POST",
      headers: { "X-API-Key": env.API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: session.identity }),
    });
    const result = await readUpstreamJson(upstream);
    // A revoked/expired Google grant comes back from the calendar service as a 5xx
    // whose detail points at oauth2.googleapis.com/token / invalid_grant. That's not
    // a server fault — the user just needs to re-authorize — so normalize it into
    // the same "needs connect" shape the not-connected case uses (a connect_url the
    // dashboard turns into a Reconnect prompt) instead of a dead-end 502.
    if (!upstream.ok && isReauthNeeded(result)) {
      return json({
        ok: true,
        status: upstream.status,
        result: {
          connected: false,
          connect_url: calendarConnectEndpoint(env),
          detail: "Calendar authorization expired — reconnect your Google Calendar to keep syncing.",
          upstream_detail: reauthDetail(result),
        },
      });
    }
    return json({ ok: upstream.ok, status: upstream.status, result }, upstream.ok ? 200 : 502);
  } catch (err) {
    return json({ error: "Failed to reach the calendar service", detail: String((err && err.message) || err) }, 502);
  }
}

// The stringified detail of an upstream calendar error, wherever it lives.
function reauthDetail(result) {
  const s =
    result && typeof result === "object"
      ? String(result.detail || result.error || result.raw || "")
      : String(result || "");
  return s.slice(0, 300);
}

// True when a failed /calendar/sync is a Google-authorization problem (revoked or
// expired grant) rather than a server/gateway fault — i.e. the user should be sent
// back through OAuth. Deliberately NARROW so a genuine 5xx (gateway "error code:
// 502", a missing system API key, etc.) still surfaces as an error, not a reconnect.
function isReauthNeeded(result) {
  return /invalid_grant|oauth2\.googleapis|refresh token|re-?authori|reconnect|revoked|token (?:expired|invalid)|unauthorized_client/i.test(
    reauthDetail(result)
  );
}

// GET /api/calendar/connect — starts the calendar Google-auth flow. This is a
// top-level browser navigation (the "Connect calendar" button), so it redirects
// straight to the calendar service's connect-start page, which runs the Google
// OAuth dance in the browser (consent → callback) and links the calendar.
//
// The email comes from the SESSION (never the client) so the connected calendar
// is tied to the right account. This HTTPS host (default port) is the calendar
// service — the same origin the server-side sync / meetings calls now use
// (calendarApiBase), set via CALENDAR_CONNECT_ENDPOINT.
async function handleCalendarConnect(request, env) {
  const appRoot = new URL("/", request.url).toString();
  const session = await getSession(request, env);
  // Browser navigation, not an XHR — bounce back to the app (which shows the
  // login screen) instead of returning a bare 401.
  if (!session || session.isAdmin) return Response.redirect(appRoot, 302);

  const base = calendarConnectEndpoint(env);
  const target =
    base + (base.includes("?") ? "&" : "?") + "email=" + encodeURIComponent(session.identity);
  return Response.redirect(target, 302);
}

// Resolves which email a calendar call should run as. A normal user always
// acts as themselves. An admin has no calendar of their own — they must name a
// target user via ?email= (GET) or body.email (POST); returns null (and the
// caller should 400) when admin passes nothing usable.
function calendarActingEmail(request, session, body) {
  if (!session.isAdmin) return session.identity;
  const raw = body ? body.email : new URL(request.url).searchParams.get("email");
  const email = normalizeEmail(raw);
  return email || null;
}

// GET /calendar/meetings?email=<acting email>. A normal user always acts as
// themselves; an admin must pass ?email=<user> to view that user's calendar.
async function handleCalendarMeetings(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  const email = calendarActingEmail(request, session);
  if (!email) return json({ error: session.isAdmin ? "email is required" : "Admin accounts have no calendar" }, session.isAdmin ? 400 : 403);
  if (!env.API_KEY) return json({ error: "Server is missing the API_KEY secret" }, 500);
  try {
    const base = calendarApiBase(env);
    const includeCancelled = new URL(request.url).searchParams.get("include_cancelled") === "true";
    const target =
      base + "/calendar/meetings?email=" + encodeURIComponent(email) +
      (includeCancelled ? "&include_cancelled=true" : "");
    const upstream = await fetch(target, { headers: { "X-API-Key": env.API_KEY } });
    const calendar = await readUpstreamJson(upstream);
    return json({ ok: upstream.ok, status: upstream.status, calendar }, upstream.ok ? 200 : 502);
  } catch (err) {
    return json({ error: "Failed to reach the calendar service", detail: String((err && err.message) || err) }, 502);
  }
}

// POST /calendar/meetings/remove {email, event_id} — removes a scheduled/upcoming
// calendar meeting so the bot won't (or no longer will) join it. The event_id
// comes from the calendar_events array; email is the acting user's — the
// session's own for a normal user, or an admin-supplied target for admin.
async function handleCalendarRemove(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (!env.API_KEY) return json({ error: "Server is missing the API_KEY secret" }, 500);
  const body = await request.json().catch(() => ({}));
  const eventId = body.event_id;
  if (eventId === undefined || eventId === null || eventId === "") {
    return json({ error: "event_id is required" }, 400);
  }
  const email = calendarActingEmail(request, session, body);
  if (!email) return json({ error: session.isAdmin ? "email is required" : "Admin accounts have no calendar" }, session.isAdmin ? 400 : 403);
  try {
    const base = calendarApiBase(env);
    const upstream = await fetch(base + "/calendar/meetings/remove", {
      method: "POST",
      headers: { "X-API-Key": env.API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, event_id: eventId }),
    });
    const result = await readUpstreamJson(upstream);
    return json({ ok: upstream.ok, status: upstream.status, result }, upstream.ok ? 200 : 502);
  } catch (err) {
    return json({ error: "Failed to reach the calendar service", detail: String((err && err.message) || err) }, 502);
  }
}

// POST /calendar/meetings/restore {email, event_id} — flips a removed meeting
// (cancelled -> pending) so the bot will auto-join it again. A restore of a
// meeting that wasn't removed comes back as a 200 "noop".
async function handleCalendarRestore(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (!env.API_KEY) return json({ error: "Server is missing the API_KEY secret" }, 500);
  const body = await request.json().catch(() => ({}));
  const eventId = body.event_id;
  if (eventId === undefined || eventId === null || eventId === "") {
    return json({ error: "event_id is required" }, 400);
  }
  const email = calendarActingEmail(request, session, body);
  if (!email) return json({ error: session.isAdmin ? "email is required" : "Admin accounts have no calendar" }, session.isAdmin ? 400 : 403);
  try {
    const base = calendarApiBase(env);
    const upstream = await fetch(base + "/calendar/meetings/restore", {
      method: "POST",
      headers: { "X-API-Key": env.API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, event_id: eventId }),
    });
    const result = await readUpstreamJson(upstream);
    return json({ ok: upstream.ok, status: upstream.status, result }, upstream.ok ? 200 : 502);
  } catch (err) {
    return json({ error: "Failed to reach the calendar service", detail: String((err && err.message) || err) }, 502);
  }
}

/* ------------------------------ api head (admin) ------------------------------ */

// Read the current head: the effective base, whether it's an override, and the
// configured fallback it would revert to.
async function handleGetConfig(request, env) {
  const session = await getSession(request, env);
  if (!session || !session.isAdmin) return json({ error: "Forbidden" }, 403);
  const override = await env.KV.get(API_BASE_KEY);
  return json({
    ok: true,
    apiBase: override || fallbackApiBase(env),
    override: override || null,
    fallback: fallbackApiBase(env),
  });
}

// Set (or clear) the head. An empty value clears the override and reverts to the
// configured fallback. A value is normalized to its origin (any path stripped).
async function handleSetConfig(request, env) {
  const session = await getSession(request, env);
  if (!session || !session.isAdmin) return json({ error: "Forbidden" }, 403);
  const body = await request.json().catch(() => ({}));
  const raw = String(body.apiBase || "").trim();
  if (!raw) {
    await env.KV.delete(API_BASE_KEY);
    return json({ ok: true, apiBase: fallbackApiBase(env), override: null, fallback: fallbackApiBase(env) });
  }
  let origin;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
    origin = u.origin;
  } catch {
    return json({ error: "Enter a valid http(s) URL, e.g. https://name.trycloudflare.com" }, 400);
  }
  await env.KV.put(API_BASE_KEY, origin);
  return json({ ok: true, apiBase: origin, override: origin, fallback: fallbackApiBase(env) });
}

// Hidden admin page to view/change the API head. Returns 404 for non-admins so
// it stays out of sight; admins reach it at /__apihead after signing in.
async function handleApiHeadPage(request, env) {
  const session = await getSession(request, env);
  if (!session || !session.isAdmin) return new Response("Not found", { status: 404 });
  return html(apiHeadPage());
}

function apiHeadPage() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>API head — admin</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;padding:24px}
  .card{width:100%;max-width:560px;background:#1e293b;border:1px solid #334155;border-radius:14px;padding:28px;box-shadow:0 12px 40px rgba(0,0,0,.35)}
  h1{margin:0 0 4px;font-size:20px}
  .sub{margin:0 0 20px;color:#94a3b8;font-size:13px}
  label{display:block;font-size:13px;margin:14px 0 6px;color:#cbd5e1}
  input{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;border:1px solid #475569;background:#0f172a;color:#e2e8f0;font-size:14px}
  input:focus{outline:none;border-color:#38bdf8}
  .cur{font-size:13px;background:#0f172a;border:1px solid #334155;border-radius:9px;padding:12px;word-break:break-all}
  .cur b{color:#38bdf8}
  .tag{display:inline-block;margin-left:8px;font-size:11px;padding:1px 7px;border-radius:999px;font-weight:700;vertical-align:middle}
  .tag.ov{background:#38bdf8;color:#04263a}
  .tag.df{background:#334155;color:#cbd5e1}
  .rowb{display:flex;gap:10px;margin-top:18px}
  button{flex:1;padding:12px;border:0;border-radius:9px;font-weight:600;font-size:14px;cursor:pointer}
  .save{background:#38bdf8;color:#04263a}.save:hover{background:#7dd3fc}
  .reset{background:#475569;color:#e2e8f0}.reset:hover{background:#64748b}
  button:disabled{opacity:.6;cursor:not-allowed}
  .msg{margin-top:16px;padding:11px 12px;border-radius:9px;font-size:13px;display:none;word-break:break-word}
  .msg.err{display:block;background:#450a0a;border:1px solid #7f1d1d;color:#fecaca}
  .msg.ok{display:block;background:#052e16;border:1px solid #166534;color:#bbf7d0}
  .hint{font-size:12px;color:#64748b;margin-top:8px}
</style></head>
<body>
  <div class="card">
    <h1>API head</h1>
    <p class="sub">The backend base URL every notetaker / calendar call is sent to. Admin only. Changes take effect immediately — no redeploy.</p>
    <div class="cur" id="cur">Loading…</div>
    <label for="u">New base URL</label>
    <input id="u" type="url" placeholder="https://name.trycloudflare.com" autocomplete="off"/>
    <p class="hint">Just the host, e.g. http://65.1.101.15.nip.io:8080 or https://name.trycloudflare.com — any path is ignored.</p>
    <div class="rowb">
      <button class="save" id="save">Save</button>
      <button class="reset" id="reset">Reset to default</button>
    </div>
    <div class="msg" id="msg"></div>
  </div>
<script>
  var cur=document.getElementById('cur'),input=document.getElementById('u'),save=document.getElementById('save'),reset=document.getElementById('reset'),msg=document.getElementById('msg');
  function showMsg(t,k){msg.textContent=t;msg.className='msg'+(k?' '+k:'');}
  function renderCur(d){
    cur.innerHTML='';
    cur.appendChild(document.createTextNode('Currently calling: '));
    var b=document.createElement('b');b.textContent=d.apiBase||'(unknown)';cur.appendChild(b);
    var tag=document.createElement('span');tag.className='tag '+(d.override?'ov':'df');tag.textContent=d.override?'override':'default';cur.appendChild(tag);
    if(d.override&&d.fallback){var f=document.createElement('div');f.className='hint';f.textContent='Default if reset: '+d.fallback;cur.appendChild(f);}
  }
  async function load(){
    try{
      var res=await fetch('/api/config');
      if(res.status===401||res.status===403){cur.textContent='Admin only — sign in as ADMIN first, then reload this page.';return;}
      var d=await res.json().catch(function(){return{};});
      if(d.ok){renderCur(d);input.value=d.override||'';}else{cur.textContent=d.error||'Could not load.';}
    }catch(e){cur.textContent='Network error.';}
  }
  async function post(val){
    save.disabled=true;reset.disabled=true;showMsg('Saving…','');
    try{
      var res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiBase:val})});
      var d=await res.json().catch(function(){return{};});
      if(res.ok&&d.ok){renderCur(d);input.value=d.override||'';showMsg('Saved. Now calling '+d.apiBase,'ok');}
      else{showMsg(d.error||'Failed.','err');}
    }catch(e){showMsg('Network error.','err');}
    finally{save.disabled=false;reset.disabled=false;}
  }
  save.onclick=function(){var v=input.value.trim();if(!v){showMsg('Enter a URL, or use Reset to default.','err');return;}post(v);};
  reset.onclick=function(){post('');};
  load();
</script>
</body></html>`;
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

// Same as publicSchedule, plus the owner — admin's cross-user view needs to know
// whose schedule each row is so it can act (cancel) on the right owner's behalf.
function publicScheduleAdmin(s) {
  return { ...publicSchedule(s), owner: s.owner };
}

/* --------------------- schedules: D1 backend (opt-in) --------------------- */

// Schedules live in Cloudflare KV by default. Once the EC2 backend is ready to
// own scheduling — its own loop reads the shared D1 `schedules` table (in the
// same `vexa-transcript` DB this Worker already binds as env.DB) and dispatches
// the bot — set the SCHEDULES_BACKEND="d1" var. Then every dashboard
// create/list/cancel writes straight to D1, and this Worker's per-minute cron
// stops firing schedules so the bot is never double-sent. Default (unset/"kv")
// keeps the original KV behaviour, so flipping the var is the whole cutover and
// clearing it is the whole rollback. See docs/schedules-d1-migration.md for the
// table schema and the EC2 scheduler contract.
function schedulesOnD1(env) {
  return String(env.SCHEDULES_BACKEND || "").trim().toLowerCase() === "d1" && !!env.DB;
}

// Lazily create the schedules table (+ its lookup indexes) once per warm
// isolate. IF NOT EXISTS makes this idempotent and cheap to call on every write,
// so neither this Worker nor the EC2 side needs a hand-run migration.
let schedulesTableReady;
async function ensureSchedulesTable(env) {
  if (schedulesTableReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS schedules (" +
      "id TEXT PRIMARY KEY, owner TEXT NOT NULL, meeting_url TEXT NOT NULL, " +
      "recurrence TEXT NOT NULL, time_zone TEXT NOT NULL, hour INTEGER NOT NULL, " +
      "minute INTEGER NOT NULL, weekday INTEGER, next_run INTEGER NOT NULL, " +
      "created_at INTEGER NOT NULL, last_run INTEGER, last_status TEXT, " +
      "attempts INTEGER NOT NULL DEFAULT 0)"
  ).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_schedules_owner ON schedules(owner)").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run)").run();
  schedulesTableReady = true;
}

// A D1 row → the same internal shape the KV path produces, so publicSchedule /
// publicScheduleAdmin serialize it identically (the frontend can't tell which
// backend served it). next_run / created_at / last_run are epoch MILLISECONDS,
// matching Date.now() — the EC2 scheduler must use the same unit.
function scheduleFromRow(r) {
  return {
    id: r.id,
    owner: r.owner,
    meetingUrl: r.meeting_url,
    recurrence: r.recurrence,
    timeZone: r.time_zone,
    hour: r.hour,
    minute: r.minute,
    weekday: r.weekday,
    nextRun: r.next_run,
    createdAt: r.created_at,
    lastRun: r.last_run ?? null,
    lastStatus: r.last_status ?? null,
    attempts: r.attempts ?? 0,
  };
}

// Read schedules from D1, soonest first. No owner → every user's (admin view).
async function d1ListSchedules(env, owner) {
  await ensureSchedulesTable(env);
  const res = owner
    ? await env.DB.prepare("SELECT * FROM schedules WHERE owner = ?1 ORDER BY next_run ASC").bind(owner).all()
    : await env.DB.prepare("SELECT * FROM schedules ORDER BY next_run ASC").all();
  return ((res && res.results) || []).map(scheduleFromRow);
}

async function d1CountSchedulesFor(env, owner) {
  await ensureSchedulesTable(env);
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM schedules WHERE owner = ?1").bind(owner).first();
  return (row && row.n) || 0;
}

async function d1InsertSchedule(env, s, { orIgnore = false } = {}) {
  await ensureSchedulesTable(env);
  await env.DB.prepare(
    "INSERT " + (orIgnore ? "OR IGNORE " : "") +
      "INTO schedules (id, owner, meeting_url, recurrence, time_zone, hour, minute, weekday, next_run, created_at, last_run, last_status, attempts) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)"
  ).bind(
    s.id, s.owner, s.meetingUrl, s.recurrence, s.timeZone, s.hour, s.minute, s.weekday,
    s.nextRun, s.createdAt, s.lastRun ?? null, s.lastStatus ?? null, s.attempts ?? 0
  ).run();
}

// Owner-scoped delete: a normal user can only pass their own owner (enforced by
// the caller) and admin must name the owner — so the WHERE clause always pins
// both, never letting one user cancel another's by id alone.
async function d1DeleteSchedule(env, owner, id) {
  await ensureSchedulesTable(env);
  await env.DB.prepare("DELETE FROM schedules WHERE id = ?1 AND owner = ?2").bind(id, owner).run();
}

// GET /api/schedules — a normal user sees only their own. An admin sees every
// user's schedules (across owners), each tagged with its owner, optionally
// filtered to a single ?email= for a focused view.
async function handleListSchedules(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (schedulesOnD1(env)) {
    const raw = session.isAdmin ? new URL(request.url).searchParams.get("email") : session.identity;
    const owner = raw ? normalizeEmail(raw) : null;
    const schedules = await d1ListSchedules(env, owner);
    return json({ ok: true, schedules: schedules.map(session.isAdmin ? publicScheduleAdmin : publicSchedule) });
  }
  if (session.isAdmin) {
    const email = new URL(request.url).searchParams.get("email");
    const schedules = email
      ? await listSchedulesFor(env, normalizeEmail(email))
      : await readSchedules(env, SCHEDULE_PREFIX);
    return json({ ok: true, schedules: schedules.map(publicScheduleAdmin) });
  }
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

  const count = schedulesOnD1(env)
    ? await d1CountSchedulesFor(env, owner)
    : (await listSchedulesFor(env, owner)).length;
  if (count >= MAX_SCHEDULES_PER_USER) {
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
  if (schedulesOnD1(env)) {
    await d1InsertSchedule(env, schedule);
  } else {
    await env.KV.put(scheduleKey(owner, id), JSON.stringify(schedule));
  }
  return json({ ok: true, schedule: publicSchedule(schedule) }, 201);
}

async function handleDeleteSchedule(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  const body = await request.json().catch(() => ({}));
  const id = String(body.id || "").trim();
  if (!id) return json({ error: "Schedule id is required" }, 400);
  let owner;
  if (session.isAdmin) {
    // Admin cancels on a specific user's behalf — the owner must be supplied
    // (the schedule list echoes it back per row), never inferred.
    owner = normalizeEmail(body.owner);
    if (!owner) return json({ error: "owner is required" }, 400);
  } else {
    // Scoping to the session owner means a user can only ever delete their own.
    owner = session.identity;
  }
  if (schedulesOnD1(env)) {
    await d1DeleteSchedule(env, owner, id);
  } else {
    await env.KV.delete(scheduleKey(owner, id));
  }
  return json({ ok: true });
}

// POST /api/schedules/migrate-kv-to-d1 — admin-only, idempotent backfill. Copies
// every existing KV schedule into the D1 `schedules` table (INSERT OR IGNORE, so
// re-running is safe and never clobbers a row the EC2 scheduler has since
// advanced). KV is left intact, so the cutover stays reversible: run this, flip
// SCHEDULES_BACKEND to "d1", verify, and only then clear KV if you want. Requires
// env.DB regardless of the current flag, so it can be run before the flip.
//
// Lists+parses KV directly here (its own paginated env.KV.list loop) instead of
// the shared readSchedules() — that helper silently drops a corrupt entry with
// no record of which key it was, which is fine for the live read paths that
// call it but defeats a backfill's whole point: `failed` below names every raw
// KV key that didn't make it across (unparseable JSON, a missing required
// field, or a D1 insert error), so a human can go fix it by hand.
//
// Required fields are checked here, in JS, BEFORE the insert — not left to D1
// to enforce. `d1InsertSchedule` always inserts with OR IGNORE (so a re-run
// doesn't clobber a row the EC2 scheduler has since advanced), and under OR
// IGNORE a NOT NULL violation is not an error: SQLite completes the statement
// successfully with zero rows changed. A bare try/catch around the insert
// can't tell that apart from the (desired, silent) case of the row already
// existing from a prior run — so a schedule missing a required field would
// count as "migrated" while never actually landing in D1, with nothing in
// `failed` to say so.
function missingScheduleField(s) {
  if (!s || typeof s !== "object") return "not an object";
  if (!s.id) return "missing id";
  if (!s.owner) return "missing owner";
  if (!s.meetingUrl) return "missing meetingUrl";
  if (!s.recurrence) return "missing recurrence";
  if (!s.timeZone) return "missing timeZone";
  if (!Number.isFinite(s.hour)) return "missing/invalid hour";
  if (!Number.isFinite(s.minute)) return "missing/invalid minute";
  if (!Number.isFinite(s.nextRun)) return "missing/invalid nextRun";
  if (!Number.isFinite(s.createdAt)) return "missing/invalid createdAt";
  return null;
}

async function handleMigrateSchedulesToD1(request, env) {
  const session = await getSession(request, env);
  if (!session || !session.isAdmin) return json({ error: "Forbidden" }, 403);
  if (!env.DB) return json({ error: "D1 (env.DB) is not bound" }, 500);

  let found = 0;
  let migrated = 0;
  const failed = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: SCHEDULE_PREFIX, cursor });
    for (const k of page.keys) {
      found++;
      try {
        const raw = await env.KV.get(k.name);
        if (!raw) throw new Error("empty value");
        const s = JSON.parse(raw);
        const problem = missingScheduleField(s);
        if (problem) throw new Error(problem);
        await d1InsertSchedule(env, s, { orIgnore: true });
        migrated++;
      } catch (err) {
        failed.push({ key: k.name, error: String((err && err.message) || err) });
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return json({ ok: true, found, migrated, failed });
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
  // When schedules live on D1, the EC2 backend runs its own scheduler against
  // that table — this Worker cron must stand down, or every due meeting would
  // get a second bot. (The cron trigger still fires runAutoSummaries /
  // runTrackingRollups, which are unaffected.)
  if (schedulesOnD1(env)) return;
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

// SameSite=None (which requires Secure) so the cookie still works when this
// app is embedded as a cross-site iframe inside the Munshot host — a
// Strict/Lax cookie is silently dropped on requests made from a cross-site
// iframe context, even to the iframe's own same-origin API. The Origin check
// in the fetch handler above is the CSRF backstop this trades away.
function sessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${SESSION_TTL}`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=0`;
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

// A short numeric password-reset code: 5 digits (00000–99999), easy to read out
// of an email and type. It is never the account password — it only authorizes a
// password change — and it's single-use with a 15-minute expiry.
function generateResetCode() {
  // Uniform 0–99999, zero-padded to a fixed 5 digits (e.g. "04821"). The minute
  // modulo bias over a 32-bit draw is irrelevant for a one-off reset code.
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 100000;
  return String(n).padStart(5, "0");
}

// Send a plain-text email through the Muns raw email API. The bearer token is
// read from the MUNS_TOKEN secret (never hardcoded); callers must ensure it's
// set before calling. Throws on a non-2xx response so the caller can react.
async function sendMunsEmail(env, { email, subject, text }) {
  const res = await fetch("https://devde.muns.io/email/send/raw", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.MUNS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, subject, text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Muns email send failed (${res.status})${detail ? `: ${detail}` : ""}`);
  }
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

