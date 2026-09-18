import type { Member } from '@/lib/adminApi'
import { parseTimestamp } from '@/lib/dates'
import { inviteWindowEnd } from '@/lib/inviteRules'
import { deriveProblems } from '@/lib/memberStatus'
import styles from '@/components/MemberProblems/MemberProblems.module.scss'

const inviteNote = ({ member }: { member: Member }): string => {
  const invitedAt = parseTimestamp(member.invited_at)
  if (!invitedAt) {
    return 'No invite is on record.'
  }
  const inviteExpiry = inviteWindowEnd({ invitedAt })
  return inviteExpiry.getTime() < Date.now()
    ? `Their invite expired on ${inviteExpiry.toLocaleDateString()} without being redeemed.`
    : `Their invite is open until ${inviteExpiry.toLocaleDateString()}.`
}

// What is wrong with the member, above the fold. The status row still shows
// one label, but a missed payment and a member holding no server record are
// separate facts, and the one who has both is the one nobody used to notice.
export const MemberProblems = ({ member }: { member: Member }) => {
  const { paymentFailed, noAccess } = deriveProblems({ member })
  if (!paymentFailed && !noAccess) {
    return null
  }
  return (
    <section className={styles.problems} aria-label="Needs attention">
      {paymentFailed && (
        <p className={`${styles.problem} ${styles.problemPayment}`}>
          <span aria-hidden="true">🟠</span>
          <span>
            <strong>Missed payment.</strong> Stripe could not charge this member and is retrying.
            The subscription is cancelled if every retry fails.
          </span>
        </p>
      )}
      {noAccess && (
        <p className={`${styles.problem} ${styles.problemAccess}`}>
          <span aria-hidden="true">🔒</span>
          <span>
            <strong>No server access.</strong> This member holds no record on any server.{' '}
            {inviteNote({ member })}
          </span>
        </p>
      )}
    </section>
  )
}
