import { useState } from 'react'
import * as api from '../lib/api'
import { useAppData } from '../store/AppData'
import { useAuth } from '../store/Auth'
import { Icon } from './Icon'

// ─────────────────────────────────────────────────────────────────────────────
// Says out loud why the dashboard is empty.
//
// Meeting visibility is decided by EXACT equality between the session's email
// and an owner_email row (see the Worker's handleTranscripts) — nothing is
// scoped by organisation id. So a user who was genuinely in a meeting can still
// see nothing, for one of two reasons that used to look identical on screen:
//
//   1. the host JWT never became a Worker session cookie, so every /api/* call
//      401s (the UI is signed in; the API is not), or
//   2. the session is real, but this exact address is not an owner of any
//      meeting — typically because the calendar invite used a different address
//      (work vs personal, or a Gmail dot/+tag variant, which are distinct
//      strings to the visibility check).
//
// Both used to render as a silent "No meetings yet". This banner names the
// address the session is actually keyed on, which is the one fact needed to
// tell those apart, and can ask the Worker for the rest on demand.
// ─────────────────────────────────────────────────────────────────────────────

export function SessionNotice() {
  const { state, retryHostSession } = useAuth()
  const { loading, loadError, episodes } = useAppData()
  const [details, setDetails] = useState<api.Whoami | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  if (state.status !== 'authed' || loading) return null

  const broken = !!state.hostSessionError || loadError === 'not_authed'
  const failed = !broken && !!loadError
  const empty = !broken && !failed && episodes.length === 0 && !state.isAdmin
  if (!broken && !failed && !empty) return null

  const check = async () => {
    setChecking(true)
    setCheckError(null)
    try {
      setDetails(await api.whoami())
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : 'Diagnostics unavailable.')
    } finally {
      setChecking(false)
    }
  }

  const tone = broken
    ? 'border-error/40 bg-error/5'
    : failed
      ? 'border-outline-variant bg-surface-container-lowest'
      : 'border-outline-variant bg-surface-container-lowest'

  return (
    <div className={`mb-gutter rounded-2xl border p-md ${tone}`}>
      <div className="flex items-start gap-3">
        <Icon
          name={broken ? 'error' : 'info'}
          size={20}
          className={broken ? 'mt-0.5 shrink-0 text-error' : 'mt-0.5 shrink-0 text-outline'}
        />
        <div className="min-w-0 flex-1">
          <p className="text-body-md font-medium text-on-surface">
            {broken
              ? 'Your Munshot session didn’t reach this dashboard'
              : failed
                ? 'Couldn’t load your meetings'
                : 'No meetings are shared with this address yet'}
          </p>

          <p className="mt-1 text-metadata text-secondary">
            {broken ? (
              <>
                You’re shown as signed in, but the dashboard couldn’t establish its own session, so every data
                request is being rejected. {state.hostSessionError ?? 'The session cookie is missing or expired.'}
              </>
            ) : failed ? (
              loadError
            ) : (
              <>
                Meetings appear here only when <Address value={state.email} /> is the exact address recorded as an
                owner — usually the address on the calendar invite. A different address on the invite (work vs
                personal, or a Gmail dot/+tag variant) counts as a different person here, even for the same meeting.
              </>
            )}
          </p>

          <p className="mt-2 text-metadata text-outline">
            Signed in as <Address value={state.email} />
            {state.orgId ? <> · organisation {state.orgId}</> : null}
            {state.hostManaged ? ' · session provided by the Munshot host' : null}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-3">
            {broken && (
              <button
                type="button"
                onClick={retryHostSession}
                className="rounded-full bg-primary px-4 py-1.5 text-metadata font-semibold text-on-primary hover:opacity-90"
              >
                Retry sign-in
              </button>
            )}
            <button
              type="button"
              onClick={check}
              disabled={checking}
              className="rounded-full border border-outline-variant px-4 py-1.5 text-metadata font-semibold text-on-surface hover:bg-surface-container disabled:opacity-60"
            >
              {checking ? 'Checking…' : 'Why am I seeing this?'}
            </button>
          </div>

          {checkError && <p className="mt-2 text-metadata text-error">{checkError}</p>}
          {details && <Diagnostics details={details} />}
        </div>
      </div>
    </div>
  )
}

/** Renders an address so trailing spaces / case / dots are actually visible —
 *  the differences that decide visibility are exactly the ones normal rendering
 *  hides. */
function Address({ value }: { value: string }) {
  return <code className="rounded bg-surface-container px-1 py-0.5 text-on-surface">{value || '(none)'}</code>
}

function Diagnostics({ details }: { details: api.Whoami }) {
  const { meetings } = details
  const count = (n: number | null) => (n === null ? 'unavailable' : String(n))
  return (
    <div className="mt-3 rounded-xl border border-outline-variant bg-surface-container-lowest p-3">
      <p className="text-metadata text-on-surface">{details.verdict}</p>
      <ul className="mt-2 space-y-0.5 text-metadata text-secondary">
        <li>
          Session address: <Address value={details.email} />
        </li>
        <li>Organisation id: {details.orgId ?? 'none on this session'} (not used for visibility)</li>
        <li>Meetings owned via meeting_owners: {count(meetings.viaMeetingOwners)}</li>
        <li>Meetings owned via legacy owner_email: {count(meetings.viaLegacyOwnerEmail)}</li>
        <li>Meetings visible to you: {count(meetings.visible)}</li>
      </ul>
      {details.similarOwners.length > 0 && (
        <p className="mt-2 text-metadata text-secondary">
          Similar addresses that <em>do</em> own meetings: {details.similarOwners.join(', ')}. If one of those is
          also you, ask an admin to add this address to those meetings — or sign in with that address instead.
        </p>
      )}
    </div>
  )
}
