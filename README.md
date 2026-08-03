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
| POST   | `/youtube/probe?v=`   | Admin-only diagnostics: what each YouTube hop returns |

These keep the shape the EC2 API returned, so callers written against that
contract are unchanged. The owner email is always taken from the **session** — an
email in the body or query string is ignored, since trusting it would let any
caller read or write another customer's transcripts. Requesting a transcript you
don't own answers **404**, never 403: a 403 would confirm the id exists.

`/youtube/probe` reads nothing but is a **POST** on purpose. The session cookie
is `SameSite=None` (this app is embedded cross-site), so a page an admin merely
visits could otherwise fire authenticated GETs at it from an `<img>` tag, and
each call spends three requests on the shared egress. As a POST it goes through
the Origin check, and a short per-admin cooldown bounds it after that.

**Where the transcript comes from.** YouTube blocks the egress of every cloud
host we can run on — EC2's and Cloudflare's alike, measured against the deployed
Worker. So the outbound leg goes through a provider whose IPs YouTube still
answers. Only that leg is third-party; parsing, storage, ownership and the whole
route contract are ours.

| Order | Provider | Needs | Gives |
| --- | --- | --- | --- |
| 1 | [Supadata](https://supadata.ai) | `SUPADATA_API_KEY` secret | Per-cue offsets and durations in ms — the model here exactly |
| 2 | [youtube-transcript.ai](https://youtube-transcript.ai) | nothing | Paragraph-level stamps, plus a title and duration |
| 3 | Direct from YouTube | `YT_ALLOW_DIRECT=1` | The best source, when the egress is clean |

**A key is effectively required.** The keyless provider rate-limits by IP, and a
Worker shares its egress IPs with the rest of Cloudflare — so its bucket is
spent by strangers and it answers with a sales pitch (HTTP 200, no less)
regardless of our own volume. Measured on the deployed Worker, not assumed. A
key gives us our own quota instead of one shared with a datacenter, which is the
whole reason it helps; Supadata's free tier is 100 requests/month with no card,
and is used automatically the moment the secret exists. It is also the better
source anyway: paragraph stamps are roughly 8x coarser than per-cue ones, and
the transcript view and chat citations both point at timestamps.

The keyless provider stays as the fallback because it costs nothing to try and
does work from an IP that has not been exhausted.

Three different things get three different messages, because they need three
different responses: no key configured, a key that ran out of credit, and a key
that was rejected. On a free tier the middle one is what people will see most,
and telling them to configure a key they already configured helps nobody.

Direct is **off** by default, and deliberately: we have measured that it fails
here, so leaving it in the chain would spend a doomed request on every fetch,
and a bot-gated reply reads as "video unavailable" — which would overwrite a
correct answer from a provider that did reach YouTube. Turn it on once the
egress is clean and it returns as the last resort. Setting `YT_ORIGIN` instead
means "fetch from YouTube yourself" and makes direct the only provider.

Auto-generated captions arrive from the keyless provider with YouTube's
rolling-window repetition intact — every phrase two or three times over, because
joining the cues into prose has already destroyed the boundaries that make it
removable. `ytCollapseRepeats` undoes it by collapsing immediately-repeated runs
of three words or more; shorter windows would eat real speech ("no no no"), and
a repeat that is not adjacent is someone genuinely saying the same thing twice.

**How the direct path builds a transcript.** `GET /watch?v=<id>` → extract
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

- `transcript_id` is allocated as `1_000_000_000 + Date.now()` plus a small
  random offset. AWS uses small Postgres serials, so the two id spaces can never
  collide; the offset is what stops concurrent inserts all starting from the
  same candidate and walking forward in lockstep.
- `user_id` is AWS's Postgres user id, which the Worker doesn't know, so
  Worker-origin rows store `0`. `owner_email` is set on **both** tables — that is
  what the dashboard filters on.

**One writer per row.** Every request that intends to fetch claims the row
first, with a conditional update that exactly one of them can win; the losers
are handed the winner's row and never reach YouTube. That includes a forced
refresh of a row that is already `completed` — the KV cooldown meant to space
those out is eventually consistent, so without the claim two of them could both
fetch and both write the same segment indexes, interleaving two transcripts.

The trade is that a forced refresh reports itself as being written for the few
seconds it runs, rather than serving the old text meanwhile. Nothing is
destroyed by that: the segment rows stay where they are, and every failure below
restores `completed` over them intact.

A transcript up to 468 cues is written as **one atomic D1 batch**, so a failed
write leaves whatever was there exactly as it was: a refresh goes back to
`completed` over its old segments, and a first attempt is marked `failed` with a
try-again message. Past that it commits in pieces, and a failure part-way leaves
a real mix — that row is marked `failed` saying it will be rebuilt, rather than
being handed back as though it were whole. There is no staging table to switch
over instead: these are AWS's tables too.

Either way the row never keeps its claim after a failed write. Leaving it
`processing` would answer 500 and then hand the same untouched row back to the
next submission, so the page polls something nothing is writing, for a failure
nobody was told about.

Two schema additions, both additive and created on demand. The first is
`CREATE UNIQUE INDEX IF NOT EXISTS uq_yt_owner_video ON youtube_transcripts
(owner_email, video_id)`, which backs idempotency: re-posting a URL already transcribed for that account returns the
existing row without refetching, unless `force: true`. A previously failed row
retries.

The second is a `worker_youtube_fetch_budget` table, which is **ours alone** —
nothing else reads it, and it is not one of the two shared transcript tables. It
is a per-account token bucket over how many videos this Worker is asked to
fetch: tokens refill continuously and each fetch spends one, reserved by a
single upsert so neither a burst of concurrent requests nor an hour boundary
lets an account past the ceiling. That ceiling is what stops one account looping
add → delete → re-add (which frees the row cap and erases the record of prior
work) until YouTube bot-gates the shared egress.

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
