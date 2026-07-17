import { useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import AdminGate, { useAdminAuth } from '@/components/AdminGate/AdminGate'
import Preloader from '@/components/Preloader/Preloader'
import TierIcon from '@/components/TierIcon/TierIcon'
import { AdminAuthError, fetchMember, type Member } from '@/lib/adminApi'
import { isPaidTier, TIER_LABELS } from '@/lib/inviteRules'
import { deriveStatus } from '@/lib/memberStatus'
import { MEMBERS_QUERY_KEY } from '@/pages/Manage/Manage'
import styles from '@/pages/User/User.module.scss'

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
  return downloads ? 'Included' : 'Not included'
}

const UserInner = () => {
  const { password, deauthenticate } = useAdminAuth()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const email = searchParams.get('email') ?? ''

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

  useEffect(() => {
    if (loadError instanceof AdminAuthError) {
      deauthenticate()
    }
  }, [loadError, deauthenticate])

  const error = !!loadError && !(loadError instanceof AdminAuthError)

  return (
    <main className={styles.page}>
      <Link className={styles.back} to="/manage">
        ← All members
      </Link>
      <h1 className={styles.title}>{member?.member ?? (email !== '' ? email : 'Member')}</h1>
      {!email && <p className={styles.notice}>No email provided.</p>}
      {error && <p className={styles.error}>Could not load member.</p>}
      {!!email && isPending && !error && (
        <Preloader message="Loading member… (this can take ~15s)" />
      )}
      {member === null && <p className={styles.notice}>No member found for {email}.</p>}
      {!!member && (
        <dl className={styles.details}>
          <dt>Member</dt>
          <dd>{member.member}</dd>
          <dt>Email</dt>
          <dd>{member.email}</dd>
          <dt>Status</dt>
          <dd>
            {isPaidTier(member.tier) && <TierIcon tier={member.tier} />} {deriveStatus({ member })}
          </dd>
          <dt>Tier</dt>
          <dd className={styles.tier}>
            {isPaidTier(member.tier) && <TierIcon tier={member.tier} />}{' '}
            {isPaidTier(member.tier) ? TIER_LABELS[member.tier] : member.tier}
          </dd>
          <dt>Downloads</dt>
          <dd>{formatDownloads(member.downloads)}</dd>
          <dt>Expiry</dt>
          <dd>{formatExpiry(member.expires)}</dd>
          <dt>Servers</dt>
          <dd>{member.servers.length ? member.servers.join(', ') : '—'}</dd>
        </dl>
      )}
    </main>
  )
}

const User = () => (
  <AdminGate title="Westeroz — Member">
    <UserInner />
  </AdminGate>
)

export default User
