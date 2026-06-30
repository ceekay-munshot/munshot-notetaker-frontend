import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Icon } from './Icon'

type EmailState = 'idle' | 'sending' | 'sent' | 'error'

/** Extra-recipient management for the email item (besides the user themselves). */
interface Recipients {
  /** The signed-in user's address — always included, shown as a fixed chip. */
  self: string
  /** Saved extra addresses the edition also goes to. */
  others: string[]
  /** Persist a new address. Returns ok + a message to surface on failure. */
  onAdd: (email: string) => { ok: boolean; message?: string }
  /** Forget an address. */
  onRemove: (email: string) => void
}

// The Download control: a primary button that drops down two formats — the
// institution-grade PDF (full design) and the editable Word .doc. Shared by the
// Weekly and Episode pages. When `onEmail` is provided, a third item delivers the
// same document by email and owns its own send lifecycle: clicking it keeps the
// menu open, swaps to a spinner while sending, then settles into a green "Email
// sent" (which breathes, then auto-closes) or a red, retryable error — so the
// outcome is always visible right where the user clicked. When `recipients` is
// also provided, the item expands to manage who the edition is sent to.
export function DownloadMenu({
  onPdf,
  onWord,
  onEmail,
  emailSubtitle,
  recipients,
  disabled,
}: {
  onPdf: () => void
  onWord: () => void
  /** Resolves to the send result; rejection is treated as a failure. */
  onEmail?: () => Promise<{ ok: boolean; message?: string }>
  /** Caption under the email item when there's no recipient management. */
  emailSubtitle?: string
  /** Enables the "also send to…" editor under the email item. */
  recipients?: Recipients
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState<EmailState>('idle')
  const [emailMsg, setEmailMsg] = useState('')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [addErr, setAddErr] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close on outside-click / Escape — but never mid-send, so the status stays on
  // screen until it resolves.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (email === 'sending') return
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && email !== 'sending') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, email])

  // A closed menu always reopens to a clean slate.
  useEffect(() => {
    if (!open) {
      setEmail('idle')
      setEditing(false)
      setDraft('')
      setAddErr(null)
    }
  }, [open])

  // Focus the input the moment the recipients editor opens.
  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  // Let the green "sent" state breathe before the menu dismisses itself.
  useEffect(() => {
    if (email !== 'sent') return
    const t = setTimeout(() => setOpen(false), 1900)
    return () => clearTimeout(t)
  }, [email])

  const pick = (fn: () => void) => {
    setOpen(false)
    fn()
  }

  const runEmail = async () => {
    if (!onEmail || email === 'sending' || email === 'sent') return
    setEditing(false) // collapse the editor so the status reads cleanly
    setEmail('sending')
    try {
      const res = await onEmail()
      setEmailMsg(res.message || '')
      setEmail(res.ok ? 'sent' : 'error')
      if (!res.ok && !res.message) setEmailMsg("Couldn't send — try again")
    } catch {
      setEmailMsg("Couldn't send — check your connection")
      setEmail('error')
    }
  }

  const others = recipients?.others ?? []
  const addRecipient = (e: FormEvent) => {
    e.preventDefault()
    if (!recipients) return
    const res = recipients.onAdd(draft)
    if (res.ok) {
      setDraft('')
      setAddErr(null)
      inputRef.current?.focus()
    } else {
      setAddErr(res.message || 'Enter a valid email address.')
    }
  }

  // Idle subtitle: the address when it's just the user, else a recipient tally.
  const idleSub = recipients
    ? others.length
      ? `To you + ${others.length} other${others.length > 1 ? 's' : ''}`
      : `To ${recipients.self}`
    : (emailSubtitle ?? 'Designed HTML to your inbox')
  const sentSub = emailMsg || (recipients ? 'Sent' : 'Sent to your inbox')

  const v = {
    idle: { icon: 'mail', fill: false, title: 'Email this edition', sub: idleSub, tone: 'idle' as const },
    sending: { icon: 'progress_activity', fill: false, title: 'Sending…', sub: 'Delivering this edition', tone: 'idle' as const },
    sent: { icon: 'mark_email_read', fill: true, title: 'Email sent', sub: sentSub, tone: 'success' as const },
    error: { icon: 'error', fill: true, title: "Couldn't send", sub: emailMsg || 'Tap to try again', tone: 'error' as const },
  }[email]
  const toneText = v.tone === 'success' ? 'text-on-success-container' : v.tone === 'error' ? 'text-on-error-container' : ''

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Download this summary"
        className="press inline-flex items-center gap-2 rounded-lg bg-primary px-md py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon name="download" size={18} /> Download <Icon name={open ? 'expand_less' : 'expand_more'} size={18} />
      </button>

      {open && (
        <div
          role="menu"
          className="pop absolute right-0 z-50 mt-1.5 w-64 origin-top-right overflow-hidden rounded-xl border border-outline-variant bg-surface-container-lowest p-1.5 shadow-card-hover"
        >
          <MenuItem icon="picture_as_pdf" title="PDF" subtitle="Full design · downloads a .pdf" onClick={() => pick(onPdf)} />
          <MenuItem icon="description" title="Word (.doc)" subtitle="Editable document" onClick={() => pick(onWord)} />
          {onEmail && (
            <button
              role="menuitem"
              onClick={runEmail}
              disabled={email === 'sending' || email === 'sent'}
              className={`press-soft flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left disabled:cursor-default ${
                v.tone === 'success' ? 'bg-success-container' : v.tone === 'error' ? 'bg-error-container' : 'hover:bg-surface-container-low'
              }`}
            >
              {/* Re-keyed per state so the new glyph pops in (node-pop); the spinner also rotates. */}
              <span key={email} className="node-pop grid h-5 w-5 shrink-0 place-items-center">
                <Icon name={v.icon} size={20} fill={v.fill} className={`${toneText || 'text-primary'} ${email === 'sending' ? 'animate-spin' : ''}`} />
              </span>
              <span className="min-w-0" aria-live="polite">
                <span className={`block text-[14px] font-semibold ${toneText || 'text-on-surface'}`}>{v.title}</span>
                <span className={`block truncate text-[11.5px] ${v.tone === 'idle' ? 'text-secondary' : toneText}`}>{v.sub}</span>
              </span>
            </button>
          )}

          {/* Recipient management — toggle row + collapsible editor. Hidden during the
              send lifecycle so the status reads cleanly. */}
          {onEmail && recipients && email === 'idle' && (
            <>
              <button
                onClick={() => setEditing((s) => !s)}
                aria-expanded={editing}
                className="press-soft mt-0.5 flex w-full items-center gap-3 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-container-low"
              >
                <Icon name="group_add" size={18} className="shrink-0 text-secondary" />
                <span className="flex-1 truncate text-[12.5px] font-medium text-secondary">{others.length ? `Recipients · ${others.length + 1}` : 'Add recipients'}</span>
                <Icon name={editing ? 'expand_less' : 'expand_more'} size={16} className="shrink-0 text-secondary" />
              </button>

              {editing && (
                <div className="recip-editor mt-1 rounded-lg bg-surface-container-low p-2">
                  <ul className="mb-1.5 space-y-1">
                    <RecipientRow address={recipients.self} you />
                    {others.map((addr) => (
                      <RecipientRow key={addr} address={addr} onRemove={() => recipients.onRemove(addr)} />
                    ))}
                  </ul>
                  {/* noValidate: our own validation drives a consistent inline error
                      for every case (format, duplicate, cap) — no native browser bubble. */}
                  <form onSubmit={addRecipient} noValidate className="flex items-center gap-1.5">
                    <input
                      ref={inputRef}
                      type="email"
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value)
                        if (addErr) setAddErr(null)
                      }}
                      placeholder="name@company.com"
                      aria-label="Add a recipient email"
                      className="min-w-0 flex-1 rounded-md border border-outline-variant bg-surface px-2 py-1.5 text-[12.5px] outline-none focus:border-primary"
                    />
                    <button
                      type="submit"
                      disabled={!draft.trim()}
                      className="press shrink-0 rounded-md bg-primary px-2.5 py-1.5 text-[12.5px] font-semibold text-on-primary hover:bg-primary-container disabled:opacity-40"
                    >
                      Add
                    </button>
                  </form>
                  {addErr && (
                    <p className="mt-1.5 flex items-start gap-1 text-[11.5px] text-error" role="alert">
                      <Icon name="error" size={13} className="mt-px shrink-0" />
                      <span>{addErr}</span>
                    </p>
                  )}
                  <p className="mt-2 flex items-start gap-1.5 border-t border-outline-variant pt-2 text-[11px] leading-snug text-secondary">
                    <Icon name="event_repeat" size={13} className="mt-px shrink-0 text-primary" />
                    <span>Saved recipients also get the automated weekly brief every Monday.</span>
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** One recipient row in the editor: the address, plus a remove button unless it's
 *  the user themselves (`you`). */
function RecipientRow({ address, you, onRemove }: { address: string; you?: boolean; onRemove?: () => void }) {
  return (
    <li className="flex items-center gap-2 rounded-md bg-surface px-2 py-1.5">
      <Icon name={you ? 'person' : 'mail'} size={14} className="shrink-0 text-secondary" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-on-surface">{address}</span>
      {you ? (
        <span className="shrink-0 rounded bg-surface-container px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-secondary">You</span>
      ) : (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${address}`}
          className="press grid h-5 w-5 shrink-0 place-items-center rounded text-secondary hover:bg-error-container hover:text-on-error-container"
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </li>
  )
}

function MenuItem({
  icon,
  title,
  subtitle,
  onClick,
}: {
  icon: string
  title: string
  subtitle: string
  onClick: () => void
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className="press-soft flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-surface-container-low"
    >
      <Icon name={icon} size={20} className="shrink-0 text-primary" />
      <span className="min-w-0">
        <span className="block text-[14px] font-semibold text-on-surface">{title}</span>
        <span className="block truncate text-[11.5px] text-secondary">{subtitle}</span>
      </span>
    </button>
  )
}
