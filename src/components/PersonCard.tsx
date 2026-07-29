import { Icon } from './Icon'
import type { PersonRollup, TodoItem } from '../lib/api'

// Shared card for a per-person status rollup: overall context plus
// Accomplished / To do columns. Used by the Weekly per-person view and the
// admin people tracker. When the rollup carries structured `items` (the
// reconcile engine's output), the To-do column shows priority + due-date /
// overdue badges instead of plain text; a record without `items` yet (not
// upgraded, or legacy) falls back to the original plain string lists.

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const chars = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)
  return chars.toUpperCase()
}

const PRIORITY_DOT: Record<TodoItem['priority'], string> = {
  high: 'bg-error',
  medium: 'bg-primary',
  low: 'bg-outline',
}

export function PersonCard({ person }: { person: PersonRollup }) {
  const openItems = person.items?.filter((it) => it.status === 'open')
  const doneItems = person.items?.filter((it) => it.status === 'done')

  return (
    <article className="flex flex-col rounded-2xl border border-outline-variant bg-surface-container-lowest p-md shadow-card">
      <header className="mb-3 flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-fixed/70 text-[13px] font-bold text-primary">
          {initials(person.name)}
        </span>
        <h3 className="text-[17px] font-semibold text-on-surface">{person.name}</h3>
      </header>

      {person.overall && (
        <p className="mb-3 text-body-md leading-relaxed text-on-surface-variant">{person.overall}</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {doneItems ? (
          <PersonCardItemColumn
            icon="check_circle"
            iconClass="text-success"
            title="Accomplished"
            items={doneItems}
            empty="Nothing logged yet."
          />
        ) : (
          <PersonCardColumn
            icon="check_circle"
            iconClass="text-success"
            title="Accomplished"
            items={person.accomplished}
            empty="Nothing logged yet."
            marker="bg-success"
          />
        )}
        {openItems ? (
          <PersonCardItemColumn icon="radio_button_unchecked" iconClass="text-primary" title="To do" items={openItems} empty="No open tasks." />
        ) : (
          <PersonCardColumn
            icon="radio_button_unchecked"
            iconClass="text-primary"
            title="To do"
            items={person.todo}
            empty="No open tasks."
            marker="bg-primary"
          />
        )}
      </div>
    </article>
  )
}

function PersonCardColumn({
  icon,
  iconClass,
  title,
  items,
  empty,
  marker,
}: {
  icon: string
  iconClass: string
  title: string
  items: string[]
  empty: string
  marker: string
}) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-low p-3">
      <p className="mb-2 flex items-center gap-1.5 text-label-caps uppercase tracking-wide text-on-surface-variant">
        <Icon name={icon} size={15} className={iconClass} /> {title}
      </p>
      {items.length === 0 ? (
        <p className="text-[13px] text-outline">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it, i) => (
            <li key={i} className="flex gap-2 text-[13.5px] leading-snug text-on-surface-variant">
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${marker}`} />
              <span>{it}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PersonCardItemColumn({
  icon,
  iconClass,
  title,
  items,
  empty,
}: {
  icon: string
  iconClass: string
  title: string
  items: TodoItem[]
  empty: string
}) {
  return (
    <div className="rounded-xl border border-outline-variant bg-surface-container-low p-3">
      <p className="mb-2 flex items-center gap-1.5 text-label-caps uppercase tracking-wide text-on-surface-variant">
        <Icon name={icon} size={15} className={iconClass} /> {title}
      </p>
      {items.length === 0 ? (
        <p className="text-[13px] text-outline">{empty}</p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((it) => (
            <li key={it.id} className="flex gap-2 text-[13.5px] leading-snug text-on-surface-variant" title={it.evidence || undefined}>
              <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${PRIORITY_DOT[it.priority]}`} />
              <span className="flex-1">
                {it.text}
                {it.dueDate && (
                  <span className={`ml-1.5 whitespace-nowrap text-[11px] font-medium ${it.overdue ? 'text-error' : 'text-secondary'}`}>
                    {it.overdue ? `overdue · was due ${it.dueDate}` : `due ${it.dueDate}`}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
