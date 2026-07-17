import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Member, PaidTier } from '@/lib/adminApi'
import { isPaidTier, PAID_TIERS, TIER_LABELS } from '@/lib/inviteRules'
import { deriveStatus } from '@/lib/memberStatus'
import TierIcon from '@/components/TierIcon/TierIcon'
import styles from '@/components/MembersTable/MembersTable.module.scss'

const PAGE_SIZE = 25

type MembersTableProps = {
  members: ReadonlyArray<Member>
  onSelectTier: (selection: { member: Member; tier: PaidTier }) => void
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

const MembersTable = ({ members, onSelectTier, invitingEmail }: MembersTableProps) => {
  const [page, setPage] = useState(0)
  const [menuEmail, setMenuEmail] = useState<string | null>(null)
  const pageCount = Math.max(1, Math.ceil(members.length / PAGE_SIZE))
  const current = Math.min(page, pageCount - 1)
  const start = current * PAGE_SIZE
  const visible = members.slice(start, start + PAGE_SIZE)

  useEffect(() => {
    if (!menuEmail) {
      return
    }
    const close = () => setMenuEmail(null)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
      }
    }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuEmail])

  return (
    <div className={styles.wrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Member</th>
            <th>Email</th>
            <th>Tier</th>
            <th>Downloads</th>
            <th>Servers</th>
            <th>Expiry</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((member) => {
            const status = deriveStatus({ member })
            return (
              <tr key={`${member.email}-${member.member}`}>
                <td>{member.member}</td>
                <td>
                  <Link
                    className={styles.emailLink}
                    to={`/user?email=${encodeURIComponent(member.email)}`}
                  >
                    {member.email}
                  </Link>
                </td>
                <td>
                  <span className={styles.tierCell}>
                    {isPaidTier(member.tier) && <TierIcon tier={member.tier} />}
                    {member.tier}
                  </span>
                </td>
                <td>{formatDownloads(member.downloads)}</td>
                <td>
                  {member.servers.length ? (
                    <span className={styles.servers} title={member.servers.join(', ')}>
                      {member.servers.length}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>{formatExpiry(member.expires)}</td>
                <td>
                  <span className={styles.status}>
                    {status === 'Subscribed Monthly' && isPaidTier(member.tier) && (
                      <TierIcon tier={member.tier} />
                    )}
                    <span className={status === 'Subscribed Monthly' ? styles.subscribed : ''}>
                      {status}
                    </span>
                  </span>
                </td>
                <td className={menuEmail === member.email ? styles.menuOpen : undefined}>
                  <div className={styles.menuWrap}>
                    <button
                      className={styles.invite}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation()
                        setMenuEmail(menuEmail === member.email ? null : member.email)
                      }}
                      disabled={invitingEmail === member.email}
                      aria-haspopup="menu"
                      aria-expanded={menuEmail === member.email}
                    >
                      {invitingEmail === member.email
                        ? 'Inviting…'
                        : status === 'Subscribed Monthly'
                          ? 'Re-invite'
                          : 'Invite'}
                    </button>
                    {menuEmail === member.email && (
                      <ul className={styles.menu} role="menu">
                        {PAID_TIERS.map((tier) => (
                          <li key={tier} role="none">
                            <button
                              className={styles.menuItem}
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMenuEmail(null)
                                onSelectTier({ member, tier })
                              }}
                            >
                              <TierIcon tier={tier} /> {TIER_LABELS[tier]} Tier
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </td>
              </tr>
            )
          })}
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
