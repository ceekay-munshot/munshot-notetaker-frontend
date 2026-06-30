import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Icon } from './Icon'
import type { WeeklyEditionMeta } from '../lib/weeklyEditions'

// The header control on the Weekly page: shows the current edition's date range and
// drops down a list of every weekly edition (plus an "All time" roll-up and a link
// to the full archive). Selecting one re-points the reader via ?week=.

export function EditionSwitcher({
  editions,
  currentKey,
  onSelect,
  archiveTo = '/weekly/archive',
}: {
  editions: WeeklyEditionMeta[]
  currentKey: string // a weekKey, or 'all'
  onSelect: (key: string) => void
  archiveTo?: string
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const currentLabel = currentKey === 'all' ? 'All time' : editions.find((e) => e.weekKey === currentKey)?.rangeLabel ?? 'This week'

  function pick(key: string) {
    setOpen(false)
    onSelect(key)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="press inline-flex items-center gap-2 rounded-lg border border-outline-variant bg-surface px-3 py-2 text-metadata font-semibold text-on-surface hover:bg-surface-container-low"
        title="Switch weekly edition"
      >
        <Icon name="calendar_month" size={16} className="text-primary" />
        {currentLabel}
        <Icon name={open ? 'expand_less' : 'expand_more'} size={18} className="text-secondary" />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute right-0 z-50 mt-1.5 max-h-[60vh] w-72 overflow-auto rounded-xl border border-outline-variant bg-surface-container-lowest p-1.5 shadow-card-hover"
        >
          <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-secondary">Editions</p>
          {editions.map((e) => (
            <EditionRow
              key={e.weekKey}
              label={e.rangeLabel}
              meta={`${e.episodeCount} ep${e.episodeCount === 1 ? '' : 's'}${e.ideaCount ? ` · ${e.ideaCount} idea${e.ideaCount === 1 ? '' : 's'}` : ''}`}
              active={e.weekKey === currentKey}
              onClick={() => pick(e.weekKey)}
            />
          ))}
          <EditionRow label="All time" meta="every analysed episode" active={currentKey === 'all'} onClick={() => pick('all')} />
          <div className="my-1 border-t border-outline-variant" />
          <Link
            to={archiveTo}
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-metadata font-semibold text-primary hover:bg-primary-fixed/40"
          >
            <Icon name="history" size={16} /> View all editions
          </Link>
        </div>
      )}
    </div>
  )
}

function EditionRow({ label, meta, active, onClick }: { label: string; meta: string; active: boolean; onClick: () => void }) {
  return (
    <button
      role="option"
      aria-selected={active}
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left ${
        active ? 'bg-primary-fixed/50 text-primary' : 'text-on-surface hover:bg-surface-container-low'
      }`}
    >
      <span className="min-w-0">
        <span className="block truncate text-[14px] font-semibold">{label}</span>
        <span className="block truncate text-[11.5px] text-secondary">{meta}</span>
      </span>
      {active && <Icon name="check" size={16} className="shrink-0 text-primary" />}
    </button>
  )
}
