# Munshot Notetaker — frontend

A **React dashboard** (Vite + TypeScript + Tailwind) served by a **Cloudflare Worker**. The Worker is the API + static host; the SPA is the whole UI, including login, and lives behind the session.

- **Architecture** — `worker/index.js` handles `/api/*` (auth, transcripts, AI, schedules, calendar, the join/leave bot) and serves the built SPA from `./dist` via the `[assets]` binding. The React app (in `src/`) calls those routes; it probes `/api/me` on boot and shows the login screen until there's a session.
- **Logins** — email + password stored in Workers KV (one `user:<email>` key per user). Passwords are PBKDF2-SHA256 hashed with a per-user salt. Sessions are KV-backed and carried in an HttpOnly cookie. Sign-in / register are rebuilt in the SPA.
- **Meetings** — the dashboard lists every meeting the notetaker has transcribed (`/api/transcripts`, grouped by `meeting_id`), with a per-meeting detail view (transcript + on-demand AI summary), search across transcripts, and a weekly digest.
- **Videos** — paste a YouTube link and **this Worker** fetches the captions from YouTube, parses them, and stores them in D1. Each account sees only the videos it added; admin sees every account's. A video gets the same treatment a meeting does: stored transcript, one-page AI summary, and chat over it.
- **Send the notetaker** — paste a meeting link to send the bot now (`/public/join`), or schedule it for later (one-time / daily / weekdays / weekly). The `X-API-Key` is a Worker **secret** injected server-side, so it never reaches the browser. A Cloudflare **Cron Trigger** fires due schedules every minute.
- **Calendar** — sync your calendar and send the notetaker to upcoming meetings in one click.
- **Meeting Assistant (AI)** — each meeting auto-summarizes its transcript and answers follow-up questions. The transcript is loaded server-side (per-user scoping) and sent to OpenAI with the `OPENAI_API_KEY` held as a Worker **secret**.

## Develop & build

```bash
npm install
npm run build      # tsc + vite build -> ./dist
npm run deploy     # build, then wrangler deploy

# Local dev: run the Worker API and the Vite SPA together.
npm run dev:worker # wrangler dev  (the API, on :8787)
npm run dev        # vite          (the SPA; proxies /api -> :8787)
```

## Routes

| Method | Path                    | Purpose                                          |
| ------ | ----------------------- | ------------------------------------------------ |
| GET    | `/*`                    | The React SPA (index.html + assets); `/api/*` excepted |
| GET    | `/api/me`               | Session probe for the SPA (user, isAdmin, or 401) |
| POST   | `/api/register`         | Create a user, start a session                   |
| POST   | `/api/login`            | Verify credentials, start a session              |
| POST   | `/api/logout`           | Destroy the session                              |
| POST   | `/api/join`             | Proxy to `/public/join` with the API key         |
| POST   | `/api/leave`            | Proxy to `/public/leave` with the API key        |
| GET    | `/api/transcripts`      | Transcripts for the signed-in user (all, admin)  |
| GET    | `/api/youtube`          | The user's YouTube videos (all accounts', admin) |
| POST   | `/api/youtube`          | Transcribe a YouTube link (captions → D1)        |
| GET    | `/api/youtube/video`    | One video + its transcript text                  |
| POST   | `/api/youtube/delete`   | Remove a video from the account's list           |
| POST   | `/api/youtube/ai`       | Summarize / chat over a video transcript (OpenAI) |
| POST   | `/youtube`              | Transcript API contract: transcribe a video      |
| GET    | `/youtube/<id>`         | Transcript API contract: the record + segments   |
| GET    | `/youtube/<id>.txt`     | Transcript API contract: plain text              |
| POST   | `/api/ai`               | Summarize / chat over a meeting transcript (OpenAI) |
| GET    | `/api/schedules`        | List the signed-in user's schedules              |
| POST   | `/api/schedules`        | Create a schedule / routine                      |
| POST   | `/api/schedules/delete` | Cancel one of the user's schedules               |
| POST   | `/api/calendar/sync`    | Sync the signed-in user's calendar               |
| GET    | `/api/calendar/meetings`| Upcoming calendar meetings for the user          |

`/api/join` sends the same payload as the original curl:

```json
{ "email": "<notetaker email>", "meeting_url": "<your meeting link>" }
```

### YouTube transcripts

The Worker owns YouTube transcripts end to end — fetch, parse, store. Nothing is
proxied to the transcript API on EC2 any more.

**Why here and not the API.** YouTube hard-blocks the EC2 egress IP: every
request from there — a plain watch-page GET, not just the player API — comes back
"Sign in to confirm you're not a bot" with `captionTracks` stripped, and every
player client fails identically, so it is IP reputation rather than tooling.
Cloudflare's egress is not blocked and this Worker already has D1 write access,
so it is the natural owner.

| Method | Path                  | Purpose                                            |
| ------ | --------------------- | -------------------------------------------------- |
| POST   | `/youtube`            | Transcribe a video (`{ url, force }`)               |
| GET    | `/youtube/<id>`       | The transcript record + its segments                |
| GET    | `/youtube/<id>.txt`   | Plain text; 409 while it is still being written     |

These keep the shape the EC2 API returned, so callers written against that
contract are unchanged. The owner email is always taken from the **session** — an
email in the body or query string is ignored, since trusting it would let any
caller read or write another customer's transcripts. Requesting a transcript you
don't own answers **404**, never 403: a 403 would confirm the id exists.

**How a transcript is built.** `GET /watch?v=<id>` → extract
`ytInitialPlayerResponse` → read
`captions.playerCaptionsTracklistRenderer.captionTracks[]` → pick a track →
fetch `baseUrl + "&fmt=json3"` → parse. Track preference: **manual beats
auto-generated** (auto has no real punctuation model), then `en`, `en-US`,
`en-GB`, the video's own language, and finally the shortest language code (a
plain `hi` beats a machine-translated `hi-Latn`). If the watch page comes back
bot-gated, there is exactly **one** fallback — the InnerTube player API — before
giving up; hammering YouTube is how Cloudflare's egress gets blocked too.

The json3 parse has three quirks worth knowing, all handled in `parseJson3`:
auto tracks interleave an `aAppend` event between every real line whose only
content is a newline (keeping them doubles the segment count and blank-lines
every sentence), `dDurationMs` is absent on some events (fall back to the next
event's start, or +2s for the last), and one line is often split across several
`segs`.

**Storage.** Rows go into the existing `youtube_transcripts` and
`youtube_transcript_segments` tables, which AWS also writes — this Worker never
creates or alters them. Two rules follow from sharing:

- `transcript_id` is allocated as `1_000_000_000 + Date.now()`. AWS uses small
  Postgres serials, so the two id spaces can never collide.
- `user_id` is AWS's Postgres user id, which the Worker doesn't know, so
  Worker-origin rows store `0`. `owner_email` is set on **both** tables — that is
  what the dashboard filters on.

The one schema addition is `CREATE UNIQUE INDEX IF NOT EXISTS uq_yt_owner_video
ON youtube_transcripts (owner_email, video_id)`, which is additive and backs
idempotency: re-posting a URL already transcribed for that account returns the
existing row without refetching, unless `force: true`. A previously failed row
retries.

**Captions only.** A video with no caption track cannot be transcribed here —
the ASR fallback needs the audio, which only the AWS side can push to Deepgram,
and that path is IP-blocked. Those are stored as `failed` with a plain
explanation ("This video has no captions available.") rather than left looking
like they're still queued. The same applies to live streams, private/removed
videos (YouTube's own reason is passed through), and a bot-gated fetch.

`YT_ORIGIN` overrides where YouTube is fetched from. It exists so the fetch and
parse path can be pointed at a fixture server in local testing; any non-https
value is ignored, so it cannot be turned into an open proxy.

### Scheduling

`POST /api/schedules` body (the owner email is taken from the session, never the body):

```json
{
  "meeting_url": "<your meeting link>",
  "local_datetime": "2026-06-27T09:00",   // wall-clock time, as picked
  "recurrence": "daily",                  // "once" | "daily" | "weekdays" | "weekly"
  "time_zone": "America/New_York"         // IANA zone the wall-clock is in
}
```

The chosen wall-clock time is resolved to a real UTC instant in the chosen
**IANA time zone**, so a schedule fires at the right local time even for users in
other zones. Recurring schedules recompute their next run as wall-clock → UTC each
time, so routines stay anchored to local time across **DST** changes (e.g. a daily
09:00 New York routine fires at 14:00 UTC in winter and 13:00 UTC in summer).

Schedules are stored in KV under `schedule:<owner>:<id>`. A Cron Trigger (`* * * * *`)
runs `runDueSchedules` every minute: it sends each due meeting to `/api/join`'s
upstream, then recomputes recurring schedules' next occurrence or removes one-time
ones. A one-time send that fails is retried for a few minutes, then dropped.

> **Why a Cron Trigger?** Workers are serverless — nothing stays running between
> requests. The schedule itself lives in **KV** (durable storage), and Cloudflare's
> Cron Trigger wakes a *fresh* Worker instance once a minute to check KV for due
> schedules and fire them. No process is held open waiting for the time to arrive.
> (Cron Triggers are a **Workers** feature; Cloudflare **Pages** Functions don't
> have them — this project is a Worker, so it works.)

## Setup & deploy

```bash
npm install

# 1. Create the KV namespace and paste its id into wrangler.toml
npx wrangler kv namespace create KV

# 2. Set the API key as a secret (paste the X-API-Key value when prompted)
npx wrangler secret put API_KEY

# 3. Enable the Meeting Assistant (paste your OpenAI API key when prompted)
npx wrangler secret put OPENAI_API_KEY
#    (optional) override the model — defaults to gpt-4o
#    npx wrangler secret put OPENAI_MODEL

# 4. (optional) Require a code to register, to keep signups closed
npx wrangler secret put SIGNUP_CODE

# 5. Deploy
npx wrangler deploy
```

Local dev: put secrets in a `.dev.vars` file (git-ignored) and run `npx wrangler dev`:

```
API_KEY=vxa_bot_...
OPENAI_API_KEY=sk-...
# OPENAI_MODEL=gpt-4o
# SIGNUP_CODE=letmein
```

## Notes

- The API key is **not** committed — set it with `wrangler secret put`. `wrangler.toml` only holds the public join endpoint.
- The meeting form pre-fills the notetaker email with your login email; edit it per-meeting if needed.
- If `SIGNUP_CODE` is set, the register form shows a code field and registration requires it.
