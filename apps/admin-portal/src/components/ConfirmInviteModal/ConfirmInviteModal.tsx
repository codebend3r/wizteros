import type { PaidTier } from '@/lib/adminApi'
import { ACCESS_DAYS, INVITE_LINK_DAYS, TIER_DOWNLOADS, TIER_LABELS } from '@/lib/inviteRules'
import { TierIcon } from '@/components/TierIcon/TierIcon'
import { ConfirmActionModal } from '@/components/ConfirmActionModal/ConfirmActionModal'
import styles from '@/components/ConfirmInviteModal/ConfirmInviteModal.module.scss'

type ConfirmInviteModalProps = {
  /** Left out for an address that is not a member yet and so has no name. */
  name?: string
  email: string
  tier: PaidTier
  /** What this particular invite does, which differs by where it is sent from. */
  note: string
  sending: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** The note for re-inviting someone the bridge already knows. */
export const reissueInviteNote = ({ tier }: { tier: PaidTier }): string =>
  `A fresh ${TIER_LABELS[tier]}-scoped invite link is generated and any existing server records for this email are disabled — they re-join through the new link.`

export const ConfirmInviteModal = ({
  name,
  email,
  tier,
  note,
  sending,
  onConfirm,
  onCancel,
}: ConfirmInviteModalProps) => (
  <ConfirmActionModal
    title="Confirm invite"
    confirmLabel="Send invite"
    busy={sending}
    busyLabel="Sending…"
    onConfirm={onConfirm}
    onCancel={onCancel}
  >
    <dl className={styles.details}>
      {!!name && (
        <>
          <dt>Member</dt>
          <dd>{name}</dd>
        </>
      )}
      <dt>Email</dt>
      <dd>{email}</dd>
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
    <p className={styles.note}>{note}</p>
  </ConfirmActionModal>
)
