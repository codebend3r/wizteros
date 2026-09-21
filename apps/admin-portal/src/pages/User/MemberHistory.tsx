import { Spinner } from '@/components/Spinner/Spinner'
import type { Member, MemberEvent } from '@/lib/adminApi'
import { deriveHistory } from '@/lib/memberStatus'
import styles from '@/pages/User/MemberHistory.module.scss'

type MemberHistoryProps = {
  member: Member
  events: ReadonlyArray<MemberEvent>
  pending: boolean
}

/** Everything that has happened to this member, newest first. */
export const MemberHistory = ({ member, events, pending }: MemberHistoryProps) => {
  const rows = deriveHistory({ member, events })
  return (
    <section className={styles.historySection}>
      <h2 className={styles.sectionTitle}>History</h2>
      {pending ? (
        <Spinner label="Loading history" />
      ) : rows.length ? (
        <ul className={styles.history}>
          {rows.map((event) => (
            <li key={event.id} className={styles.historyRow}>
              <span className={styles.historyAt}>{new Date(event.at).toLocaleString()}</span>
              <span className={styles.historyAction}>{event.action}</span>
              {!!event.detail && <span className={styles.historyDetail}>{event.detail}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.notice}>No history yet.</p>
      )}
    </section>
  )
}
