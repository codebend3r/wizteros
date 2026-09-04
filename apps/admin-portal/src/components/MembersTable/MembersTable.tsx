import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import type { Member, PaidTier } from '@/lib/adminApi'
import { isPaidTier, PAID_TIERS, TIER_LABELS } from '@/lib/inviteRules'
import { STATUS_EMOJI, deriveStatus, type MemberStatus } from '@/lib/memberStatus'
import { findDuplicateTwins } from '@/lib/duplicateMembers'
import { TierIcon } from '@/components/TierIcon/TierIcon'
import styles from '@/components/MembersTable/MembersTable.module.scss'

const PAGE_SIZES = [10, 25, 50, 100, 250] as const

type SortColumn = 'member' | 'email' | 'status'
type SortDirection = 'asc' | 'desc'
type SortState = { column: SortColumn; direction: SortDirection }

// The sort lives in the query string next to the search term, so a refresh,
// a bookmark, or a pasted link lands on the same order the sender saw.
const SORT_PARAM = 'sort'
const DIRECTION_PARAM = 'dir'

const SORT_COLUMNS: ReadonlyArray<SortColumn> = ['member', 'email', 'status']

// A bare /manage opens sorted by status, descending, until a header is clicked.
const DEFAULT_SORT: SortState = { column: 'status', direction: 'desc' }

const isSortColumn = (value: string | null): value is SortColumn =>
  SORT_COLUMNS.some((column) => column === value)

// A missing or unknown column falls back to the default order; a direction
// that is not `desc` reads as ascending.
const readSort = (params: URLSearchParams): SortState => {
  const column = params.get(SORT_PARAM)
  return isSortColumn(column)
    ? { column, direction: params.get(DIRECTION_PARAM) === 'desc' ? 'desc' : 'asc' }
    : DEFAULT_SORT
}

type MembersTableProps = {
  members: ReadonlyArray<Member>
  onSelectTier: (selection: { member: Member; tier: PaidTier }) => void
  invitingEmail: string | null
  onLinkAddresses?: (link: { stripeEmail: string; plexEmail: string }) => void
  linkingEmail?: string | null
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

// A member already holding access gets "Re-invite"; one in dunning still holds
// theirs, so the failed charge must not relabel their action button.
const HOLDS_ACCESS: ReadonlySet<MemberStatus> = new Set<MemberStatus>([
  'Subscribed Monthly',
  'Payment Failed',
])

const STATUS_CLASS: Partial<Record<MemberStatus, string>> = {
  'Subscribed Monthly': styles.subscribed,
  'Payment Failed': styles.paymentFailed,
}

const statusClass = (status: MemberStatus): string => STATUS_CLASS[status] ?? ''

const accessLabel = ({ servers, libraries }: { servers: number; libraries: number }): string =>
  `${servers} ${servers === 1 ? 'server' : 'servers'}, ` +
  `${libraries} ${libraries === 1 ? 'library' : 'libraries'}`

const formatDownloads = (downloads: boolean | null): string => {
  if (downloads === null) {
    return '—'
  }
  return downloads ? '✓' : '✗'
}

/**
 * The pair a "same person" link can be stated for, or null when it cannot.
 *
 * Only one shape is unambiguous: exactly one twin, and exactly one of the two
 * holding Wizarr records. That one is the Plex account; the other is the
 * address the money arrives at. Two members who both hold access are two
 * people until someone says otherwise, and two who hold none say nothing
 * about which way the link points; both stay a hint only.
 */
const linkableTwin = ({
  member,
  twins,
  byEmail,
}: {
  member: Member
  twins: ReadonlyArray<string>
  byEmail: ReadonlyMap<string, Member>
}): { stripeEmail: string; plexEmail: string } | null => {
  if (twins.length !== 1) {
    return null
  }
  const twin = byEmail.get(twins[0] ?? '')
  if (!twin || !!member.stripe_email || !!twin.stripe_email) {
    return null
  }
  const holders = [member, twin].filter((row) => row.servers.length > 0)
  if (holders.length !== 1) {
    return null
  }
  const plex = holders[0]
  const payer = [member, twin].find((row) => row !== plex)
  return !!plex && !!payer ? { stripeEmail: payer.email, plexEmail: plex.email } : null
}

const sortValue = ({ member, column }: { member: Member; column: SortColumn }): string =>
  column === 'status' ? deriveStatus({ member }) : member[column]

type SortHeaderProps = {
  column: SortColumn
  label: string
  sort: SortState
  onToggle: (column: SortColumn) => void
}

const SortHeader = ({ column, label, sort, onToggle }: SortHeaderProps) => {
  const active = sort.column === column
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

export const MembersTable = ({
  members,
  onSelectTier,
  invitingEmail,
  onLinkAddresses,
  linkingEmail,
}: MembersTableProps) => {
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState<number>(25)
  const [searchParams, setSearchParams] = useSearchParams()
  const sort = useMemo(() => readSort(searchParams), [searchParams])
  const [menuEmail, setMenuEmail] = useState<string | null>(null)

  // Two live customers for one person bill twice and heal neither: the new
  // payment cannot rescue the old address's access. Flag the pair so it is
  // reconciled in Stripe rather than read as two healthy members.
  const duplicates = useMemo(() => findDuplicateTwins({ members }), [members])

  const byEmail = useMemo(
    () => new Map(members.map((member) => [member.email.toLowerCase(), member])),
    [members],
  )

  const sorted = useMemo(() => {
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

  // replace, not push: toggling a header is a view tweak, and one history
  // entry per click would bury the page the admin arrived from. The updater
  // keeps whatever else is in the query string (the search term) intact.
  const toggleSort = (column: SortColumn) => {
    setPage(0)
    const direction: SortDirection =
      sort.column === column && sort.direction === 'asc' ? 'desc' : 'asc'
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params)
        next.set(SORT_PARAM, column)
        next.set(DIRECTION_PARAM, direction)
        return next
      },
      { replace: true },
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
              const twins = duplicates.get(member.email.toLowerCase()) ?? []
              const link = twins.length ? linkableTwin({ member, twins, byEmail }) : null
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
                    {!!twins.length && (
                      <span className={styles.duplicate}>
                        <span title="Another member has a nearly identical address. Check Stripe for two customers billing one person.">
                          possible duplicate
                        </span>
                        {!!link && !!onLinkAddresses && (
                          <button
                            className={styles.linkButton}
                            type="button"
                            disabled={linkingEmail === link.stripeEmail}
                            title={`Record ${link.stripeEmail} as the address ${link.plexEmail} pays under. Nothing in Stripe changes.`}
                            aria-label={`Mark ${member.email} and ${twins[0]} as one member`}
                            onClick={() => onLinkAddresses(link)}
                          >
                            {linkingEmail === link.stripeEmail ? 'linking…' : 'same person'}
                          </button>
                        )}
                      </span>
                    )}
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
                      {status === 'Payment Failed' && (
                        <span aria-hidden="true">{STATUS_EMOJI[status]}</span>
                      )}
                      <span className={statusClass(status)}>{status}</span>
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
                          : HOLDS_ACCESS.has(status)
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
