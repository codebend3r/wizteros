import { useState, type FormEvent } from 'react'
import { AdminGate, useAdminAuth } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import {
  AdminAuthError,
  fetchMember,
  reissueInvite,
  resetExpiry,
  type Member,
  type PaidTier,
} from '@/lib/adminApi'
import styles from '@/pages/ResetUser/ResetUser.module.scss'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const TIERS: ReadonlyArray<PaidTier> = ['bronze', 'silver', 'gold', 'youth']
const EXPIRY_PRESETS: ReadonlyArray<{ label: string; days: number | null }> = [
  { label: 'No expiry', days: null },
  { label: '15 days', days: 15 },
  { label: '35 days', days: 35 },
  { label: '70 days', days: 70 },
]

const ResetUserInner = () => {
  const { deauthenticate } = useAdminAuth()
  const [email, setEmail] = useState('')
  const [member, setMember] = useState<Member | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const valid = EMAIL_RE.test(email)

  const onAuthError = (cause: unknown): boolean => {
    if (cause instanceof AdminAuthError) {
      deauthenticate()
      return true
    }
    return false
  }

  const lookup = (event: FormEvent) => {
    event.preventDefault()
    if (!valid) {
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    setMember(null)
    fetchMember({ email })
      .then((result) => {
        if (result === null) {
          setError('No member found for that email.')
        } else {
          setMember(result)
        }
      })
      .catch((cause) => {
        if (!onAuthError(cause)) {
          setError('Lookup failed.')
        }
      })
      .finally(() => setBusy(false))
  }

  const applyTier = (tier: PaidTier) => {
    if (!member) {
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    reissueInvite({ email: member.email, tier })
      .then((result) =>
        setStatus(
          result.emailed
            ? `Reset to ${tier}. Re-join link emailed: ${result.url}`
            : `Reset to ${tier}. Email failed — send this re-join link manually: ${result.url}`,
        ),
      )
      .catch((cause) => {
        if (!onAuthError(cause)) {
          setError('Could not reset tier.')
        }
      })
      .finally(() => setBusy(false))
  }

  const applyExpiry = (days: number | null) => {
    if (!member) {
      return
    }
    setBusy(true)
    setError(null)
    setStatus(null)
    resetExpiry({ email: member.email, days })
      .then(() => setStatus(days === null ? 'Expiry cleared.' : `Expiry set to ${days} days.`))
      .catch((cause) => {
        if (!onAuthError(cause)) {
          setError('Could not set expiry.')
        }
      })
      .finally(() => setBusy(false))
  }

  return (
    <AdminLayout>
      <main className={styles.page}>
        <h1 className={styles.title}>Reset a member</h1>
        <form className={styles.lookup} onSubmit={lookup}>
          <input
            className={styles.input}
            type="email"
            placeholder="member@email.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          <button className={styles.button} type="submit" disabled={!valid || busy}>
            Find
          </button>
        </form>
        {!!error && <p className={styles.error}>{error}</p>}
        {!!status && <p className={styles.status}>{status}</p>}
        {!!member && (
          <section className={styles.member}>
            <p className={styles.summary}>
              {member.member} — {member.email} ({member.tier})
            </p>
            <div className={styles.group}>
              <p className={styles.groupLabel}>
                Set tier — disables + re-invites; member must re-open the link
              </p>
              <div className={styles.buttons}>
                {TIERS.map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    className={styles.preset}
                    onClick={() => applyTier(tier)}
                    disabled={busy}
                  >
                    {tier}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.group}>
              <p className={styles.groupLabel}>Set expiry — instant, in place</p>
              <div className={styles.buttons}>
                {EXPIRY_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={styles.preset}
                    onClick={() => applyExpiry(preset.days)}
                    disabled={busy}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </section>
        )}
      </main>
    </AdminLayout>
  )
}

export const ResetUser = () => (
  <AdminGate title="Westeroz — Reset user">
    <ResetUserInner />
  </AdminGate>
)
