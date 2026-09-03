import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AdminGate, useAdminAuth } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { ConfirmInviteModal } from '@/components/ConfirmInviteModal/ConfirmInviteModal'
import { CopyEmailsButton } from '@/components/CopyEmailsButton/CopyEmailsButton'
import { MembersTable } from '@/components/MembersTable/MembersTable'
import { Preloader } from '@/components/Preloader/Preloader'
import {
  AdminAuthError,
  fetchMembers,
  linkMemberAddress,
  loadErrorMessage,
  reissueInvite,
  type InviteResult,
  type Member,
  type PaidTier,
} from '@/lib/adminApi'
import { TIER_DOWNLOADS } from '@/lib/inviteRules'
import { deriveStatus, STATUS_EMOJI, type MemberStatus } from '@/lib/memberStatus'
import styles from '@/pages/Manage/Manage.module.scss'

export const MEMBERS_QUERY_KEY = ['members'] as const

// The search term lives in the query string, so a refresh, a bookmark, or a
// pasted link lands on the same filtered list the sender was looking at.
const SEARCH_PARAM = 'search'

type PendingInvite = {
  member: Member
  tier: PaidTier
}

// The lifecycle pills double as a legend: every status the table can derive,
// with its live count, in the order the lifecycle moves.
const STATUS_FILTERS: ReadonlyArray<{ status: MemberStatus; label: string }> = [
  { status: 'Subscribed Monthly', label: 'Subscribed' },
  { status: 'Payment Failed', label: 'Payment failed' },
  { status: 'VIP', label: 'VIP' },
  { status: 'Invited', label: 'Invited' },
  { status: 'Declined Invite', label: 'Declined' },
  { status: 'Expired Member', label: 'Expired' },
  { status: 'Uninvited', label: 'Uninvited' },
]

const EMPTY_COUNTS: Record<MemberStatus, number> = {
  'Subscribed Monthly': 0,
  'Payment Failed': 0,
  'Expired Member': 0,
  Invited: 0,
  'Declined Invite': 0,
  Uninvited: 0,
  VIP: 0,
}

const ManageInner = () => {
  const { deauthenticate } = useAdminAuth()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const search = searchParams.get(SEARCH_PARAM) ?? ''
  const [statusFilter, setStatusFilter] = useState<MemberStatus | null>(null)
  const [pendingInvite, setPendingInvite] = useState<PendingInvite | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)
  const [linkingEmail, setLinkingEmail] = useState<string | null>(null)

  const {
    data: members,
    error: loadError,
    isPending,
  } = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: () => fetchMembers(),
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (loadError instanceof AdminAuthError) {
      deauthenticate()
    }
  }, [loadError, deauthenticate])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return members?.filter(
      (member) =>
        (!needle || member.email.toLowerCase().includes(needle)) &&
        (!statusFilter || deriveStatus({ member }) === statusFilter),
    )
  }, [members, search, statusFilter])

  const statusCounts = useMemo(
    () =>
      // The accumulator starts as a fresh copy and is bumped in place:
      // spreading it per row is the one immutability habit the linter vetoes.
      (members ?? []).reduce<Record<MemberStatus, number>>(
        (counts, member) => {
          counts[deriveStatus({ member })] += 1
          return counts
        },
        { ...EMPTY_COUNTS },
      ),
    [members],
  )

  const inviteMutation = useMutation({
    mutationFn: ({ member, tier }: PendingInvite) => reissueInvite({ email: member.email, tier }),
    onSuccess: (result, { member, tier }) => {
      setInviteResult(result)
      // Existing access survives the invite window now, so keep expiry and
      // servers as they are — only the tier, downloads, and the freshly
      // restarted grace clock change until the member redeems.
      queryClient.setQueryData<Member[]>(MEMBERS_QUERY_KEY, (old) =>
        old?.map((row) =>
          row.email === member.email
            ? {
                ...row,
                tier,
                downloads: TIER_DOWNLOADS[tier],
                invited_at: new Date().toISOString(),
              }
            : row,
        ),
      )
      setPendingInvite(null)
    },
    onError: (cause) => {
      setPendingInvite(null)
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not create invite.')
    },
  })

  // Stating that two rows are one member changes which customer the merged row
  // reads its billing from, so the list is refetched rather than patched.
  const linkMutation = useMutation({
    mutationFn: ({ stripeEmail, plexEmail }: { stripeEmail: string; plexEmail: string }) =>
      linkMemberAddress({ stripeEmail, plexEmail }),
    onMutate: ({ stripeEmail }) => {
      setActionError(null)
      setLinkingEmail(stripeEmail)
    },
    onSettled: () => setLinkingEmail(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: MEMBERS_QUERY_KEY })
    },
    onError: (cause) => {
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not link those addresses.')
    },
  })

  const selectTier = (selection: PendingInvite) => {
    setActionError(null)
    setInviteResult(null)
    setPendingInvite(selection)
  }

  // replace, not push: one history entry per keystroke would bury whatever
  // page the admin arrived from behind a dozen back presses. An emptied box
  // drops the key entirely rather than leaving a bare `?search=` behind.
  const setSearch = (term: string) => {
    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params)
        if (term) {
          next.set(SEARCH_PARAM, term)
        } else {
          next.delete(SEARCH_PARAM)
        }
        return next
      },
      { replace: true },
    )
  }

  const error =
    loadError && !(loadError instanceof AdminAuthError) ? loadErrorMessage(loadError) : actionError

  return (
    <AdminLayout>
      <main className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>Members</h1>
          <div className={styles.copyGroup} role="group" aria-label="Copy email lists">
            <CopyEmailsButton emails={(members ?? []).map((member) => member.email)} />
            <CopyEmailsButton
              label="Copy non-VIP emails"
              emails={(members ?? [])
                .filter((member) => member.tag !== 'vip')
                .map((member) => member.email)}
            />
            <CopyEmailsButton
              label="Copy VIP emails"
              emails={(members ?? [])
                .filter((member) => member.tag === 'vip')
                .map((member) => member.email)}
            />
            <CopyEmailsButton
              label="Copy invited emails"
              emails={(members ?? [])
                .filter((member) => deriveStatus({ member }) === 'Invited')
                .map((member) => member.email)}
            />
          </div>
        </div>
        <div className={styles.actions}>
          <Link className={styles.inviteLink} to="/invite">
            + Invite someone
          </Link>
          <Link className={styles.inviteLink} to="/email">
            Email all members
          </Link>
        </div>
        {!!error && <p className={styles.error}>{error}</p>}
        {!!inviteResult && (
          <p className={styles.invite}>
            {inviteResult.emailed
              ? 'Invite emailed. Link: '
              : 'Email failed — send this link manually: '}
            <a href={inviteResult.url}>{inviteResult.url}</a>
          </p>
        )}
        {isPending && !error && <Preloader message="Loading members… (this can take ~15s)" />}
        {!!members && (
          <>
            <div className={styles.filters} role="group" aria-label="Filter by status">
              <button
                className={statusFilter === null ? styles.filterActive : styles.filterPill}
                type="button"
                aria-pressed={statusFilter === null}
                onClick={() => setStatusFilter(null)}
              >
                All {members.length}
              </button>
              {STATUS_FILTERS.map(({ status, label }) => (
                <button
                  key={status}
                  className={statusFilter === status ? styles.filterActive : styles.filterPill}
                  type="button"
                  aria-pressed={statusFilter === status}
                  onClick={() => setStatusFilter(statusFilter === status ? null : status)}
                >
                  <span aria-hidden="true">{STATUS_EMOJI[status]}</span> {label}{' '}
                  {statusCounts[status]}
                </button>
              ))}
            </div>
            <label className={styles.searchLabel} htmlFor="member-search">
              Search by email
            </label>
            <input
              id="member-search"
              className={styles.search}
              type="search"
              placeholder="name@example.com"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <MembersTable
              members={filtered ?? []}
              onSelectTier={selectTier}
              invitingEmail={
                inviteMutation.isPending ? (inviteMutation.variables?.member.email ?? null) : null
              }
              onLinkAddresses={(link) => linkMutation.mutate(link)}
              linkingEmail={linkingEmail}
            />
          </>
        )}
        {!!pendingInvite && (
          <ConfirmInviteModal
            member={pendingInvite.member}
            tier={pendingInvite.tier}
            sending={inviteMutation.isPending}
            onConfirm={() => inviteMutation.mutate(pendingInvite)}
            onCancel={() => setPendingInvite(null)}
          />
        )}
      </main>
    </AdminLayout>
  )
}

export const Manage = () => (
  <AdminGate title="Westeroz — Manage">
    <ManageInner />
  </AdminGate>
)
