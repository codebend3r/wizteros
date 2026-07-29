import type { Member, PaidTier } from '@/lib/adminApi'
import { ACCESS_DAYS, INVITE_LINK_DAYS, TIER_DOWNLOADS, TIER_LABELS } from '@/lib/inviteRules'
import { TierIcon } from '@/components/TierIcon/TierIcon'
import { ConfirmActionModal } from '@/components/ConfirmActionModal/ConfirmActionModal'
import styles from '@/components/ConfirmInviteModal/ConfirmInviteModal.module.scss'

type ConfirmInviteModalProps = {
  member: Member
  tier: PaidTier
  sending: boolean
  onConfirm: () => void
  onCancel: () => void
}

export const ConfirmInviteModal = ({
  member,
  tier,
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
      <dt>Member</dt>
      <dd>{member.member}</dd>
      <dt>Email</dt>
      <dd>{member.email}</dd>
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
    <p className={styles.note}>
      A fresh {TIER_LABELS[tier]}-scoped invite link is generated and any existing server records
      for this email are disabled — they re-join through the new link.
    </p>
  </ConfirmActionModal>
)
