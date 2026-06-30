# Munshot Notetaker — frontend

A **React dashboard** (Vite + TypeScript + Tailwind) served by a **Cloudflare Worker**. The Worker is the API + static host; the SPA is the whole UI, including login, and lives behind the session.

- **Architecture** — `worker/index.js` handles `/api/*` (auth, transcripts, AI, schedules, calendar, the join/leave bot) and serves the built SPA from `./dist` via the `[assets]` binding. The React app (in `src/`) calls those routes; it probes `/api/me` on boot and shows the login screen until there's a session.
- **Logins** — email + password stored in Workers KV (one `user:<email>` key per user). Passwords are PBKDF2-SHA256 hashed with a per-user salt. Sessions are KV-backed and carried in an HttpOnly cookie. Sign-in / register are rebuilt in the SPA.
- **Meetings** — the dashboard lists every meeting the notetaker has transcribed (`/api/transcripts`, grouped by `meeting_id`), with a per-meeting detail view (transcript + on-demand AI summary), search across transcripts, and a weekly digest.
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
#    (optional) override the model — defaults to gpt-4o-mini
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
# OPENAI_MODEL=gpt-4o-mini
# SIGNUP_CODE=letmein
```

## Notes

- The API key is **not** committed — set it with `wrangler secret put`. `wrangler.toml` only holds the public join endpoint.
- The meeting form pre-fills the notetaker email with your login email; edit it per-meeting if needed.
- If `SIGNUP_CODE` is set, the register form shows a code field and registration requires it.
