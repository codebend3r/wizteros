import { createContext, useContext, useState, type FormEvent, type ReactNode } from 'react'
import styles from '@/components/AdminGate/AdminGate.module.scss'

type AdminAuth = {
  password: string
  deauthenticate: () => void
}

const AdminAuthContext = createContext<AdminAuth | null>(null)

export const useAdminAuth = (): AdminAuth => {
  const auth = useContext(AdminAuthContext)
  if (!auth) {
    throw new Error('useAdminAuth must be used within AdminGate')
  }
  return auth
}

const STORAGE_KEY = 'westeroz-admin-password'

type AdminGateProps = {
  title: string
  children: ReactNode
}

const AdminGate = ({ title, children }: AdminGateProps) => {
  const [password, setPassword] = useState<string>(() => sessionStorage.getItem(STORAGE_KEY) ?? '')
  const [draft, setDraft] = useState('')

  const authenticate = (event: FormEvent) => {
    event.preventDefault()
    sessionStorage.setItem(STORAGE_KEY, draft)
    setPassword(draft)
  }

  const deauthenticate = () => {
    sessionStorage.removeItem(STORAGE_KEY)
    setPassword('')
    setDraft('')
  }

  if (!password) {
    return (
      <main className={styles.gate}>
        <form className={styles.form} onSubmit={authenticate}>
          <h1 className={styles.title}>{title}</h1>
          <label className={styles.label} htmlFor="admin-password">
            Password
          </label>
          <input
            id="admin-password"
            className={styles.input}
            type="password"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button className={styles.button} type="submit">
            Enter
          </button>
        </form>
      </main>
    )
  }

  return (
    <AdminAuthContext.Provider value={{ password, deauthenticate }}>
      {children}
    </AdminAuthContext.Provider>
  )
}

export default AdminGate
