import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import AdminGate, { useAdminAuth } from '@/components/AdminGate/AdminGate'
import ConfirmInviteModal from '@/components/ConfirmInviteModal/ConfirmInviteModal'
import MembersTable from '@/components/MembersTable/MembersTable'
import Preloader from '@/components/Preloader/Preloader'
import {
  AdminAuthError,
  fetchMembers,
  reissueInvite,
  type Member,
  type PaidTier,
} from '@/lib/adminApi'
import { ACCESS_DAYS, TIER_DOWNLOADS } from '@/lib/inviteRules'
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
  const [inviteLink, setInviteLink] = useState<string | null>(null)

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
      setInviteLink(result.url)
      // The bridge doesn't return the member's new expiry (it only exists
      // once they redeem), so project the tier's access window optimistically.
      const expires = new Date(Date.now() + ACCESS_DAYS * 24 * 60 * 60 * 1000).toISOString()
      queryClient.setQueryData<Member[]>(MEMBERS_QUERY_KEY, (old) =>
        old?.map((row) =>
          row.email === member.email
            ? {
                ...row,
                tier,
                downloads: TIER_DOWNLOADS[tier],
                expires,
                subscribed: true,
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
    setInviteLink(null)
    setPendingInvite(selection)
  }

  const error =
    loadError && !(loadError instanceof AdminAuthError) ? 'Could not load members.' : actionError

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Members</h1>
      {!!error && <p className={styles.error}>{error}</p>}
      {!!inviteLink && (
        <p className={styles.invite}>
          Invite link: <a href={inviteLink}>{inviteLink}</a>
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
  )
}

const Manage = () => (
  <AdminGate title="Westeroz — Manage">
    <ManageInner />
  </AdminGate>
)

export default Manage
