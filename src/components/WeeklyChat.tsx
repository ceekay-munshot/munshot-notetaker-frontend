import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { ApiError, chatWeekly, type WeeklyMeetingRef } from '../lib/api'
import { Icon } from './Icon'
import { RichText } from './RichText'

// ── Weekly chat — free-form Q&A over the week's meetings ─────────────────────────
// A slide-over panel that queries POST /api/weekly/chat. The Worker loads the
// week's cached meeting summaries (+ the saved master summary) server-side and
// answers with OpenAI, so the browser only ever sends the running conversation.
// The thread is per-visit (not persisted) — a fresh chat each time it opens.

type ChatMsg = { role: 'user' | 'assistant'; content: string }

const SUGGESTIONS = [
  'Recap the whole week',
  'What decisions were made?',
  'List every action item and who owns it',
  'What is still unresolved or blocked?',
]

export function WeeklyChat({
  week,
  meetings,
  rangeLabel,
  onClose,
}: {
  week: string
  meetings: WeeklyMeetingRef[]
  rangeLabel?: string
  onClose: () => void
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Close on Escape; keep the newest message in view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, busy])

  async function send(text: string) {
    const q = text.trim()
    if (!q || busy) return
    const next: ChatMsg[] = [...messages, { role: 'user', content: q }]
    setMessages(next)
    setInput('')
    setError(null)
    setBusy(true)
    if (inputRef.current) inputRef.current.style.height = 'auto'
    try {
      const reply = await chatWeekly(week, meetings, next)
      setMessages((m) => [...m, { role: 'assistant', content: reply.trim() || '(No answer.)' }])
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 503
          ? 'The assistant isn’t configured yet — set the OPENAI_API_KEY secret on the Worker.'
          : err instanceof ApiError && err.status === 404
            ? 'No summarised meetings for this week yet — analyse some meetings first.'
            : (err as Error)?.message || 'The assistant could not answer just now. Please try again.',
      )
    } finally {
      setBusy(false)
      inputRef.current?.focus()
    }
  }

  function onInput(e: ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Chat with this week">
      {/* Backdrop */}
      <button aria-label="Close chat" onClick={onClose} className="fade-in absolute inset-0 bg-black/30 backdrop-blur-[1px]" />

      {/* Panel */}
      <div className="slide-over relative flex h-full w-full max-w-md flex-col border-l border-outline-variant bg-surface shadow-2xl">
        {/* Header */}
        <div className="flex items-center gap-2.5 border-b border-outline-variant px-md py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg chip-signal">
            <Icon name="forum" size={18} className="text-primary" fill />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold text-on-surface">Ask about this week</h2>
            <p className="truncate text-metadata text-secondary">
              {rangeLabel ? `${rangeLabel} · ` : ''}Answers come only from the meetings.
            </p>
          </div>
          {messages.length > 0 && (
            <button
              onClick={() => {
                setMessages([])
                setError(null)
              }}
              className="press inline-flex items-center gap-1.5 rounded-lg border border-outline-variant bg-surface px-2.5 py-1.5 text-metadata font-semibold text-on-surface hover:bg-surface-container-low"
            >
              <Icon name="restart_alt" size={16} /> <span className="hidden sm:inline">New</span>
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            className="press grid h-8 w-8 shrink-0 place-items-center rounded-lg text-secondary hover:bg-surface-container-low hover:text-on-surface"
          >
            <Icon name="close" size={20} />
          </button>
        </div>

        {/* Messages */}
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-md py-md">
          {messages.length === 0 && !busy && !error ? (
            <div className="grid h-full place-items-center">
              <div className="max-w-sm text-center">
                <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full chip-signal">
                  <Icon name="auto_awesome" size={24} className="text-primary" fill />
                </span>
                <h3 className="text-[16px] font-semibold text-on-surface">Query your weekly summary</h3>
                <p className="mt-1 text-body-md text-secondary">
                  Decisions, action items, blockers, who did what — I’ll answer across every meeting this week.
                </p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => void send(s)}
                      className="press rounded-full border border-outline-variant bg-surface px-3 py-1.5 text-[13px] font-medium text-on-surface hover:border-primary hover:text-primary"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            messages.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-[14px] leading-relaxed text-on-primary">
                    {m.content}
                  </div>
                </div>
              ) : (
                <div key={i} className="flex gap-2.5">
                  <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full chip-signal">
                    <Icon name="auto_awesome" size={16} className="text-primary" fill />
                  </span>
                  <div className="min-w-0 max-w-[85%] rounded-2xl rounded-tl-md border border-outline-variant bg-surface-container-lowest px-3.5 py-2.5">
                    <ChatAnswer text={m.content} />
                  </div>
                </div>
              ),
            )
          )}

          {busy && (
            <div className="flex gap-2.5">
              <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full chip-signal">
                <Icon name="auto_awesome" size={16} className="text-primary" fill />
              </span>
              <div className="flex items-center gap-1 rounded-2xl rounded-tl-md border border-outline-variant bg-surface-container-lowest px-4 py-3.5">
                <span className="h-1.5 w-1.5 rounded-full bg-secondary motion-safe:animate-bounce [animation-delay:-0.2s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-secondary motion-safe:animate-bounce [animation-delay:-0.1s]" />
                <span className="h-1.5 w-1.5 rounded-full bg-secondary motion-safe:animate-bounce" />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-error/30 bg-error-container/40 px-3 py-2.5 text-[13px] text-error">
              <Icon name="error" size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-outline-variant p-3">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void send(input)
            }}
            className="flex items-end gap-2"
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={onInput}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send(input)
                }
              }}
              rows={1}
              placeholder="Ask about this week…"
              className="max-h-40 flex-1 resize-none rounded-xl border border-outline-variant bg-surface-container-low px-3.5 py-2.5 text-[14px] leading-relaxed outline-none focus:border-primary focus:bg-surface"
            />
            <button
              type="submit"
              disabled={!input.trim() || busy}
              aria-label="Send"
              className="press grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary text-on-primary transition-opacity hover:bg-primary-container disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name={busy ? 'progress_activity' : 'send'} size={20} className={busy ? 'motion-safe:animate-spin' : ''} />
            </button>
          </form>
          <p className="mt-1.5 px-1 text-[11px] text-secondary">Enter to send · Shift + Enter for a new line</p>
        </div>
      </div>
    </div>
  )
}

// Renders a chat answer with the same light markdown the summaries use (bold
// **headers**, "- " bullets, paragraphs) at a compact, uniform chat size.
function ChatAnswer({ text }: { text: string }) {
  const isBullet = (l: string) => /^([-*•]|\d+[.)])\s+/.test(l)
  const stripBullet = (l: string) => l.replace(/^([-*•]|\d+[.)])\s+/, '')
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
  if (!blocks.length) return <p className="text-[14px] leading-relaxed text-on-surface">{text}</p>
  return (
    <div className="space-y-2.5 text-[14px] leading-relaxed text-on-surface">
      {blocks.map((block, i) => {
        const lines = block
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
        const headMatch = lines[0] ? /^\*\*(.+?)\*\*$/.exec(lines[0]) : null
        const header = headMatch ? headMatch[1] : null
        const rest = header ? lines.slice(1) : lines
        const bullets = rest.filter(isBullet).map(stripBullet)
        const paras = rest.filter((l) => !isBullet(l))
        return (
          <div key={i}>
            {header && <p className="mb-1 font-semibold text-on-surface">{header}</p>}
            {paras.map((p, j) => (
              <p key={`p${j}`} className={j ? 'mt-1.5' : ''}>
                <RichText text={p} terms={[]} />
              </p>
            ))}
            {bullets.length > 0 && (
              <ul className="mt-1 space-y-1">
                {bullets.map((b, j) => (
                  <li key={`b${j}`} className="flex gap-2">
                    <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-primary" />
                    <span>
                      <RichText text={b} terms={[]} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}
