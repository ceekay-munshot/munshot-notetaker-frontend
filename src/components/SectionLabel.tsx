import type { ReactNode } from 'react'

/** Small uppercase eyebrow used to title sections, per the design system. */
export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={`text-label-caps uppercase tracking-widest text-on-surface-variant ${className}`}>{children}</h3>
  )
}
