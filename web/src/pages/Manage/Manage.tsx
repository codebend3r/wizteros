import { useEffect, useState } from 'react'
import AdminGate, { useAdminAuth } from '@/components/AdminGate/AdminGate'
import MembersTable from '@/components/MembersTable/MembersTable'
import { AdminAuthError, fetchMembers, reissueInvite, type Member } from '@/lib/adminApi'
import styles from '@/pages/Manage/Manage.module.scss'

const ManageInner = () => {
  const { password, deauthenticate } = useAdminAuth()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [invitingEmail, setInvitingEmail] = useState<string | null>(null)
  const [inviteLink, setInviteLink] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setError(null)
    fetchMembers({ password })
      .then((result) => {
        if (active) {
          setMembers(result)
        }
      })
      .catch((cause) => {
        if (!active) {
          return
        }
        if (cause instanceof AdminAuthError) {
          deauthenticate()
          return
        }
        setError('Could not load members.')
      })
    return () => {
      active = false
    }
  }, [password])

  const invite = (member: Member) => {
    setInvitingEmail(member.email)
    setInviteLink(null)
    setError(null)
    reissueInvite({ email: member.email, tier: 'bronze', password })
      .then((result) => setInviteLink(result.url))
      .catch((cause) => {
        if (cause instanceof AdminAuthError) {
          deauthenticate()
          return
        }
        setError('Could not create invite.')
      })
      .finally(() => setInvitingEmail(null))
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Members</h1>
      {!!error && <p className={styles.error}>{error}</p>}
      {!!inviteLink && (
        <p className={styles.invite}>
          Invite link: <a href={inviteLink}>{inviteLink}</a>
        </p>
      )}
      {members === null && !error && (
        <p className={styles.loading}>Loading members… (this can take ~15s)</p>
      )}
      {!!members && (
        <MembersTable members={members} onInvite={invite} invitingEmail={invitingEmail} />
      )}
    </main>
  )
}

const Manage = () => (
  <AdminGate title="Westeroz — Manage">
    <ManageInner />
  </AdminGate>
)

export default Manage
