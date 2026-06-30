import type { Takeaway } from '../lib/types'

// "Intelligence module" — the 4px blue accent-bar list item from the design
// system. Used on Home, the episode page, and the weekly summary.
export function TakeawayList({ items, numbered = false }: { items: Takeaway[]; numbered?: boolean }) {
  return (
    <ul className="space-y-sm">
      {items.map((t, i) => (
        <li
          key={i}
          className="intel-bar rounded-r-lg bg-surface-container-low py-2.5 pr-md transition-transform hover:translate-x-0.5"
        >
          <p className="mb-0.5 text-metadata font-bold text-on-surface">
            {numbered && <span className="text-primary">{i + 1}. </span>}
            {t.title}
          </p>
          <p className="text-[14px] leading-snug text-on-surface-variant">{t.detail}</p>
        </li>
      ))}
    </ul>
  )
}
