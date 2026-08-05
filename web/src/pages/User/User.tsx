import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AdminGate, useAdminAuth } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { ConfirmActionModal } from '@/components/ConfirmActionModal/ConfirmActionModal'
import { ConfirmInviteModal } from '@/components/ConfirmInviteModal/ConfirmInviteModal'
import { Preloader } from '@/components/Preloader/Preloader'
import { TierIcon } from '@/components/TierIcon/TierIcon'
import {
  AdminAuthError,
  cancelSubscription,
  fetchMember,
  fetchMemberEvents,
  fetchMemberNotes,
  fetchPlexAccess,
  reissueInvite,
  resetExpiry,
  resetTier,
  saveMemberNotes,
  setMemberDownloads,
  setMemberTag,
  type InviteResult,
  type Member,
  type MemberEvent,
  type MemberTag,
  type PaidTier,
  type PlexAccess,
} from '@/lib/adminApi'
import {
  INVITE_LINK_DAYS,
  isPaidTier,
  PAID_TIERS,
  TIER_DOWNLOADS,
  TIER_LABELS,
} from '@/lib/inviteRules'
import { deriveStatus, type MemberStatus } from '@/lib/memberStatus'
import { MEMBERS_QUERY_KEY } from '@/pages/Manage/Manage'
import { siteConfig } from '@/site.config'
import styles from '@/pages/User/User.module.scss'

const DAY_MS = 24 * 60 * 60 * 1000

const STATUS_EMOJI: Record<MemberStatus, string> = {
  'Subscribed Monthly': '🟢',
  'Expired Member': '🔴',
  Invited: '✉️',
  'Declined Invite': '🚫',
  Uninvited: '⚪',
  VIP: '💎',
}

const TAG_LABELS: Record<MemberTag, string> = {
  vip: '💎 VIP',
  hvu: '⭐ HVU',
}

const parseTimestamp = (value: string | null): Date | null => {
  if (!value) {
    return null
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

// The invite link stops working INVITE_LINK_DAYS after it was sent, which is
// also when the status ages from Invited into Declined Invite.
const inviteWindowEnd = (invitedAt: Date): Date =>
  new Date(invitedAt.getTime() + INVITE_LINK_DAYS * DAY_MS)

const pad = (value: number): string => String(value).padStart(2, '0')

// The picker's seed: the given date (current expiry, else tomorrow) at one
// minute after midnight, in the local datetime-local format.
const toExpiryDraft = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T00:01`

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

const MemberDetails = ({
  member,
  plexAccess,
  plexChecking,
  expiryUpdating,
  downloadsUpdating,
  onToggleDownloads,
}: {
  member: Member
  plexAccess: PlexAccess | undefined
  plexChecking: boolean
  expiryUpdating: boolean
  downloadsUpdating: boolean
  onToggleDownloads: () => void
}) => {
  const status = deriveStatus({ member })
  const expiry = parseTimestamp(member.expires)
  const invitedAt = parseTimestamp(member.invited_at)
  // A member with no server records and no expiry has nothing but their open
  // invite, so the invite's own deadline is the expiry that matters to them.
  const inviteExpiry = invitedAt ? inviteWindowEnd(invitedAt) : null
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
  // The live plex.tv share is ground truth when we have it; it covers legacy
  // shares whose unknown tier derives zero libraries. Servers only plex.tv
  // knows about are unioned in; the rest fall back to the tier-derived list.
  const plexServers = plexAccess?.servers ?? {}
  const serverEntries = [...new Set([...member.servers, ...Object.keys(plexServers)])]
    .sort((a, b) => a.localeCompare(b))
    .map((server) => ({
      server,
      allLibraries: !!plexServers[server]?.all_libraries,
      // ?. survives old-shape members restored from the persisted query cache
      // (written before the bridge sent libraries).
      libraries: plexServers[server]?.libraries ?? member.libraries?.[server] ?? [],
    }))
  const totalLibraries = serverEntries.reduce((sum, entry) => sum + entry.libraries.length, 0)
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
        {downloadsUpdating && (
          <span className={styles.spinner} role="status" aria-label="Updating downloads" />
        )}
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
          // A joined member with no expiry has unlimited access, say so
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
        {expiryUpdating && (
          <span className={styles.spinner} role="status" aria-label="Updating expiry" />
        )}
      </dd>
      <dt className={styles.serversLabel}>Servers</dt>
      <dd>
        {serverEntries.length ? (
          <div className={styles.serversWrap}>
            <p className={styles.serversSummary}>
              {serverEntries.length} {serverEntries.length === 1 ? 'server' : 'servers'} ·{' '}
              {formatLibraryCount(totalLibraries)}
              {plexChecking && (
                <span className={styles.spinner} role="status" aria-label="Checking plex.tv" />
              )}
            </p>
            <ul className={styles.serverList}>
              {serverEntries.map(({ server, allLibraries, libraries }) => (
                <li key={server} className={styles.server}>
                  <span className={styles.serverHeading}>
                    <span className={styles.serverName}>{server}</span>
                    <span className={styles.serverCount}>
                      {allLibraries
                        ? `all libraries (${libraries.length})`
                        : formatLibraryCount(libraries.length)}
                    </span>
                  </span>
                  {!!libraries.length && (
                    <ul className={styles.pillList}>
                      {libraries.map((library) => (
                        <li key={library} className={styles.pill}>
                          {library}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : plexChecking ? (
          <span className={styles.spinner} role="status" aria-label="Checking plex.tv" />
        ) : (
          '—'
        )}
      </dd>
    </dl>
  )
}

const UserInner = () => {
  const { deauthenticate } = useAdminAuth()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const email = searchParams.get('email') ?? ''
  const [menuOpen, setMenuOpen] = useState(false)
  const [pendingTier, setPendingTier] = useState<PaidTier | null>(null)
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notesDraft, setNotesDraft] = useState<string | null>(null)
  const [expiryDraft, setExpiryDraft] = useState<string | null>(null)
  const [pendingHardReset, setPendingHardReset] = useState<PaidTier | null>(null)
  const [pendingExpiry, setPendingExpiry] = useState<string | null>(null)
  const [pendingNeverExpire, setPendingNeverExpire] = useState(false)
  const [pendingCancelSub, setPendingCancelSub] = useState(false)
  const [cancelNotice, setCancelNotice] = useState<string | null>(null)
  const [pendingDownloads, setPendingDownloads] = useState<boolean | null>(null)

  const {
    data: member,
    error: loadError,
    isPending,
  } = useQuery({
    queryKey: ['member', email],
    queryFn: () => fetchMember({ email }),
    enabled: !!email,
    staleTime: 5 * 60 * 1000,
    // Seed from the /manage table so the detail page is instant when the
    // member list is already cached; /admin/member costs the same ~15s
    // Wizarr fan-out as the full list.
    initialData: () =>
      queryClient
        .getQueryData<Member[]>(MEMBERS_QUERY_KEY)
        ?.find((row) => row.email.toLowerCase() === email.toLowerCase()),
  })

  // Best-effort: a bridge without the endpoint (or plex.tv down) just leaves
  // the tier-derived fallback in place.
  const { data: plexAccess, isPending: plexChecking } = useQuery({
    queryKey: ['plex-access', email],
    queryFn: () => fetchPlexAccess({ email }),
    enabled: !!email,
    staleTime: 5 * 60 * 1000,
  })

  const {
    data: memberNotes,
    error: notesError,
    isPending: notesPending,
  } = useQuery({
    queryKey: ['member-notes', email],
    queryFn: () => fetchMemberNotes({ email }),
    enabled: !!email,
    staleTime: 5 * 60 * 1000,
  })

  const {
    data: memberEvents,
    error: eventsError,
    isPending: eventsPending,
  } = useQuery({
    queryKey: ['member-events', email],
    queryFn: () => fetchMemberEvents({ email }),
    enabled: !!email,
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (
      loadError instanceof AdminAuthError ||
      notesError instanceof AdminAuthError ||
      eventsError instanceof AdminAuthError
    ) {
      deauthenticate()
    }
  }, [loadError, notesError, eventsError, deauthenticate])

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const close = () => setMenuOpen(false)
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
  }, [menuOpen])

  const inviteMutation = useMutation({
    mutationFn: (tier: PaidTier) => reissueInvite({ email, tier }),
    onSuccess: (result, tier) => {
      setInviteResult(result)
      // Existing access survives the invite window now, so keep expiry and
      // servers as they are; only the tier, downloads, and the freshly
      // restarted grace clock change until the member redeems.
      const apply = (row: Member): Member => ({
        ...row,
        tier,
        downloads: TIER_DOWNLOADS[tier],
        invited_at: new Date().toISOString(),
      })
      queryClient.setQueryData<Member | null>(['member', email], (old) => (old ? apply(old) : old))
      queryClient.setQueryData<Member[]>(MEMBERS_QUERY_KEY, (old) =>
        old?.map((row) => (row.email.toLowerCase() === email.toLowerCase() ? apply(row) : row)),
      )
      void queryClient.invalidateQueries({ queryKey: ['member-events', email] })
      setPendingTier(null)
    },
    onError: (cause) => {
      setPendingTier(null)
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not create invite.')
    },
  })

  const applyToMemberCaches = (transform: (row: Member) => Member) => {
    queryClient.setQueryData<Member | null>(['member', email], (old) =>
      old ? transform(old) : old,
    )
    queryClient.setQueryData<Member[]>(MEMBERS_QUERY_KEY, (old) =>
      old?.map((row) => (row.email.toLowerCase() === email.toLowerCase() ? transform(row) : row)),
    )
  }

  const tierResetMutation = useMutation({
    mutationFn: (tier: PaidTier) => resetTier({ email, tier }),
    onSuccess: (_result, tier) => {
      applyToMemberCaches((row) => ({ ...row, tier, downloads: TIER_DOWNLOADS[tier] }))
      void queryClient.invalidateQueries({ queryKey: ['member-events', email] })
    },
    onError: (cause) => {
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not reset tier.')
    },
  })

  const expiryMutation = useMutation({
    mutationFn: (expiresAt: string) => resetExpiry({ email, expiresAt }),
    onMutate: (expiresAt) => {
      const previousMember = queryClient.getQueryData<Member | null>(['member', email])
      const previousMembers = queryClient.getQueryData<Member[]>(MEMBERS_QUERY_KEY)
      applyToMemberCaches((row) => ({ ...row, expires: expiresAt, subscribed: true }))
      return { previousMember, previousMembers }
    },
    onSuccess: (result) => {
      // Settle on the bridge's canonical value in case it normalized ours.
      applyToMemberCaches((row) => ({ ...row, expires: result.expires }))
      void queryClient.invalidateQueries({ queryKey: ['member-events', email] })
      setExpiryDraft(null)
    },
    onError: (cause, _expiresAt, context) => {
      queryClient.setQueryData(['member', email], context?.previousMember)
      queryClient.setQueryData(MEMBERS_QUERY_KEY, context?.previousMembers)
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not set expiry.')
    },
  })

  const neverExpireMutation = useMutation({
    mutationFn: () => resetExpiry({ email }),
    onMutate: () => {
      const previousMember = queryClient.getQueryData<Member | null>(['member', email])
      const previousMembers = queryClient.getQueryData<Member[]>(MEMBERS_QUERY_KEY)
      // A cleared expiry reads back as "—": the bridge derives subscribed
      // from the expiry, so both flip together.
      applyToMemberCaches((row) => ({ ...row, expires: null, subscribed: false }))
      return { previousMember, previousMembers }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['member-events', email] })
      setExpiryDraft(null)
    },
    onError: (cause, _variables, context) => {
      queryClient.setQueryData(['member', email], context?.previousMember)
      queryClient.setQueryData(MEMBERS_QUERY_KEY, context?.previousMembers)
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not clear expiry.')
    },
  })

  const downloadsMutation = useMutation({
    mutationFn: (allow: boolean) => setMemberDownloads({ email, allow }),
    onMutate: (allow) => {
      const previousMember = queryClient.getQueryData<Member | null>(['member', email])
      const previousMembers = queryClient.getQueryData<Member[]>(MEMBERS_QUERY_KEY)
      applyToMemberCaches((row) => ({ ...row, downloads: allow }))
      return { previousMember, previousMembers }
    },
    onSuccess: (result) => {
      // Settle on the bridge's canonical value.
      applyToMemberCaches((row) => ({ ...row, downloads: result.downloads }))
      void queryClient.invalidateQueries({ queryKey: ['member-events', email] })
    },
    onError: (cause, _allow, context) => {
      queryClient.setQueryData(['member', email], context?.previousMember)
      queryClient.setQueryData(MEMBERS_QUERY_KEY, context?.previousMembers)
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not toggle allow downloads for this user.')
    },
  })

  const tagMutation = useMutation({
    mutationFn: (tag: MemberTag | null) => setMemberTag({ email, tag }),
    onSuccess: (result) => {
      applyToMemberCaches((row) => ({ ...row, tag: result.tag }))
      void queryClient.invalidateQueries({ queryKey: ['member-events', email] })
    },
    onError: (cause) => {
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not change the tag.')
    },
  })

  const cancelSubMutation = useMutation({
    mutationFn: () => cancelSubscription({ email }),
    onSuccess: (result) => {
      setCancelNotice(
        result.cancel_at
          ? `Cancellation scheduled, access ends ${new Date(result.cancel_at).toLocaleString()}.`
          : 'Cancellation scheduled.',
      )
      void queryClient.invalidateQueries({ queryKey: ['member-events', email] })
    },
    onError: (cause) => {
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not cancel the subscription.')
    },
  })

  const expiryValue =
    expiryDraft ??
    toExpiryDraft(parseTimestamp(member?.expires ?? null) ?? new Date(Date.now() + DAY_MS))
  const expiryValid = !Number.isNaN(new Date(expiryValue).getTime())

  const savedNotes = memberNotes?.notes ?? ''
  const notes = notesDraft ?? savedNotes
  const notesDirty = notes !== savedNotes

  const notesMutation = useMutation({
    mutationFn: (value: string) => saveMemberNotes({ email, notes: value }),
    onSuccess: (result) => {
      queryClient.setQueryData(['member-notes', email], result)
      setNotesDraft(null)
    },
    onError: (cause) => {
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not save notes.')
    },
  })

  const error = !!loadError && !(loadError instanceof AdminAuthError)

  // The bridge can't observe an expiry date passing, so surface it as a
  // derived row on top of the recorded history.
  const expiredAt = member && deriveStatus({ member }) === 'Expired Member' ? member.expires : null
  const historyRows: MemberEvent[] = [
    ...(expiredAt
      ? [
          {
            id: -1,
            at: expiredAt,
            email: member?.email ?? '',
            action: 'Membership expired',
            detail: '',
          },
        ]
      : []),
    ...(memberEvents ?? []),
  ]

  return (
    <AdminLayout>
      <main className={styles.page}>
        <Link className={styles.back} to="/manage">
          ← All members
        </Link>
        <h1 className={styles.title}>{member?.member ?? (email !== '' ? email : 'Member')}</h1>
        {!email && <p className={styles.notice}>No email provided.</p>}
        {error && <p className={styles.error}>Could not load member.</p>}
        {!!actionError && <p className={styles.error}>{actionError}</p>}
        {!!inviteResult && (
          <p className={styles.inviteNotice}>
            {inviteResult.emailed
              ? 'Invite emailed. Link: '
              : 'Email failed. Send this link manually: '}
            <a href={inviteResult.url}>{inviteResult.url}</a>
          </p>
        )}
        {!!email && isPending && !error && (
          <Preloader message="Loading member… (this can take ~15s)" />
        )}
        {member === null && <p className={styles.notice}>No member found for {email}.</p>}
        {!!member && (
          <>
            <MemberDetails
              member={member}
              plexAccess={plexAccess}
              plexChecking={plexChecking}
              expiryUpdating={expiryMutation.isPending || neverExpireMutation.isPending}
              downloadsUpdating={downloadsMutation.isPending}
              onToggleDownloads={() => {
                setActionError(null)
                setPendingDownloads(!(member.downloads ?? false))
              }}
            />
            <div className={styles.actions}>
              <div className={styles.menuWrap}>
                <button
                  className={styles.invite}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    setMenuOpen(!menuOpen)
                  }}
                  disabled={inviteMutation.isPending}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                >
                  {inviteMutation.isPending
                    ? 'Inviting…'
                    : deriveStatus({ member }) === 'Subscribed Monthly'
                      ? 'Re-invite'
                      : 'Invite'}
                </button>
                {menuOpen && (
                  <ul className={styles.menu} role="menu">
                    {PAID_TIERS.map((tier) => (
                      <li key={tier} role="none">
                        <button
                          className={styles.menuItem}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false)
                            setActionError(null)
                            setInviteResult(null)
                            setPendingTier(tier)
                          }}
                        >
                          <TierIcon tier={tier} /> {TIER_LABELS[tier]} Tier
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <section className={styles.controlSection}>
              <h2 className={styles.sectionTitle}>Hard reset tier</h2>
              <p className={styles.controlHint}>
                Rewrites the recorded tier instantly; no new invite is sent.
              </p>
              <div className={styles.controlRow}>
                {PAID_TIERS.map((tier) => (
                  <button
                    key={tier}
                    className={styles.controlButton}
                    type="button"
                    onClick={() => {
                      setActionError(null)
                      setPendingHardReset(tier)
                    }}
                    disabled={tierResetMutation.isPending}
                  >
                    <TierIcon tier={tier} /> {TIER_LABELS[tier]}
                  </button>
                ))}
                {tierResetMutation.isPending && (
                  <span className={styles.spinner} role="status" aria-label="Resetting tier" />
                )}
              </div>
            </section>
            <section className={styles.controlSection}>
              <h2 className={styles.sectionTitle}>Tag</h2>
              <p className={styles.controlHint}>
                A manual designation shown as the member's status
              </p>
              <div className={styles.controlRow}>
                <button
                  className={styles.controlButton}
                  type="button"
                  onClick={() => {
                    setActionError(null)
                    tagMutation.mutate('vip')
                  }}
                  disabled={tagMutation.isPending || member.tag === 'vip'}
                >
                  💎 VIP
                </button>
                {tagMutation.isPending && tagMutation.variables === 'vip' && (
                  <span className={styles.spinner} role="status" aria-label="Updating tag" />
                )}
                <button
                  className={styles.controlButton}
                  type="button"
                  onClick={() => {
                    setActionError(null)
                    tagMutation.mutate('hvu')
                  }}
                  disabled={tagMutation.isPending || member.tag === 'hvu'}
                >
                  ⭐ HVU
                </button>
                {tagMutation.isPending && tagMutation.variables === 'hvu' && (
                  <span className={styles.spinner} role="status" aria-label="Updating tag" />
                )}
                <button
                  className={styles.controlButton}
                  type="button"
                  onClick={() => {
                    setActionError(null)
                    tagMutation.mutate(null)
                  }}
                  disabled={tagMutation.isPending || !member.tag}
                >
                  Clear tag
                </button>
                {tagMutation.isPending && tagMutation.variables === null && (
                  <span className={styles.spinner} role="status" aria-label="Updating tag" />
                )}
              </div>
            </section>
            <section className={styles.controlSection}>
              <h2 className={styles.sectionTitle}>Set expiry</h2>
              <form
                className={styles.controlRow}
                onSubmit={(event) => {
                  event.preventDefault()
                  setActionError(null)
                  setPendingExpiry(new Date(expiryValue).toISOString())
                }}
              >
                <input
                  className={styles.expiryInput}
                  type="datetime-local"
                  value={expiryValue}
                  aria-label="New expiry date and time"
                  onChange={(event) => setExpiryDraft(event.target.value)}
                />
                <button
                  className={styles.controlButton}
                  type="submit"
                  disabled={!expiryValid || expiryMutation.isPending}
                >
                  Set expiry
                </button>
                <button
                  className={styles.dangerButton}
                  type="button"
                  onClick={() => {
                    setActionError(null)
                    setPendingNeverExpire(true)
                  }}
                  disabled={expiryMutation.isPending || neverExpireMutation.isPending}
                >
                  Never expire
                </button>
                {neverExpireMutation.isPending && (
                  <span className={styles.spinner} role="status" aria-label="Clearing expiry" />
                )}
              </form>
            </section>
            <section className={styles.controlSection}>
              <h2 className={styles.sectionTitle}>Subscription</h2>
              <p className={styles.controlHint}>
                Flags the member's Stripe subscription to cancel at the end of the billing period;
                access shuts off automatically when it lapses.
              </p>
              {!!cancelNotice && <p className={styles.cancelNotice}>{cancelNotice}</p>}
              <div className={styles.controlRow}>
                <button
                  className={styles.dangerButton}
                  type="button"
                  onClick={() => {
                    setActionError(null)
                    setPendingCancelSub(true)
                  }}
                  disabled={cancelSubMutation.isPending}
                >
                  {cancelSubMutation.isPending ? 'Cancelling…' : 'Cancel subscription'}
                </button>
              </div>
            </section>
            <section className={styles.notesSection}>
              <h2 className={styles.sectionTitle}>
                Notes
                {notesPending && (
                  <span className={styles.spinner} role="status" aria-label="Loading notes" />
                )}
              </h2>
              <textarea
                className={styles.notes}
                value={notes}
                placeholder="Notes about this member…"
                aria-label="Member notes"
                rows={6}
                disabled={notesPending}
                onChange={(event) => setNotesDraft(event.target.value)}
              />
              <div className={styles.notesActions}>
                <button
                  className={styles.notesSave}
                  type="button"
                  onClick={() => notesMutation.mutate(notes)}
                  disabled={!notesDirty || notesMutation.isPending}
                >
                  {notesMutation.isPending ? 'Saving…' : 'Save notes'}
                </button>
                {notesMutation.isSuccess && !notesDirty && (
                  <span className={styles.notesSaved}>Saved ✓</span>
                )}
              </div>
            </section>
            <section className={styles.historySection}>
              <h2 className={styles.sectionTitle}>History</h2>
              {eventsPending ? (
                <span className={styles.spinner} role="status" aria-label="Loading history" />
              ) : historyRows.length ? (
                <ul className={styles.history}>
                  {historyRows.map((event) => (
                    <li key={event.id} className={styles.historyRow}>
                      <span className={styles.historyAt}>
                        {new Date(event.at).toLocaleString()}
                      </span>
                      <span className={styles.historyAction}>{event.action}</span>
                      {!!event.detail && (
                        <span className={styles.historyDetail}>{event.detail}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.notice}>No history yet.</p>
              )}
            </section>
          </>
        )}
        {!!member && !!pendingHardReset && (
          <ConfirmActionModal
            title="Confirm tier reset"
            confirmLabel="Hard reset"
            onConfirm={() => {
              tierResetMutation.mutate(pendingHardReset)
              setPendingHardReset(null)
            }}
            onCancel={() => setPendingHardReset(null)}
          >
            <p>
              Hard reset {member.member} ({member.email}) to <TierIcon tier={pendingHardReset} />{' '}
              {TIER_LABELS[pendingHardReset]}.
            </p>
            <p className={styles.controlHint}>
              Rewrites the recorded tier instantly; no new invite is sent and Plex access is
              unchanged.
            </p>
          </ConfirmActionModal>
        )}
        {!!member && !!pendingExpiry && (
          <ConfirmActionModal
            title="Confirm expiry change"
            confirmLabel="Set expiry"
            onConfirm={() => {
              expiryMutation.mutate(pendingExpiry)
              setPendingExpiry(null)
            }}
            onCancel={() => setPendingExpiry(null)}
          >
            <p>
              Set the expiry for {member.member} ({member.email}) to{' '}
              {new Date(pendingExpiry).toLocaleString()}.
            </p>
            <p className={styles.controlHint}>Applies to every server record for this email.</p>
          </ConfirmActionModal>
        )}
        {!!member && pendingDownloads !== null && (
          <ConfirmActionModal
            title="Confirm downloads change"
            confirmLabel={pendingDownloads ? 'Turn on downloads' : 'Turn off downloads'}
            onConfirm={() => {
              downloadsMutation.mutate(pendingDownloads)
              setPendingDownloads(null)
            }}
            onCancel={() => setPendingDownloads(null)}
          >
            <p>
              Turn downloads {pendingDownloads ? 'on' : 'off'} for {member.member} ({member.email}
              ).
            </p>
            <p className={styles.controlHint}>
              The record updates immediately; the Plex-side permission applies with the member's
              next reissued invite.
            </p>
          </ConfirmActionModal>
        )}
        {!!member && pendingNeverExpire && (
          <ConfirmActionModal
            title="Confirm never expire"
            confirmLabel="Never expire"
            onConfirm={() => {
              neverExpireMutation.mutate()
              setPendingNeverExpire(false)
            }}
            onCancel={() => setPendingNeverExpire(false)}
          >
            <p>
              Set {member.member} ({member.email}) to never expire.
            </p>
            <p className={styles.controlHint}>
              Clears the expiry on every server record for this email; access stays on until you
              change it again.
            </p>
          </ConfirmActionModal>
        )}
        {!!member && pendingCancelSub && (
          <ConfirmActionModal
            title="Confirm subscription cancellation"
            confirmLabel="Cancel subscription"
            onConfirm={() => {
              cancelSubMutation.mutate()
              setPendingCancelSub(false)
            }}
            onCancel={() => setPendingCancelSub(false)}
          >
            <p>
              Cancel the Stripe subscription for {member.member} ({member.email}).
            </p>
            <p className={styles.controlHint}>
              They keep access until the end of the period they already contributed for; the bridge
              shuts them off automatically when it ends.
            </p>
          </ConfirmActionModal>
        )}
        {!!member && !!pendingTier && (
          <ConfirmInviteModal
            member={member}
            tier={pendingTier}
            sending={inviteMutation.isPending}
            onConfirm={() => inviteMutation.mutate(pendingTier)}
            onCancel={() => setPendingTier(null)}
          />
        )}
      </main>
    </AdminLayout>
  )
}

export const User = () => (
  <AdminGate title="Westeroz: Member">
    <UserInner />
  </AdminGate>
)
