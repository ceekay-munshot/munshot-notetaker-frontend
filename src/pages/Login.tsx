import { useState } from 'react'
import { useAuth } from '../store/Auth'
import { Icon } from '../components/Icon'
import { ApiError, forgotPassword, resetPassword } from '../lib/api'

// The sign-in / register screen — the gate in front of the whole dashboard.
// Both flows run through the Worker's auth routes (Auth store); on success the
// session probe re-runs and the dashboard takes over. A third "forgot" mode
// emails the user a working temporary password.
export default function Login({ codeRequired }: { codeRequired: boolean }) {
  const { signIn, signUp } = useAuth()
  const [mode, setMode] = useState<'login' | 'register' | 'forgot'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const isRegister = mode === 'register'
  const isForgot = mode === 'forgot'

  function switchMode(m: 'login' | 'register' | 'forgot') {
    setMode(m)
    setError('')
  }

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
          {isForgot ? (
            <ForgotPassword email={email} setEmail={setEmail} onBack={() => switchMode('login')} />
          ) : (
            <>
          <div className="mb-md flex rounded-lg bg-surface-container-low p-1">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
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

            {!isRegister && (
              <button
                type="button"
                onClick={() => switchMode('forgot')}
                className="mt-1 self-center text-metadata font-medium text-primary hover:underline"
              >
                Forgot password?
              </button>
            )}
          </form>
            </>
          )}
        </div>

        <p className="mt-6 text-center text-[12px] text-outline">
          Meetings, transcripts &amp; summaries — private to your account.
        </p>
      </div>
    </div>
  )
}

// Two-step password reset: (1) request a single-use 5-digit code by email, then
// (2) enter that code + a new password. On success we sign the user straight in
// with their new credentials (falling back to a "sign in" screen if that hiccups).
function ForgotPassword({
  email,
  setEmail,
  onBack,
}: {
  email: string
  setEmail: (v: string) => void
  onBack: () => void
}) {
  const { signIn } = useAuth()
  const [step, setStep] = useState<'request' | 'reset' | 'done'>('request')
  const [code, setCode] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault()
    setError('')
    setBusy(true)
    try {
      await forgotPassword(email.trim())
      setStep('reset')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function doReset(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await resetPassword(email.trim(), code.trim(), newPassword)
      // Password changed — sign straight in with the new credentials. On success
      // the Auth gate swaps this screen for the dashboard (this component
      // unmounts). If that hiccups, show a success screen to sign in manually.
      try {
        await signIn(email.trim(), newPassword)
      } catch {
        setStep('done')
        setBusy(false)
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  const codeValid = /^\d{5}$/.test(code.trim())
  const pwValid = newPassword.length >= 6

  if (step === 'done') {
    return (
      <div className="flex flex-col gap-3">
        <div className="mb-1">
          <h2 className="text-body-lg font-semibold text-on-surface">Password updated</h2>
          <p className="mt-1 text-metadata text-secondary">Your password has been reset. Sign in with your new password.</p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="press mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container"
        >
          <Icon name="login" size={18} />
          Back to sign in
        </button>
      </div>
    )
  }

  if (step === 'reset') {
    return (
      <div className="flex flex-col gap-3">
        <div className="mb-1">
          <h2 className="text-body-lg font-semibold text-on-surface">Enter your reset code</h2>
          <p className="mt-1 text-metadata text-secondary">
            If an account exists for <span className="font-medium text-on-surface">{email}</span>, a 5-digit code is on
            its way. It expires in 15 minutes. Enter it with your new password.
          </p>
        </div>

        <form onSubmit={doReset} className="flex flex-col gap-3">
          <Field label="Reset code" htmlFor="reset-code">
            <input
              id="reset-code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={5}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder="5-digit code"
              className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-body-md tracking-[0.3em] text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </Field>
          <Field label="New password" htmlFor="reset-password">
            <input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 6 characters"
              className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-body-md text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </Field>

          {error && (
            <p className="flex items-start gap-1.5 rounded-lg bg-error-container/60 px-3 py-2 text-metadata text-error">
              <Icon name="error" size={16} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !codeValid || !pwValid}
            className="press mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container disabled:opacity-50"
          >
            {busy ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary/40 border-t-on-primary" />
            ) : (
              <Icon name="lock_reset" size={18} />
            )}
            Reset password
          </button>

          <div className="mt-1 flex items-center justify-between">
            <button
              type="button"
              onClick={() => {
                setError('')
                setStep('request')
              }}
              className="text-metadata font-medium text-secondary hover:text-on-surface hover:underline"
            >
              Use a different email
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void requestCode()}
              className="text-metadata font-medium text-primary hover:underline disabled:opacity-50"
            >
              Resend code
            </button>
          </div>
        </form>
      </div>
    )
  }

  // step === 'request'
  return (
    <div className="flex flex-col gap-3">
      <div className="mb-1">
        <h2 className="text-body-lg font-semibold text-on-surface">Reset your password</h2>
        <p className="mt-1 text-metadata text-secondary">
          Enter your email and we&apos;ll send you a 5-digit reset code to set a new password.
        </p>
      </div>

      <form onSubmit={requestCode} className="flex flex-col gap-3">
        <Field label="Email" htmlFor="forgot-email">
          <input
            id="forgot-email"
            type="text"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            className="w-full rounded-lg border border-outline-variant bg-surface px-3 py-2.5 text-body-md text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
        </Field>

        {error && (
          <p className="flex items-start gap-1.5 rounded-lg bg-error-container/60 px-3 py-2 text-metadata text-error">
            <Icon name="error" size={16} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        <button
          type="submit"
          disabled={busy || !email}
          className="press mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-metadata font-semibold text-on-primary hover:bg-primary-container disabled:opacity-50"
        >
          {busy ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary/40 border-t-on-primary" />
          ) : (
            <Icon name="mail" size={18} />
          )}
          Send reset code
        </button>

        <button
          type="button"
          onClick={onBack}
          className="mt-1 self-center text-metadata font-medium text-primary hover:underline"
        >
          Back to sign in
        </button>
      </form>
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
