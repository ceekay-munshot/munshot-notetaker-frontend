import { Icon } from './Icon'
import type { ToneView, ToneLabel } from '../lib/tone'
import type { ToneAspect, ToneSentiment } from '../lib/types'

// Visual language for a tone read. Greens / reds match the inline sentiment
// palette exactly; "mixed" gets amber, "neutral" stays quiet.
const META: Record<ToneLabel, { label: string; icon: string; text: string }> = {
  positive: { label: 'Positive', icon: 'trending_up', text: 'text-[#15803d]' },
  cautious: { label: 'Cautious', icon: 'trending_down', text: 'text-[#b91c1c]' },
  mixed: { label: 'Mixed', icon: 'trending_flat', text: 'text-[#b45309]' },
  neutral: { label: 'Neutral', icon: 'remove', text: 'text-secondary' },
}

// Per-aspect chip styling — same palette, arrows read at a glance.
const ASPECT: Record<ToneSentiment, { arrow: string; chip: string }> = {
  positive: { arrow: '↑', chip: 'border-[#cdeeda] bg-[#ecfdf3] text-[#15803d]' },
  negative: { arrow: '↓', chip: 'border-[#f6d4d2] bg-[#fef2f2] text-[#b91c1c]' },
  neutral: { arrow: '→', chip: 'border-outline-variant bg-surface-container-high text-secondary' },
}

function tip(tone: ToneView): string {
  if (tone.rationale) return tone.rationale
  if (!tone.bar) return 'No clear tone signal in this analysis yet'
  return `Tone from this analysis — ${Math.round(tone.posRatio * 100)}% positive`
}

// The proportion bar: green share vs red share of the directional signal, so the
// balance behind the label is visible at a glance. Paint-only width (no reflow).
function Bar({ posRatio }: { posRatio: number }) {
  const pos = Math.round(posRatio * 100)
  return (
    <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-surface-container-high" aria-hidden>
      <span className="absolute inset-y-0 left-0 bg-[#16a34a]" style={{ width: `${pos}%` }} />
      <span className="absolute inset-y-0 right-0 bg-[#dc2626]" style={{ width: `${100 - pos}%` }} />
    </span>
  )
}

function AspectChip({ aspect }: { aspect: ToneAspect }) {
  const s = ASPECT[aspect.sentiment]
  return (
    <span
      title={aspect.note}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none ${s.chip}`}
    >
      <span className="truncate">{aspect.subject}</span>
      <span aria-hidden className="opacity-80">
        {s.arrow}
      </span>
    </span>
  )
}

function Read({ tone }: { tone: ToneView }) {
  const m = META[tone.label]
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`inline-flex items-center gap-1 font-semibold ${m.text}`}>
        <Icon name={m.icon} size={15} /> {m.label}
      </span>
      {tone.bar && <Bar posRatio={tone.posRatio} />}
    </span>
  )
}

// Tone meter. By default: a labelled read + proportion bar, inline (Home hero,
// Weekly header). With `detailed`: the same read plus the one-line rationale and a
// scannable row of per-subject aspect chips — for the Episode header, where there's
// room for the "about what".
export function ToneMeter({ tone, detailed = false, className = '' }: { tone: ToneView; detailed?: boolean; className?: string }) {
  if (!detailed) {
    return (
      <span className={`inline-flex items-center ${className}`} title={tip(tone)}>
        <Read tone={tone} />
      </span>
    )
  }
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div className="flex items-center gap-2 text-metadata" title={tip(tone)}>
        <Read tone={tone} />
      </div>
      {tone.rationale && <p className="max-w-2xl text-metadata leading-snug text-secondary">{tone.rationale}</p>}
      {tone.aspects && tone.aspects.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tone.aspects.map((a, i) => (
            <AspectChip key={`${a.subject}-${i}`} aspect={a} />
          ))}
        </div>
      )}
    </div>
  )
}

// Compact badge for dense rows — labelled read + bar, and nothing at all when there's
// no real signal (keeps the Episodes table calm).
export function ToneBadge({ tone, className = '' }: { tone: ToneView; className?: string }) {
  if (tone.label === 'neutral' && !tone.bar) return null
  return (
    <span className={`inline-flex items-center ${className}`} title={tip(tone)}>
      <Read tone={tone} />
    </span>
  )
}
