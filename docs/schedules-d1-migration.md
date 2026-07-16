# Scheduled & upcoming meetings → D1 (backend-owned)

This is the coordination contract for moving **scheduled meetings** out of the
Worker's KV and into the shared **D1** database (`vexa-transcript`), and for
having the **EC2 backend** own scheduling execution and calendar persistence.

- **Worker side (done, in this repo):** dashboard create/list/cancel of
  schedules read & write the D1 `schedules` table; the Worker's per-minute cron
  stands down so it never double-fires. All behind the `SCHEDULES_BACKEND` flag,
  which defaults to the old KV behavior.
- **EC2 side (you build):** a scheduler loop that fires due rows from that same
  table, and (for calendar) persisting synced Google Calendar events into D1.

The frontend is unchanged — the Worker keeps identical request/response shapes,
so the storage swap is invisible to the React app.

---

## 1. The flag & cutover

`SCHEDULES_BACKEND` (in `wrangler.toml [vars]`):

| value | schedule storage | who fires schedules |
|---|---|---|
| `"kv"` (default) | Worker KV (`schedule:*`) | Worker cron (`runDueSchedules`) |
| `"d1"` | D1 `schedules` table | **EC2 scheduler** (Worker cron stands down) |

**Cutover:** deploy EC2 scheduler → run the backfill (§5) → set
`SCHEDULES_BACKEND="d1"` and deploy the Worker. **Rollback:** set it back to
`"kv"` and deploy. KV rows are never deleted by the migration, so rollback is
lossless.

---

## 2. D1 table: `schedules`

The Worker creates this lazily (`CREATE TABLE IF NOT EXISTS`), so you don't have
to run a migration — but here it is for reference. It lives in the same D1
database the Worker binds as `env.DB`:

- `database_name = "vexa-transcript"`
- `database_id = "d43cc292-3389-42ba-bd20-184ac4335360"`

```sql
CREATE TABLE IF NOT EXISTS schedules (
  id          TEXT PRIMARY KEY,     -- uuid
  owner       TEXT NOT NULL,        -- normalized user email
  meeting_url TEXT NOT NULL,
  recurrence  TEXT NOT NULL,        -- 'once' | 'daily' | 'weekdays' | 'weekly'
  time_zone   TEXT NOT NULL,        -- IANA zone, e.g. 'Asia/Kolkata'
  hour        INTEGER NOT NULL,     -- local wall-clock hour (0-23)
  minute      INTEGER NOT NULL,     -- local wall-clock minute (0-59)
  weekday     INTEGER,              -- 0=Sun..6=Sat; anchors 'weekly'
  next_run    INTEGER NOT NULL,     -- epoch MILLISECONDS (UTC). NOTE: ms, not s.
  created_at  INTEGER NOT NULL,     -- epoch ms
  last_run    INTEGER,              -- epoch ms of the last fire, or NULL
  last_status TEXT,                 -- 'sent' | 'error 502' | 'error: ...' | NULL
  attempts    INTEGER NOT NULL DEFAULT 0  -- consecutive one-time retry count
);
CREATE INDEX IF NOT EXISTS idx_schedules_owner    ON schedules(owner);
CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(next_run);
```

> **Time unit:** `next_run`/`created_at`/`last_run` are **epoch milliseconds**
> (JavaScript `Date.now()`), not seconds. The scheduler must compare against
> `Date.now()`-equivalent milliseconds.

---

## 3. EC2 scheduler loop (the thing you build)

Run about once a minute. This mirrors the Worker's retired `runDueSchedules`
exactly — match it so behavior is identical after cutover.

```
now = current epoch ms
due = SELECT * FROM schedules WHERE next_run <= now

for row in due:
    ok, status = POST {API_BASE}/public/join
                   headers: { "X-API-Key": API_KEY }
                   body:    { "email": row.owner, "meeting_url": row.meeting_url }
    last_run = now
    last_status = ok ? "sent" : ("error " + status)   # on exception: "error: <msg>"

    if row.recurrence != "once":
        attempts = 0
        next = nextRecurringRun(now, row)              # strictly AFTER now (see §4)
        if next: UPDATE row SET next_run=next, last_run, last_status, attempts=0
        else:    DELETE row                            # unreachable in practice
    elif ok:
        DELETE row                                     # one-time succeeded
    else:
        attempts = row.attempts + 1                    # one-time failed → retry
        if attempts >= 3: DELETE row                   # give up (MAX_SCHEDULE_ATTEMPTS)
        else: UPDATE row SET last_run, last_status, attempts   # next_run unchanged → retries next tick
```

`API_BASE` is the bot API (today `http://65.1.101.15.nip.io:8080`); `/public/join`
is the same endpoint the Worker's `dispatchBot` calls. `API_KEY` is the shared
`X-API-Key`.

**Overlap guard:** take a short lease (a row/lock) so two overlapping ticks can't
double-dispatch — the Worker used a 120s KV lease for the same reason.

---

## 4. `nextRecurringRun` — DST-aware next occurrence

Returns the next epoch-ms instant strictly after `afterMs` whose **local**
wall clock in `time_zone` is `hour:minute` on a day the recurrence allows.
Recomputing wall-clock → UTC each time keeps routines correct across DST (the
local time stays put; the UTC instant shifts). Algorithm (ported from the
Worker):

```
nextRecurringRun(afterMs, {recurrence, hour, minute, weekday, time_zone}):
    start = localCalendarDate(afterMs, time_zone)          # y/m/d in the zone
    for i in 0..372:
        cal = start + i days                               # a calendar date + its dow (0=Sun..6=Sat)
        allowed =
            recurrence == "daily"    or
            (recurrence == "weekdays" and 1 <= cal.dow <= 5) or
            (recurrence == "weekly"   and cal.dow == weekday)
        if not allowed: continue
        utc = wallTimeToUtc({cal.y, cal.m, cal.d, hour, minute}, time_zone)
        if utc > afterMs: return utc
    return null

wallTimeToUtc(wall, tz):   # two passes resolve DST
    naive = Date.UTC(wall.y, wall.m-1, wall.d, wall.hour, wall.minute)
    utc   = naive - zoneOffsetMs(naive, tz)
    utc   = naive - zoneOffsetMs(utc,   tz)               # re-resolve at the result
    return utc

zoneOffsetMs(utcMs, tz):   # local − UTC at that instant
    format utcMs in tz, read back its wall-clock fields as if they were UTC,
    return (thatAsIfUtc − utcMs)
```

In Python this is `zoneinfo`; in Node it's `Intl.DateTimeFormat` with a
`timeZone`. The reference implementation is in `worker/index.js`
(`nextRecurringRun`, `wallTimeToUtc`, `zoneOffsetMs`, `zoneParts`, `addDays`).

---

## 5. Backfill existing KV schedules

Before flipping the flag, copy the schedules already in KV into D1. The Worker
exposes an **admin-only, idempotent** endpoint (INSERT OR IGNORE, KV left intact):

```
POST /api/schedules/migrate-kv-to-d1        (admin session)
→ { ok: true, found: <n>, migrated: <n> }
```

Run it once (safe to re-run). Then set `SCHEDULES_BACKEND="d1"` and deploy.

---

## 6. Reaching the shared D1 from EC2

D1 is Cloudflare-managed, so EC2 talks to it over the D1 REST API:

```
POST https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{DATABASE_ID}/query
Authorization: Bearer {CF_API_TOKEN}        # token scoped to D1:Edit
Content-Type: application/json

{ "sql": "SELECT * FROM schedules WHERE next_run <= ?1", "params": [ 1737000000000 ] }
```

`DATABASE_ID = d43cc292-3389-42ba-bd20-184ac4335360`. (If EC2 already reaches
this D1 another way — a binding, a proxy, `wrangler d1 execute` — use that; the
table contract is what matters, not the transport.)

---

## 7. Calendar (upcoming) events — persist in D1

Decision: the backend keeps a **synced copy** of calendar events in D1 (Google
Calendar stays the upstream source of truth; reconcile on each sync).

The Worker's `/api/calendar/*` routes are **unchanged** — they proxy to your
existing calendar endpoints (`/calendar/sync`, `/calendar/meetings`,
`/calendar/meetings/remove|restore`). So the only change is *inside* EC2:

- **`/calendar/sync`** — upsert Google events into a D1 table; mark events that
  vanished from Google as cancelled (**tombstone**, don't hard-delete) so
  remove/restore semantics keep working.
- **`/calendar/meetings`** — read from D1 instead of hitting Google live;
  honor `include_cancelled=true`.
- Keep the **response JSON shape identical** — the frontend maps
  `calendar` / `calendar_events` with fields like `id`, `meeting_url`/`url`,
  `title`/`summary`, `start`/`start_time`, `end_time`, `platform`, `status`,
  `meeting_id`. (See `CalendarEvent` in `src/lib/api.ts`.)

Suggested table:

```sql
CREATE TABLE IF NOT EXISTS calendar_events (
  id           TEXT PRIMARY KEY,     -- provider event id (stable across syncs)
  owner        TEXT NOT NULL,        -- user email the calendar belongs to
  meeting_url  TEXT,
  title        TEXT,
  start_time   TEXT,                 -- ISO 8601
  end_time     TEXT,
  platform     TEXT,
  status       TEXT NOT NULL,        -- 'pending' | 'cancelled'
  meeting_id   TEXT,                 -- links to a recorded meeting once it happens
  updated_at   INTEGER NOT NULL      -- epoch ms of last sync touch
);
CREATE INDEX IF NOT EXISTS idx_calendar_owner ON calendar_events(owner);
```

---

## 8. Summary of responsibilities

| Concern | Owner | Where |
|---|---|---|
| Dashboard create/list/cancel schedule | **Worker** (this repo) | `/api/schedules*` → D1 |
| Enforce max schedules / validate / compute initial `next_run` | **Worker** | `handleCreateSchedule` |
| Fire due schedules + advance `next_run` | **EC2** | scheduler loop (§3–4) |
| Backfill KV → D1 | **Worker** (admin endpoint) | §5 |
| Persist calendar events, serve `/calendar/*` | **EC2** | §7 |
| Show it all in the UI | **Frontend** | unchanged |
