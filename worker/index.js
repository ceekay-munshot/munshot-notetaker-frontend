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
      if (method === "POST" && pathname === "/api/weekly/people") return handleWeeklyPeople(request, env);
      if (method === "GET" && pathname === "/api/schedules") return handleListSchedules(request, env);
      if (method === "POST" && pathname === "/api/schedules") return handleCreateSchedule(request, env);
      if (method === "POST" && pathname === "/api/schedules/delete") return handleDeleteSchedule(request, env);
      if (method === "POST" && pathname === "/api/calendar/sync") return handleCalendarSync(request, env);
      if (method === "GET" && pathname === "/api/calendar/meetings") return handleCalendarMeetings(request, env);
      if (method === "POST" && pathname === "/api/calendar/meetings/remove") return handleCalendarRemove(request, env);
      if (method === "POST" && pathname === "/api/calendar/meetings/restore") return handleCalendarRestore(request, env);
      if (method === "GET" && pathname === "/api/config") return handleGetConfig(request, env);
      if (method === "POST" && pathname === "/api/config") return handleSetConfig(request, env);
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

// The effective base URL every bot/calendar call is sent to: the KV override if
// an admin set one, else the configured fallback. All endpoints (/public/join,
// /public/leave, /calendar/*) are built from this single head.
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

// Fetches any stored AI-generated titles for the meetings in these rows, as a
// { meeting_id: title } map, so the dashboard can show real names instead of
// "Meeting <id>". Scoped to the caller's own (already-authorized) meetings, and
// capped so a huge history can't blow the Worker's subrequest budget — meetings
// past the cap keep the "Meeting <id>" fallback until they're opened.
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
  return out;
}

/* ------------------------------ AI assistant ------------------------------ */

// KV key under which a meeting's generated summary is cached. Keyed by meeting_id
// only (shared across all co-owners); bump the version suffix to invalidate every
// cached summary at once after a summary-format change.
function summaryCacheKey(meetingId) {
  return `summary:v1:${String(meetingId).trim()}`;
}

// KV key for a meeting's AI-generated display title. Ad-hoc meetings arrive with
// no name (the UI shows "Meeting <id>"); we mint a short title once, while
// summarizing, and cache it here so every user sees the same name everywhere.
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
// A summary is built from several OpenAI calls for depth: one for the overview +
// decisions/action items, then one per participant capturing — step by step —
// what that person actually said and did (not a vague one-liner). The pieces are
// stitched into Markdown (bold section titles + "- " bullets) the dashboard renders.

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

  // 1) Overview prose (no header, so it reads clean as a teaser) + decisions.
  const overviewPromise = openaiChat(apiKey, model, [
    {
      role: "system",
      content:
        "You are a precise meeting analyst. Use ONLY the transcript; never invent names, numbers, decisions, or owners. " +
        "Use **bold** for section titles — never # headings.",
    },
    {
      role: "user",
      content:
        "From the meeting transcript, write:\n\n" +
        "First, a 2-3 sentence overview — purpose, main topics, outcome. Concise; no header before it.\n\n" +
        "Then a blank line, then this section:\n\n" +
        "**Decisions & Action Items**\n" +
        'Short bullets ("- " per line), one decision or action item each, with the owner/deadline in parentheses when the ' +
        'transcript states them (e.g. "- Multiselect filter options (Owner: Tarandeep)."). Keep each to a phrase, not a ' +
        'sentence. If there were none, write "- None recorded."\n\n' +
        "Output only that.\n\nTRANSCRIPT:\n" + transcript,
    },
  ], 900);

  // 2) One detailed, step-by-step call per participant (run in parallel).
  const perPersonPrompt = (name) => [
    {
      role: "system",
      content:
        "You are a sharp meeting summarizer who writes terse, minimalist notes. Summarize one person's contribution in your " +
        "own words from the transcript only — never quote or transcribe. Keep all the substance; cut every word you can.",
    },
    {
      role: "user",
      content:
        `In terse note form, summarize everything ${name} contributed — what they explained, proposed, asked, demonstrated, ` +
        "or decided — as short bullets, in order.\n\n" +
        "Style:\n" +
        "- Minimalist meeting notes, NOT prose. Each bullet = a compact fragment (drop filler words, articles, hedging). " +
        "No full-sentence padding.\n" +
        "- Cut WORDS, never INFORMATION — keep every specific: features, tools, numbers, names, reasons, decisions.\n" +
        "- One idea per bullet. Merge related lines; a multi-step walkthrough → one short bullet per step.\n" +
        "- Skip pleasantries (okay / sure / can you see my screen). No quotes. Don't prefix bullets with the name.\n" +
        `- If ${name} barely spoke, one bullet.\n\n` +
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
        { role: "system", content: "Sharp summarizer who writes terse, minimalist notes from the transcript only; never quote or transcribe." },
        {
          role: "user",
          content:
            "In terse note form, summarize what happened — key topics, points, decisions — as short Markdown bullets, in " +
            "order. Compact fragments, no filler, no quotes; cut words, not information.\n\nTRANSCRIPT:\n" + transcript,
        },
      ],
      900
    )
      .then((notes) => [{ name: "", notes }])
      .catch(() => [{ name: "", notes: "- (Notes unavailable)" }]);
  }

  const [overviewMd, people] = await Promise.all([overviewPromise, peoplePromise]);

  let md = String(overviewMd || "").trim();
  if (speakers.length) {
    md += "\n\n**Discussion by Person**";
    for (const p of people) md += `\n\n**${p.name}**\n${String(p.notes || "").trim()}`;
  } else {
    md += `\n\n**Detailed Discussion**\n${String((people[0] && people[0].notes) || "").trim()}`;
  }
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

  const model = env.OPENAI_MODEL || "gpt-4o-mini";
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
    if (!force && env.KV) {
      try {
        const cached = await env.KV.get(cacheKey);
        if (cached) {
          // Summary is cached; return the stored title too. If this meeting was
          // summarized before titles existed, mint one now (once) so it still
          // gets a name.
          let title = "";
          try {
            title = (await env.KV.get(titleKey)) || "";
            if (!title) {
              title = await generateMeetingTitle(rows, apiKey, model);
              if (title) await env.KV.put(titleKey, title);
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
      // best-effort — a title failure must never sink the summary).
      const [reply, title] = await Promise.all([
        generateDetailedSummary(rows, apiKey, model),
        generateMeetingTitle(rows, apiKey, model).catch(() => ""),
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
  // created_at desc per meeting → newest meetings first.
  const order = [...byMeeting.entries()].sort((a, b) => {
    const la = a[1].reduce((m, r) => (r.created_at > m ? r.created_at : m), "");
    const lb = b[1].reduce((m, r) => (r.created_at > m ? r.created_at : m), "");
    return la < lb ? 1 : la > lb ? -1 : 0;
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
// (own rows; all rows for admin), then asks OpenAI for a STRICT-JSON breakdown
// per participant: an overall view, what they've accomplished, and their current
// to-dos. The OpenAI key stays a server-side secret. Same ACL as /api/transcripts.
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

  const transcripts = buildMultiMeetingText(rows);
  const messages = [
    {
      role: "system",
      content:
        "You analyze a team's meeting transcripts and produce a per-person status rollup. " +
        "Use ONLY what the transcripts support — never invent names, tasks, or outcomes. " +
        "Respond with STRICT JSON only.",
    },
    {
      role: "user",
      content:
        "From the meeting transcripts below, produce a per-person rollup across all the meetings. " +
        "For each person who actually spoke or was discussed, return an object with:\n" +
        '- "name": their name exactly as it appears in the transcript.\n' +
        '- "overall": one or two sentences describing their role / focus across the meetings.\n' +
        '- "accomplished": an array of concrete things they have completed or made progress on (past tense).\n' +
        '- "todo": an array of concrete current or next tasks / action items they still need to do.\n' +
        "Keep each list item short (a phrase, not a paragraph). Omit a person entirely if there is nothing " +
        "concrete to say. If a list has nothing, use an empty array. " +
        'Return JSON of the exact shape: {"people":[{"name":"","overall":"","accomplished":[],"todo":[]}]}.\n\n' +
        "TRANSCRIPTS:\n" + transcripts,
    },
  ];

  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  let upstream;
  try {
    upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        max_tokens: 1500,
        response_format: { type: "json_object" },
      }),
    });
  } catch (err) {
    return json({ error: "Failed to reach the AI service", detail: String((err && err.message) || err) }, 502);
  }
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    const detail = (data && data.error && data.error.message) || `HTTP ${upstream.status}`;
    return json({ error: "AI request failed", detail }, 502);
  }
  const content =
    (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "{}";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = { people: [] };
  }
  const people = Array.isArray(parsed.people)
    ? parsed.people
        .map((p) => ({
          name: String((p && p.name) || "").trim(),
          overall: String((p && p.overall) || "").trim(),
          accomplished: Array.isArray(p && p.accomplished) ? p.accomplished.map((x) => String(x).trim()).filter(Boolean) : [],
          todo: Array.isArray(p && p.todo) ? p.todo.map((x) => String(x).trim()).filter(Boolean) : [],
        }))
        .filter((p) => p.name)
    : [];
  return json({ ok: true, people });
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
    const base = await resolveApiBase(env);
    const upstream = await fetch(base + "/calendar/sync", {
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
    const base = await resolveApiBase(env);
    const includeCancelled = new URL(request.url).searchParams.get("include_cancelled") === "true";
    const target =
      base + "/calendar/meetings?email=" + encodeURIComponent(session.identity) +
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
// comes from the calendar_events array; email is the session's, added server-side.
async function handleCalendarRemove(request, env) {
  const session = await getSession(request, env);
  if (!session) return json({ error: "Not authenticated" }, 401);
  if (session.isAdmin) return json({ error: "Admin accounts have no calendar" }, 403);
  if (!env.API_KEY) return json({ error: "Server is missing the API_KEY secret" }, 500);
  const body = await request.json().catch(() => ({}));
  const eventId = body.event_id;
  if (eventId === undefined || eventId === null || eventId === "") {
    return json({ error: "event_id is required" }, 400);
  }
  try {
    const base = await resolveApiBase(env);
    const upstream = await fetch(base + "/calendar/meetings/remove", {
      method: "POST",
      headers: { "X-API-Key": env.API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: session.identity, event_id: eventId }),
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
  if (session.isAdmin) return json({ error: "Admin accounts have no calendar" }, 403);
  if (!env.API_KEY) return json({ error: "Server is missing the API_KEY secret" }, 500);
  const body = await request.json().catch(() => ({}));
  const eventId = body.event_id;
  if (eventId === undefined || eventId === null || eventId === "") {
    return json({ error: "event_id is required" }, 400);
  }
  try {
    const base = await resolveApiBase(env);
    const upstream = await fetch(base + "/calendar/meetings/restore", {
      method: "POST",
      headers: { "X-API-Key": env.API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: session.identity, event_id: eventId }),
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

