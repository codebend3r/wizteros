import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import styles from '@/components/LoginGate/LoginGate.module.scss'
import { useAuthStore } from '@/stores/authStore'

// Defense in depth: signups are disabled server-side, so only pre-created
// accounts can authenticate at all.
export const ALLOWED_ADMIN_EMAILS: ReadonlyArray<string> = ['cj.rivas.dev@gmail.com']

type LoginGateProps = {
  title: string
  children: ReactNode
}

export const LoginGate = ({ title, children }: LoginGateProps) => {
  const enabled = useAuthStore((state) => state.enabled)
  const status = useAuthStore((state) => state.status)
  const email = useAuthStore((state) => state.email)
  const signIn = useAuthStore((state) => state.signIn)
  const signOut = useAuthStore((state) => state.signOut)
  const [draftEmail, setDraftEmail] = useState('')
  const [draftPassword, setDraftPassword] = useState('')
  const [error, setError] = useState('')

  const allowed = !!email && ALLOWED_ADMIN_EMAILS.includes(email)
  const blocked = enabled && status === 'signed-in' && !allowed

  useEffect(() => {
    if (blocked) {
      setError('This account is not allowed here')
      void signOut()
    }
  }, [blocked, signOut])

  if (!enabled) {
    return <>{children}</>
  }

  if (status === 'loading') {
    return null
  }

  if (status === 'signed-in' && allowed) {
    return <>{children}</>
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    try {
      await signIn({ email: draftEmail, password: draftPassword })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign-in failed')
    }
  }

  return (
    <main className={styles.gate}>
      <form className={styles.form} onSubmit={(event) => void submit(event)}>
        <h1 className={styles.title}>{title}</h1>
        <label className={styles.label} htmlFor="login-email">
          Email
        </label>
        <input
          id="login-email"
          className={styles.input}
          type="email"
          autoComplete="email"
          value={draftEmail}
          onChange={(event) => setDraftEmail(event.target.value)}
        />
        <label className={styles.label} htmlFor="login-password">
          Password
        </label>
        <input
          id="login-password"
          className={styles.input}
          type="password"
          autoComplete="current-password"
          value={draftPassword}
          onChange={(event) => setDraftPassword(event.target.value)}
        />
        {!!error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        <button className={styles.button} type="submit">
          Sign in
        </button>
      </form>
    </main>
  )
}
