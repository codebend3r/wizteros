import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import AdminGate, { useAdminAuth } from '@/components/AdminGate/AdminGate'
import AdminLayout from '@/components/AdminLayout/AdminLayout'
import CopyEmailsButton from '@/components/CopyEmailsButton/CopyEmailsButton'
import Preloader from '@/components/Preloader/Preloader'
import { AdminAuthError, fetchMembers } from '@/lib/adminApi'
import { buildMailto, dedupeEmails } from '@/lib/emails'
import { MEMBERS_QUERY_KEY } from '@/pages/Manage/Manage'
import styles from '@/pages/Email/Email.module.scss'

const EmailInner = () => {
  const { deauthenticate } = useAdminAuth()
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set())

  const {
    data: members,
    error: loadError,
    isPending,
  } = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: () => fetchMembers(),
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (loadError instanceof AdminAuthError) {
      deauthenticate()
    }
  }, [loadError, deauthenticate])

  const allEmails = useMemo(
    () => dedupeEmails((members ?? []).map((member) => member.email)),
    [members],
  )
  const recipients = useMemo(
    () => allEmails.filter((email) => !excluded.has(email)),
    [allEmails, excluded],
  )

  const removeRecipient = (email: string) => setExcluded((prev) => new Set(prev).add(email))

  const reset = () => setExcluded(new Set())

  const handleSend = () => {
    if (!recipients.length) {
      return
    }
    window.location.href = buildMailto({ recipients, subject, body })
  }

  const error =
    loadError && !(loadError instanceof AdminAuthError) ? 'Could not load members.' : null

  return (
    <AdminLayout>
      <main className={styles.page}>
        <div className={styles.header}>
          <div className={styles.heading}>
            <Link className={styles.back} to="/manage">
              ← All members
            </Link>
            <h1 className={styles.title}>Email members</h1>
          </div>
          <CopyEmailsButton emails={allEmails} />
        </div>
        {!!error && <p className={styles.error}>{error}</p>}
        {isPending && !error && <Preloader message="Loading members… (this can take ~15s)" />}
        {!!members && (
          <div className={styles.form}>
            <div className={styles.recipients}>
              <div className={styles.recipientsHead}>
                <span className={styles.count}>{recipients.length} recipients</span>
                {excluded.size > 0 && (
                  <button className={styles.reset} type="button" onClick={reset}>
                    Reset
                  </button>
                )}
              </div>
              {recipients.length ? (
                <ul className={styles.chips}>
                  {recipients.map((email) => (
                    <li key={email} className={styles.chip}>
                      <span className={styles.chipText}>{email}</span>
                      <button
                        className={styles.chipRemove}
                        type="button"
                        onClick={() => removeRecipient(email)}
                        aria-label={`Remove ${email}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.empty}>No recipients selected. Reset to add everyone back.</p>
              )}
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="email-subject">
                Subject
              </label>
              <input
                id="email-subject"
                className={styles.input}
                type="text"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="email-body">
                Message
              </label>
              <textarea
                id="email-body"
                className={styles.textarea}
                rows={10}
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
            </div>
            <button
              className={styles.send}
              type="button"
              onClick={handleSend}
              disabled={!recipients.length}
            >
              Send email
            </button>
          </div>
        )}
      </main>
    </AdminLayout>
  )
}

const Email = () => (
  <AdminGate title="Westeroz — Email">
    <EmailInner />
  </AdminGate>
)

export default Email
