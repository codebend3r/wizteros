import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import AdminGate, { useAdminAuth } from '@/components/AdminGate/AdminGate'
import AdminLayout from '@/components/AdminLayout/AdminLayout'
import ConfirmInviteModal from '@/components/ConfirmInviteModal/ConfirmInviteModal'
import CopyEmailsButton from '@/components/CopyEmailsButton/CopyEmailsButton'
import MembersTable from '@/components/MembersTable/MembersTable'
import Preloader from '@/components/Preloader/Preloader'
import {
  AdminAuthError,
  fetchMembers,
  reissueInvite,
  type InviteResult,
  type Member,
  type PaidTier,
} from '@/lib/adminApi'
import { TIER_DOWNLOADS } from '@/lib/inviteRules'
import styles from '@/pages/Manage/Manage.module.scss'

export const MEMBERS_QUERY_KEY = ['members'] as const

type PendingInvite = {
  member: Member
  tier: PaidTier
}

const ManageInner = () => {
  const { password, deauthenticate } = useAdminAuth()
  const queryClient = useQueryClient()
  const [search, setSearch] = useState('')
  const [pendingInvite, setPendingInvite] = useState<PendingInvite | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)

  const {
    data: members,
    error: loadError,
    isPending,
  } = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: () => fetchMembers({ password }),
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (loadError instanceof AdminAuthError) {
      deauthenticate()
    }
  }, [loadError, deauthenticate])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) {
      return members
    }
    return members?.filter((member) => member.email.toLowerCase().includes(needle))
  }, [members, search])

  const inviteMutation = useMutation({
    mutationFn: ({ member, tier }: PendingInvite) =>
      reissueInvite({ email: member.email, tier, password }),
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

  const selectTier = (selection: PendingInvite) => {
    setActionError(null)
    setInviteResult(null)
    setPendingInvite(selection)
  }

  const error =
    loadError && !(loadError instanceof AdminAuthError) ? 'Could not load members.' : actionError

  return (
    <AdminLayout>
      <main className={styles.page}>
        <div className={styles.header}>
          <h1 className={styles.title}>Members</h1>
          <CopyEmailsButton emails={(members ?? []).map((member) => member.email)} />
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

const Manage = () => (
  <AdminGate title="Westeroz — Manage">
    <ManageInner />
  </AdminGate>
)

export default Manage
