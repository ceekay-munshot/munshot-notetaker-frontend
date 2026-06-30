import type { ProcessingStatus } from '../lib/types'
import { statusMeta } from '../lib/format'
import { Icon } from './Icon'

interface StatusBadgeProps {
  status: ProcessingStatus
  /** Compact hides the label on very tight rows. */
  compact?: boolean
}

export function StatusBadge({ status, compact = false }: StatusBadgeProps) {
  const meta = statusMeta(status)
  const animating = status === 'transcribing' || status === 'summarizing' || status === 'fetching'
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-label-caps uppercase ${meta.tone}`}
    >
      {meta.pulse ? (
        <span className={`h-1.5 w-1.5 rounded-full ${meta.dot ?? 'bg-primary'}`} />
      ) : (
        <Icon name={meta.icon} size={13} className={animating ? 'motion-safe:animate-spin' : ''} />
      )}
      {!compact && <span>{meta.label}</span>}
    </span>
  )
}
