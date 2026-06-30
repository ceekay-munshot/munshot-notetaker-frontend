import { useEffect, useRef } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { useAppData } from '../store/AppData'
import { isEmbedded, type Identity } from '../lib/munshot'
import { Icon } from './Icon'
import { WeeklySubscribe } from './WeeklySubscribe'

type NavItem = { to: string; label: string; icon: string; end?: boolean; sub?: boolean }

const NAV: NavItem[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/episodes', label: 'Episodes', icon: 'play_circle' },
  { to: '/weekly', label: 'Weekly Summary', icon: 'bar_chart', end: true },
  { to: '/weekly/archive', label: 'Past Editions', icon: 'history', sub: true },
  { to: '/discover', label: 'Discover', icon: 'explore' },
]

/** The static sidebar — desktop/tablet only; below `md` the drawer takes over. */
export function Sidebar() {
  return (
    <nav className="fixed left-0 top-0 z-50 hidden h-screen w-64 flex-col border-r border-outline-variant bg-surface px-3 py-5 md:flex">
      <SidebarContent />
    </nav>
  )
}

/** The same nav as a left drawer for small viewports. Stays mounted (CSS handles
 *  enter/exit + visibility) so a fast open→close retargets mid-animation. */
export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)

  // While open: focus moves into the drawer (Esc backs out, focus returns to
  // the ☰ trigger) and the page behind doesn't scroll.
  useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    panelRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      restoreRef.current?.focus?.()
    }
  }, [open, onClose])

  return (
    <div id="mobile-nav" data-open={open} className="drawer fixed inset-0 z-[60] md:hidden" aria-hidden={!open}>
      {/* Scrim — click closes */}
      <button
        aria-hidden
        tabIndex={-1}
        onClick={onClose}
        className="drawer-scrim absolute inset-0 cursor-default bg-inverse-surface/40"
      />
      <nav
        ref={panelRef}
        tabIndex={-1}
        aria-label="Navigation"
        className="drawer-panel absolute left-0 top-0 flex h-full w-64 flex-col border-r border-outline-variant bg-surface px-3 py-5 shadow-card-hover focus:outline-none"
      >
        <SidebarContent onNavigate={onClose} onClose={onClose} />
      </nav>
    </div>
  )
}

function SidebarContent({ onNavigate, onClose }: { onNavigate?: () => void; onClose?: () => void }) {
  return (
    <>
      <div className="mb-7 flex items-center justify-between">
        {/* Brand — links to Home */}
        <Link
          to="/"
          aria-label="Munshot — go to Home"
          onClick={onNavigate}
          className="press flex items-center gap-2.5 rounded-lg px-2 py-1 hover:opacity-90"
        >
          <span
            className="grid h-9 w-9 shrink-0 place-items-center overflow-hidden rounded-[10px] shadow-sm"
            style={{ background: 'linear-gradient(150deg, #2a2e38 0%, #0c0e13 100%)' }}
          >
            <img src="/munshot-logo.png" alt="Munshot" className="h-7 w-7 object-contain" />
          </span>
          <span className="text-[19px] font-bold tracking-tight text-on-surface">Munshot</span>
        </Link>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close navigation"
            className="press grid h-9 w-9 place-items-center rounded-lg text-secondary hover:bg-surface-container-low hover:text-on-surface"
          >
            <Icon name="close" size={20} />
          </button>
        )}
      </div>

      {/* Primary nav */}
      <ul className="flex flex-col gap-1">
        {NAV.map((item) => (
          <li key={item.to} className={item.sub ? 'ml-4 border-l border-outline-variant pl-1.5' : ''}>
            <NavLink to={item.to} end={item.end} onClick={onNavigate} className={navClass}>
              {({ isActive }) => (
                <>
                  <Icon name={item.icon} size={item.sub ? 18 : 20} fill={isActive} />
                  <span className={item.sub ? 'text-[13px]' : 'text-[14px]'}>{item.label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
        {/* Weekly-brief subscription — small bell that opens a popup */}
        <li className="mt-0.5">
          <WeeklySubscribe />
        </li>
      </ul>

      {/* Who this space belongs to — pinned to the bottom */}
      <IdentityBadge />
    </>
  )
}

/** Shows whose space this is: the Munshot account the host signed in (data
 *  synced per user); a "Signing you in…" state while embedded and the host
 *  handshake is still resolving; the shared space when genuinely anonymous
 *  (standalone); or a quiet skeleton for the first moment identity resolves. */
function IdentityBadge() {
  const { identity } = useAppData()

  if (identity === undefined) {
    return (
      <div className="mt-auto flex items-center gap-3 rounded-xl border border-outline-variant/60 px-3 py-2.5" aria-hidden>
        <span className="h-8 w-8 shrink-0 rounded-full bg-surface-container-low motion-safe:animate-pulse" />
        <span className="flex min-w-0 flex-col gap-1.5">
          <span className="h-2.5 w-24 rounded-full bg-surface-container-low motion-safe:animate-pulse" />
          <span className="h-2 w-16 rounded-full bg-surface-container-low motion-safe:animate-pulse" />
        </span>
      </div>
    )
  }

  if (!identity) {
    // Inside the Munshot host the user is, by definition, signed in (they can't
    // reach the dashboard otherwise) — so an unresolved identity here means the
    // host handshake just hasn't delivered the session yet. Show a calm
    // "Signing you in…" state, never a false "Not signed in"; it flips to the
    // account card the moment context.session arrives. "Not signed in / shared
    // space" is reserved for genuine standalone use (opened outside the host).
    if (isEmbedded()) {
      return (
        <div
          className="mt-auto flex items-center gap-3 rounded-xl border border-outline-variant/60 px-3 py-2.5"
          title="Connecting to your Munshot account…"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-container-low text-primary">
            <Icon name="progress_activity" size={18} className="motion-safe:animate-spin" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-on-surface">Signing you in…</p>
            <p className="truncate text-[11.5px] text-secondary">Connecting to Munshot</p>
          </div>
        </div>
      )
    }
    return (
      <div
        className="mt-auto flex items-center gap-3 rounded-xl border border-outline-variant/60 px-3 py-2.5"
        title="No Munshot sign-in detected — podcasts you track here are stored in the shared space"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-surface-container-low text-secondary">
          <Icon name="person" size={18} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold text-on-surface">Not signed in</p>
          <p className="truncate text-[11.5px] text-secondary">Browsing the shared space</p>
        </div>
      </div>
    )
  }

  const display = identity.name || identity.email || identity.userId
  const detail = identity.email && identity.email !== display ? identity.email : 'Personal space · synced'
  return (
    <div
      className="mt-auto flex items-center gap-3 rounded-xl border border-outline-variant/60 bg-surface-container-low/40 px-3 py-2.5"
      title={`Signed in via Munshot — your tracked shows and history are saved to this account (${identity.userId})`}
    >
      <span className="relative shrink-0">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-primary-fixed/70 text-[12px] font-bold text-primary">
          {initials(identity)}
        </span>
        {/* Connected-to-host dot */}
        <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-emerald-500 ring-2 ring-surface" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-on-surface">{display}</p>
        <p className="truncate text-[11.5px] text-secondary">{detail}</p>
      </div>
    </div>
  )
}

function initials(identity: Identity): string {
  const source = identity.name || identity.email || identity.userId
  const words = source.replace(/@.*$/, '').split(/[\s._-]+/).filter(Boolean)
  const chars = words.length >= 2 ? words[0][0] + words[1][0] : source.slice(0, 2)
  return chars.toUpperCase()
}

function navClass({ isActive }: { isActive: boolean }): string {
  return [
    'press-soft flex items-center gap-3 rounded-lg px-3 py-2.5',
    isActive
      ? 'bg-primary-fixed/60 font-semibold text-primary'
      : 'font-medium text-secondary hover:bg-surface-container-low hover:text-on-surface',
  ].join(' ')
}
