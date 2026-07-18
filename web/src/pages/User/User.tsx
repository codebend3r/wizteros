import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import AdminGate, { useAdminAuth } from '@/components/AdminGate/AdminGate'
import AdminLayout from '@/components/AdminLayout/AdminLayout'
import ConfirmInviteModal from '@/components/ConfirmInviteModal/ConfirmInviteModal'
import Preloader from '@/components/Preloader/Preloader'
import TierIcon from '@/components/TierIcon/TierIcon'
import {
  AdminAuthError,
  fetchMember,
  fetchMemberEvents,
  fetchMemberNotes,
  reissueInvite,
  saveMemberNotes,
  type InviteResult,
  type Member,
  type MemberEvent,
  type PaidTier,
} from '@/lib/adminApi'
import { ACCESS_DAYS, isPaidTier, PAID_TIERS, TIER_DOWNLOADS, TIER_LABELS } from '@/lib/inviteRules'
import { deriveStatus, type MemberStatus } from '@/lib/memberStatus'
import { MEMBERS_QUERY_KEY } from '@/pages/Manage/Manage'
import styles from '@/pages/User/User.module.scss'

const DAY_MS = 24 * 60 * 60 * 1000

const STATUS_EMOJI: Record<MemberStatus, string> = {
  'Subscribed Monthly': '🟢',
  'Expired Member': '🔴',
  Invited: '🟡',
  Uninvited: '⚪',
  VIP: '💎',
}

const parseExpiry = (expires: string | null): Date | null => {
  if (!expires) {
    return null
  }
  const date = new Date(expires)
  return Number.isNaN(date.getTime()) ? null : date
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

const MemberDetails = ({ member }: { member: Member }) => {
  const status = deriveStatus({ member })
  const expiry = parseExpiry(member.expires)
  return (
    <dl className={styles.details}>
      <dt>Member</dt>
      <dd>{member.member}</dd>
      <dt>Email</dt>
      <dd className={styles.email}>{member.email}</dd>
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
      <dt>Downloads</dt>
      <dd>{formatDownloads(member.downloads)}</dd>
      <dt>Expiry</dt>
      <dd>
        {expiry ? (
          <>
            {expiry.toLocaleDateString()}{' '}
            <span className={styles.daysLeft}>({formatDaysLeft(expiry)})</span>
          </>
        ) : (
          '—'
        )}
      </dd>
      <dt className={styles.serversLabel}>Servers</dt>
      <dd>
        {member.servers.length ? (
          <ul className={styles.serverList}>
            {member.servers.map((server) => {
              // ?. survives old-shape members restored from the persisted
              // query cache (written before the bridge sent libraries).
              const libraries = member.libraries?.[server] ?? []
              return (
                <li key={server} className={styles.server}>
                  <span className={styles.serverName}>{server}</span>
                  {!!libraries.length && (
                    <span className={styles.libraries}>{libraries.join(', ')}</span>
                  )}
                </li>
              )
            })}
          </ul>
        ) : (
          '—'
        )}
      </dd>
    </dl>
  )
}

const UserInner = () => {
  const { password, deauthenticate } = useAdminAuth()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const email = searchParams.get('email') ?? ''
  const [menuOpen, setMenuOpen] = useState(false)
  const [pendingTier, setPendingTier] = useState<PaidTier | null>(null)
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notesDraft, setNotesDraft] = useState<string | null>(null)

  const {
    data: member,
    error: loadError,
    isPending,
  } = useQuery({
    queryKey: ['member', email],
    queryFn: () => fetchMember({ email, password }),
    enabled: !!email,
    staleTime: 5 * 60 * 1000,
    // Seed from the /manage table so the detail page is instant when the
    // member list is already cached — /admin/member costs the same ~15s
    // Wizarr fan-out as the full list.
    initialData: () =>
      queryClient
        .getQueryData<Member[]>(MEMBERS_QUERY_KEY)
        ?.find((row) => row.email.toLowerCase() === email.toLowerCase()),
  })

  const { data: memberNotes, error: notesError } = useQuery({
    queryKey: ['member-notes', email],
    queryFn: () => fetchMemberNotes({ email, password }),
    enabled: !!email,
    staleTime: 5 * 60 * 1000,
  })

  const { data: memberEvents, error: eventsError } = useQuery({
    queryKey: ['member-events', email],
    queryFn: () => fetchMemberEvents({ email, password }),
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
    mutationFn: (tier: PaidTier) => reissueInvite({ email, tier, password }),
    onSuccess: (result, tier) => {
      setInviteResult(result)
      // The bridge doesn't return the member's new expiry (it only exists
      // once they redeem), so project the tier's access window optimistically.
      const expires = new Date(Date.now() + ACCESS_DAYS * DAY_MS).toISOString()
      const apply = (row: Member): Member => ({
        ...row,
        tier,
        downloads: TIER_DOWNLOADS[tier],
        expires,
        subscribed: true,
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

  const savedNotes = memberNotes?.notes ?? ''
  const notes = notesDraft ?? savedNotes
  const notesDirty = notes !== savedNotes

  const notesMutation = useMutation({
    mutationFn: (value: string) => saveMemberNotes({ email, notes: value, password }),
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
              : 'Email failed — send this link manually: '}
            <a href={inviteResult.url}>{inviteResult.url}</a>
          </p>
        )}
        {!!email && isPending && !error && (
          <Preloader message="Loading member… (this can take ~15s)" />
        )}
        {member === null && <p className={styles.notice}>No member found for {email}.</p>}
        {!!member && (
          <>
            <MemberDetails member={member} />
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
              <a className={styles.sendEmail} href={`mailto:${member.email}`}>
                Send email
              </a>
            </div>
            <section className={styles.notesSection}>
              <h2 className={styles.sectionTitle}>Notes</h2>
              <textarea
                className={styles.notes}
                value={notes}
                placeholder="Notes about this member…"
                aria-label="Member notes"
                rows={6}
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
              {historyRows.length ? (
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

const User = () => (
  <AdminGate title="Westeroz — Member">
    <UserInner />
  </AdminGate>
)

export default User
