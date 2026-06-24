# Munshot Notetaker — frontend

A single Cloudflare Worker that provides:

- **Logins** — email + password stored in Workers KV (one `user:<email>` key per user). Passwords are PBKDF2-SHA256 hashed with a per-user salt. Sessions are KV-backed and carried in an HttpOnly cookie.
- **A meeting form** — once signed in, paste a meeting link and it calls the munshot `/public/join` endpoint. The `X-API-Key` is held as a Worker **secret** and injected server-side, so it never reaches the browser.

## Routes

| Method | Path            | Purpose                                  |
| ------ | --------------- | ---------------------------------------- |
| GET    | `/`             | Login / register page                    |
| GET    | `/dashboard`    | Meeting form (requires session)          |
| POST   | `/api/register` | Create a user, start a session           |
| POST   | `/api/login`    | Verify credentials, start a session      |
| POST   | `/api/logout`   | Destroy the session                      |
| POST   | `/api/join`     | Proxy to `/public/join` with the API key |

`/api/join` sends the same payload as the original curl:

```json
{ "email": "<notetaker email>", "meeting_url": "<your meeting link>" }
```

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
