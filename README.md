# Munshot Notetaker — frontend

A single Cloudflare Worker that provides:

- **Logins** — email + password stored in Workers KV (one `user:<email>` key per user). Passwords are PBKDF2-SHA256 hashed with a per-user salt. Sessions are KV-backed and carried in an HttpOnly cookie.
- **A meeting form** — once signed in, paste a meeting link and it calls the munshot `/public/join` endpoint. The `X-API-Key` is held as a Worker **secret** and injected server-side, so it never reaches the browser.
- **Scheduling & routines** — schedule the notetaker to join at a future time, or set a repeating routine (daily / weekdays / weekly). A Cloudflare **Cron Trigger** fires due schedules server-side every minute, so the bot joins on time whether or not you have the dashboard open.

## Routes

| Method | Path                    | Purpose                                          |
| ------ | ----------------------- | ------------------------------------------------ |
| GET    | `/`                     | Login / register page                            |
| GET    | `/dashboard`            | Meeting form + scheduler (requires session)      |
| POST   | `/api/register`         | Create a user, start a session                   |
| POST   | `/api/login`            | Verify credentials, start a session              |
| POST   | `/api/logout`           | Destroy the session                              |
| POST   | `/api/join`             | Proxy to `/public/join` with the API key         |
| POST   | `/api/leave`            | Proxy to `/public/leave` with the API key        |
| GET    | `/api/transcripts`      | Transcripts for the signed-in user (all, admin)  |
| GET    | `/api/schedules`        | List the signed-in user's schedules              |
| POST   | `/api/schedules`        | Create a schedule / routine                      |
| POST   | `/api/schedules/delete` | Cancel one of the user's schedules               |

`/api/join` sends the same payload as the original curl:

```json
{ "email": "<notetaker email>", "meeting_url": "<your meeting link>" }
```

### Scheduling

`POST /api/schedules` body (the owner email is taken from the session, never the body):

```json
{
  "meeting_url": "<your meeting link>",
  "run_at": 1750000000000,          // epoch ms of the first run
  "recurrence": "once",             // "once" | "daily" | "weekdays" | "weekly"
  "tz_offset": -120                 // browser getTimezoneOffset(), for "weekdays"
}
```

Schedules are stored in KV under `schedule:<owner>:<id>`. A Cron Trigger (`* * * * *`)
runs `runDueSchedules` every minute: it sends each due meeting to `/api/join`'s
upstream, then advances recurring schedules to their next occurrence or removes
one-time ones. A one-time send that fails is retried for a few minutes, then dropped.

## Setup & deploy

```bash
npm install

# 1. Create the KV namespace and paste its id into wrangler.toml
npx wrangler kv namespace create KV

# 2. Set the API key as a secret (paste the X-API-Key value when prompted)
npx wrangler secret put API_KEY

# 3. (optional) Require a code to register, to keep signups closed
npx wrangler secret put SIGNUP_CODE

# 4. Deploy
npx wrangler deploy
```

Local dev: put secrets in a `.dev.vars` file (git-ignored) and run `npx wrangler dev`:

```
API_KEY=vxa_bot_...
# SIGNUP_CODE=letmein
```

## Notes

- The API key is **not** committed — set it with `wrangler secret put`. `wrangler.toml` only holds the public join endpoint.
- The meeting form pre-fills the notetaker email with your login email; edit it per-meeting if needed.
- If `SIGNUP_CODE` is set, the register form shows a code field and registration requires it.
