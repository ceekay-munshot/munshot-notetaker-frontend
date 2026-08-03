import { bedrockModelConfig, bedrockChat, bedrockJson } from "./bedrock.js";

// Munshot Notetaker — Cloudflare Worker
// - KV-backed logins (one user = one `user:<email>` key)
// - KV-backed sessions via HttpOnly cookie
// - Admin login (username from env, password from the ADMIN_PASSWORD secret):
//   sees ALL users' transcripts
// - Join/leave the notetaker bot (email is taken from the session, never the body)
// - D1-backed transcripts view, scoped to the signed-in user (all rows for admin)
// - YouTube video transcripts (/api/youtube*), owned per user the same way:
//   each account sees only the videos it queued, admin sees every account's

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
// GET /youtube/<transcript_id> and /youtube/<transcript_id>.txt — the transcript
// API contract this Worker took over from EC2.
const YT_ROUTE_RE = /^\/youtube\/(\d+)(\.txt)?$/;

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
      if ((pathname.startsWith("/api/") || pathname === "/youtube" || pathname.startsWith("/youtube/")) && method !== "GET" && method !== "OPTIONS" && method !== "HEAD") {
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
      if (method === "GET" && pathname === "/api/recording") return handleRecording(request, env);
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
      if (method === "POST" && pathname === "/api/calendar/unsubscribe") return handleCalendarUnsubscribe(request, env);
      if (method === "GET" && pathname === "/api/version") return handleVersion();
      if (method === "GET" && pathname === "/api/config") return handleGetConfig(request, env);
      if (method === "POST" && pathname === "/api/config") return handleSetConfig(request, env);
      if (method === "GET" && pathname === "/api/youtube") return handleListVideos(request, env);
      if (method === "POST" && pathname === "/api/youtube") return handleCreateVideo(request, env);
      if (method === "GET" && pathname === "/api/youtube/video") return handleGetVideo(request, env);
      if (method === "POST" && pathname === "/api/youtube/delete") return handleDeleteVideo(request, env);
      if (method === "POST" && pathname === "/api/youtube/ai") return handleVideoAi(request, env);
      // The EC2 transcript API's own shape, served from here now (see the
      // YouTube transcripts section): POST /youtube, GET /youtube/<id>,
      // GET /youtube/<id>.txt. Callers written against that contract are
      // unchanged; the email is taken from the session, never the payload.
      if (method === "POST" && pathname === "/youtube") return handleTranscriptCreate(request, env);
      // POST, not GET: see handleTranscriptProbe. A GET falls through to the
      // 405 below, which is the honest answer for it.
      if (method === "POST" && pathname === "/youtube/probe") return handleTranscriptProbe(request, env);
      if (method === "GET" && YT_ROUTE_RE.test(pathname)) {
        const [, transcriptId, asText] = YT_ROUTE_RE.exec(pathname);
        return asText
          ? handleTranscriptText(request, env, transcriptId)
          : handleTranscriptGet(request, env, transcriptId);
      }
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
      // The transcript contract owns /youtube outright, for the same reason: a
      // malformed id, a trailing slash, or the wrong method would otherwise fall
      // through to the SPA and answer HTTP 200 with an HTML page, which a client
      // parsing JSON reads as either success or a parse error rather than the
      // 404/405 it actually is.
      if (pathname === "/youtube" || pathname.startsWith("/youtube/")) {
        const known =
          pathname === "/youtube" || pathname === "/youtube/probe" || YT_ROUTE_RE.test(pathname);
        return known
          ? json({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, 405)
          : json({ error: "Not found", code: "NOT_FOUND" }, 404);
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

// GET /api/recording?meeting_id=...&owner=... — proxies a meeting's recorded
// audio from the bot backend. Same per-meeting ACL as /api/ai (a normal user
// must own the meeting via meeting_owners or legacy owner_email; admin passes
// ?owner= to pick whose meeting, since meeting_id alone isn't unique across
// owners). Fetches GET {apiBase}/public/audio/{meeting_id} — same origin and
// same server-held X-API-Key as dispatchBot's /public/join and /public/leave
// (port 8056 hosted its own copy of this route but wasn't reliably reachable
// from Cloudflare's network; 8080 is proven to work), just a GET with no
// body. The audio bytes are streamed straight back to the browser; the API
// key never reaches the client.
async function handleRecording(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);
  if (!env.API_KEY) return json({ error: "Server is missing the API_KEY secret" }, 500);

  const url = new URL(request.url);
  const meetingId = String(url.searchParams.get("meeting_id") || "").trim();
  if (!meetingId) return json({ error: "Pick a meeting first" }, 400);
  const ownerScope = session.isAdmin ? String(url.searchParams.get("owner") || "").trim() : session.identity;

  try {
    let owns;
    if (session.isAdmin && !ownerScope) {
      owns = await env.DB.prepare("SELECT 1 FROM transcriptions WHERE meeting_id = ?1 LIMIT 1").bind(meetingId).all();
    } else {
      const email = normalizeEmail(ownerScope);
      owns = await env.DB.prepare(
        "SELECT 1 FROM transcriptions WHERE meeting_id = ?2 AND (" +
        "EXISTS (SELECT 1 FROM meeting_owners WHERE meeting_id = ?2 AND owner_email = ?1) " +
        "OR owner_email = ?1) LIMIT 1"
      ).bind(email, meetingId).all();
    }
    if (!owns.results || !owns.results.length) return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: "Failed to authorize that meeting", detail: String((err && err.message) || err) }, 500);
  }

  const endpoint = `${await resolveApiBase(env)}/public/audio/${encodeURIComponent(meetingId)}`;
  // Forward the browser's Range header so <audio> can stream and seek natively
  // instead of buffering the whole file before playback starts.
  const upstreamHeaders = { "X-API-Key": env.API_KEY };
  const range = request.headers.get("Range");
  if (range) upstreamHeaders["Range"] = range;
  let upstream;
  try {
    upstream = await fetch(endpoint, { headers: upstreamHeaders });
  } catch (err) {
    return json({ error: "Failed to reach the notetaker service", detail: String((err && err.message) || err) }, 502);
  }
  if (upstream.status === 404) {
    // The upstream's {"detail": "..."} distinguishes a bad/wrong-owner id (we
    // already checked ownership above, so this shouldn't happen), an aged-out-
    // of-retention recording, and a meeting that was simply never recorded.
    let detail = "";
    try {
      const body = await upstream.json();
      detail = String((body && body.detail) || "");
    } catch {
      detail = await upstream.text().catch(() => "");
    }
    const message = /retention/i.test(detail)
      ? "This recording has been deleted per the retention policy"
      : /meeting not found/i.test(detail)
      ? "Not found"
      : "No recorded audio found for this meeting";
    return json({ error: message }, 404);
  }
  if (!upstream.ok) {
    // Don't flatten everything to 502: a 401/403 from upstream is a permanent
    // configuration failure (e.g. an expired server-held API key). Report it as
    // 503 so the client shows it immediately instead of retrying a request that
    // can never succeed. (Never surface upstream's own 401 verbatim — that
    // would read as "your session expired" and sign the user out.)
    if (upstream.status === 401 || upstream.status === 403) {
      return json(
        {
          error: "The notetaker service rejected this request — the server's API key may need renewing",
          detail: `Upstream returned ${upstream.status}`,
        },
        503
      );
    }
    return json({ error: "Failed to fetch the recording", detail: `Upstream returned ${upstream.status}` }, 502);
  }

  // Pass the upstream status through: 206 (partial) keeps range/seek working in
  // the browser's native player; anything else stays 200.
  const headers = {
    "Content-Type": upstream.headers.get("Content-Type") || "audio/webm",
    "Cache-Control": "private, no-store",
    "Accept-Ranges": upstream.headers.get("Accept-Ranges") || "bytes",
  };
  for (const h of ["Content-Length", "Content-Range", "Content-Disposition"]) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers });
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

// Every apiKey/model pair the handlers below resolve from OPENAI_API_KEY /
// OPENAI_MODEL is routed through here before being handed to openaiChat /
// openaiJson. LLM_PROVIDER defaults to "openai" — every existing deployment
// is unaffected until someone sets it to "claude" — at which point the
// returned `model` becomes the Bedrock marker object openaiChat/openaiJson
// key off below, and `apiKey` becomes the temp_claude_token Worker secret.
function withLlmProvider(env, apiKey, model) {
  if ((env.LLM_PROVIDER || "openai") !== "claude") return { apiKey, model };
  return { apiKey: env.temp_claude_token, model: bedrockModelConfig(env) };
}

async function openaiChat(apiKey, model, messages, maxTokens, temperature = 0.2) {
  if (model && model.bedrock) return bedrockChat(apiKey, model, messages, maxTokens, temperature);
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

// ── Transcript retrieval — the chat's grounding layer ─────────────────────────
// The meeting chat used to hand the model a head+tail slice of the transcript
// and a two-line system prompt. That produced the exact failure this layer
// exists to kill: ask "discussion about nadam?" and the model replies "the
// transcript does not mention anything about nadam" — even though the line is
// sitting there at 28:11. Two causes, both fixed here:
//
//   1. The line was never sent. A 30k-char head+tail slice drops the entire
//      middle of any meeting longer than ~40 minutes, which is precisely where
//      a 28-minute mark lands.
//   2. The user's spelling never literally appears. The transcript is ASR over
//      mixed Hindi/English, so a person or product the user knows as "Nadam"
//      may be written "Nadaam", "Nadim", or "Na Dam" — and a model scanning for
//      a literal string reports absence with total confidence.
//
// So the Worker now searches the FULL transcript itself, phonetically, before
// the model is asked anything, and hands over the lines it found, the actual
// spellings those lines used, and as much surrounding transcript as the context
// window allows. "Not mentioned" now has to survive evidence already on the table.

// Words carrying no retrieval signal. Deliberately small: an over-eager stoplist
// is how a real question term ("about", in "the About page") gets discarded.
const CHAT_STOPWORDS = new Set(
  ("the a an and or but if then than that this these those there here is are was were be been being am " +
    "do does did doing done have has had having will would shall should can could may might must " +
    "i me my we us our you your he him his she her it its they them their who whom whose what which " +
    "when where why how all any both each few more most other some such no nor not only own same so " +
    "too very just about above after again against below between during for from into of off on once " +
    "out over under until up down with within without to at by as in out please tell say said talk " +
    "talked talking discuss discussed discussion mention mentioned anything something someone anyone " +
    "meeting transcript call give me show list summary summarize summarise " +
    "ok okay yeah yes yep no nope hmm uh um like really actually basically").split(" "),
);

// Lowercase, strip accents and punctuation. The common denominator every
// comparison below runs on.
function normWord(word) {
  return String(word || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

// A crude phonetic key, tuned for Indian-English ASR rather than for English
// surnames (which is what Soundex/Metaphone are built for). Aspirated pairs are
// folded to their base consonant, the usual k/c/q and s/z confusions collapse,
// and vowels — where ASR is least reliable on transliterated names — are dropped
// after the first character. "nadam", "Nadaam", "Nadim" and "Nadhim" all key to
// "ndm"; that is the whole point.
function soundKey(word) {
  let w = normWord(word);
  if (!w) return "";
  w = w
    .replace(/ph/g, "f")
    .replace(/([gkbdt])h/g, "$1")
    .replace(/ck/g, "k")
    .replace(/q/g, "k")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/w/g, "v")
    .replace(/x/g, "ks")
    .replace(/y/g, "i");
  const key = w[0] + w.slice(1).replace(/[aeiou]/g, "");
  return key.replace(/(.)\1+/g, "$1");
}

// Levenshtein distance, abandoned as soon as it provably exceeds `max`. Bounding
// it matters: this runs over every token of a transcript that can be tens of
// thousands of words, inside a Worker's CPU budget.
function editWithin(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    prev = curr;
  }
  return prev[b.length];
}

// How well a transcript token answers a query token, 0 (no) to 1 (exact). The
// tiers below the exact match are what let a question survive an ASR misspelling;
// each is scored lower than the one above so a literal hit always outranks a
// phonetic one when both exist.
function fuzzyScore(q, t) {
  if (!q || !t) return 0;
  if (q === t) return 1;
  // Shared stem — "deploy" ↔ "deployment", "Nadam" ↔ "Nadam's".
  if (q.length >= 4 && t.startsWith(q)) return 0.9;
  if (t.length >= 4 && q.startsWith(t)) return 0.85;
  // The looser tiers below are gated on the two words starting with the same
  // sound. ASR mangles the inside of a name far more often than its opening
  // consonant, and without the gate a 1-edit rule quietly matches "tool" to
  // "cool" and "nadam" to "madam" — noise that reads as evidence.
  const kq = soundKey(q);
  const kt = soundKey(t);
  if (!kq || !kt || kq[0] !== kt[0]) return 0;
  if (q.length >= 4) {
    const budget = q.length <= 6 ? 1 : 2;
    if (editWithin(q, t, budget) <= budget) return 0.75;
  }
  // Last resort: same sound, similar length. Cheap enough to be worth it, loose
  // enough that it only ever contributes evidence — never a claim on its own.
  if (q.length >= 3 && Math.abs(q.length - t.length) <= 3 && kq.length >= 2 && kq === kt) return 0.6;
  return 0;
}

// Tokens paired with the spelling they had in the source, so the term report can
// show the user the transcript's own casing ("Nadam") rather than the normalized
// form the matching ran on ("nadam").
function chatTokenPairs(text) {
  const out = [];
  for (const raw of String(text || "").split(/[^A-Za-z0-9']+/)) {
    const n = normWord(raw);
    if (n) out.push({ n, raw });
  }
  return out;
}

function chatTokens(text) {
  return chatTokenPairs(text).map((p) => p.n);
}

// The terms a question is actually *about*. Walks backwards through the user's
// turns so a follow-up ("and what about the timeline?") still carries the subject
// of the turn that set it up, which is where a single-message extraction fails.
function chatQueryTerms(clientMessages) {
  const terms = [];
  const seen = new Set();
  const userTurns = clientMessages.filter((m) => m && m.role !== "assistant");
  for (let i = userTurns.length - 1; i >= 0; i--) {
    for (const tok of chatTokens(userTurns[i].content)) {
      // Two-character terms are kept: "HR", "AI", "QA", "UI" are exactly the
      // acronyms this product's meetings turn on. They can only ever match
      // exactly (fuzzyScore's looser tiers all require more characters), so
      // they add precision without adding noise.
      if (tok.length < 2 || CHAT_STOPWORDS.has(tok) || seen.has(tok)) continue;
      seen.add(tok);
      if (terms.push(tok) >= 12) return terms;
    }
    // Reach further back ONLY when the latest turn is too thin to locate
    // anything by itself ("and when?", "who owns that?"). A question that
    // already names its own subject must not have an older, unrelated one
    // dragged into its scoring.
    if (terms.length >= 3) break;
  }
  return terms;
}

// Scores every transcript line against the query terms and records which real
// spellings each term matched. Terms common across the whole meeting are
// down-weighted (a crude IDF) so "dashboard" in a meeting about dashboards
// doesn't drown out the one rare name that actually locates the answer.
function scanTranscript(rows, terms) {
  const lineTokens = rows.map((r) => chatTokenPairs(`${r.speaker || ""} ${r.text || ""}`));
  const df = new Map();
  const scores = new Array(rows.length).fill(0);
  // term → Map(normalized spelling → { count, firstIndex, raw })
  const spellings = new Map();
  if (!terms.length) return { scores, spellings };

  const perLineBest = terms.map(() => new Array(rows.length).fill(0));
  terms.forEach((term, ti) => {
    let hits = 0;
    for (let li = 0; li < rows.length; li++) {
      let best = 0;
      let bestTok = null;
      for (const tok of lineTokens[li]) {
        const s = fuzzyScore(term, tok.n);
        if (s > best) {
          best = s;
          bestTok = tok;
          if (s === 1) break;
        }
      }
      if (!best) continue;
      hits++;
      perLineBest[ti][li] = best;
      if (!spellings.has(term)) spellings.set(term, new Map());
      const m = spellings.get(term);
      const prev = m.get(bestTok.n);
      if (prev) prev.count++;
      else m.set(bestTok.n, { count: 1, firstIndex: li, raw: bestTok.raw });
    }
    df.set(term, hits);
  });

  terms.forEach((term, ti) => {
    const hits = df.get(term) || 0;
    if (!hits) return;
    // A term on more than a third of the lines is background, not signal.
    const idf = hits / Math.max(1, rows.length) > 0.33 ? 0.2 : 1;
    for (let li = 0; li < rows.length; li++) {
      if (perLineBest[ti][li] > 0) scores[li] += perLineBest[ti][li] * idf;
    }
  });
  return { scores, spellings };
}

function clockOf(row) {
  const t = Math.max(0, Math.floor(Number(row && row.start_time) || 0));
  const h = Math.floor(t / 3600);
  const mm = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const ss = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// A missing speaker (null/undefined — a meeting row D1 has no label for) still
// reads as "Unknown", which is information. An explicitly empty one is how a
// video transcript says "this medium has no speakers", and prefixing every line
// with "Unknown:" there would be noise the model has to see past.
function chatLine(row) {
  const who = String(row.speaker == null ? "Unknown" : row.speaker).trim();
  return who ? `[${clockOf(row)}] ${who}: ${row.text || ""}` : `[${clockOf(row)}] ${row.text || ""}`;
}

// A video transcript arrives as text — "[MM:SS] line" when upstream gave the
// segments timings, bare lines when it didn't. Projecting it onto the same row
// shape the meeting pipeline uses is what lets videos reuse that pipeline whole
// rather than growing a second, weaker copy of it.
function videoRowsFromText(text) {
  const rows = [];
  const push = (secs, body) => {
    const trimmed = String(body || "").trim();
    if (trimmed) rows.push({ start_time: secs, speaker: "", text: trimmed });
  };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*(.*)$/.exec(line);
    if (m) {
      push(
        m[1].split(":").map(Number).reduce((acc, n) => acc * 60 + n, 0),
        m[2],
      );
    } else {
      // Untimed line: carry the last known offset so citations stay honest —
      // approximate, never invented forward.
      push(rows.length ? rows[rows.length - 1].start_time : 0, line);
    }
  }
  // A transcript delivered as one unbroken block would otherwise be a single
  // row, defeating retrieval and slicing alike. Break it into sentence groups.
  if (rows.length === 1 && rows[0].text.length > 2000) {
    const sentences = rows[0].text.match(/[^.!?]+[.!?]+|\S+$/g) || [];
    const grouped = [];
    let buf = "";
    for (const s of sentences) {
      buf += s;
      if (buf.length >= 300) {
        grouped.push(buf.trim());
        buf = "";
      }
    }
    if (buf.trim()) grouped.push(buf.trim());
    return grouped.map((t) => ({ start_time: 0, speaker: "", text: t }));
  }
  return rows;
}

// The lines that matched the question, in meeting order. Sent to the model as a
// separate block so the answer is anchored even when the transcript below had to
// be sampled — and so a wrong "not discussed" would have to contradict lines the
// model was handed explicitly.
function buildEvidence(rows, scores, maxLines = 40, maxChars = 7000) {
  const ranked = [];
  for (let i = 0; i < rows.length; i++) if (scores[i] > 0) ranked.push([i, scores[i]]);
  if (!ranked.length) return "";
  ranked.sort((a, b) => b[1] - a[1]);
  const keep = ranked.slice(0, maxLines).map(([i]) => i).sort((a, b) => a - b);
  const out = [];
  let used = 0;
  for (const i of keep) {
    const line = chatLine(rows[i]);
    if (used + line.length > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.join("\n");
}

// Merge [start, end) index windows into non-overlapping, sorted ranges.
function mergeWindows(windows) {
  const sorted = windows.slice().sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
    else out.push([w[0], w[1]]);
  }
  return out;
}

// The transcript as the chat model sees it. Whole, whenever it fits — which for
// gpt-4o is nearly every real meeting, and is the single biggest reason the old
// chat "forgot" the middle of a long call. When it genuinely doesn't fit, the
// opening, the close, and the highest-scoring passages are kept, in meeting
// order, with the omissions marked so the model can say what it couldn't see
// instead of quietly answering from a hole.
function buildChatTranscript(rows, scores, maxChars = 90000) {
  const lines = rows.map(chatLine);
  const lineCost = lines.map((l) => l.length + 1);
  const total = lineCost.reduce((a, b) => a + b, 0);
  if (total <= maxChars) return { text: lines.join("\n"), complete: true };

  const n = rows.length;
  const cost = (a, b) => {
    let c = 0;
    for (let i = a; i < b; i++) c += lineCost[i];
    return c;
  };

  // Seed: the opening and the close (where framing and commitments live), plus a
  // window around each line that matched the question, best first.
  const edge = Math.min(60, Math.floor(n * 0.1));
  let windows = [[0, edge], [Math.max(0, n - edge), n]];
  let budget = maxChars - cost(0, edge) - cost(Math.max(0, n - edge), n);

  const ranked = [];
  for (let i = 0; i < n; i++) if (scores[i] > 0) ranked.push([i, scores[i]]);
  ranked.sort((a, b) => b[1] - a[1]);
  for (const [i] of ranked) {
    if (budget <= 0) break;
    const a = Math.max(0, i - 10);
    const b = Math.min(n, i + 11);
    const c = cost(a, b);
    if (c > budget) continue;
    windows.push([a, b]);
    budget -= c;
  }
  windows = mergeWindows(windows);

  // Spend whatever budget is left widening what we kept, a slice at a time,
  // round-robin so no one window eats the remainder. Without this pass a
  // question with few matches would ship a couple of hundred lines and leave
  // most of the context window empty — strictly worse than the head+tail slice
  // this replaced. With it, an omission only ever means the budget really ran out.
  let grew = true;
  while (budget > 0 && grew) {
    grew = false;
    for (const w of windows) {
      if (budget <= 0) break;
      const before = Math.max(0, w[0] - 20);
      if (before < w[0]) {
        const c = cost(before, w[0]);
        if (c <= budget) {
          budget -= c;
          w[0] = before;
          grew = true;
        }
      }
      const after = Math.min(n, w[1] + 20);
      if (after > w[1]) {
        const c = cost(w[1], after);
        if (c <= budget) {
          budget -= c;
          w[1] = after;
          grew = true;
        }
      }
    }
    windows = mergeWindows(windows);
  }

  const parts = [];
  let cursor = 0;
  for (const [a, b] of windows) {
    if (a > cursor) parts.push(`…[${a - cursor} lines not shown]…`);
    parts.push(lines.slice(a, b).join("\n"));
    cursor = b;
  }
  if (cursor < n) parts.push(`…[${n - cursor} lines not shown]…`);
  return { text: parts.join("\n"), complete: cursor === n && windows.length === 1 && windows[0][0] === 0 };
}

// Tells the model, in plain terms, which real transcript spellings each of the
// user's words resolved to — "you asked about 'nadam'; the transcript writes it
// 'Nadam', first at 28:11". Without this the model has to rediscover the
// misspelling on its own, and it reliably doesn't.
function buildTermMatchReport(rows, terms, spellings) {
  const lines = [];
  for (const term of terms) {
    const m = spellings.get(term);
    if (!m || !m.size) continue;
    const variants = [...m.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 4)
      .map(([, info]) => `"${info.raw}" (${info.count}×, first at ${clockOf(rows[info.firstIndex])})`);
    lines.push(`- "${term}" → ${variants.join(", ")}`);
  }
  const missing = terms.filter((t) => !spellings.has(t));
  if (lines.length && missing.length) {
    lines.push(`- no close match in the transcript for: ${missing.map((t) => `"${t}"`).join(", ")}`);
  }
  return lines.join("\n");
}

// Words that start sentences often enough to look like proper nouns in ASR
// output. Without this the vocabulary below is 60% "Okay" and "Because".
const CAPS_STOPWORDS = new Set(
  ("the this that these those there here it its they them their we our you your he him his she her i " +
    "and but or so because if then when where why how what which who whom all any some no not never " +
    "yes yeah yep nope okay ok well now just like maybe sorry thanks thank hi hello hey let lets " +
    "can could will would shall should may might must do does did done have has had is are was were be " +
    "one two three four five six seven eight nine ten first second next last also actually basically " +
    "right left good great cool nice sure fine true false today tomorrow yesterday monday tuesday " +
    "wednesday thursday friday saturday sunday january february march april may june july august " +
    "september october november december").split(" "),
);

// The proper nouns, names and acronyms that literally appear in THIS transcript,
// most frequent first. This is the list the planner call gets to map the user's
// spelling onto — "nadam" is resolved by showing the model that this meeting
// says "Nadam", rather than by hoping it guesses.
function transcriptVocabulary(rows, max = 150) {
  // Every word this transcript ever writes in lowercase. A real proper noun is
  // essentially never seen lowercase, while the ordinary words that merely got
  // capitalized by landing at the start of a sentence ("Basically", "Routine")
  // almost always are. That asymmetry filters the noise without a word list
  // long enough to be wrong about someone's actual name.
  const seenLower = new Set();
  for (const r of rows) {
    for (const m of String(r.text || "").matchAll(/\b[a-z][a-z'’-]{1,}\b/g)) seenLower.add(normWord(m[0]));
  }

  const counts = new Map();
  const add = (raw, always = false) => {
    const n = normWord(raw);
    if (n.length < 2 || CHAT_STOPWORDS.has(n) || CAPS_STOPWORDS.has(n)) return;
    if (!always && seenLower.has(n)) return;
    const entry = counts.get(n);
    if (entry) entry.count++;
    else counts.set(n, { raw: String(raw).replace(/[.,'’]+$/, ""), count: 1 });
  };
  for (const r of rows) {
    const text = String(r.text || "");
    // Capitalized words (names, products, clients) and all-caps acronyms (HR, QA).
    for (const m of text.matchAll(/\b[A-Z][A-Za-z'’-]{1,}\b/g)) add(m[0]);
    // An acronym and a speaker label are proper nouns whatever else the
    // transcript does with those letters.
    for (const m of text.matchAll(/\b[A-Z]{2,5}\b/g)) add(m[0], true);
    const speaker = String(r.speaker || "").trim();
    if (speaker && speaker.toLowerCase() !== "unknown") for (const part of speaker.split(/\s+/)) add(part, true);
  }

  const all = [...counts.values()].sort((a, b) => b.count - a.count);
  if (all.length <= max) return all;
  // When the cap bites, keep both ends. The frequent names give the planner the
  // meeting's shape; the rare ones are precisely where a misheard name hides —
  // taking the top N by count alone would drop "Nadam (2)" first.
  const head = Math.floor(max * 0.7);
  return [...all.slice(0, head), ...all.slice(-(max - head))];
}

// ── Pass 1: resolve the question against the transcript's own words ───────────
// A phonetic key catches "nadam"→"Nadam". It does not catch "the notetaker bot"
// →"research bot", or a name the transcriber heard as two words. Showing a model
// the meeting's actual vocabulary and asking which entries the user means covers
// what string distance cannot. Failure here is survivable — the deterministic
// retrieval still runs — so every error path falls through to an empty plan.
async function planChatQuery(question, speakers, vocab, apiKey, model) {
  if (!question || !vocab.length) return { resolved: [], terms: [], scope: "narrow", restated: "" };
  const list = vocab.map((v) => `${v.raw} (${v.count})`).join(", ");
  const plan = await openaiJson(
    apiKey,
    model,
    [
      {
        role: "system",
        content:
          "You turn a question about a meeting into a search plan. You are given the question and the " +
          "VOCABULARY of that meeting's transcript — the names, products and acronyms that literally appear " +
          "in it, with occurrence counts.\n\n" +
          "The transcript is machine transcription of mixed Hindi/English speech, so the user's spelling of a " +
          "name is usually NOT the transcript's spelling. Your main job is to map what the user typed onto " +
          "what this transcript actually says: match by sound and by role, not by characters. \"nadam\" " +
          "matches a VOCABULARY entry \"Nadam\" or \"Nadaam\"; \"the research bot\" may appear as \"research " +
          "bot\" or \"reasearch bot\".\n\n" +
          "Reply with JSON only:\n" +
          "{\n" +
          '  "resolved": [{"asked": "<word from the question>", "transcript": ["<spelling(s) taken verbatim from VOCABULARY>"], "confidence": "high"|"medium"|"low"}],\n' +
          '  "terms": ["<every word worth searching the transcript for, including the VOCABULARY spellings>"],\n' +
          '  "scope": "narrow" | "whole_meeting",\n' +
          '  "restated": "<the question rewritten using the transcript\'s own spellings>"\n' +
          "}\n\n" +
          'Only put spellings in "transcript" that appear verbatim in VOCABULARY. If nothing plausibly ' +
          'matches a word, leave it out of "resolved" rather than inventing a match. Use scope ' +
          '"whole_meeting" for questions about the meeting as a whole (summaries, per-person breakdowns, ' +
          'action items, decisions) and "narrow" for questions about one topic, person or moment.',
      },
      {
        role: "user",
        content:
          `QUESTION: ${question}\n\n` +
          `SPEAKERS: ${speakers.join(", ") || "(unlabelled)"}\n\n` +
          `VOCABULARY (word (times used)): ${list}`,
      },
    ],
    600,
  );
  return {
    resolved: Array.isArray(plan.resolved) ? plan.resolved : [],
    terms: Array.isArray(plan.terms) ? plan.terms.map(String) : [],
    scope: plan.scope === "whole_meeting" ? "whole_meeting" : "narrow",
    restated: String(plan.restated || ""),
  };
}

// ── Pass 2: read the whole meeting, a slice at a time ─────────────────────────
// The map half of a map/reduce. Every slice of the transcript gets its own call,
// so nothing is missed because it fell outside a context budget or scored badly
// on a keyword match — the failure mode of any single-call design over a long
// meeting. Slices run concurrently; a slice that fails contributes nothing
// rather than sinking the answer.
function chunkTranscript(rows, maxChars = 11000) {
  const chunks = [];
  let start = 0;
  let size = 0;
  for (let i = 0; i < rows.length; i++) {
    size += chatLine(rows[i]).length + 1;
    if (size >= maxChars) {
      chunks.push([start, i + 1]);
      start = i + 1;
      size = 0;
    }
  }
  if (start < rows.length) chunks.push([start, rows.length]);
  return chunks;
}

const MAP_PROMPT =
  "You are reading ONE slice of a longer meeting transcript, looking for anything that bears on a question. " +
  "You are NOT answering the question — a later step does that. Your job is to extract evidence, and to miss " +
  "nothing.\n\n" +
  "The transcript is machine transcription of mixed Hindi/English speech. Proper nouns are frequently " +
  "misspelt, so match names by sound, not by exact characters, and include a line whenever it plausibly " +
  "concerns what was asked.\n\n" +
  "Output: \"- [MM:SS] Speaker: <what was said, in clear English>\" — one bullet per relevant moment, using the " +
  "timestamps exactly as they appear in the slice. Include partial and tangential relevance; err towards " +
  "including. Never invent anything.\n\n" +
  "If this slice genuinely contains nothing relevant, reply with exactly: NONE";

async function mapTranscript(rows, chunks, question, extraTerms, apiKey, model) {
  const results = await Promise.all(
    chunks.map(async ([a, b]) => {
      const slice = rows.slice(a, b).map(chatLine).join("\n");
      try {
        const out = await openaiChat(
          apiKey,
          model,
          [
            { role: "system", content: MAP_PROMPT },
            {
              role: "user",
              content:
                `QUESTION: ${question}\n\n` +
                (extraTerms.length ? `ALSO TREAT THESE AS THE SUBJECT: ${extraTerms.join(", ")}\n\n` : "") +
                `SLICE (${clockOf(rows[a])}–${clockOf(rows[b - 1])}):\n${slice}`,
            },
          ],
          600,
          0,
        );
        const text = String(out || "").trim();
        return /^none\b/i.test(text) || !text ? "" : text;
      } catch {
        return "";
      }
    }),
  );
  return results
    .map((text, i) => (text ? `From ${clockOf(rows[chunks[i][0]])}–${clockOf(rows[chunks[i][1] - 1])}:\n${text}` : ""))
    .filter(Boolean)
    .join("\n\n");
}

// The video counterpart of CHAT_SYSTEM_PROMPT. Same discipline — never declare
// absence over a spelling, always cite — with the meeting-specific parts (named
// speakers, decisions and owners) swapped for what a video actually has.
const VIDEO_SYSTEM_PROMPT =
  "You are the analyst for ONE video. You have its transcript and answer questions about it.\n\n" +
  "HOW THE TRANSCRIPT WAS MADE — this changes how you must read it:\n" +
  "It is machine transcription of speech, so it contains recognition errors, and the errors cluster in proper " +
  "nouns: people, companies, products, places and technical terms. The same name can appear spelt several " +
  "ways, and none need match how the user spells it. Treat the user's spelling as an approximation of a " +
  "sound, never as an exact string to find.\n\n" +
  "THE RULE THAT MATTERS MOST:\n" +
  "Never answer that something \"is not mentioned\" or \"is not covered\" because of a spelling difference. " +
  "Before you say a topic is absent, look for words that SOUND like what the user typed. The TERM MATCHES " +
  "section below already tells you which real transcript spellings the user's words resolved to — trust it, " +
  "and answer about those. Only say something is absent when neither TERM MATCHES nor EVIDENCE nor the " +
  "transcript shows anything that could plausibly be it, and when you do, say what you looked for and offer " +
  "the nearest thing that IS covered.\n\n" +
  "ANSWERING:\n" +
  "- Lead with the direct answer to what was actually asked. Do not summarize the whole video for a narrow " +
  "question.\n" +
  "- Cite timestamps in square brackets, e.g. [12:40], for every specific claim, quote, figure or " +
  "recommendation. Use the timestamps exactly as they appear at the start of each transcript line.\n" +
  "- Quote the transcript when the exact words matter; otherwise clean the speech into plain professional " +
  "English. Answer in the user's language.\n" +
  "- Never invent names, numbers, dates or claims. Separate what the speaker asserts from what they merely " +
  "raise or attribute to someone else.\n" +
  "- Format for skimming: short paragraphs, \"- \" bullets, and **bold headers** only when there are real " +
  "sections. No preamble like \"Based on the transcript\" — just answer.\n" +
  "- If parts of the transcript are marked as not shown, and the answer would depend on them, say which " +
  "stretch you could not see.";

const CHAT_SYSTEM_PROMPT =
  "You are the analyst for ONE recorded meeting. You have its transcript and answer questions about it.\n\n" +
  "HOW THE TRANSCRIPT WAS MADE — this changes how you must read it:\n" +
  "It is machine transcription of mixed Hindi/English speech, so it contains recognition errors, and the " +
  "errors cluster in proper nouns: people, companies, products, tools, and clients. The same name can appear " +
  "spelt several different ways in the same meeting, and none of them need match how the user spells it. " +
  "Treat the user's spelling as an approximation of a sound, never as an exact string to find.\n\n" +
  "THE RULE THAT MATTERS MOST:\n" +
  "Never answer that something \"is not mentioned\" or \"does not appear\" because of a spelling difference. " +
  "Before you say a topic is absent, look for names that SOUND like what the user typed (nadam/Nadaam/Nadim, " +
  "aashita/Ashita, munshot/Moonshot). The TERM MATCHES section below already tells you which real transcript " +
  "spellings the user's words resolved to — trust it, and answer about those. Only say something is absent " +
  "when neither TERM MATCHES nor EVIDENCE nor the transcript shows anything that could plausibly be it, and " +
  "when you do, say what you looked for and offer the nearest thing that IS discussed.\n\n" +
  "ANSWERING:\n" +
  "- Lead with the direct answer to what was actually asked. Do not restate the whole meeting for a narrow question.\n" +
  "- Cite timestamps in square brackets, e.g. [28:11], for every specific claim, quote, decision, or number. " +
  "Use the timestamps exactly as they appear at the start of each transcript line.\n" +
  "- Attribute to the speaker the transcript attributes it to. Speaker labels are also machine-assigned and can " +
  "be wrong on a line or two; if a line's attribution clearly contradicts the surrounding turns, say so rather " +
  "than repeating it as fact.\n" +
  "- Quote the transcript when the exact words matter; otherwise clean up the speech into plain professional " +
  "English. Answer in the user's language.\n" +
  "- Never invent names, numbers, dates, decisions, or owners. Distinguish what was decided from what was only " +
  "floated, and say when something was left open.\n" +
  "- Format for skimming: short paragraphs, \"- \" bullets, and **bold headers** only when there are real sections. " +
  "No preamble like \"Based on the transcript\" — just answer.\n" +
  "- If parts of the transcript are marked as not shown, and the answer would depend on them, say which stretch " +
  "you could not see.";

// Assembles the grounding message: what meeting this is, which spellings the
// question resolved to, the matching lines, the notes the map pass took while
// reading the whole meeting, and the transcript itself.
function buildChatGrounding(rows, terms, meta) {
  const { scores, spellings } = scanTranscript(rows, terms);
  const termReport = buildTermMatchReport(rows, terms, spellings);
  const evidence = buildEvidence(rows, scores);
  const { text: transcript, complete } = buildChatTranscript(rows, scores);
  const speakers = distinctSpeakers(rows, 20);
  const resolved = (meta.resolved || [])
    .filter((r) => r && r.asked && Array.isArray(r.transcript) && r.transcript.length)
    .map((r) => `- the user's "${r.asked}" is this transcript's ${r.transcript.map((t) => `"${t}"`).join(" / ")}` +
      (r.confidence && r.confidence !== "high" ? ` (${r.confidence} confidence)` : ""));

  const header = [
    `${meta.kind === "video" ? "VIDEO" : "MEETING"}: ${meta.title || "(untitled)"}`,
    meta.channel ? `CHANNEL: ${meta.channel}` : "",
    `LENGTH: ${clockOf(rows[rows.length - 1])} · ${rows.length} transcript lines`,
    speakers.length ? `SPEAKERS: ${speakers.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const sections = [header];
  if (resolved.length) {
    sections.push(
      "NAME RESOLUTION — the user's spelling mapped onto this transcript's spelling. Answer about the " +
        "transcript spelling; do not tell the user their word is absent:\n" + resolved.join("\n"),
    );
  }
  if (termReport) {
    sections.push(
      "TERM MATCHES — how the words in the user's question appear in this transcript.\n" +
        "These were found by a phonetic search over the FULL transcript, so they are reliable even where the " +
        "spelling differs from the user's:\n" +
        termReport,
    );
  } else if (terms.length) {
    sections.push(
      "TERM MATCHES: a phonetic search over the full transcript found no close match for the distinctive words " +
        `in this question (${terms.map((t) => `"${t}"`).join(", ")}). Say so plainly, and point to the nearest ` +
        "related thing the meeting does cover.",
    );
  }
  if (evidence) {
    sections.push("EVIDENCE — the transcript lines that best match this question, in meeting order:\n" + evidence);
  }
  if (meta.mapNotes) {
    sections.push(
      "READING NOTES — a separate pass read the meeting end to end, slice by slice, and pulled out everything " +
        "bearing on this question. This covers the WHOLE meeting, including any stretch omitted from the " +
        "transcript below, so treat it as authoritative about what exists:\n" + meta.mapNotes,
    );
  }
  if (meta.summary) {
    sections.push(
      "PREPARED SUMMARY of this meeting (secondary — the transcript below is authoritative and wins any conflict):\n" +
        meta.summary,
    );
  }
  sections.push(
    (complete
      ? "FULL TRANSCRIPT (every line of the meeting):\n"
      : "TRANSCRIPT (too long to include whole — the opening, the close, and the passages most relevant to this " +
        "question are included; omitted stretches are marked):\n") + transcript,
  );
  return sections.join("\n\n");
}

// The whole three-pass pipeline, in one place and with no Worker bindings in
// sight, so `scripts/chat-eval.mjs` can run exactly this against a transcript
// file. Returns the messages for the answering call plus a trace of how they
// were assembled. Both model-assisted passes are optional by construction: if
// either fails, the deterministic phonetic retrieval still grounds the answer.
async function buildChatRequest({
  rows,
  history,
  apiKey,
  model,
  planModel,
  title = "",
  summary = "",
  // "meeting" or "video". Switches the system prompt and the grounding
  // header; every pass below is identical either way, which is the point —
  // the video chat gets the real pipeline, not a second-rate copy of it.
  kind = "meeting",
  channel = "",
  seedPrompt = "",
}) {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const question = lastUser ? lastUser.content : "";
  let terms = chatQueryTerms(history);

  // Pass 1 — resolve the question against the meeting's own vocabulary.
  const vocab = transcriptVocabulary(rows);
  let plan = { resolved: [], terms: [], scope: "narrow", restated: "" };
  if (question) {
    try {
      plan = await planChatQuery(question, distinctSpeakers(rows, 20), vocab, apiKey, planModel || model);
    } catch {
      /* an accelerant, not a dependency */
    }
  }
  // Fold the planner's spellings into retrieval, so the phonetic scan searches
  // for what the transcript calls things as well as for what the user typed.
  for (const t of plan.terms) {
    for (const tok of chatTokens(t)) {
      if (tok.length >= 2 && !CHAT_STOPWORDS.has(tok) && !terms.includes(tok)) terms.push(tok);
    }
  }

  // Pass 2 — read the meeting end to end in slices, concurrently, extracting
  // everything that bears on the question. This is what makes "not mentioned"
  // nearly impossible to reach wrongly: every line is read by something, rather
  // than only the lines that survived a context budget. Skipped for a short
  // meeting, where the whole transcript reaches the answering call anyway.
  const allChunks = chunkTranscript(rows);
  let mapNotes = "";
  let chunksRead = 0;
  if (question && allChunks.length > 1) {
    // Bound the fan-out. A narrow question spends its budget on the slices that
    // matched; a whole-meeting question reads from the top, in order.
    const MAX_CHUNKS = 12;
    let chunks = allChunks;
    if (allChunks.length > MAX_CHUNKS) {
      const { scores } = scanTranscript(rows, terms);
      const weight = ([a, b]) => scores.slice(a, b).reduce((x, y) => x + y, 0);
      chunks = allChunks
        .map((c, i) => ({ c, i, w: plan.scope === "whole_meeting" ? -i : weight(c) }))
        .sort((x, y) => y.w - x.w)
        .slice(0, MAX_CHUNKS)
        .sort((x, y) => x.i - y.i)
        .map((x) => x.c);
    }
    chunksRead = chunks.length;
    try {
      const extra = plan.resolved.flatMap((r) => (Array.isArray(r.transcript) ? r.transcript : []));
      mapNotes = await mapTranscript(rows, chunks, plan.restated || question, extra, apiKey, model);
    } catch {
      /* same posture as the plan */
    }
  }

  // Pass 3 — answer, from the notes, the evidence, and the transcript.
  const grounding = buildChatGrounding(rows, terms, {
    title,
    summary,
    resolved: plan.resolved,
    mapNotes,
    kind,
    channel,
  });
  const messages = [
    { role: "system", content: kind === "video" ? VIDEO_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT },
    { role: "system", content: grounding },
    ...history,
  ];
  // Chat opened with no user message yet: seed with a quick per-person breakdown.
  if (!history.length && seedPrompt) {
    messages.push({ role: "user", content: seedPrompt });
  } else if (!history.length) {
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

  return {
    messages,
    trace: {
      lines: rows.length,
      terms,
      vocabularySample: vocab.slice(0, 40).map((v) => `${v.raw}(${v.count})`),
      plan,
      chunksTotal: allChunks.length,
      chunksRead,
      mapNotes,
      grounding,
    },
  };
}

// A build marker, bumped whenever the chat pipeline changes shape. Nothing but
// a deploy can change what this returns, which is the point: "is the new code
// actually live?" should cost one request, not three rounds of inference from
// how an answer is phrased. Deliberately public and deliberately boring — a
// version string and a feature list, no data, no secrets, no session needed.
const BUILD_MARKER = "chat-pipeline-v2";

function handleVersion() {
  return json({
    ok: true,
    build: BUILD_MARKER,
    meetingChat: {
      passes: ["resolve-names", "read-every-slice", "answer"],
      phoneticRetrieval: true,
      citesTimestamps: true,
      debugFlag: true,
    },
    weeklyChat: { passes: ["resolve-names", "read-every-meeting", "answer"], readsTranscripts: true },
  });
}

// Chat over a single meeting's transcript with OpenAI. The transcript is loaded
// server-side and scoped to the session (all meetings for admin), and the OpenAI
// key is a Worker secret that never reaches the browser. Same ACL as transcripts.
async function handleAiChat(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  let apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
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

  let model = env.OPENAI_MODEL || "gpt-4o";
  ({ apiKey, model } = withLlmProvider(env, apiKey, model));
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

  // Normalize the client's turns first: the grounding below is built FROM the
  // question, so it has to be derived from the same messages the model will see.
  const history = [];
  for (const m of clientMessages.slice(-16)) {
    const role = m && m.role === "assistant" ? "assistant" : "user";
    const content = String((m && m.content) || "").slice(0, 4000);
    if (content) history.push({ role, content });
  }

  // The meeting's own name and its cached summary, when they exist — both are
  // best-effort context, so a KV hiccup must not cost the user their answer.
  let meetingTitle = "";
  let cachedSummary = "";
  try {
    meetingTitle = (await d1MeetingNames(env, [meetingId]))[meetingId] || "";
  } catch {
    /* name is best-effort */
  }
  if (env.KV) {
    try {
      if (!meetingTitle) meetingTitle = (await env.KV.get(titleCacheKey(meetingId))) || "";
      cachedSummary = ((await env.KV.get(summaryCacheKey(meetingId))) || "").slice(0, 6000);
    } catch {
      /* KV is optional context, never a hard dependency here */
    }
  }

  let built;
  try {
    built = await buildChatRequest({
      rows,
      history,
      apiKey,
      model,
      planModel: model && model.bedrock ? model : env.OPENAI_FAST_MODEL || model,
      title: meetingTitle,
      summary: cachedSummary,
    });
  } catch (err) {
    return json({ error: "AI request failed", detail: String((err && err.message) || err) }, 502);
  }
  const messages = built.messages;

  let reply;
  if (model && model.bedrock) {
    try {
      reply = await bedrockChat(apiKey, model, messages, 1600, 0.2);
    } catch (err) {
      return json({ error: "AI request failed", detail: String((err && err.message) || err) }, 502);
    }
  } else {
    let upstream;
    try {
      upstream = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // Low temperature: this is a question answered from evidence, not a piece
        // of writing. The token budget is generous enough that a per-person recap
        // (what the empty-chat seed asks for) can finish instead of being cut off
        // mid-person, which the old 700 regularly did.
        body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 1600 }),
      });
    } catch (err) {
      return json({ error: "Failed to reach the AI service", detail: String((err && err.message) || err) }, 502);
    }
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const detail = (data && data.error && data.error.message) || `HTTP ${upstream.status}`;
      return json({ error: "AI request failed", detail }, 502);
    }
    reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  }
  // `debug: true` returns everything the pipeline decided along the way — what
  // the question resolved to, what the readers found, exactly how much of the
  // transcript reached the model. It is the difference between "the answer looks
  // wrong" and knowing which of the three passes produced the wrong thing.
  return json({ ok: true, reply: String(reply || "").trim(), debug: body.debug ? built.trace : undefined });
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
  let apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
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

  let model = env.OPENAI_MODEL || "gpt-4o";
  ({ apiKey, model } = withLlmProvider(env, apiKey, model));
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
  if (model && model.bedrock) return bedrockJson(apiKey, model, messages, maxTokens);
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
  let apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
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
  let model = env.OPENAI_MODEL || "gpt-4o";
  ({ apiKey, model } = withLlmProvider(env, apiKey, model));

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
    ai = await synthesizeWeekly(sources, range, apiKey, model);
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

// Transcript rows for the week's meetings, ACL-checked exactly as the summary
// loader is. The weekly chat used to see ONLY the cached summaries — so any
// question whose answer lived in a detail the summary didn't keep (who said it,
// when, the exact number) was unanswerable by construction, and came back as
// "not covered". Reading the transcripts is what makes those answerable.
async function loadWeeklyTranscripts(env, session, meetings, maxMeetings = 12) {
  const out = [];
  const seen = new Set();
  const email = normalizeEmail(session.identity);
  for (const m of meetings) {
    if (out.length >= maxMeetings) break;
    const meetingId = String((m && m.meeting_id) || "").trim();
    if (!meetingId || seen.has(meetingId)) continue;
    seen.add(meetingId);
    let res;
    try {
      res = session.isAdmin
        ? await env.DB.prepare(
            "SELECT start_time, text, speaker FROM transcriptions WHERE meeting_id = ?1 ORDER BY start_time",
          )
            .bind(meetingId)
            .all()
        : await env.DB.prepare(
            "SELECT start_time, text, speaker FROM transcriptions WHERE meeting_id = ?2 AND (" +
              "EXISTS (SELECT 1 FROM meeting_owners WHERE meeting_id = ?2 AND owner_email = ?1) " +
              "OR owner_email = ?1) ORDER BY start_time",
          )
            .bind(email, meetingId)
            .all();
    } catch {
      continue; // one bad lookup shouldn't sink the batch
    }
    const rows = (res && res.results) || [];
    if (!rows.length) continue;
    let title = "";
    try {
      title = (await env.KV.get(titleCacheKey(meetingId))) || "";
    } catch {
      /* title is best-effort */
    }
    out.push({ meetingId, title: (title && title.trim()) || `Meeting ${meetingId}`, rows });
  }
  return out;
}

const WEEKLY_SYSTEM_PROMPT =
  "You are the analyst for a team's WEEK of meetings. You have the transcripts of those meetings, the " +
  "summaries built from them, and a weekly master summary.\n\n" +
  "HOW THE TRANSCRIPTS WERE MADE — this changes how you must read them:\n" +
  "They are machine transcription of mixed Hindi/English speech, so they contain recognition errors, and the " +
  "errors cluster in proper nouns: people, companies, products, tools and clients. The same name can appear " +
  "spelt several ways, and none need match how the user spells it. Treat the user's spelling as an " +
  "approximation of a sound, never as an exact string to find.\n\n" +
  "THE RULE THAT MATTERS MOST:\n" +
  "Never answer that something \"is not mentioned\" or \"was not discussed\" because of a spelling difference. " +
  "The NAME RESOLUTION and TERM MATCHES sections below already tell you which real spellings the user's words " +
  "resolved to — trust them and answer about those. Only say something is absent when nothing in the notes, " +
  "the evidence or the summaries could plausibly be it, and then say what you looked for and offer the " +
  "nearest thing that IS there.\n\n" +
  "ANSWERING:\n" +
  "- Lead with the direct answer. Say which meeting something came from, and cite [MM:SS] within it for " +
  "specific claims, quotes, decisions and numbers.\n" +
  "- Draw the week together: name what recurred across meetings, what changed between them, and what is " +
  "still open. That cross-meeting read is the reason this view exists.\n" +
  "- Never invent names, numbers, dates, decisions or owners. Distinguish decided from merely floated.\n" +
  "- Short paragraphs, \"- \" bullets, **bold headers** only for real sections. No \"Based on the summaries\" " +
  "preamble — just answer. Answer in the user's language.";

// The weekly counterpart of buildChatRequest: same three passes, fanned out over
// meetings rather than over slices of one meeting.
async function buildWeeklyChatRequest({ transcripts, sources, master, history, apiKey, model, planModel }) {
  const lastUser = [...history].reverse().find((m) => m.role === "user");
  const question = lastUser ? lastUser.content : "";
  let terms = chatQueryTerms(history);

  // Pass 1 — resolve the question against the whole week's vocabulary.
  const vocabMap = new Map();
  const speakerSet = new Set();
  for (const t of transcripts) {
    for (const v of transcriptVocabulary(t.rows, 80)) {
      const key = normWord(v.raw);
      const entry = vocabMap.get(key);
      if (entry) entry.count += v.count;
      else vocabMap.set(key, { raw: v.raw, count: v.count });
    }
    for (const s of distinctSpeakers(t.rows, 10)) speakerSet.add(s);
  }
  const vocab = [...vocabMap.values()].sort((a, b) => b.count - a.count).slice(0, 150);
  let plan = { resolved: [], terms: [], scope: "narrow", restated: "" };
  if (question && vocab.length) {
    try {
      plan = await planChatQuery(question, [...speakerSet], vocab, apiKey, planModel || model);
    } catch {
      /* an accelerant, not a dependency */
    }
  }
  for (const t of plan.terms) {
    for (const tok of chatTokens(t)) {
      if (tok.length >= 2 && !CHAT_STOPWORDS.has(tok) && !terms.includes(tok)) terms.push(tok);
    }
  }

  // Phonetic retrieval across every meeting, scored so the map pass can spend
  // its calls where the week actually discusses the question.
  const scanned = transcripts.map((t) => {
    const { scores, spellings } = scanTranscript(t.rows, terms);
    return { ...t, scores, spellings, total: scores.reduce((a, b) => a + b, 0) };
  });

  const evidence = scanned
    .filter((t) => t.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8)
    .map((t) => {
      const lines = buildEvidence(t.rows, t.scores, 12, 2000);
      return lines ? `=== ${t.title} ===\n${lines}` : "";
    })
    .filter(Boolean)
    .join("\n\n");

  const termReport = scanned
    .map((t) => {
      const report = buildTermMatchReport(t.rows, terms, t.spellings);
      return report ? `In "${t.title}":\n${report}` : "";
    })
    .filter(Boolean)
    .join("\n");

  // Pass 2 — one reader per meeting, over the part of it that bears on the
  // question, concurrently. Capped so a 40-meeting week can't fan out forever.
  let mapNotes = "";
  let meetingsRead = 0;
  if (question && scanned.length) {
    const ranked = scanned
      .slice()
      .sort((a, b) => b.total - a.total)
      .slice(0, 6)
      .filter((t) => t.total > 0 || plan.scope === "whole_meeting");
    meetingsRead = ranked.length;
    if (ranked.length) {
      const extra = plan.resolved.flatMap((r) => (Array.isArray(r.transcript) ? r.transcript : []));
      const notes = await Promise.all(
        ranked.map(async (t) => {
          const { text } = buildChatTranscript(t.rows, t.scores, 11000);
          try {
            const out = await openaiChat(
              apiKey,
              model,
              [
                { role: "system", content: MAP_PROMPT },
                {
                  role: "user",
                  content:
                    `QUESTION: ${plan.restated || question}\n\n` +
                    (extra.length ? `ALSO TREAT THESE AS THE SUBJECT: ${extra.join(", ")}\n\n` : "") +
                    `MEETING "${t.title}":\n${text}`,
                },
              ],
              600,
              0,
            );
            const trimmed = String(out || "").trim();
            return /^none\b/i.test(trimmed) || !trimmed ? "" : `=== ${t.title} ===\n${trimmed}`;
          } catch {
            return "";
          }
        }),
      );
      mapNotes = notes.filter(Boolean).join("\n\n");
    }
  }

  // Pass 3 — answer from the notes, the evidence, and the summaries.
  const resolved = plan.resolved
    .filter((r) => r && r.asked && Array.isArray(r.transcript) && r.transcript.length)
    .map((r) => `- the user's "${r.asked}" is this week's ${r.transcript.map((x) => `"${x}"`).join(" / ")}`);

  const sections = [`THIS WEEK: ${transcripts.length} meeting(s) with transcripts, ${sources.length} summarized.`];
  if (resolved.length) {
    sections.push(
      "NAME RESOLUTION — the user's spelling mapped onto what these meetings actually say. Answer about the " +
        "transcript spelling; do not tell the user their word is absent:\n" + resolved.join("\n"),
    );
  }
  if (termReport) sections.push("TERM MATCHES — where the question's words appear, by meeting:\n" + termReport);
  if (evidence) sections.push("EVIDENCE — the transcript lines that best match, by meeting:\n" + evidence);
  if (mapNotes) {
    sections.push(
      "READING NOTES — a separate pass read the most relevant meetings and pulled out everything bearing on " +
        "this question. Treat it as authoritative about what exists:\n" + mapNotes,
    );
  }
  sections.push(buildWeeklyChatContext(sources, master));

  const messages = [
    { role: "system", content: WEEKLY_SYSTEM_PROMPT },
    { role: "system", content: sections.join("\n\n") },
    ...history,
  ];
  if (!history.length) {
    messages.push({ role: "user", content: "Give me a concise recap of this week across all the meetings." });
  }
  return {
    messages,
    trace: {
      meetings: transcripts.length,
      terms,
      plan,
      meetingsRead,
      mapNotes,
      grounding: messages[1].content,
    },
  };
}

// POST /api/weekly/chat — free-form Q&A grounded on a week's meeting summaries
// (and the saved master summary). Body: { week, meetings: [{ meeting_id, owner? }],
// messages: [{ role, content }] }. Same per-meeting ACL as /api/ai.
async function handleWeeklyChat(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  let apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
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
  let model = env.OPENAI_MODEL || "gpt-4o";
  ({ apiKey, model } = withLlmProvider(env, apiKey, model));
  // Transcripts are extra grounding on top of the summaries, so a load failure
  // degrades the answer rather than blocking it.
  let transcripts = [];
  try {
    transcripts = await loadWeeklyTranscripts(env, session, meetings);
  } catch {
    /* fall through — the summaries still ground the answer */
  }
  // A week with transcripts but no cached summaries is now answerable — the
  // transcripts ARE the material. Only a week with neither is a dead end.
  if (!sources.length && !master && !transcripts.length) {
    return json({ error: "No meetings with transcripts for this week yet." }, 404);
  }

  const history = [];
  for (const m of clientMessages.slice(-16)) {
    const role = m && m.role === "assistant" ? "assistant" : "user";
    const content = String((m && m.content) || "").slice(0, 4000);
    if (content) history.push({ role, content });
  }

  let built;
  try {
    built = await buildWeeklyChatRequest({
      transcripts,
      sources,
      master,
      history,
      apiKey,
      model,
      planModel: model && model.bedrock ? model : env.OPENAI_FAST_MODEL || model,
    });
  } catch (err) {
    return json({ error: "AI request failed", detail: String((err && err.message) || err) }, 502);
  }

  try {
    const reply = await openaiChat(apiKey, model, built.messages, 1600, 0.2);
    return json({ ok: true, reply, debug: body.debug ? built.trace : undefined });
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
  let apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
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

    let model = env.OPENAI_MODEL || "gpt-4o";
    ({ apiKey, model } = withLlmProvider(env, apiKey, model));
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
  let apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
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

    let model = env.OPENAI_MODEL || "gpt-4o";
    ({ apiKey, model } = withLlmProvider(env, apiKey, model));
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

// POST /calendar/unsubscribe {email} — the one-shot "unsync calendar". In a
// SINGLE upstream call it cancels every pending calendar meeting, stops any
// bot that's currently live for one, and drops the stored Google OAuth
// connection — so a later /calendar/sync reports connected:false until the
// user re-authorizes. This replaces looping /calendar/meetings/remove per
// event (no pagination gap, and it actually clears the connection, which the
// per-event path never did). It lives on the bot/vexa API host
// (resolveApiBase, honoring any admin /api/config override) — NOT the
// calendar HTTPS host the read/remove/restore calls use — because that's
// where the upstream exposes this combined stop-everything operation. email
// is the acting user's: the session's own for a normal user, or an
// admin-supplied target for admin (same rule as remove/restore).
async function handleCalendarUnsubscribe(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (!env.API_KEY) return json({ error: "Server is missing the API_KEY secret" }, 500);
  const body = await request.json().catch(() => ({}));
  const email = calendarActingEmail(request, session, body);
  if (!email) return json({ error: session.isAdmin ? "email is required" : "Admin accounts have no calendar" }, session.isAdmin ? 400 : 403);
  try {
    const base = await resolveApiBase(env);
    const upstream = await fetch(base + "/calendar/unsubscribe", {
      method: "POST",
      headers: { "X-API-Key": env.API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
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

/* --------------------- YouTube transcripts (home-grown) --------------------- */
// This Worker owns YouTube transcripts end to end: it fetches the caption track
// from YouTube itself, parses it, and stores it in D1. Nothing is proxied to the
// transcript API on EC2 any more.
//
// WHY the Worker and not the API: YouTube hard-blocks the EC2 egress IP. Every
// request from there — a plain watch-page GET, not just the player API — comes
// back "Sign in to confirm you're not a bot" with captionTracks stripped, and
// every player client fails identically, so it is IP reputation rather than
// tooling. Cloudflare's egress is not blocked, and this Worker already has D1
// write access, so it is the natural owner.
//
// The route contract below is deliberately the SAME shape the EC2 API returned,
// so callers written against that API keep working unchanged.
//
// SCOPE: captions only. A video with no caption track cannot be transcribed here
// at all — the ASR fallback needs the audio, which only the AWS side can push to
// Deepgram, and that path is IP-blocked. Those are marked failed with a plain
// explanation rather than left looking like they're still queued.

const YT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const YT_ACCEPT_LANGUAGE = "en-US,en;q=0.9";
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
// AWS writes these same tables using Postgres serial ids (currently ~150, growing
// slowly). Worker-created rows live above this floor so the two id spaces can
// never collide and overwrite each other's transcripts.
const YT_ID_FLOOR = 1000000000;
const YT_ID_ATTEMPTS = 25; // same-millisecond id collisions retry from the floor up
// Every request in the same millisecond would otherwise start from the SAME
// candidate and walk forward in lockstep, so N of them need N probes each and
// the 26th fails outright — and the ids they claim push the collision into the
// next millisecond too. A random offset spreads the starting points instead, so
// the probe only ever handles the rare genuine clash. Well clear of AWS's small
// Postgres serials either way, which is all the floor has to guarantee.
const YT_ID_JITTER = 4096;
const YT_SEGMENT_CHUNK = 100; // segment INSERTs per D1 batch
// Bounds what one account can make us fetch and store: every submission is a
// YouTube round trip plus a row and potentially thousands of segment rows.
const MAX_VIDEOS_PER_USER = 300;
// A row left "processing" by an interrupted request would otherwise look like
// an active concurrent write forever, and the video would sit transcribing for
// good. Past this age it is treated as orphaned and retried.
const YT_PROCESSING_STALE_MS = 2 * 60 * 1000;
// The public InnerTube web key, used only when the (bot-gated) watch page didn't
// give us one to scrape. Not a secret — it ships in every youtube.com page.
const YT_PUBLIC_INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const YT_SUMMARY_PREFIX = "ytsummary:v1:";

// Short, human error text — this renders straight into the customer's transcript
// page, so it never carries a stack or a wall of library output.
const YT_MESSAGES = {
  NO_CAPTIONS: "This video has no captions available.",
  IS_LIVE: "Video is a live stream; wait until it has ended.",
  BOT_GATED: "Temporarily unable to reach YouTube. Try again shortly.",
  UPSTREAM_ERROR: "Temporarily unable to reach YouTube. Try again shortly.",
  BAD_VIDEO_ID: "That doesn't look like a YouTube video link.",
  UNAVAILABLE: "This video is unavailable.",
  // Not "try again shortly": retrying is exactly what will not help. The free
  // provider limits by IP, and this Worker shares its egress IPs with the rest
  // of Cloudflare, so that bucket is spent by strangers no matter what we do.
  PROVIDER_LIMIT: "The transcript service is over its free limit. A transcript API key needs to be configured.",
  // Told apart from the above on purpose. Once a key IS set, "an API key needs
  // to be configured" tells whoever reads it to do the thing they already did —
  // and on the free tier this is the message they will see most.
  PROVIDER_QUOTA: "The transcript service has used up its quota. The transcript API key needs more credit.",
  PROVIDER_AUTH: "The transcript API key was rejected. It needs checking.",
};

// Where YouTube lives. Overridable only by an operator (a var, not user input) so
// the fetch/parse path can be pointed at a fixture server in local testing; any
// non-https value is ignored so it can never be turned into an open proxy.
function ytOrigin(env) {
  const raw = String((env && env.YT_ORIGIN) || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s]+$/i.test(raw) || /^http:\/\/127\.0\.0\.1:\d+$/.test(raw) ? raw : "https://www.youtube.com";
}

function ytHeaders(extra) {
  return {
    "User-Agent": YT_UA,
    "Accept-Language": YT_ACCEPT_LANGUAGE,
    ...(extra || {}),
  };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The 11-character video id out of any YouTube URL shape (watch, youtu.be,
// shorts, embed, live) or a bare id. A non-YouTube host is REJECTED: the caller's
// URL is never fetched as given, only a rebuilt watch URL for the id we parsed.
function parseYoutubeUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (YT_ID_RE.test(raw)) return { videoId: raw, url: `https://www.youtube.com/watch?v=${raw}` };
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./i, "").toLowerCase();
  let id = "";
  if (host === "youtu.be") {
    id = u.pathname.split("/").filter(Boolean)[0] || "";
  } else if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") {
    id = u.searchParams.get("v") || "";
    if (!id) {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && ["shorts", "embed", "live", "v"].includes(parts[0].toLowerCase())) id = parts[1];
    }
  } else {
    return null; // never fetch a caller-supplied host
  }
  id = String(id || "").trim();
  if (!YT_ID_RE.test(id)) return null;
  return { videoId: id, url: `https://www.youtube.com/watch?v=${id}` };
}

// ── Fetching the player response ─────────────────────────────────────────────

// Pulls the first complete JSON object following `marker`, matching braces while
// respecting string literals and escapes. A regex up to the next "};" breaks on
// any brace inside a caption or title string, which real pages contain.
function extractJsonAfter(html, marker) {
  const at = html.indexOf(marker);
  if (at === -1) return null;
  const start = html.indexOf("{", at + marker.length);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return safeJsonParse(html.slice(start, i + 1));
  }
  return null;
}

function playerResponseFromHtml(html) {
  return extractJsonAfter(html, "ytInitialPlayerResponse");
}

function innertubeKeyFromHtml(html) {
  const m = /"INNERTUBE_API_KEY":"([A-Za-z0-9_-]+)"/.exec(html || "");
  return m ? m[1] : "";
}

function playabilityOf(player) {
  const ps = (player && player.playabilityStatus) || {};
  let reason = String(ps.reason || "");
  if (!reason && ps.errorScreen) {
    const r = ps.errorScreen.playerErrorMessageRenderer || ps.errorScreen.playerLegacyDesktopYpcTrailerRenderer || {};
    reason = String((r.reason && (r.reason.simpleText || "")) || (r.subreason && r.subreason.simpleText) || "");
  }
  return { status: String(ps.status || ""), reason: reason.trim() };
}

// YouTube's anti-bot challenge, however it shows up: the interstitial HTML, or a
// playability status carrying the "confirm you're not a bot" reason.
function looksBotGated(reason, html) {
  if (/not a bot|sign in to confirm/i.test(reason || "")) return true;
  return /\/sorry\/index|captcha-form|<title>Sorry\.\.\./i.test(html || "");
}

// The InnerTube player API — the ONE fallback we allow when the watch page is
// gated. Hammering YouTube beyond this is how Cloudflare's egress gets blocked
// too, so there is no retry loop anywhere in this path.
async function innertubePlayer(env, videoId, apiKey) {
  const key = apiKey || YT_PUBLIC_INNERTUBE_KEY;
  const res = await fetch(`${ytOrigin(env)}/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`, {
    method: "POST",
    headers: ytHeaders({
      "Content-Type": "application/json",
      "X-YouTube-Client-Name": "1",
      "X-YouTube-Client-Version": "2.20240401.00.00",
      Origin: "https://www.youtube.com",
    }),
    body: JSON.stringify({
      videoId,
      context: {
        client: { clientName: "WEB", clientVersion: "2.20240401.00.00", hl: "en", gl: "US" },
      },
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  if (!res.ok) return null;
  return safeJsonParse(await res.text().catch(() => ""));
}

// The player response for a video: the watch page first, then a single InnerTube
// fallback if that page is bot-gated or unparseable. Returns
// { ok: true, player } or { ok: false, code, error }.
async function fetchPlayerResponse(env, videoId) {
  let html = "";
  let player = null;
  try {
    const res = await fetch(`${ytOrigin(env)}/watch?v=${encodeURIComponent(videoId)}&hl=en&bpctr=9999999999&has_verified=1`, {
      headers: ytHeaders({
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        // Skips the EU consent interstitial, which otherwise serves a page with
        // no player response at all.
        Cookie: "CONSENT=YES+1; SOCS=CAI",
      }),
    });
    html = await res.text().catch(() => "");
    if (res.ok) player = playerResponseFromHtml(html);
  } catch {
    /* network failure — the InnerTube fallback below still gets a turn */
  }

  const gatedPage = !player || looksBotGated(playabilityOf(player).reason, html);
  if (gatedPage) {
    let fallback = null;
    try {
      fallback = await innertubePlayer(env, videoId, innertubeKeyFromHtml(html));
    } catch {
      fallback = null;
    }
    if (fallback) {
      const { reason } = playabilityOf(fallback);
      // `degraded` records that the watch page was gated, so what came back is
      // whatever YouTube is willing to tell a blocked IP — see the caller.
      if (!looksBotGated(reason, "")) return { ok: true, player: fallback, degraded: true };
    }
    if (!player) return { ok: false, code: "BOT_GATED", error: YT_MESSAGES.BOT_GATED };
    if (looksBotGated(playabilityOf(player).reason, html)) {
      return { ok: false, code: "BOT_GATED", error: YT_MESSAGES.BOT_GATED };
    }
  }
  if (!player) return { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR };
  return { ok: true, player };
}

// ── Choosing a caption track ─────────────────────────────────────────────────

// Manual beats auto-generated (auto has no real punctuation model). Within a
// kind: en, then en-US, then en-GB, then the video's own language, then the
// shortest code — so a plain "hi" wins over machine-translated "hi-Latn".
function captionTrackRank(track, videoLanguage) {
  const code = String((track && track.languageCode) || "");
  if (code === "en") return 0;
  if (code === "en-US") return 1;
  if (code === "en-GB") return 2;
  if (videoLanguage && code === videoLanguage) return 3;
  return 4;
}

function pickCaptionTrack(tracks, videoLanguage) {
  let best = null;
  let bestKey = null;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (!t || !t.baseUrl) continue;
    const key = [
      String(t.kind || "") === "asr" ? 1 : 0,
      captionTrackRank(t, videoLanguage),
      String(t.languageCode || "").length,
      i,
    ];
    if (!bestKey || compareKeys(key, bestKey) < 0) {
      best = t;
      bestKey = key;
    }
  }
  return best;
}

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function videoLanguageOf(player) {
  const details = (player && player.videoDetails) || {};
  const micro = (player && player.microformat && player.microformat.playerMicroformatRenderer) || {};
  return String(details.defaultAudioLanguage || micro.defaultAudioLanguage || "").trim();
}

// ── json3 parsing ────────────────────────────────────────────────────────────
// Shape: { events: [ { tStartMs, dDurationMs, segs: [ { utf8 } ] } ] }. Single
// pass, no per-event intermediate arrays — a 3-hour auto-caption track is
// thousands of events and this runs inside the Worker's CPU budget.
function parseJson3(data) {
  const events = data && Array.isArray(data.events) ? data.events : [];
  const rows = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    const segs = ev.segs;
    if (!Array.isArray(segs) || !segs.length) continue;
    // One line is often split across several segs.
    let text = "";
    for (let k = 0; k < segs.length; k++) {
      const seg = segs[k];
      if (seg && typeof seg.utf8 === "string") text += seg.utf8;
    }
    // Collapses the newlines auto-captions carry inside a cue, and drops
    // positioning-only events, which have segs but no printable text.
    text = text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    // aAppend means "append to what is on screen", and auto-generated tracks
    // interleave one between every real line whose only content is a newline —
    // those vanish in the trim above, which is what stops the segment count
    // doubling and a blank line landing between every sentence. But the flag
    // describes rendering, not content: an append event CAN carry real words.
    // Appending them to the previous line keeps that text without inventing a
    // separate cue for it (and without duplicating it as one).
    //
    // With nothing on screen yet there is no line to append to — a track can
    // open with an append, or everything before it can have been positioning
    // only. Fall through and let it become a cue of its own, which is what it
    // renders as anyway; dropping it would lose the words outright.
    if (ev.aAppend && rows.length) {
      const prev = rows[rows.length - 1];
      prev.text += ` ${text}`;
      // The append carries its own timing, and it is later than the line it
      // joins. Taking only the text would leave the cue ending before half of
      // its own words are spoken, so every timestamp link and citation into
      // that stretch points at the wrong moment. Carry the append's end as a
      // floor on the cue's, which only ever extends it.
      const apStart = Number(ev.tStartMs);
      if (Number.isFinite(apStart) && apStart >= 0) {
        const apDur = Number(ev.dDurationMs);
        const apEnd = apStart + (Number.isFinite(apDur) && apDur > 0 ? apDur : 0);
        if (prev.minEndMs == null || apEnd > prev.minEndMs) prev.minEndMs = apEnd;
      }
      continue;
    }
    const startMs = Number(ev.tStartMs);
    if (!Number.isFinite(startMs) || startMs < 0) continue;
    const durMs = Number(ev.dDurationMs);
    rows.push({ startMs, durMs: Number.isFinite(durMs) && durMs > 0 ? durMs : null, minEndMs: null, text });
  }
  rows.sort((a, b) => a.startMs - b.startMs);

  const segments = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // dDurationMs is absent on some events: fall back to the next event's start,
    // and for the last event to start + 2s. An append merged into this cue then
    // raises the floor, so the cue covers the words it actually carries.
    let endMs =
      row.durMs != null ? row.startMs + row.durMs : i + 1 < rows.length ? rows[i + 1].startMs : row.startMs + 2000;
    if (row.minEndMs != null && row.minEndMs > endMs) endMs = row.minEndMs;
    segments[i] = {
      index: i,
      start: Math.round(row.startMs) / 1000,
      end: Math.round(Math.max(endMs, row.startMs)) / 1000,
      text: row.text,
    };
  }
  return segments;
}

// Is this stream live RIGHT NOW? `isLiveContent` alone is not the answer — it
// stays true for the VOD of a stream that has already ended, which we do want to
// transcribe. The reliable signals are videoDetails.isLive (when present) and
// the microformat's liveBroadcastDetails.isLiveNow; a broadcast with no
// endTimestamp recorded has not finished either.
function isLiveNow(player) {
  const details = (player && player.videoDetails) || {};
  if (details.isLive === true || details.isLiveNow === true) return true;
  const micro = (player && player.microformat && player.microformat.playerMicroformatRenderer) || {};
  const live = micro.liveBroadcastDetails || {};
  if (live.isLiveNow === true) return true;
  if (details.isLiveContent === true && live.startTimestamp && !live.endTimestamp) return true;
  return false;
}

// Fetches and parses the best caption track for a video. Returns
// { ok: true, title, channel, durationSeconds, language, isAutoGenerated, segments }
// or { ok: false, code, error } with a message fit to show a customer.
async function ytProviderDirect(env, videoId) {
  const got = await fetchPlayerResponse(env, videoId);
  if (!got.ok) return got;
  const player = got.player;
  // The watch page was bot-gated and this came from the fallback, so YouTube is
  // already treating this egress as a bot. Verified against the deployed Worker:
  // in that state it answers with the video's REAL title but UNPLAYABLE /
  // "Video unavailable" and zero caption tracks — for videos that are perfectly
  // available elsewhere. Reporting that as "unavailable" or "no captions" would
  // blame the video for our own egress being blocked, so both read as gated.
  const degraded = !!got.degraded;
  const details = player.videoDetails || {};
  const { status, reason } = playabilityOf(player);

  if (isLiveNow(player)) {
    return { ok: false, code: "IS_LIVE", error: YT_MESSAGES.IS_LIVE };
  }
  if (status && status !== "OK") {
    if (degraded) return { ok: false, code: "BOT_GATED", error: YT_MESSAGES.BOT_GATED };
    // Pass YouTube's own wording through for private / removed / age-gated.
    return { ok: false, code: "UNAVAILABLE", error: reason || YT_MESSAGES.UNAVAILABLE };
  }

  const tracklist = player.captions && player.captions.playerCaptionsTracklistRenderer;
  const tracks = (tracklist && Array.isArray(tracklist.captionTracks) && tracklist.captionTracks) || [];
  if (!tracks.length) {
    return degraded
      ? { ok: false, code: "BOT_GATED", error: YT_MESSAGES.BOT_GATED }
      : { ok: false, code: "NO_CAPTIONS", error: YT_MESSAGES.NO_CAPTIONS };
  }

  const track = pickCaptionTrack(tracks, videoLanguageOf(player));
  if (!track) return { ok: false, code: "NO_CAPTIONS", error: YT_MESSAGES.NO_CAPTIONS };

  let base = String(track.baseUrl || "");
  if (base.startsWith("//")) base = `https:${base}`;
  else if (base.startsWith("/")) base = `${ytOrigin(env)}${base}`;
  const url = base + (base.includes("?") ? "&" : "?") + "fmt=json3";

  let payload;
  try {
    const res = await fetch(url, { headers: ytHeaders({ Accept: "application/json" }) });
    if (!res.ok) return { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR };
    payload = safeJsonParse(await res.text().catch(() => ""));
  } catch {
    return { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR };
  }
  // The player response already proved this track exists, so an empty or
  // unparseable body is a failed fetch (an expired signed URL, or that endpoint
  // being gated) — NOT a captionless video. Calling it NO_CAPTIONS would store a
  // permanent "no captions available" and tell the user to stop retrying.
  if (!payload || !Array.isArray(payload.events)) {
    return { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR };
  }

  const segments = parseJson3(payload);
  if (!segments.length) return { ok: false, code: "NO_CAPTIONS", error: YT_MESSAGES.NO_CAPTIONS };

  return {
    ok: true,
    title: String(details.title || ""),
    channel: String(details.author || ""),
    durationSeconds: Number(details.lengthSeconds) || 0,
    language: String(track.languageCode || ""),
    isAutoGenerated: String(track.kind || "") === "asr",
    segments,
  };
}

/* ------------------------- transcript providers ---------------------------- */
// YouTube blocks the egress of every cloud host we can run on — EC2's and
// Cloudflare's alike, verified against the deployed Worker. So the outbound leg
// goes through somebody whose IPs YouTube still answers. Everything else in this
// file is unchanged by that: a provider's only job is to return the same shape
// ytProviderDirect does.
//
// Order, and why:
//   1. Supadata, when SUPADATA_API_KEY is set. It returns per-cue offsets and
//      durations in milliseconds, which is exactly the model here — no timing is
//      invented or lost.
//   2. youtube-transcript.ai, which needs no key at all, so the feature works
//      with nothing configured. It costs accuracy: paragraph-level timestamps
//      instead of per-cue, and auto-generated captions arrive with YouTube's
//      rolling-window repetition still in them (see ytCollapseRepeats).
//   3. Direct — only when an operator asks for it. It is the best source by far
//      when it works, but we have measured that it does not: YouTube gates this
//      egress. Leaving it in the chain would spend a doomed request on every
//      single fetch, and a gated reply reads as "video unavailable", which would
//      then overwrite a correct answer from a provider that DID reach YouTube.
//      Set YT_ALLOW_DIRECT once the egress is clean (a proxy, or Cloudflare's
//      reputation recovering) and it comes back as the last resort.
//
// An operator who sets YT_ORIGIN (tests, or a proxy with clean IPs) means "fetch
// from YouTube yourself" — then that is the only provider used.

function ytProviderOrigin(env, name, fallback) {
  const raw = String((env && env[name]) || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s]+$/i.test(raw) || /^http:\/\/127\.0\.0\.1:\d+$/.test(raw) ? raw : fallback;
}

// Auto-generated captions are a rolling window: YouTube re-sends the line on
// screen with each new phrase appended, so a naive join repeats every phrase two
// or three times ("hello giraffe how are you today why the hello giraffe how are
// you today why the long neck..."). The json3 path never sees this because the
// cue boundaries are intact there; a provider that hands back joined prose has
// already lost them, so the repetition has to be undone by looking at it.
//
// Only immediate repeats of three or more words are collapsed: shorter windows
// would eat real speech ("no no no", "very very"), and a repeat that is not
// adjacent is someone genuinely saying the same thing twice.
function ytCollapseRepeats(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const out = [];
  let i = 0;
  while (i < words.length) {
    let collapsed = false;
    // Longest window first: matching "a b c" inside "a b c d a b c d" would
    // leave the "d" stranded, so try the biggest repeat that fits.
    const max = Math.min(14, out.length, words.length - i);
    for (let k = max; k >= 3; k--) {
      let same = true;
      for (let j = 0; j < k; j++) {
        if (out[out.length - k + j] !== words[i + j]) {
          same = false;
          break;
        }
      }
      if (same) {
        i += k;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) out.push(words[i++]);
  }
  return out.join(" ");
}

// "[1:07]" / "[1:02:07]" -> seconds.
function ytStampSeconds(stamp) {
  const parts = String(stamp).split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// Supadata: { lang, content: [ { text, offset, duration, lang } ] }, all ms.
async function ytProviderSupadata(env, videoId) {
  const key = String((env && env.SUPADATA_API_KEY) || "").trim();
  if (!key) return null; // not configured — not a failure, just not available
  const origin = ytProviderOrigin(env, "SUPADATA_ORIGIN", "https://api.supadata.ai");
  const url = `${origin}/v1/transcript?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  let res;
  try {
    res = await fetch(url, { headers: { "x-api-key": key, Accept: "application/json" } });
  } catch (err) {
    return { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR, detail: `supadata threw: ${String((err && err.message) || err)}` };
  }
  const raw = await res.text().catch(() => "");
  const body = safeJsonParse(raw) || {};
  const detail = `supadata ${res.status} ${JSON.stringify(String(raw).slice(0, 120))}`;
  if (!res.ok) {
    // Their own wording for a video that genuinely has nothing to transcribe,
    // so it is not retried forever as though it were a transport failure.
    const reason = String(body.message || body.error || "");
    if (res.status === 404 || /no transcript|not found|unavailable/i.test(reason)) {
      return { ok: false, code: "NO_CAPTIONS", error: YT_MESSAGES.NO_CAPTIONS, detail };
    }
    // A rejected key and a spent one need different answers: one is a typo in
    // the secret, the other is a plan that ran out.
    if (res.status === 401 || res.status === 403 || /invalid|unauthor/i.test(reason)) {
      return { ok: false, code: "PROVIDER_AUTH", error: YT_MESSAGES.PROVIDER_AUTH, detail };
    }
    if (res.status === 402 || res.status === 429 || /quota|limit|credit/i.test(reason)) {
      return { ok: false, code: "PROVIDER_QUOTA", error: YT_MESSAGES.PROVIDER_QUOTA, detail };
    }
    return { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR, detail };
  }
  const content = Array.isArray(body.content) ? body.content : null;
  if (!content) return { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR, detail };

  const segments = [];
  for (const cue of content) {
    const text = String((cue && cue.text) || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const startMs = Number(cue.offset);
    if (!Number.isFinite(startMs) || startMs < 0) continue;
    const durMs = Number(cue.duration);
    segments.push({
      index: segments.length,
      start: Math.round(startMs) / 1000,
      end: Math.round(startMs + (Number.isFinite(durMs) && durMs > 0 ? durMs : 2000)) / 1000,
      text,
    });
  }
  if (!segments.length) return { ok: false, code: "NO_CAPTIONS", error: YT_MESSAGES.NO_CAPTIONS, detail };
  segments.sort((a, b) => a.start - b.start);
  segments.forEach((s, i) => {
    s.index = i;
  });
  return {
    ok: true,
    // This endpoint returns the transcript only; the row keeps whatever title,
    // channel and duration it already had rather than being blanked.
    title: "",
    channel: "",
    durationSeconds: 0,
    language: String(body.lang || ""),
    isAutoGenerated: false,
    segments,
  };
}

// youtube-transcript.ai: markdown, keyless. A metadata header, then paragraphs
// prefixed with [m:ss].
async function ytProviderKeyless(env, videoId) {
  const origin = ytProviderOrigin(env, "YT_TEXT_ORIGIN", "https://youtube-transcript.ai");
  let res;
  let body;
  try {
    res = await fetch(`${origin}/transcript/${encodeURIComponent(videoId)}.txt`, {
      // A bare datacenter request with no browser identity is what bot
      // protection in front of a service like this exists to challenge, and a
      // challenge comes back as HTTP 200 carrying HTML.
      headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.8", "User-Agent": YT_UA },
    });
    body = await res.text().catch(() => "");
  } catch (err) {
    return { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR, detail: `keyless threw: ${String((err && err.message) || err)}` };
  }
  // What came back, in a form that can be read from the API response. No
  // secrets pass through here — it is our own upstream's status line and the
  // opening of its body — and without it a production failure is a guess.
  const detail =
    `keyless ${res.status} ${String(res.headers.get("content-type") || "")} ` +
    `${body.length}b ${JSON.stringify(String(body).slice(0, 120))}`;
  if (!res.ok) {
    // It answers 404 with "Reason: {"error":"YouTube: ..."}" for both a missing
    // video and one with captions turned off. Only the second is permanent.
    const reason = /Reason:\s*(.*)/.exec(body || "");
    const reasonText = reason ? reason[1] : "";
    if (/no transcript|captions? (are )?disabled|no captions/i.test(reasonText)) {
      return { ok: false, code: "NO_CAPTIONS", error: YT_MESSAGES.NO_CAPTIONS, detail };
    }
    if (/unavailable|private|removed|does not exist/i.test(reasonText)) {
      return { ok: false, code: "UNAVAILABLE", error: YT_MESSAGES.UNAVAILABLE, detail };
    }
    if (res.status === 429 || /high volume|rate.?limit/i.test(body)) {
      return { ok: false, code: "PROVIDER_LIMIT", error: YT_MESSAGES.PROVIDER_LIMIT, detail };
    }
    return { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR, detail };
  }

  const title = (/^#\s*Transcript:\s*(.+)$/m.exec(body) || [, ""])[1].trim();
  const langLine = /^Language:\s*(.+)$/m.exec(body);
  let language = "";
  let durationSeconds = 0;
  let isAutoGenerated = false;
  if (langLine) {
    const line = langLine[1];
    language = (/^([A-Za-z-]+)/.exec(line) || [, ""])[1];
    isAutoGenerated = /auto-generated/i.test(line);
    const dur = /Duration:\s*([\d:]+)/.exec(line);
    if (dur) durationSeconds = ytStampSeconds(dur[1]) || 0;
  }

  // Anything can answer 200. A challenge page, an interstitial or a rewritten
  // error all arrive that way, and none of them say anything about the video —
  // so the reply has to be recognisable as this service's own document before a
  // shortage of cues in it is allowed to mean "this video has no captions".
  // Getting that wrong stores a permanent verdict over a transport failure and
  // tells the user to stop trying.
  // Their rate limit is an HTTP 200 carrying a sales pitch, so it has to be
  // recognised by what it says. Reporting it as a transport blip would tell the
  // user to retry forever against a bucket they can never get back.
  if (/calling this API at high volume|higher rate limits?|rate.?limit/i.test(body)) {
    return { ok: false, code: "PROVIDER_LIMIT", error: YT_MESSAGES.PROVIDER_LIMIT, detail };
  }
  const start = body.indexOf("## Transcript");
  if (start === -1 || !/^#\s*Transcript/m.test(body)) {
    return { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR, detail };
  }
  const transcript = body.slice(start + "## Transcript".length);
  const raw = [];
  const re = /\[(\d+(?::\d+){1,2})\]\s*([^[]*)/g;
  let m;
  while ((m = re.exec(transcript)) !== null) {
    const at = ytStampSeconds(m[1]);
    if (at == null) continue;
    let text = m[2].replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (isAutoGenerated) text = ytCollapseRepeats(text);
    if (!text) continue;
    raw.push({ start: at, text });
  }
  if (!raw.length) return { ok: false, code: "NO_CAPTIONS", error: YT_MESSAGES.NO_CAPTIONS, detail };

  raw.sort((a, b) => a.start - b.start);
  const segments = raw.map((row, i) => ({
    index: i,
    start: row.start,
    // Paragraph-level stamps: a block runs until the next one begins. The last
    // one runs to the video's end when we know it, and otherwise gets the same
    // 2s tail the json3 path gives a final cue.
    end: i + 1 < raw.length ? raw[i + 1].start : Math.max(durationSeconds || 0, row.start + 2),
    text: row.text,
  }));
  return { ok: true, title, channel: "", durationSeconds, language, isAutoGenerated, segments };
}

// A definite answer about the VIDEO beats a transport failure: if one provider
// says the video is private and another simply couldn't be reached, the user
// should be told it is private rather than to keep retrying.
const YT_ERROR_RANK = {
  NO_CAPTIONS: 3,
  IS_LIVE: 4,
  UNAVAILABLE: 4,
  BAD_VIDEO_ID: 4,
  BOT_GATED: 1,
  UPSTREAM_ERROR: 1,
  // Above the transport failures, below anything about the video: they say
  // something true and actionable about us, but a provider that actually
  // reached YouTube still knows better about the video itself. A configured
  // key's own problem outranks the shared free tier being spent, because it is
  // the one whoever set it up can actually do something about.
  PROVIDER_LIMIT: 2,
  PROVIDER_QUOTA: 2.5,
  PROVIDER_AUTH: 2.5,
};

async function fetchYoutubeTranscript(env, videoId) {
  const allowDirect = /^(1|true|yes)$/i.test(String((env && env.YT_ALLOW_DIRECT) || "").trim());
  const chain = String((env && env.YT_ORIGIN) || "").trim()
    ? [ytProviderDirect]
    : allowDirect
      ? [ytProviderSupadata, ytProviderKeyless, ytProviderDirect]
      : [ytProviderSupadata, ytProviderKeyless];

  let best = null;
  const tried = [];
  for (const provider of chain) {
    let out;
    try {
      out = await provider(env, videoId);
    } catch {
      out = { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR };
    }
    if (!out) continue; // provider not configured
    if (out.ok) return out;
    // A live stream is the one answer worth stopping on: no provider can
    // transcribe it, and asking the next one just spends another request.
    if (out.code === "IS_LIVE") return out;
    // (falls through to record what this provider said)
    tried.push(out.detail || out.code);
    if (!best || (YT_ERROR_RANK[out.code] || 0) > (YT_ERROR_RANK[best.code] || 0)) best = out;
  }
  // Every provider's answer, not just the winning error: with the chain, "could
  // not reach YouTube" alone doesn't say WHICH hop failed or how, and that is
  // the difference between a retry and a configuration change.
  const detail = tried.join(" | ");
  if (best) return { ...best, detail };
  return { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR, detail };
}

/* ---------------------- transcripts: D1 storage layer ---------------------- */
// The two tables are deployed and AWS writes them too, so this code NEVER
// creates or alters them. The one addition is a unique index, which is additive
// and idempotent, and backs the "one transcript per (owner, video)" rule.

const YT_COLUMNS =
  "transcript_id, user_id, owner_email, video_id, url, title, channel, duration_seconds, " +
  "status, source, language, segment_count, error, created_at, updated_at, completed_at";

let ytIndexReady = false;
async function ensureYoutubeIndex(env) {
  if (ytIndexReady || !env.DB) return;
  try {
    await env.DB.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_yt_owner_video ON youtube_transcripts (owner_email, video_id)"
    ).run();
    ytIndexReady = true;
  } catch {
    // Creation fails if the table already holds a duplicate (owner, video) pair.
    // Marking it ready anyway would quietly leave idempotency resting on the
    // lookup alone, which two concurrent inserts can slip past — so the flag
    // stays clear and the next request tries again. The lookup still runs
    // meanwhile, so behaviour degrades rather than breaking.
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function ytRowByOwnerVideo(env, owner, videoId) {
  // Ordered, not just LIMIT 1: if the unique index couldn't be created because
  // the table already held duplicates for this pair, an unordered pick would
  // resolve to a different row from one request to the next. Preferring a
  // completed row, then the newest, at least makes the choice deterministic and
  // useful while the duplicates remain.
  const res = await env.DB.prepare(
    `SELECT ${YT_COLUMNS} FROM youtube_transcripts WHERE owner_email = ?1 AND video_id = ?2 ` +
      "ORDER BY (status = 'completed') DESC, transcript_id DESC LIMIT 1"
  )
    .bind(normalizeEmail(owner), videoId)
    .all();
  return (res.results && res.results[0]) || null;
}

async function ytRowById(env, id) {
  const res = await env.DB.prepare(`SELECT ${YT_COLUMNS} FROM youtube_transcripts WHERE transcript_id = ?1 LIMIT 1`)
    .bind(id)
    .all();
  return (res.results && res.results[0]) || null;
}

// Every transcript an account owns, newest first. `owner` null lists them all
// (admin's cross-account view).
async function ytRowsForOwner(env, owner) {
  const sql = `SELECT ${YT_COLUMNS} FROM youtube_transcripts` + (owner ? " WHERE owner_email = ?1" : "") + " ORDER BY created_at DESC, transcript_id DESC";
  const stmt = owner ? env.DB.prepare(sql).bind(normalizeEmail(owner)) : env.DB.prepare(sql);
  const res = await stmt.all();
  return res.results || [];
}

// Counting and then inserting is not atomic: a burst of concurrent submissions
// from one account can all read a count below the cap and all insert. The cap
// therefore lives INSIDE the insert — the row only materializes if the account
// is still under it at the moment the statement runs.
function ytInsertUnderCap(env, row) {
  return env.DB.prepare(
    "INSERT INTO youtube_transcripts " +
      "(transcript_id, user_id, owner_email, video_id, url, title, channel, duration_seconds, " +
      "status, source, language, segment_count, error, created_at, updated_at, completed_at) " +
      "SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16 " +
      "WHERE (SELECT COUNT(*) FROM youtube_transcripts WHERE owner_email = ?3) < ?17"
  ).bind(
    row.transcript_id,
    0, // user_id is AWS's Postgres id, which this Worker doesn't know
    row.owner_email,
    row.video_id,
    row.url,
    row.title || null,
    row.channel || null,
    row.duration_seconds || null,
    row.status,
    row.source || null,
    row.language || null,
    row.segment_count || 0,
    row.error || null,
    row.created_at,
    row.updated_at,
    row.completed_at || null,
    MAX_VIDEOS_PER_USER
  );
}

async function ytSegmentRows(env, id) {
  const res = await env.DB.prepare(
    "SELECT segment_index, start_time, end_time, text, speaker, language FROM youtube_transcript_segments " +
      "WHERE transcript_id = ?1 ORDER BY segment_index"
  )
    .bind(id)
    .all();
  return res.results || [];
}

// Allocates a transcript_id in the Worker's own range: the clock for ordering,
// a random offset (see YT_ID_JITTER) so concurrent inserts don't all start from
// the same candidate, and a bounded forward probe for the clash that survives
// both. Ordering stays by created_at, which transcript_id only ever tie-breaks,
// so the jitter costs nothing there.
async function ytInsertRow(env, row) {
  let candidate = YT_ID_FLOOR + Date.now() + Math.floor(Math.random() * YT_ID_JITTER);
  for (let attempt = 0; attempt < YT_ID_ATTEMPTS; attempt++) {
    try {
      const res = await ytInsertUnderCap(env, { ...row, transcript_id: candidate }).run();
      // No row written and no error: the capped INSERT ... SELECT matched
      // nothing, i.e. the account is at its limit.
      const changes = (res && res.meta && res.meta.changes) || 0;
      if (!changes) return { id: 0, atCap: true };
      return { id: candidate, existed: false };
    } catch (err) {
      const message = String((err && err.message) || err);
      // A clash on (owner_email, video_id) means someone else just created the
      // same transcript — hand back whatever now exists instead of duplicating.
      if (/uq_yt_owner_video|owner_email/i.test(message)) {
        const existing = await ytRowByOwnerVideo(env, row.owner_email, row.video_id);
        // The caller must NOT go on to fetch and write segments for a row it
        // didn't create — both requests would replace each other's segments.
        if (existing) return { id: existing.transcript_id, existed: true };
      }
      if (!/UNIQUE|PRIMARY KEY|constraint/i.test(message)) throw err;
      candidate++;
    }
  }
  throw new Error("Could not allocate a transcript id");
}

// Claims a failed or stale row for THIS request before any fetching happens.
// Two concurrent retries of the same row would otherwise both run the pipeline,
// and a later failure could overwrite the row the other one just populated. The
// claim is a conditional update: exactly one request can move the row out of the
// state it was in, and the loser backs off and returns the active writer's row.
// `allowCompleted` is for a forced refresh, which is the one case that starts
// from a row that already works. Without it two concurrent force requests both
// walk past the claim — the cooldown that is supposed to stop them lives in KV
// and is eventually consistent — and then both fetch and both write the same
// segment indexes, interleaving two transcripts and letting one request's
// failure handling overwrite the other's success.
async function ytClaimForRetry(env, id, staleBefore, allowCompleted = false) {
  const res = await env.DB.prepare(
    "UPDATE youtube_transcripts SET status = 'processing', error = NULL, updated_at = ?2 " +
      "WHERE transcript_id = ?1 AND (status = 'failed' OR status = 'queued' OR " +
      (allowCompleted ? "status = 'completed' OR " : "") +
      "((status = 'processing') AND (updated_at IS NULL OR updated_at < ?3)))"
  )
    .bind(id, nowIso(), staleBefore)
    .run();
  return ((res && res.meta && res.meta.changes) || 0) > 0;
}

async function ytUpdateRow(env, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k, i) => `${k} = ?${i + 2}`).join(", ");
  await env.DB.prepare(`UPDATE youtube_transcripts SET ${sets} WHERE transcript_id = ?1`)
    .bind(id, ...keys.map((k) => fields[k]))
    .run();
}

// Replaces a transcript's segments.
//
// Deleting everything and re-inserting would leave a window where the row is
// still `completed` but has no segments — a concurrent reader (or a forced
// refresh that fails partway) would see an empty or half-written transcript. So
// nothing is deleted up front: each index is UPSERTed in place, and only the
// tail left over from a longer previous transcript is removed at the end. A
// reader during the write sees old-or-new text at every index, never a gap.
//
// When the whole replacement fits in one D1 batch it is sent as one, which is
// atomic — no window at all. Longer transcripts (a 3-hour auto-caption track is
// thousands of cues) are chunked, which is why the upsert ordering above
// matters.
// D1 caps bound parameters per query at 100, so each statement carries as many
// whole rows as fit: 8 columns => 12 rows, 96 parameters. That matters because
// every statement counts against D1's per-invocation query limit even inside a
// batch — one statement per cue exhausted it partway through a multi-hour track
// (thousands of cues), leaving the row stuck in `processing` and every retry
// failing the same way. At 12 rows a statement, a 3-hour transcript is a few
// hundred queries instead of a few thousand.
const YT_ROWS_PER_STATEMENT = 12;
const YT_ATOMIC_MAX = 40; // statements still sent as a single atomic batch

function ytSegmentInsert(env, id, email, language, chunk) {
  const values = [];
  const binds = [];
  for (let i = 0; i < chunk.length; i++) {
    const base = i * 8;
    values.push(`(?${base + 1}, ?${base + 2}, ?${base + 3}, ?${base + 4}, ?${base + 5}, ?${base + 6}, ?${base + 7}, ?${base + 8})`);
    // speaker is NULL on the captions path — YouTube gives no diarization.
    binds.push(id, chunk[i].index, chunk[i].start, chunk[i].end, chunk[i].text, null, language || null, email);
  }
  return env.DB.prepare(
    "INSERT OR REPLACE INTO youtube_transcript_segments " +
      "(transcript_id, segment_index, start_time, end_time, text, speaker, language, owner_email) VALUES " +
      values.join(", ")
  ).bind(...binds);
}

// Does a replacement of this many cues go in as ONE atomic batch? Beyond this
// it commits in pieces, and the row holds a mix of new and old cues until the
// last one lands. Callers that had a working transcript need to know which of
// the two they are about to do — see the staging in createYoutubeTranscript.
function ytReplaceIsAtomic(count) {
  return Math.ceil(count / YT_ROWS_PER_STATEMENT) + 1 <= YT_ATOMIC_MAX;
}

async function ytReplaceSegments(env, id, owner, language, segments) {
  const email = normalizeEmail(owner);
  const statements = [];
  for (let i = 0; i < segments.length; i += YT_ROWS_PER_STATEMENT) {
    statements.push(ytSegmentInsert(env, id, email, language, segments.slice(i, i + YT_ROWS_PER_STATEMENT)));
  }
  const trim = env.DB.prepare(
    "DELETE FROM youtube_transcript_segments WHERE transcript_id = ?1 AND segment_index >= ?2"
  ).bind(id, segments.length);

  if (ytReplaceIsAtomic(segments.length)) {
    await env.DB.batch([...statements, trim]);
    return;
  }
  for (let i = 0; i < statements.length; i += YT_SEGMENT_CHUNK) {
    await env.DB.batch(statements.slice(i, i + YT_SEGMENT_CHUNK));
  }
  await trim.run();
}

async function ytDeleteTranscript(env, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM youtube_transcript_segments WHERE transcript_id = ?1").bind(id),
    env.DB.prepare("DELETE FROM youtube_transcripts WHERE transcript_id = ?1").bind(id),
  ]);
}

// Before transcripts lived in D1, this Worker kept them in KV: a record per
// video under `yt:<owner>:<jobId>` and the transcript text under
// `yttext:v1:<owner>:<jobId>`. That code is gone, but keys written while it was
// deployed are not — and the job ids it used have no relation to a D1
// transcript_id, so they can only be found by looking. Deleting a transcript
// has to remove them too, or the UI reports the transcript deleted while a
// complete copy of it stays in KV.
//
// Best-effort and bounded to the one account's prefix; only runs on delete.
async function ytDeleteLegacyKvCopies(env, owner, videoId) {
  if (!env.KV) return;
  const prefix = `yt:${encodeURIComponent(normalizeEmail(owner))}:`;
  try {
    let cursor;
    do {
      const page = await env.KV.list({ prefix, cursor });
      for (const key of page.keys) {
        const raw = await env.KV.get(key.name);
        if (!raw) continue;
        let rec;
        try {
          rec = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!rec || rec.videoId !== videoId) continue;
        await env.KV.delete(key.name);
        await env.KV.delete(`yttext:v1:${encodeURIComponent(normalizeEmail(owner))}:${rec.id}`);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } catch {
    /* the D1 delete is the one that matters; this is cleanup of retired state */
  }
}

// ── The transcript response shape ────────────────────────────────────────────
// Deliberately identical to what the EC2 API returned, so callers written
// against that contract keep working.

function ytSegmentPayload(rows) {
  return rows.map((r) => ({
    index: Number(r.segment_index),
    start: Number(r.start_time) || 0,
    end: Number(r.end_time) || 0,
    text: String(r.text || ""),
    speaker: r.speaker || null,
    language: r.language || null,
  }));
}

function ytTranscriptText(segments) {
  return segments.map((s) => s.text).join("\n");
}

function transcriptPayload(row, segmentRows) {
  const segments = segmentRows ? ytSegmentPayload(segmentRows) : [];
  const done = row.status === "completed";
  return {
    id: row.transcript_id,
    video_id: row.video_id,
    url: row.url,
    title: row.title || null,
    channel: row.channel || null,
    duration_seconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
    status: row.status,
    source: row.source || null,
    language: row.language || null,
    segment_count: Number(row.segment_count) || 0,
    error: row.error || null,
    created_at: row.created_at || null,
    completed_at: row.completed_at || null,
    text: done && segments.length ? ytTranscriptText(segments) : null,
    segments,
  };
}

/* ------------------- transcripts: create / fetch / store ------------------- */

// Creates (or returns) the transcript for one video under one account, doing the
// YouTube fetch + parse + store inline.
//
// Every limit below applies to every caller. There is no admin exemption: both
// create routes refuse admin accounts outright (a transcript belongs to the user
// who added it, and an admin has no account of their own to own one), so an
// exemption here could never fire and only read as though it did. Repairing a
// user's transcript as an admin would need its own owner-scoped route. Captions are a metadata fetch plus one
// text download, so this stays well inside the request budget.
//
// Idempotent per (owner, video): re-posting a URL already transcribed for that
// account returns the existing row untouched. A previously FAILED row retries,
// and force=true re-fetches regardless.
// One forced refetch per account per window. KV is eventually consistent, which
// is fine here: the point is to stop a loop, not to be exact to the second.
const YT_FORCE_COOLDOWN_MS = 5 * 60 * 1000;
// The same window for retrying a row that already failed. With the 300-row cap,
// this bounds one account to roughly one YouTube request a second even if it
// tries to loop over every row it owns.
const YT_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
// The diagnostic probe's window (see ytProbeCooldown). Seconds, not minutes:
// it is run by hand to answer one question, and the point is only to stop it
// being looped.
const YT_PROBE_COOLDOWN_MS = 20 * 1000;

async function ytForceCooldown(env, email) {
  if (!env.KV) return { ok: true };
  const key = `ytforce:${encodeURIComponent(email)}`;
  try {
    const last = Number(await env.KV.get(key)) || 0;
    const waited = Date.now() - last;
    if (last && waited < YT_FORCE_COOLDOWN_MS) {
      const mins = Math.max(1, Math.ceil((YT_FORCE_COOLDOWN_MS - waited) / 60000));
      return { ok: false, error: `Too many refreshes — try again in about ${mins} minute${mins === 1 ? "" : "s"}.` };
    }
    await env.KV.put(key, String(Date.now()), { expirationTtl: Math.ceil(YT_FORCE_COOLDOWN_MS / 1000) * 2 });
  } catch {
    /* KV hiccup — don't block a legitimate refresh on the rate limiter */
  }
  return { ok: true };
}

// The diagnostic probe's own limiter. It is admin-only and writes nothing, but
// each call still spends three requests on the shared egress outside every
// per-account allowance — so without this an admin holding the page open on a
// refresh, or a script looping it, is indistinguishable from the abuse the rest
// of these limits exist to prevent. Short: it is a thing you run by hand and
// read, not a monitor to poll.
async function ytProbeCooldown(env, email) {
  if (!env.KV) return { ok: true };
  const key = `ytprobe:${encodeURIComponent(normalizeEmail(email))}`;
  try {
    const last = Number(await env.KV.get(key)) || 0;
    const waited = Date.now() - last;
    if (last && waited < YT_PROBE_COOLDOWN_MS) {
      const secs = Math.max(1, Math.ceil((YT_PROBE_COOLDOWN_MS - waited) / 1000));
      return { ok: false, error: `Probed too recently — try again in about ${secs} second${secs === 1 ? "" : "s"}.` };
    }
    await env.KV.put(key, String(Date.now()), { expirationTtl: 60 });
  } catch {
    /* KV hiccup — a diagnostic that can't reach its limiter still runs */
  }
  return { ok: true };
}

// A per-account ceiling on how many videos it can actually make us FETCH in an
// hour, independent of what it currently owns. The row cap alone doesn't bound
// this: deleting a transcript frees its slot AND removes the only record of
// prior work, so add-delete-add (or rotating video ids) would refetch forever
// and bot-gate the shared egress. Generous for real use — nobody transcribes 30
// videos an hour by hand — and it is the backstop the row-keyed limits can't be.
//
// The reservation is a single D1 statement, not a KV read-modify-write: KV is
// eventually consistent and the read/write pair is not atomic, so a burst of
// concurrent submissions could all observe the same count, all pass, and all hit
// YouTube — defeating the one safeguard that exists to keep the shared egress
// off YouTube's bad list. SQLite's upsert does the whole thing in one go: the
// row is inserted or incremented, and the WHERE on the update means a request
// over the limit changes nothing and is refused.
const YT_FETCH_QUOTA = 30;
const YT_FETCH_WINDOW_MS = 60 * 60 * 1000;

// This table is OURS and additive — it is not one of the two transcript tables
// AWS shares, and nothing else reads it. Created on demand so no migration step
// is needed.
//
// It is a token bucket, not an hourly counter. Fixed epoch-hour buckets reset on
// the clock, so an account could spend its whole allowance just before the
// boundary and the whole of the next one just after — 60 fetches in seconds,
// which is exactly the burst the limit exists to prevent. Tokens refill
// continuously at quota-per-window, so the ceiling holds no matter where the
// requests fall.
let ytQuotaTableReady = false;
async function ensureQuotaTable(env) {
  if (ytQuotaTableReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS worker_youtube_fetch_budget (" +
      "owner_email TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_ms INTEGER NOT NULL)"
  ).run();
  // The fixed-window table this replaced, from one deploy earlier. Ours, and
  // only ever held rate-limit counters.
  await env.DB.prepare("DROP TABLE IF EXISTS worker_youtube_fetch_quota").run().catch(() => {});
  ytQuotaTableReady = true;
}

// Hands a token back when the request that reserved it turns out not to need
// one — it was handed an existing row, lost a race, or hit the row cap. Capped
// at a full bucket so a refund can never mint allowance. Best-effort: a lost
// refund costs that account one token, which the refill returns anyway.
async function ytRefundQuota(env, email) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(
      "UPDATE worker_youtube_fetch_budget SET tokens = MIN(?2, tokens + 1) WHERE owner_email = ?1"
    )
      .bind(normalizeEmail(email), YT_FETCH_QUOTA)
      .run();
  } catch {
    /* best-effort */
  }
}

async function ytFetchQuota(env, email) {
  if (!env.DB) return { ok: true };
  const now = Date.now();
  try {
    await ensureQuotaTable(env);
    // One statement does refill, spend and refusal together, so the read and the
    // write can't be split by a concurrent request. MIN() caps the refill at a
    // full bucket; the WHERE refuses anyone without a whole token to spend.
    const refill = "MIN(?2, tokens + CAST(?3 - updated_ms AS REAL) * ?2 / ?4)";
    const res = await env.DB.prepare(
      "INSERT INTO worker_youtube_fetch_budget (owner_email, tokens, updated_ms) VALUES (?1, ?2 - 1, ?3) " +
        `ON CONFLICT(owner_email) DO UPDATE SET tokens = ${refill} - 1, updated_ms = ?3 WHERE ${refill} >= 1`
    )
      .bind(normalizeEmail(email), YT_FETCH_QUOTA, now, YT_FETCH_WINDOW_MS)
      .run();
    if (!((res && res.meta && res.meta.changes) || 0)) {
      return { ok: false, error: `You've transcribed ${YT_FETCH_QUOTA} videos in the past hour — try again later.` };
    }
  } catch {
    /* D1 hiccup — don't block a legitimate transcription on the limiter */
  }
  return { ok: true };
}

async function createYoutubeTranscript(env, owner, input, opts = {}) {
  if (!env.DB) return { ok: false, status: 503, code: "UPSTREAM_ERROR", error: "Transcripts database is not connected yet" };
  const parsed = parseYoutubeUrl(input);
  if (!parsed) return { ok: false, status: 400, code: "BAD_VIDEO_ID", error: YT_MESSAGES.BAD_VIDEO_ID };

  const email = normalizeEmail(owner);
  await ensureYoutubeIndex(env);

  // `force` deliberately skips both the reuse check and the per-account cap, so
  // without a limit one account could sit on a single video and re-fetch it in a
  // loop — hammering the shared egress (the exact thing that gets us bot-gated)
  // and rewriting every segment row each time. One forced refetch per account
  // per cooldown window; admins, who use it to repair a bad transcript, skip it.
  if (opts.force) {
    const gate = await ytForceCooldown(env, email);
    if (!gate.ok) return { ok: false, status: 429, code: "TOO_MANY_REFRESHES", error: gate.error };
  }

  const existing = await ytRowByOwnerVideo(env, email, parsed.videoId);
  if (existing && !opts.force) {
    if (existing.status === "completed") return { ok: true, row: existing, reused: true };
    // A failed row retries — but not on demand, without limit. Re-posting the
    // same failing video (no captions, unavailable, live, bot-gated) reran the
    // whole fetch every time while occupying just one of the account's rows, so
    // one account could hammer the shared egress indefinitely. Hold it for the
    // same window a forced refresh uses; the row is handed back meanwhile,
    // carrying the reason it failed.
    if (existing.status === "failed") {
      const since = Date.now() - (Date.parse(existing.updated_at || existing.created_at || "") || 0);
      if (since < YT_RETRY_COOLDOWN_MS) return { ok: true, row: existing, reused: true, failed: true, error: existing.error };
    }
    // A row another request is actively writing is handed back as-is; one left
    // behind by an interrupted request is retried below rather than pinning the
    // video in "transcribing" forever.
    if (existing.status === "processing" || existing.status === "queued") {
      const age = Date.now() - (Date.parse(existing.updated_at || existing.created_at || "") || 0);
      if (age < YT_PROCESSING_STALE_MS) return { ok: true, row: existing, reused: true };
    }
  }

  // Every reuse path above returned already, so this request intends to fetch.
  // The token is reserved HERE — before any row exists — and handed back below
  // on the paths that turn out not to fetch after all. Taking it first is what
  // keeps a refusal from having to touch a row at all: nothing is created, so
  // there is nothing to strand in `processing`, nothing to delete out from
  // under a concurrent caller, and no invisible row left eating the account's
  // capacity. The refund covers the cases the reservation can't foresee.
  const quota = await ytFetchQuota(env, email);
  if (!quota.ok) return { ok: false, status: 429, code: "RATE_LIMITED", error: quota.error };

  // A forced refresh of a transcript that already works must not destroy it: the
  // row keeps its completed state and segments until a replacement is in hand.
  const preserveOnFailure = !!existing && existing.status === "completed";

  const at = nowIso();
  let id;
  if (existing) {
    id = existing.transcript_id;
    // Take the row before fetching. Losing this means another request is
    // already transcribing it, so back off and return its row rather than
    // running the same pipeline twice and racing to write the result.
    //
    // A completed row is claimed too, on a forced refresh — see
    // ytClaimForRetry. That does mean a refresh shows as being written rather
    // than serving the old text for those few seconds, which is the price of
    // there being exactly one writer. Nothing is destroyed by it: the old
    // segments stay where they are, and any failure below puts the row back to
    // `completed` over them.
    const claimed = await ytClaimForRetry(
      env,
      id,
      new Date(Date.now() - YT_PROCESSING_STALE_MS).toISOString(),
      preserveOnFailure
    );
    if (!claimed) {
      const active = await ytRowById(env, id);
      if (active) {
        await ytRefundQuota(env, email); // another writer owns the fetch
        return { ok: true, row: active, reused: true };
      }
    }
    await ytUpdateRow(env, id, { url: parsed.url, updated_at: at });
  } else {
    const inserted = await ytInsertRow(env, {
      owner_email: email,
      video_id: parsed.videoId,
      url: parsed.url,
      status: "processing",
      created_at: at,
      updated_at: at,
    });
    // Lost the race to a concurrent request for the same video: that request
    // owns the fetch and the segment write, so return its row rather than
    // running the same pipeline against the same rows.
    if (inserted.atCap) {
      // The capped INSERT ... SELECT writes nothing both when the account is
      // genuinely full AND when a concurrent request for this same video just
      // took the last slot. Look before blaming the cap: if the video now
      // exists, that is the answer the caller wanted.
      const winner = await ytRowByOwnerVideo(env, email, parsed.videoId);
      await ytRefundQuota(env, email); // neither branch below fetches anything
      if (winner) return { ok: true, row: winner, reused: true };
      return {
        ok: false,
        status: 400,
        code: "LIMIT_REACHED",
        error: `You can keep up to ${MAX_VIDEOS_PER_USER} videos — delete one first`,
      };
    }
    if (inserted.existed) {
      const winner = await ytRowById(env, inserted.id);
      if (winner) {
        await ytRefundQuota(env, email); // the winner owns the fetch
        return { ok: true, row: winner, reused: true };
      }
    }
    id = inserted.id;
  }

  let result;
  try {
    result = await fetchYoutubeTranscript(env, parsed.videoId);
  } catch (err) {
    result = { ok: false, code: "UPSTREAM_ERROR", error: YT_MESSAGES.UPSTREAM_ERROR, detail: String((err && err.message) || err) };
  }

  if (!result.ok) {
    if (preserveOnFailure) {
      // Keep the working transcript; report why the refresh didn't happen. The
      // claim above moved the row to `processing` and nothing has touched its
      // segments, so putting the status back restores it exactly as it was.
      await ytUpdateRow(env, id, { status: "completed", error: null, updated_at: nowIso() });
      const kept = await ytRowById(env, id);
      return { ok: true, row: kept || existing, refreshFailed: true, code: result.code, error: result.error, detail: result.detail };
    }
    await ytUpdateRow(env, id, { status: "failed", error: result.error || YT_MESSAGES.UPSTREAM_ERROR, updated_at: nowIso() });
    const row = await ytRowById(env, id);
    return { ok: true, row: row || null, failed: true, code: result.code, error: result.error, detail: result.detail };
  }

  // The row can still have been deleted while this request was fetching — a
  // stale claim is deletable by design. Writing segments for a parent that no
  // longer exists would leave rows nothing can reach or clean up.
  if (!(await ytRowById(env, id))) {
    return { ok: false, status: 404, code: "NOT_FOUND", error: "That video was removed while it was being transcribed" };
  }
  // The row is `processing` by now either way — it was claimed before the fetch
  // — so no reader is being served a half-written transcript as a finished one.
  // What is left to decide is how a failed write recovers, and that depends on
  // whether the replacement was one atomic batch.
  const atomic = ytReplaceIsAtomic(result.segments.length);
  try {
    await ytReplaceSegments(env, id, email, result.language, result.segments);
  } catch (err) {
    // One batch: it either landed or it didn't, so the old segments are exactly
    // as they were and the row can go straight back to serving them.
    if (atomic && preserveOnFailure) {
      await ytUpdateRow(env, id, { status: "completed", error: null, updated_at: nowIso() });
      const kept = await ytRowById(env, id);
      return {
        ok: true,
        row: kept || existing,
        refreshFailed: true,
        code: "UPSTREAM_ERROR",
        error: YT_MESSAGES.UPSTREAM_ERROR,
      };
    }
    // Every other case ends the same way: the row must not be left holding the
    // claim. It is `processing` with a fresh timestamp, so rethrowing would
    // answer 500 and leave a row that a resubmission inside the stale window is
    // handed straight back — the page then polls a row nothing is writing, for
    // a failure nobody was told about. Marking it failed says what happened and
    // retries on the normal cooldown.
    //
    // Several batches with one of them not landing is the same outcome with a
    // different reason: the segments are part new, part old, so there is
    // nothing to restore and the whole thing has to be rebuilt.
    const interrupted = !atomic;
    const message = interrupted
      ? "Saving this transcript was interrupted — it will be rebuilt on the next attempt."
      : "Couldn't save this transcript — try again shortly.";
    await ytUpdateRow(env, id, { status: "failed", error: message, updated_at: nowIso() });
    const broken = await ytRowById(env, id);
    return {
      ok: true,
      row: broken || null,
      failed: true,
      code: interrupted ? "WRITE_INTERRUPTED" : "WRITE_FAILED",
      error: message,
    };
  }
  // The lease is only honoured while it looks fresh, and a long fetch plus a
  // long chunked write can outlive it — so the row may have been deleted after
  // the check above and while these segments were going in. Clean up after
  // ourselves rather than leaving rows no parent can reach.
  if (!(await ytRowById(env, id))) {
    await env.DB.prepare("DELETE FROM youtube_transcript_segments WHERE transcript_id = ?1")
      .bind(id)
      .run()
      .catch(() => {});
    return { ok: false, status: 404, code: "NOT_FOUND", error: "That video was removed while it was being transcribed" };
  }
  const completedAt = nowIso();
  // A player response can come back with captions but without some of the
  // optional metadata around them. Writing that absence through would blank a
  // title, channel or duration the row already had — a forced refresh would
  // "succeed" and leave the video showing its raw id. Only overwrite a field
  // the fetch actually produced.
  await ytUpdateRow(env, id, {
    title: result.title || (existing && existing.title) || null,
    channel: result.channel || (existing && existing.channel) || null,
    duration_seconds: result.durationSeconds || (existing && existing.duration_seconds) || null,
    status: "completed",
    source: "captions",
    language: result.language || null,
    segment_count: result.segments.length,
    error: null,
    updated_at: completedAt,
    completed_at: completedAt,
  });
  // No cache invalidation needed on a refresh: the summary key carries a
  // signature of the transcript, so replacement captions simply address a
  // different entry, and unchanged captions keep (and share) the existing one.
  return { ok: true, row: await ytRowById(env, id) };
}

// Resolves a transcript for a caller, enforcing ownership. A row belonging to
// someone else answers 404 rather than 403 — a 403 would confirm the id exists.
// Admin is this dashboard's own operator role and sees every account's.
async function ytRowForSession(env, session, id) {
  const numeric = Number(id);
  if (!Number.isFinite(numeric)) return null;
  const row = await ytRowById(env, numeric);
  if (!row) return null;
  if (session.isAdmin) return row;
  return normalizeEmail(row.owner_email) === normalizeEmail(session.identity) ? row : null;
}

/* --------------------------- transcript routes ---------------------------- */
// The EC2 API's shape, served from here. `email` is ALWAYS the session's — an
// email in the body or query string is ignored, since trusting it would let any
// caller read or write another customer's transcripts.

async function handleTranscriptCreate(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (session.isAdmin) return json({ error: "Admin accounts can't add videos — sign in as a user" }, 403);

  const body = await request.json().catch(() => ({}));
  const result = await createYoutubeTranscript(env, session.identity, body.url, { force: !!body.force });
  if (!result.ok) return json({ error: result.error, code: result.code }, result.status || 400);
  if (!result.row) return json({ error: YT_MESSAGES.UPSTREAM_ERROR, code: "UPSTREAM_ERROR" }, 502);
  const segments = result.row.status === "completed" ? await ytSegmentRows(env, result.row.transcript_id) : [];
  const payload = transcriptPayload(result.row, segments);
  // A forced refresh that failed deliberately keeps the old transcript, which
  // would otherwise come back as a plain 202 — indistinguishable from freshly
  // fetched captions. Say so, so the caller knows what it is holding.
  // Not stored on the row — the row keeps the short human message. This is for
  // whoever is looking at why it failed right now.
  if (result.detail) payload.detail = result.detail;
  if (result.refreshFailed) {
    payload.refresh_failed = true;
    payload.refresh_error = result.error || YT_MESSAGES.UPSTREAM_ERROR;
    payload.code = result.code || "UPSTREAM_ERROR";
  }
  return json(payload, 202);
}

async function handleTranscriptGet(request, env, id) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);
  const row = await ytRowForSession(env, session, id);
  if (!row) return json({ error: "Not found", code: "NOT_FOUND" }, 404);
  const segments = row.status === "completed" ? await ytSegmentRows(env, row.transcript_id) : [];
  return json(transcriptPayload(row, segments));
}

async function handleTranscriptText(request, env, id) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);
  const row = await ytRowForSession(env, session, id);
  if (!row) return json({ error: "Not found", code: "NOT_FOUND" }, 404);
  if (row.status === "failed") return json({ error: row.error || YT_MESSAGES.UPSTREAM_ERROR, code: "FAILED" }, 409);
  if (row.status !== "completed") return json({ error: "This transcript is still being written", code: "PENDING" }, 409);
  const segments = ytSegmentPayload(await ytSegmentRows(env, row.transcript_id));
  return new Response(ytTranscriptText(segments), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}


// POST /youtube/probe?v=<id> — read-only diagnostics for the YouTube path.
// Writes nothing. This exists because the whole design rests on Cloudflare's
// egress not being bot-gated the way EC2's is, and that can change under us: it
// reports exactly what each hop returns so a failure can be told apart from a
// genuinely unavailable video, and so the egress can be monitored over time.
// The extra client probes here are deliberate and manual — the transcript path
// itself still makes at most one InnerTube call.
//
// POST for a route that reads nothing, deliberately. The session cookie is
// SameSite=None (this app is embedded cross-site), so where third-party cookies
// are still allowed a page an admin merely VISITS can fire authenticated GETs
// at us from an <img> or <iframe> — and each one spends three requests on the
// shared egress. As a POST it goes through the Origin check in the fetch
// handler, which no cross-site form or tag can satisfy. The cooldown below then
// bounds it even for a legitimate admin, since nothing else does.
async function handleTranscriptProbe(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  // Admin only. Each call spends three requests on the shared Cloudflare egress
  // without touching any per-account allowance, so leaving it open to every
  // signed-in account would let one of them hammer the egress until YouTube
  // bot-gates it — which disables transcription for everyone.
  if (!session.isAdmin) return json({ error: "Forbidden" }, 403);
  const url = new URL(request.url);
  const videoId = String(url.searchParams.get("v") || "aircAruvnKk").trim();
  if (!YT_ID_RE.test(videoId)) return json({ error: YT_MESSAGES.BAD_VIDEO_ID, code: "BAD_VIDEO_ID" }, 400);
  const gate = await ytProbeCooldown(env, session.identity);
  if (!gate.ok) return json({ error: gate.error, code: "TOO_MANY_PROBES" }, 429);

  const out = { videoId, watch: {}, innertube: {} };

  try {
    const res = await fetch(`${ytOrigin(env)}/watch?v=${encodeURIComponent(videoId)}&hl=en&bpctr=9999999999&has_verified=1`, {
      headers: ytHeaders({
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Cookie: "CONSENT=YES+1; SOCS=CAI",
      }),
    });
    const html = await res.text().catch(() => "");
    const player = res.ok ? playerResponseFromHtml(html) : null;
    const play = playabilityOf(player);
    const tracks =
      (player && player.captions && player.captions.playerCaptionsTracklistRenderer &&
        player.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    out.watch = {
      status: res.status,
      bytes: html.length,
      botGated: looksBotGated(play.reason, html),
      hasPlayerResponse: !!player,
      playability: play.status || null,
      reason: play.reason || null,
      captionTracks: tracks.length,
      languages: tracks.map((t) => `${t.languageCode}${String(t.kind || "") === "asr" ? " (asr)" : ""}`),
      hasInnertubeKey: !!innertubeKeyFromHtml(html),
    };
  } catch (err) {
    out.watch = { error: String((err && err.message) || err) };
  }

  // Both InnerTube clients, so a failure tells us WHICH one Cloudflare can still
  // use rather than just that the fallback didn't work.
  for (const client of ["WEB", "ANDROID"]) {
    try {
      const body =
        client === "ANDROID"
          ? { videoId, context: { client: { clientName: "ANDROID", clientVersion: "19.09.37", androidSdkVersion: 30, hl: "en", gl: "US" } } }
          : { videoId, context: { client: { clientName: "WEB", clientVersion: "2.20240401.00.00", hl: "en", gl: "US" } } };
      const res = await fetch(`${ytOrigin(env)}/youtubei/v1/player?key=${YT_PUBLIC_INNERTUBE_KEY}&prettyPrint=false`, {
        method: "POST",
        headers: ytHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const data = safeJsonParse(await res.text().catch(() => "")) || {};
      const play = playabilityOf(data);
      const tracks =
        (data.captions && data.captions.playerCaptionsTracklistRenderer &&
          data.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
      out.innertube[client] = {
        status: res.status,
        playability: play.status || null,
        reason: play.reason || null,
        botGated: looksBotGated(play.reason, ""),
        captionTracks: tracks.length,
        title: (data.videoDetails && data.videoDetails.title) || null,
      };
    } catch (err) {
      out.innertube[client] = { error: String((err && err.message) || err) };
    }
  }

  // The providers are where a transcript actually comes from now, so a probe
  // that only reported the direct path would be reporting the one hop we
  // already know is blocked. What matters for each: did it answer, and does
  // what it returned actually look like its own payload — a challenge page or
  // an interstitial answers 200 with HTML and would otherwise be mistaken for
  // a verdict about the video.
  out.providers = {};
  const keylessOrigin = ytProviderOrigin(env, "YT_TEXT_ORIGIN", "https://youtube-transcript.ai");
  try {
    const res = await fetch(`${keylessOrigin}/transcript/${encodeURIComponent(videoId)}.txt`, {
      headers: { Accept: "text/markdown, text/plain;q=0.9, */*;q=0.8", "User-Agent": YT_UA },
    });
    const text = await res.text().catch(() => "");
    out.providers.keyless = {
      status: res.status,
      contentType: res.headers.get("content-type"),
      bytes: text.length,
      looksLikeTranscript: /^#\s*Transcript/m.test(text) && text.includes("## Transcript"),
      cues: (text.match(/\[\d+(?::\d+){1,2}\]/g) || []).length,
      head: text.slice(0, 200),
    };
  } catch (err) {
    out.providers.keyless = { error: String((err && err.message) || err) };
  }

  if (String((env && env.SUPADATA_API_KEY) || "").trim()) {
    const supaOrigin = ytProviderOrigin(env, "SUPADATA_ORIGIN", "https://api.supadata.ai");
    try {
      const res = await fetch(
        `${supaOrigin}/v1/transcript?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`,
        { headers: { "x-api-key": String(env.SUPADATA_API_KEY).trim(), Accept: "application/json" } }
      );
      const text = await res.text().catch(() => "");
      const data = safeJsonParse(text) || {};
      out.providers.supadata = {
        status: res.status,
        cues: Array.isArray(data.content) ? data.content.length : null,
        lang: data.lang || null,
        // Their error wording, never the key.
        head: res.ok ? undefined : text.slice(0, 200),
      };
    } catch (err) {
      out.providers.supadata = { error: String((err && err.message) || err) };
    }
  } else {
    out.providers.supadata = { configured: false };
  }

  return json({ ok: true, probe: out });
}

/* ------------------------- the dashboard's Videos tab ------------------------- */
// The same transcripts, shaped for the SPA. These routes are what the Videos tab
// calls; they read and write the D1 tables above, so the dashboard and any
// caller using the EC2-shaped contract are looking at exactly one store.

// Only the client-facing fields. `owner` IS included — the dashboard shows it in
// the admin cross-account list, and for a normal user it's just their own address.
function publicVideo(row) {
  return {
    id: String(row.transcript_id),
    owner: row.owner_email || "",
    url: row.url || "",
    videoId: row.video_id || "",
    title: row.title || "",
    channel: row.channel || "",
    durationSec: Number(row.duration_seconds) || 0,
    status: row.status || "queued",
    error: row.error || "",
    createdAt: Date.parse(row.created_at || "") || 0,
    updatedAt: Date.parse(row.updated_at || row.created_at || "") || 0,
    hasTranscript: (Number(row.segment_count) || 0) > 0,
  };
}

// GET /api/youtube — the signed-in user's videos (admin: everyone's, or one
// user's with ?email=).
async function handleListVideos(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);
  const url = new URL(request.url);
  const filter = normalizeEmail(url.searchParams.get("email") || "");
  const owner = session.isAdmin ? filter || null : normalizeEmail(session.identity);
  try {
    const rows = await ytRowsForOwner(env, owner);
    return json({ ok: true, admin: !!session.isAdmin, videos: rows.map(publicVideo) });
  } catch (err) {
    return json({ error: "Failed to load your videos", detail: String((err && err.message) || err) }, 500);
  }
}

// POST /api/youtube {url} — transcribe a YouTube video for the signed-in
// account. The owner is always the session email.
async function handleCreateVideo(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (session.isAdmin) return json({ error: "Admin accounts can't add videos — sign in as a user" }, 403);

  const body = await request.json().catch(() => ({}));
  let result;
  try {
    result = await createYoutubeTranscript(env, session.identity, body.url, { force: !!body.force });
  } catch (err) {
    return json({ error: "Failed to transcribe that video", detail: String((err && err.message) || err) }, 500);
  }
  if (!result.ok) return json({ error: result.error, code: result.code }, result.status || 400);
  if (!result.row) return json({ error: YT_MESSAGES.UPSTREAM_ERROR, code: "UPSTREAM_ERROR" }, 502);
  // Transcription runs inline, so its outcome is already known here. The row is
  // returned either way (a failed video belongs in the list, with its reason),
  // but `failed` tells the client not to report this as a success.
  return json(
    {
      ok: true,
      video: publicVideo(result.row),
      duplicate: !!result.reused,
      failed: !!result.failed,
      refreshFailed: !!result.refreshFailed,
      error: result.error || null,
      code: result.code || null,
    },
    result.reused ? 200 : 202,
  );
}

// GET /api/youtube/video?id=…&owner=… — one video, its transcript segments, and
// the plain-text rendering the summary/chat paths use.
async function handleGetVideo(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);
  const url = new URL(request.url);
  const row = await ytRowForSession(env, session, url.searchParams.get("id"));
  if (!row) return json({ error: "Not found" }, 404);
  const segments = row.status === "completed" ? ytSegmentPayload(await ytSegmentRows(env, row.transcript_id)) : [];
  return json({ ok: true, video: publicVideo(row), segments, transcript: ytTranscriptText(segments) });
}

// POST /api/youtube/delete {id} — drop a transcript and its segments.
async function handleDeleteVideo(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);
  const body = await request.json().catch(() => ({}));
  const row = await ytRowForSession(env, session, body.id);
  if (!row) return json({ error: "Not found" }, 404);
  // Deleting a row another request is actively writing would leave that writer
  // to finish into a parent that no longer exists — orphaned segments, and a
  // 500 for the request that was doing real work. A row only counts as held
  // while its claim is fresh, so one abandoned by an interrupted request is
  // still removable.
  if (row.status === "processing" || row.status === "queued") {
    const age = Date.now() - (Date.parse(row.updated_at || row.created_at || "") || 0);
    if (age < YT_PROCESSING_STALE_MS) {
      return json({ error: "This video is still being transcribed — try again in a moment", code: "IN_PROGRESS" }, 409);
    }
  }
  try {
    await ytDeleteTranscript(env, row.transcript_id);
    await ytDeleteLegacyKvCopies(env, row.owner_email, row.video_id);
  } catch (err) {
    return json({ error: "Failed to remove that video", detail: String((err && err.message) || err) }, 500);
  }
  return json({ ok: true });
}

// ── Video AI: summary + chat ──────────────────────────────────────────────────
// Same shape as the meeting assistant (handleAiChat): the transcript is loaded
// server-side under the caller's own ownership, the OpenAI key stays a Worker
// secret, and a video is summarized ONCE — cached by video id, so every user who
// transcribes the same video shares it.

// A cheap, stable signature of a string. Only needs to change when the text
// changes — not to be cryptographic.
function ytTextSignature(text) {
  let h = 2166136261; // FNV-1a
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// Summaries are shared by VIDEO, not by transcript row: two accounts that
// transcribe the same video get one summary and we never pay to make it twice.
//
// But each account's transcript is independently refreshable, so "same video"
// is not the same thing as "same words" — after one owner force-refreshes and
// YouTube's captions have changed, a key of video id alone would serve the
// other owner a summary that contradicts the transcript on their own page. The
// key therefore carries a signature of the transcript itself: identical
// captions still share, divergent ones no longer collide.
function ytSummaryKey(row, transcript) {
  const video = String(row.video_id || row.transcript_id).trim();
  return `${YT_SUMMARY_PREFIX}${video}:${ytTextSignature(transcript || "")}`;
}

// The transcript as the model sees it: "[mm:ss] line", which gives the summary
// and chat something to anchor timings to.
function ytTranscriptForModel(segments) {
  const lines = new Array(segments.length);
  for (let i = 0; i < segments.length; i++) {
    const t = Math.max(0, Math.floor(segments[i].start));
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = String(t % 60).padStart(2, "0");
    lines[i] = `[${mm}:${ss}] ${segments[i].text}`;
  }
  return lines.join("\n");
}

const VIDEO_CAVEAT =
  "Work ONLY from the transcript — never invent facts, numbers, names, or claims. " +
  "The transcript is auto-generated from speech, has no speaker labels, and contains speech-to-text errors, " +
  "especially in proper nouns (people, companies, products, places): infer the most likely intended spelling " +
  "from context and use it consistently. Write in clear, professional English.";

// Length-bounded transcript for the model: keep the opening (where the topic is
// set) and the tail (where conclusions land).
function buildVideoText(text) {
  const MAX = 30000;
  const full = String(text || "").trim();
  if (full.length <= MAX) return full;
  const head = Math.floor(MAX * 0.7);
  const tail = MAX - head;
  return full.slice(0, head) + "\n…[transcript truncated]…\n" + full.slice(full.length - tail);
}

// A short display title for a video YouTube gave no name for. Best-effort —
// "" on any failure, so the UI falls back to the video id.
async function generateVideoTitle(text, apiKey, model) {
  const transcript = buildVideoText(text).slice(0, 6000);
  if (!transcript) return "";
  const raw = await openaiChat(
    apiKey,
    model,
    [
      {
        role: "system",
        content:
          "You name videos. Given a transcript, reply with a specific, natural title of AT MOST 6 words that " +
          "captures what the video is about. Use Title Case. No quotes, no trailing punctuation. Reply with the title only.",
      },
      { role: "user", content: "TRANSCRIPT:\n" + transcript },
    ],
    24,
    0.3,
  );
  return cleanTitle(raw);
}

// The briefing, assembled from three parallel calls: (1) a classification line +
// narrative overview, (2) the thematic walk-through of what the video covers, and
// (3) the takeaways. Stitched into the same light Markdown the meeting summary
// uses, so every renderer (dashboard, PDF, Word) handles it unchanged.
async function generateVideoSummary(text, apiKey, model, meta = {}) {
  const transcript = buildVideoText(text);
  const context = [meta.title ? `Video title: ${meta.title}` : "", meta.channel ? `Channel: ${meta.channel}` : ""]
    .filter(Boolean)
    .join("\n");
  const source = (context ? context + "\n\n" : "") + "TRANSCRIPT:\n" + transcript;

  const overviewPromise = openaiChat(apiKey, model, [
    {
      role: "system",
      content:
        "You are an expert analyst who writes crisp, information-dense briefings on video content in the style of " +
        "a top research assistant. " + VIDEO_CAVEAT + " Use **bold** for emphasis and section titles; never use # headings.",
    },
    {
      role: "user",
      content:
        "Write two things from the video transcript:\n\n" +
        "1) ONE opening sentence that classifies the video and states its focus, with the video type in **bold** " +
        '— e.g. "This is a **technical explainer** on how neural networks learn from data." No header before ' +
        "this sentence.\n\n" +
        "2) A blank line, then exactly this section:\n\n" +
        "**Video Summary**\n" +
        "A flowing 4–6 sentence narrative covering the subject and purpose, the main arguments or steps with the " +
        "specific people, companies, products, and numbers named, and what the video concludes. Prose, not bullets.\n\n" +
        "Output only those two parts.\n\n" + source,
    },
  ], 700);

  const topicsPromise = openaiChat(apiKey, model, [
    {
      role: "system",
      content:
        "You break a video down into its thematic sections as tight notes, in your own words from the transcript " +
        "only — never quote or transcribe. " + VIDEO_CAVEAT + " Keep every specific (numbers, names, tools, " +
        "examples); cut filler. Use **bold** only for the short label that opens each bullet.",
    },
    {
      role: "user",
      content:
        "Walk through everything the video covers, grouped by topic, in the order it arises.\n\n" +
        "Style:\n" +
        "- Format every bullet exactly as: - **<Topic>:** <note>\n" +
        "- <Topic> is a 1–3 word label naming the subject of that stretch of the video.\n" +
        "- Merge related material under one topic; one topic per bullet; 5–12 bullets total.\n" +
        "- Keep all substance — definitions, numbers, examples, claims, caveats — but drop intros, sponsor reads, " +
        "and sign-offs. No quotes.\n\n" +
        'Output: Markdown "- " bullets only. No heading, no preamble.\n\n' + source,
    },
  ], 1000);

  const takeawaysPromise = openaiChat(apiKey, model, [
    {
      role: "system",
      content:
        "You extract what a viewer should actually remember from a video. " + VIDEO_CAVEAT +
        " Use **bold** for each takeaway's short label.",
    },
    {
      role: "user",
      content:
        "List the key takeaways from the transcript — the claims, conclusions, numbers, and recommendations that " +
        "matter.\n\n" +
        "Format:\n" +
        "- Each bullet exactly: - **<Label>:** <the takeaway, with the specifics that support it>.\n" +
        "- <Label> is a 1–4 word tag. 3–7 bullets. Order by importance.\n" +
        "- If the video states concrete next steps, tools to try, or resources by name, end with a " +
        "**Mentioned & Recommended** bullet listing them.\n" +
        "- If the transcript supports no real takeaway, output exactly: - None stated.\n\n" +
        "Start directly with the first bullet — no heading, no preamble.\n\n" + source,
    },
  ], 900);

  const [overviewMd, topicsMd, takeawaysMd] = await Promise.all([overviewPromise, topicsPromise, takeawaysPromise]);

  let md = String(overviewMd || "").trim();
  const topics = String(topicsMd || "").trim();
  if (topics) md += `\n\n**Key Topics**\n${topics}`;
  const takeaways = String(takeawaysMd || "").trim();
  if (takeaways) md += `\n\n**Key Takeaways**\n${takeaways}`;
  return md.trim();
}

// POST /api/youtube/ai {id, summarize?, force?, messages?}
async function handleVideoAi(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  let apiKey = env.OPENAI_API_KEY || env.OPEN_AI_API_KEY;
  if (!apiKey) return json({ error: "AI isn't configured (set the OPENAI_API_KEY secret)" }, 503);
  if (!env.DB) return json({ error: "Transcripts database is not connected yet" }, 503);

  const body = await request.json().catch(() => ({}));
  const row = await ytRowForSession(env, session, body.id);
  if (!row) return json({ error: "Not found" }, 404);
  if (row.status === "failed") return json({ error: row.error || "That video failed to transcribe" }, 409);
  if (row.status !== "completed") return json({ error: "This video is still being transcribed" }, 409);

  const segments = ytSegmentPayload(await ytSegmentRows(env, row.transcript_id));
  if (!segments.length) return json({ error: "No transcript found for that video yet" }, 404);
  const transcript = ytTranscriptForModel(segments);

  let model = env.OPENAI_MODEL || "gpt-4o";
  ({ apiKey, model } = withLlmProvider(env, apiKey, model));

  if (body.summarize) {
    const cacheKey = ytSummaryKey(row, transcript);
    const force = !!body.force;
    if (!force && env.KV) {
      try {
        const cached = await env.KV.get(cacheKey);
        if (cached) return json({ ok: true, reply: cached, title: row.title || undefined, cached: true });
      } catch {
        /* KV hiccup — generate fresh */
      }
    }
    try {
      // The summary and (only when YouTube gave the video no name) a short
      // display title are minted together; a title failure never sinks the summary.
      const [reply, title] = await Promise.all([
        generateVideoSummary(transcript, apiKey, model, { title: row.title, channel: row.channel }),
        row.title ? Promise.resolve(row.title) : generateVideoTitle(transcript, apiKey, model).catch(() => ""),
      ]);
      if (env.KV) {
        try {
          await env.KV.put(cacheKey, reply);
        } catch {
          /* best-effort cache — still return what we just generated */
        }
      }
      if (title && title !== row.title) {
        await ytUpdateRow(env, row.transcript_id, { title, updated_at: nowIso() }).catch(() => {});
      }
      return json({ ok: true, reply, title: title || undefined });
    } catch (err) {
      return json({ error: "AI request failed", detail: String((err && err.message) || err) }, 502);
    }
  }

  // Same three-pass pipeline the meeting chat runs — resolve the question
  // against the video's own vocabulary, read every slice of the transcript,
  // then answer from what those readers found. A video transcript is one long
  // unattributed stream, which is the hardest case for a single-call design:
  // there are no speaker turns to anchor on and nothing to make the relevant
  // stretch stand out, so "it isn't covered" was the easy wrong answer.
  const history = [];
  for (const m of (Array.isArray(body.messages) ? body.messages : []).slice(-16)) {
    const role = m && m.role === "assistant" ? "assistant" : "user";
    const content = String((m && m.content) || "").slice(0, 4000);
    if (content) history.push({ role, content });
  }

  let cachedSummary = "";
  try {
    cachedSummary = ((await env.KV.get(ytSummaryKey(row, transcript))) || "").slice(0, 6000);
  } catch {
    /* optional context */
  }

  let built;
  try {
    built = await buildChatRequest({
      // Straight from the stored segments: each carries its real start time, so
      // the pipeline's citations point at the actual moment. videoRowsFromText
      // exists to recover that from a flat transcript — unnecessary here, where
      // the timings were never flattened in the first place.
      rows: segments.map((seg) => ({ start_time: seg.start, speaker: "", text: seg.text })),
      history,
      apiKey,
      model,
      planModel: model && model.bedrock ? model : env.OPENAI_FAST_MODEL || model,
      title: row.title || "",
      channel: row.channel || "",
      summary: cachedSummary,
      kind: "video",
      seedPrompt:
        "Give me a briefing on this video: one line on what it is, then the main points in order, then the key " +
        "takeaways. Cite timestamps. Keep it tight and only include what the transcript supports.",
    });
  } catch (err) {
    return json({ error: "AI request failed", detail: String((err && err.message) || err) }, 502);
  }

  try {
    const reply = await openaiChat(apiKey, model, built.messages, 1600, 0.2);
    return json({ ok: true, reply, debug: body.debug ? built.trace : undefined });
  } catch (err) {
    return json({ error: "AI request failed", detail: String((err && err.message) || err) }, 502);
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


// ── Test surface ──────────────────────────────────────────────────────────────
// Named exports alongside the default fetch handler, so `scripts/chat-eval.mjs`
// runs the REAL chat pipeline against a transcript file rather than a copy of it
// that can drift. Inert at runtime — Workers only ever invokes the default
// export — and deliberately limited to the pure, binding-free chat internals.
export {
  parseJson3,
  ytReplaceIsAtomic,
  ytCollapseRepeats,
  ytStampSeconds,
  buildChatRequest,
  buildWeeklyChatRequest,
  videoRowsFromText,
  planChatQuery,
  mapTranscript,
  buildChatGrounding,
  transcriptVocabulary,
  scanTranscript,
  chatQueryTerms,
  chunkTranscript,
  buildChatTranscript,
  fuzzyScore,
  soundKey,
  openaiChat,
};
// CHAT_SYSTEM_PROMPT is deliberately NOT exported. A module Worker treats every
// named export as a potential entrypoint, so workerd rejects one that isn't a
// function — "Incorrect type for map entry 'CHAT_SYSTEM_PROMPT'" — and the
// Worker fails to boot under `wrangler dev`. Nothing imported it anyway.
