import { useState } from 'react'
import { useAuth } from '../store/Auth'
import { Icon } from '../components/Icon'
import { ApiError } from '../lib/api'

// The sign-in / register screen — the gate in front of the whole dashboard.
// Both flows run through the Worker's auth routes (Auth store); on success the
// session probe re-runs and the dashboard takes over.
export default function Login({ codeRequired }: { codeRequired: boolean }) {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isRegister = mode === 'register'

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (isRegister) await signUp(email.trim(), password, code.trim() || undefined)
      else await signIn(email.trim(), password)
      // On success the Auth gate swaps this screen for the dashboard.
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background px-4 py-12">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <img src="/munshot-logo.png" alt="Munshot" className="mb-4 h-10 w-auto" />
          <h1 className="text-display-lg text-on-background">Munshot Notetaker</h1>
          <p className="mt-1 text-body-md text-secondary">Your meeting intelligence layer.</p>
        </div>

        <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-lg shadow-card">
          <div className="mb-md flex rounded-lg bg-surface-container-low p-1">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m)
                  setError('')
                }}
                className={`flex-1 rounded-md px-3 py-2 text-metadata font-semibold transition-colors ${
                  mode === m ? 'bg-surface text-on-surface shadow-sm' : 'text-secondary hover:text-on-surface'
                }`}
              >
                {m === 'login' ? 'Sign in' : 'Create account'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="flex flex-col gap-3">
            <Field label="Email" htmlFor="email">
              <input
                id="email"
                type="text"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-body-md text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <input
                id="password"
                type="password"
                autoComplete={isRegister ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isRegister ? 'At least 6 characters' : '••••••••'}
                className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-body-md text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </Field>
            {isRegister && codeRequired && (
              <Field label="Signup code" htmlFor="code">
                <input
                  id="code"
                  type="text"
                  autoComplete="off"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-body-md text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                />
              </Field>
            )}

            {error && (
              <p className="flex items-start gap-1.5 rounded-lg bg-error-container/60 px-3 py-2 text-metadata text-error">
                <Icon name="error" size={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </p>
            )}

            <button
              type="submit"
              disabled={busy || !email || !password}
              className="press mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container disabled:opacity-50"
            >
              {busy ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary/40 border-t-on-primary" />
              ) : (
                <Icon name={isRegister ? 'person_add' : 'login'} size={18} />
              )}
              {isRegister ? 'Create account' : 'Sign in'}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-[12px] text-outline">
          Meetings, transcripts &amp; summaries — private to your account.
        </p>
      </div>
    </div>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="flex flex-col gap-1.5">
      <span className="text-metadata font-medium text-on-surface">{label}</span>
      {children}
    </label>
  )
}
