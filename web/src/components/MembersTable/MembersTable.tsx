import { useState } from 'react'
import type { Member } from '@/lib/adminApi'
import styles from '@/components/MembersTable/MembersTable.module.scss'

const PAGE_SIZE = 25

type MembersTableProps = {
  members: ReadonlyArray<Member>
  onInvite: (member: Member) => void
  invitingEmail: string | null
}

const formatExpiry = (expires: string | null): string => {
  if (!expires) {
    return '—'
  }
  const date = new Date(expires)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

const formatDownloads = (downloads: boolean | null): string => {
  if (downloads === null) {
    return '—'
  }
  return downloads ? '✓' : '✗'
}

const MembersTable = ({ members, onInvite, invitingEmail }: MembersTableProps) => {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(members.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const start = current * PAGE_SIZE
  const visible = members.slice(start, start + PAGE_SIZE)

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Member</th>
            <th>Email</th>
            <th>Tier</th>
            <th>Downloads</th>
            <th>Expiry</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((member) => (
            <tr key={`${member.email}-${member.member}`}>
              <td>{member.member}</td>
              <td>{member.email}</td>
              <td className={styles.tier}>{member.tier}</td>
              <td>{formatDownloads(member.downloads)}</td>
              <td>{formatExpiry(member.expires)}</td>
              <td>
                {member.subscribed ? (
                  <span className={styles.subscribed}>Subscribed</span>
                ) : (
                  <button
                    className={styles.invite}
                    type="button"
                    onClick={() => onInvite(member)}
                    disabled={invitingEmail === member.email}
                  >
                    {invitingEmail === member.email ? 'Inviting…' : 'Invite'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className={styles.pager}>
        <button type="button" onClick={() => setPage(current - 1)} disabled={current === 0}>
          Prev
        </button>
        <span className={styles.count}>
          Page {current + 1} of {pageCount}
        </span>
        <button
          type="button"
          onClick={() => setPage(current + 1)}
          disabled={current >= pageCount - 1}
        >
          Next
        </button>
      </div>
    </div>
  )
}

export default MembersTable
