import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AdminGate } from '@/components/AdminGate/AdminGate'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { ConfirmInviteModal } from '@/components/ConfirmInviteModal/ConfirmInviteModal'
import { InviteResultNotice } from '@/components/InviteResultNotice/InviteResultNotice'
import { TierIcon } from '@/components/TierIcon/TierIcon'
import { reissueInvite, type InviteResult, type Member, type PaidTier } from '@/lib/adminApi'
import { isEmailAddress } from '@/lib/emails'
import { isPaidTier, PAID_TIERS, pendingMember, TIER_LABELS } from '@/lib/inviteRules'
import { membersQueryOptions, patchMember } from '@/lib/memberQueries'
import styles from '@/pages/Invite/Invite.module.scss'

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
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [tier, setTier] = useState<PaidTier | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)
  const [sentEmail, setSentEmail] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [blockedMember, setBlockedMember] = useState<Member | null>(null)

  const trimmedEmail = email.trim()
  const emailValid = isEmailAddress(trimmedEmail)

  const { data: members, isPending: membersPending } = useQuery(membersQueryOptions())

  const inviteMutation = useMutation({
    mutationFn: ({ email: to, tier: paid }: PendingSend) =>
      reissueInvite({ email: to, tier: paid }),
    onSuccess: (result, { email: to, tier: paid }) => {
      setInviteResult(result)
      setSentEmail(to)
      const pendingRow = pendingMember({ email: to, tier: paid })
      patchMember({ queryClient, email: to, patch: () => pendingRow, insert: pendingRow })
      setEmail('')
      setTier(null)
      setConfirming(false)
    },
    onError: () => {
      setConfirming(false)
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
          <InviteResultNotice result={inviteResult}>
            <Link className={styles.viewMember} to={`/user?email=${encodeURIComponent(sentEmail)}`}>
              View member
            </Link>
          </InviteResultNotice>
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
          <ConfirmInviteModal
            email={trimmedEmail}
            tier={tier}
            note={`A fresh ${TIER_LABELS[tier]}-scoped invite link is generated and emailed to ${trimmedEmail}. They join by opening the link and signing in with their Plex account.`}
            sending={inviteMutation.isPending}
            onConfirm={() => inviteMutation.mutate({ email: trimmedEmail, tier })}
            onCancel={() => setConfirming(false)}
          />
        )}
      </main>
    </AdminLayout>
  )
}

export const Invite = () => (
  <AdminGate title="Westeroz — Invite">
    <InviteInner />
  </AdminGate>
)
