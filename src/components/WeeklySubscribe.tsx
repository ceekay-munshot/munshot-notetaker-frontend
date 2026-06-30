import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { subscribeWeekly, unsubscribeWeekly } from '../lib/api'
import { useAppData } from '../store/AppData'
import { Icon } from './Icon'
import { WeeklyScheduleEditor } from './WeeklyScheduleEditor'

// Weekly-digest subscription as a compact sidebar bell + popover.
// Persists locally; subscribing sends a real confirmation email through
// api.subscribeWeekly (which posts to the Munshot raw-email endpoint).
export const WEEKLY_SUB_KEY = 'munshot:weekly-subscription'

/** The address this browser subscribed the weekly brief with (or null). Shared
 *  with the Weekly page so "Email this edition" can reuse it. */
export function readSubscribedEmail(): string | null {
  try {
    return localStorage.getItem(WEEKLY_SUB_KEY)
  } catch {
    return null
  }
}

export function WeeklySubscribe() {
  const { identity } = useAppData()
  const [open, setOpen] = useState(false)
  const [stored, setStored] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // True once a saved subscription has been loaded (so the identity prefill
  // below never clobbers an address the user already subscribed with).
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(WEEKLY_SUB_KEY)
      if (saved) {
        setStored(saved)
        setEmail(saved)
      }
    } catch {
      /* localStorage unavailable — fine, just won't persist */
    }
    setHydrated(true)
  }, [])

  // Prefill the signed-in user's address once identity resolves — but only when
  // there's no stored subscription and the user hasn't typed anything yet.
  useEffect(() => {
    if (hydrated && !stored && !email && identity?.email) setEmail(identity.email)
  }, [hydrated, stored, email, identity])

  async function subscribe(e: FormEvent) {
    e.preventDefault()
    const addr = email.trim()
    if (!addr || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await subscribeWeekly(addr, { name: identity?.name })
      if (res.subscribed) {
        try {
          localStorage.setItem(WEEKLY_SUB_KEY, res.email)
        } catch {
          /* ignore */
        }
        setStored(res.email)
      } else {
        setError(res.message || "Couldn't send the confirmation — please try again.")
      }
    } finally {
      setBusy(false)
    }
  }

  async function unsubscribe() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await unsubscribeWeekly(stored ?? email)
      try {
        localStorage.removeItem(WEEKLY_SUB_KEY)
      } catch {
        /* ignore */
      }
      setStored(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="relative">
      {/* Trigger — a small bell row, styled like the nav items above it */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Weekly brief email"
        aria-expanded={open}
        className={`press-soft flex w-full items-center gap-3 rounded-lg px-3 py-2.5 ${
          open ? 'bg-surface-container-low text-on-surface' : 'font-medium text-secondary hover:bg-surface-container-low hover:text-on-surface'
        }`}
      >
        <span className="relative">
          <Icon
            name={stored ? 'notifications_active' : 'notifications'}
            size={20}
            fill={!!stored}
            className={stored ? 'text-primary' : ''}
          />
          {stored && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-success ring-2 ring-surface" />}
        </span>
        <span className="text-[14px]">Weekly brief</span>
      </button>

      {open && (
        <>
          {/* click-away */}
          <button className="fixed inset-0 z-40 cursor-default" aria-hidden onClick={() => setOpen(false)} />
          {/* Anchored to the bell's TOP so it grows down into the open sidebar space
              below it (the editor makes it tall); capped to the viewport with scroll. */}
          <div className="pop absolute top-0 left-full z-50 ml-2 max-h-[calc(100vh-2rem)] w-72 origin-top-left overflow-y-auto rounded-xl border border-outline-variant bg-surface p-md shadow-card-hover">
            {stored ? (
              <>
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-on-primary">
                    <Icon name="mark_email_read" size={18} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold text-on-surface">You're subscribed</p>
                    <p className="truncate text-[12px] text-secondary">{stored}</p>
                  </div>
                </div>
                <p className="mb-3 text-[12px] text-secondary">A confirmation just landed in your inbox. Then one email every week with the whole weekly summary — on the schedule below.</p>
                <button
                  onClick={unsubscribe}
                  disabled={busy}
                  className="press w-full rounded-lg border border-outline-variant bg-surface px-md py-2 text-[13px] font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-60"
                >
                  {busy ? 'Updating…' : 'Unsubscribe'}
                </button>
              </>
            ) : (
              <form onSubmit={subscribe}>
                <div className="mb-3 flex items-center gap-2.5">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full chip-signal">
                    <Icon name="mail" size={18} />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[14px] font-semibold text-on-surface">Weekly brief in your inbox</p>
                    <p className="text-[12px] text-secondary">One email a week — this whole summary.</p>
                  </div>
                </div>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    if (error) setError(null)
                  }}
                  placeholder="you@example.com"
                  className="mb-2 w-full rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-[14px] outline-none focus:border-primary"
                />
                <button
                  type="submit"
                  disabled={busy}
                  className="press flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-md py-2.5 text-[14px] font-semibold text-on-primary hover:bg-primary-container disabled:opacity-60"
                >
                  <Icon name="notifications_active" size={16} /> {busy ? 'Sending…' : 'Subscribe'}
                </button>
                {error && (
                  <p className="mt-2 flex items-start gap-1.5 text-[12px] text-error" role="alert">
                    <Icon name="error" size={14} className="mt-0.5 shrink-0" />
                    <span>{error}</span>
                  </p>
                )}
              </form>
            )}
            <WeeklyScheduleEditor />
          </div>
        </>
      )}
    </div>
  )
}
