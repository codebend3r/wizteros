import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Member, PaidTier } from '@/lib/adminApi'
import { isPaidTier, PAID_TIERS, TIER_LABELS } from '@/lib/inviteRules'
import { deriveStatus } from '@/lib/memberStatus'
import { TierIcon } from '@/components/TierIcon/TierIcon'
import styles from '@/components/MembersTable/MembersTable.module.scss'

const PAGE_SIZES = [10, 25, 50, 100, 250] as const

type SortColumn = 'member' | 'email' | 'status'
type SortDirection = 'asc' | 'desc'
type SortState = { column: SortColumn; direction: SortDirection }

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

// Old-shape members restored from the persisted query cache were written
// before the bridge sent libraries, so the map can be missing entirely.
const countLibraries = (libraries: Member['libraries']): number =>
  Object.values(libraries ?? {}).reduce((total, names) => total + names.length, 0)

const accessLabel = ({ servers, libraries }: { servers: number; libraries: number }): string =>
  `${servers} ${servers === 1 ? 'server' : 'servers'}, ` +
  `${libraries} ${libraries === 1 ? 'library' : 'libraries'}`

const formatDownloads = (downloads: boolean | null): string => {
  if (downloads === null) {
    return '—'
  }
  return downloads ? '✓' : '✗'
}

const sortValue = ({ member, column }: { member: Member; column: SortColumn }): string =>
  column === 'status' ? deriveStatus({ member }) : member[column]

type SortHeaderProps = {
  column: SortColumn
  label: string
  sort: SortState | null
  onToggle: (column: SortColumn) => void
}

const SortHeader = ({ column, label, sort, onToggle }: SortHeaderProps) => {
  const active = sort?.column === column
  return (
    <th aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button className={styles.sortButton} type="button" onClick={() => onToggle(column)}>
        {label}
        {active && <span aria-hidden="true">{sort.direction === 'asc' ? ' ▲' : ' ▼'}</span>}
      </button>
    </th>
  )
}

type PagerProps = {
  current: number
  pageCount: number
  onPageChange: (page: number) => void
  pageSize?: number
  onPageSizeChange?: (size: number) => void
}

const Pager = ({ current, pageCount, onPageChange, pageSize, onPageSizeChange }: PagerProps) => (
  <div className={styles.pager}>
    {!!pageSize && !!onPageSizeChange && (
      <select
        className={styles.pageSize}
        aria-label="Rows per page"
        value={pageSize}
        onChange={(event) => onPageSizeChange(Number(event.target.value))}
      >
        {PAGE_SIZES.map((size) => (
          <option key={size} value={size}>
            {size} rows
          </option>
        ))}
      </select>
    )}
    <button type="button" onClick={() => onPageChange(current - 1)} disabled={current === 0}>
      Prev
    </button>
    <span className={styles.count}>
      Page {current + 1} of {pageCount}
    </span>
    <button
      type="button"
      onClick={() => onPageChange(current + 1)}
      disabled={current >= pageCount - 1}
    >
      Next
    </button>
  </div>
)

export const MembersTable = ({ members, onSelectTier, invitingEmail }: MembersTableProps) => {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<number>(25)
  const [sort, setSort] = useState<SortState | null>(null)
  const [menuEmail, setMenuEmail] = useState<string | null>(null)

  const sorted = useMemo(() => {
    if (!sort) {
      return members
    }
    const factor = sort.direction === 'asc' ? 1 : -1
    return [...members].sort(
      (a, b) =>
        factor *
        sortValue({ member: a, column: sort.column }).localeCompare(
          sortValue({ member: b, column: sort.column }),
        ),
    )
  }, [members, sort])

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize))
  const current = Math.min(page, pageCount - 1)
  const start = current * pageSize
  const visible = sorted.slice(start, start + pageSize)

  const toggleSort = (column: SortColumn) => {
    setPage(0)
    setSort(
      sort?.column === column
        ? { column, direction: sort.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: 'asc' },
    )
  }

  const changePageSize = (size: number) => {
    setPage(0)
    setPageSize(size)
  }

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
      <Pager
        current={current}
        pageCount={pageCount}
        onPageChange={setPage}
        pageSize={pageSize}
        onPageSizeChange={changePageSize}
      />
      <div className={styles.scroller}>
        <table className={styles.table}>
          <thead>
            <tr>
              <SortHeader column="member" label="Member" sort={sort} onToggle={toggleSort} />
              <SortHeader column="email" label="Email" sort={sort} onToggle={toggleSort} />
              <th>Tier</th>
              <th>Downloads</th>
              <th>Servers/Libs</th>
              <th>Expiry</th>
              <SortHeader column="status" label="Status" sort={sort} onToggle={toggleSort} />
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((member) => {
              const status = deriveStatus({ member })
              const libraryCount = countLibraries(member.libraries)
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
                      <span
                        className={styles.servers}
                        title={member.servers.join(', ')}
                        aria-label={accessLabel({
                          servers: member.servers.length,
                          libraries: libraryCount,
                        })}
                      >
                        {member.servers.length} / {libraryCount}
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
                      {status === 'VIP' && <span aria-hidden="true">💎</span>}
                      {status === 'Invited' && <span aria-hidden="true">✉️</span>}
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
      </div>
      <Pager current={current} pageCount={pageCount} onPageChange={setPage} />
    </div>
  )
}
