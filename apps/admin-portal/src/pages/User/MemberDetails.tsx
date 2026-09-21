import { useEffect, useState } from 'react'
import { Spinner } from '@/components/Spinner/Spinner'
import { TierIcon } from '@/components/TierIcon/TierIcon'
import type { Member, PlexServerAccess } from '@/lib/adminApi'
import { DAY_MS, parseTimestamp } from '@/lib/dates'
import { INVITE_LINK_DAYS, inviteWindowEnd, isPaidTier, TIER_LABELS } from '@/lib/inviteRules'
import { buildServerAccess, stateLabel, type LibraryAccessState } from '@/lib/libraryAccess'
import { deriveStatus, STATUS_EMOJI, TAG_LABELS } from '@/lib/memberStatus'
import { siteConfig } from '@/site.config'
import styles from '@/pages/User/MemberDetails.module.scss'

type MemberDetailsProps = {
  member: Member
  /** What plex.tv reports it is sharing, or null when it could not be read. */
  sharing: Record<string, PlexServerAccess> | null
  /** True while plex.tv is still being read, which is one reason for a null. */
  checking: boolean
  expiryUpdating: boolean
  downloadsUpdating: boolean
  onToggleDownloads: () => void
}

const STATE_CLASS: Record<LibraryAccessState, string | undefined> = {
  shared: styles.shared,
  'not-shared': styles.notShared,
  'not-entitled': styles.notEntitled,
  unknown: undefined,
}

const formatDaysLeft = (expiry: Date): string => {
  const days = Math.ceil((expiry.getTime() - Date.now()) / DAY_MS)
  if (days < 0) {
    return 'overdue'
  }
  if (days === 0) {
    return 'due today'
  }
  return days === 1 ? '1 day left' : `${days} days left`
}

const formatDownloads = (downloads: boolean | null): string => {
  if (downloads === null) {
    return '—'
  }
  return downloads ? '✅' : '❌'
}

const formatLibraryCount = (count: number): string =>
  `${count} ${count === 1 ? 'library' : 'libraries'}`

/** Everything the bridge records about one member, as it stands right now. */
export const MemberDetails = ({
  member,
  sharing,
  checking,
  expiryUpdating,
  downloadsUpdating,
  onToggleDownloads,
}: MemberDetailsProps) => {
  const status = deriveStatus({ member })
  const expiry = parseTimestamp(member.expires)
  const invitedAt = parseTimestamp(member.invited_at)
  // A member with no server records and no expiry has nothing but their open
  // invite, so the invite's own deadline is the expiry that matters to them.
  const inviteExpiry = invitedAt ? inviteWindowEnd({ invitedAt }) : null
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  const copyEmail = () => {
    navigator.clipboard
      .writeText(member.email)
      .then(() => setCopied(true))
      .catch(() => undefined)
  }
  // Entitlement (what the tier grants) and the live plex.tv share (what is
  // actually shared) are kept apart and merged per library, so a member
  // mid-invite no longer renders identically to one with real access.
  // ?. survives old-shape members restored from the persisted query cache
  // (written before the bridge sent entitled).
  const serverEntries = buildServerAccess({
    entitled: member.entitled ?? member.libraries ?? {},
    sharing,
  })
  const totalLibraries = serverEntries.reduce((sum, entry) => sum + entry.libraries.length, 0)
  const totalShared = serverEntries.reduce((sum, entry) => sum + entry.sharedCount, 0)
  const notEntitled = serverEntries.reduce(
    (sum, entry) =>
      sum + entry.libraries.filter((library) => library.state === 'not-entitled').length,
    0,
  )
  return (
    <dl className={styles.details}>
      <dt>Member</dt>
      <dd>{member.member}</dd>
      <dt>Email</dt>
      <dd className={styles.email}>
        <span>{member.email}</span>
        <button className={styles.copyEmail} type="button" onClick={copyEmail}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </dd>
      <dt>Status</dt>
      <dd className={styles.status}>
        <span aria-hidden="true">{STATUS_EMOJI[status]}</span>
        <span>{status}</span>
      </dd>
      <dt>Tier</dt>
      <dd className={styles.tier}>
        {isPaidTier(member.tier) && <TierIcon tier={member.tier} />}{' '}
        {isPaidTier(member.tier) ? TIER_LABELS[member.tier] : member.tier}
      </dd>
      <dt>Tag</dt>
      <dd>{member.tag ? TAG_LABELS[member.tag] : '—'}</dd>
      {!!member.stripe_email && (
        <>
          <dt>Stripe email</dt>
          <dd className={styles.stripeEmail}>
            <span>{member.stripe_email}</span>
            <span className={styles.stripeEmailHint}>
              pays under this address; watches as {member.email}
            </span>
          </dd>
        </>
      )}
      <dt>Stripe</dt>
      <dd>
        {member.customer_id && siteConfig.stripeDashboardUrl ? (
          <a
            className={styles.stripeLink}
            href={`${siteConfig.stripeDashboardUrl}/customers/${member.customer_id}`}
            target="_blank"
            rel="noreferrer"
          >
            {member.customer_id} ↗
          </a>
        ) : (
          '—'
        )}
      </dd>
      <dt>Downloads</dt>
      <dd className={styles.downloadsValue}>
        <button
          className={styles.downloadsToggle}
          type="button"
          onClick={onToggleDownloads}
          aria-label="Toggle allow downloads"
        >
          {formatDownloads(member.downloads)}
        </button>
        {downloadsUpdating && <Spinner label="Updating downloads" />}
      </dd>
      <dt>Invited</dt>
      <dd>{invitedAt ? invitedAt.toLocaleString() : '—'}</dd>
      <dt>Expiry</dt>
      <dd className={styles.expiryValue}>
        {expiry ? (
          <>
            <span>{expiry.toLocaleString()}</span>
            <span className={styles.daysLeft}>({formatDaysLeft(expiry)})</span>
          </>
        ) : member.servers.length ? (
          // A joined member with no expiry has unlimited access — say so
          // instead of the pending-member em dash.
          <span>♾️ Never expires</span>
        ) : inviteExpiry ? (
          <>
            <span>{inviteExpiry.toLocaleString()}</span>
            <span className={styles.daysLeft}>({formatDaysLeft(inviteExpiry)})</span>
            <span className={styles.inviteWindow}>{INVITE_LINK_DAYS} days from the invite</span>
          </>
        ) : (
          '—'
        )}
        {expiryUpdating && <Spinner label="Updating expiry" />}
      </dd>
      <dt className={styles.serversLabel}>Servers</dt>
      <dd>
        {serverEntries.length ? (
          <div className={styles.serversWrap}>
            <p className={styles.serversSummary}>
              {serverEntries.length} {serverEntries.length === 1 ? 'server' : 'servers'} ·{' '}
              {formatLibraryCount(totalLibraries)}
              {!checking && ` · ${totalShared} shared on plex.tv`}
              {!!notEntitled && ` · ${notEntitled} not entitled`}
              {checking && <Spinner label="Checking plex.tv" />}
            </p>
            <ul className={styles.serverList}>
              {serverEntries.map(({ server, entitled, libraries, sharedCount }) => (
                <li key={server} className={styles.server}>
                  <span className={styles.serverHeading}>
                    <span className={styles.serverName}>{server}</span>
                    <span className={styles.serverCount}>
                      {formatLibraryCount(libraries.length)}
                      {!checking && ` · ${sharedCount} shared`}
                    </span>
                    {!entitled && <span className={styles.serverWarning}>no tier grants this</span>}
                  </span>
                  {!!libraries.length && (
                    <ul className={styles.pillList}>
                      {libraries.map(({ library, state }) => (
                        <li
                          key={library}
                          className={`${styles.pill} ${STATE_CLASS[state] ?? ''}`.trim()}
                        >
                          <span className={styles.pillName}>{library}</span>
                          <span className={styles.pillState}>{stateLabel(state)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : checking ? (
          <Spinner label="Checking plex.tv" />
        ) : (
          '—'
        )}
      </dd>
    </dl>
  )
}
