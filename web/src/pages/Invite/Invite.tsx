import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import AdminGate, { useAdminAuth } from '@/components/AdminGate/AdminGate'
import AdminLayout from '@/components/AdminLayout/AdminLayout'
import ConfirmActionModal from '@/components/ConfirmActionModal/ConfirmActionModal'
import TierIcon from '@/components/TierIcon/TierIcon'
import {
  AdminAuthError,
  fetchMembers,
  reissueInvite,
  type InviteResult,
  type Member,
  type PaidTier,
} from '@/lib/adminApi'
import {
  ACCESS_DAYS,
  INVITE_LINK_DAYS,
  isPaidTier,
  PAID_TIERS,
  TIER_DOWNLOADS,
  TIER_LABELS,
} from '@/lib/inviteRules'
import { MEMBERS_QUERY_KEY } from '@/pages/Manage/Manage'
import styles from '@/pages/Invite/Invite.module.scss'

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/

const TIER_SUMMARY: Record<PaidTier, string> = {
  bronze: 'Everything except 4K · no downloads',
  silver: 'Everything · no downloads',
  gold: 'Everything · downloads included',
  youth: 'Youth-safe libraries only · downloads included',
}

type PendingSend = {
  email: string
  tier: PaidTier
}

const InviteInner = () => {
  const { password, deauthenticate } = useAdminAuth()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [tier, setTier] = useState<PaidTier | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)
  const [sentEmail, setSentEmail] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [blockedMember, setBlockedMember] = useState<Member | null>(null)

  const trimmedEmail = email.trim()
  const emailValid = EMAIL_RE.test(trimmedEmail)

  const {
    data: members,
    error: loadError,
    isPending: membersPending,
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

  const inviteMutation = useMutation({
    mutationFn: ({ email: to, tier: paid }: PendingSend) =>
      reissueInvite({ email: to, tier: paid, password }),
    onSuccess: (result, { email: to, tier: paid }) => {
      setInviteResult(result)
      setSentEmail(to)
      const pendingRow: Member = {
        member: to.split('@')[0] ?? to,
        email: to,
        tier: paid,
        downloads: TIER_DOWNLOADS[paid],
        expires: null,
        servers: [],
        libraries: {},
        subscribed: false,
        invited_at: new Date().toISOString(),
      }
      queryClient.setQueryData<Member[]>(MEMBERS_QUERY_KEY, (old) => {
        if (!old) {
          return old
        }
        const exists = old.some((row) => row.email.toLowerCase() === to.toLowerCase())
        return exists
          ? old.map((row) => (row.email.toLowerCase() === to.toLowerCase() ? pendingRow : row))
          : [...old, pendingRow]
      })
      setEmail('')
      setTier(null)
      setConfirming(false)
    },
    onError: (cause) => {
      setConfirming(false)
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not create invite.')
    },
  })

  const handleSend = () => {
    setActionError(null)
    setInviteResult(null)
    if (!tier || !emailValid) {
      return
    }
    const match = (members ?? []).find(
      (row) => row.email.toLowerCase() === trimmedEmail.toLowerCase(),
    )
    if (match) {
      setBlockedMember(match)
      return
    }
    setBlockedMember(null)
    setConfirming(true)
  }

  return (
    <AdminLayout>
      <main className={styles.page}>
        <Link className={styles.back} to="/manage">
          ← All members
        </Link>
        <h1 className={styles.title}>Invite someone</h1>
        {!!actionError && <p className={styles.error}>{actionError}</p>}
        {!!inviteResult && !!sentEmail && (
          <p className={styles.resultNotice}>
            {inviteResult.emailed
              ? 'Invite emailed. Link: '
              : 'Email failed — send this link manually: '}
            <a href={inviteResult.url}>{inviteResult.url}</a>{' '}
            <Link className={styles.viewMember} to={`/user?email=${encodeURIComponent(sentEmail)}`}>
              View member
            </Link>
          </p>
        )}
        {!!blockedMember && (
          <p className={styles.blockedNotice}>
            {blockedMember.email} is already a member
            {isPaidTier(blockedMember.tier) && ` (${TIER_LABELS[blockedMember.tier]})`}. Use
            Re-invite instead.{' '}
            <Link
              className={styles.viewMember}
              to={`/user?email=${encodeURIComponent(blockedMember.email)}`}
            >
              Go to member
            </Link>
          </p>
        )}
        <div className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="invite-email">
              Email address
            </label>
            <input
              id="invite-email"
              className={styles.emailInput}
              type="email"
              placeholder="name@example.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                setActionError(null)
                setBlockedMember(null)
                setInviteResult(null)
                setSentEmail(null)
              }}
            />
          </div>
          <fieldset className={styles.tierFieldset}>
            <legend className={styles.label}>Tier</legend>
            <div className={styles.tierGrid}>
              {PAID_TIERS.map((paid) => (
                <label
                  key={paid}
                  className={`${styles.tierCard} ${tier === paid ? styles.tierCardSelected : ''}`}
                >
                  <input
                    className={styles.tierCardInput}
                    type="radio"
                    name="tier"
                    value={paid}
                    checked={tier === paid}
                    onChange={() => setTier(paid)}
                  />
                  <span className={styles.tierCardLabel}>
                    <TierIcon tier={paid} /> {TIER_LABELS[paid]}
                  </span>
                  <span className={styles.tierCardSummary}>{TIER_SUMMARY[paid]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button
            className={styles.send}
            type="button"
            onClick={handleSend}
            disabled={!emailValid || !tier || membersPending || inviteMutation.isPending}
          >
            {membersPending
              ? 'Checking members…'
              : inviteMutation.isPending
                ? 'Sending…'
                : 'Send invite'}
          </button>
        </div>
        {confirming && !!tier && (
          <ConfirmActionModal
            title="Confirm invite"
            confirmLabel="Send invite"
            busy={inviteMutation.isPending}
            busyLabel="Sending…"
            onConfirm={() => inviteMutation.mutate({ email: trimmedEmail, tier })}
            onCancel={() => setConfirming(false)}
          >
            <dl className={styles.confirmDetails}>
              <dt>Email</dt>
              <dd>{trimmedEmail}</dd>
              <dt>Tier</dt>
              <dd>
                <TierIcon tier={tier} /> {TIER_LABELS[tier]}
              </dd>
              <dt>Downloads</dt>
              <dd>{TIER_DOWNLOADS[tier] ? 'Included' : 'Not included'}</dd>
              <dt>Access</dt>
              <dd>{ACCESS_DAYS} days per billing cycle</dd>
              <dt>Link valid for</dt>
              <dd>{INVITE_LINK_DAYS} days</dd>
            </dl>
            <p className={styles.confirmNote}>
              A fresh {TIER_LABELS[tier]}-scoped invite link is generated and emailed to{' '}
              {trimmedEmail}. They join by opening the link and signing in with their Plex account.
            </p>
          </ConfirmActionModal>
        )}
      </main>
    </AdminLayout>
  )
}

const Invite = () => (
  <AdminGate title="Westeroz — Invite">
    <InviteInner />
  </AdminGate>
)

export default Invite
