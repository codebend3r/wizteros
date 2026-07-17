import { useEffect } from 'react'
import type { Member, PaidTier } from '@/lib/adminApi'
import { ACCESS_DAYS, INVITE_LINK_DAYS, TIER_DOWNLOADS, TIER_LABELS } from '@/lib/inviteRules'
import TierIcon from '@/components/TierIcon/TierIcon'
import styles from '@/components/ConfirmInviteModal/ConfirmInviteModal.module.scss'

type ConfirmInviteModalProps = {
  member: Member
  tier: PaidTier
  sending: boolean
  onConfirm: () => void
  onCancel: () => void
}

const ConfirmInviteModal = ({
  member,
  tier,
  sending,
  onConfirm,
  onCancel,
}: ConfirmInviteModalProps) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !sending) {
        onCancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel, sending])

  return (
    <div className={styles.overlay} onClick={() => !sending && onCancel()}>
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-invite-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className={styles.title} id="confirm-invite-title">
          Confirm invite
        </h2>
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
          A fresh {TIER_LABELS[tier]}-scoped invite link is generated and any existing server
          records for this email are disabled — they re-join through the new link.
        </p>
        <div className={styles.actions}>
          <button className={styles.cancel} type="button" onClick={onCancel} disabled={sending}>
            Cancel
          </button>
          <button className={styles.confirm} type="button" onClick={onConfirm} disabled={sending}>
            {sending ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      </section>
    </div>
  )
}

export default ConfirmInviteModal
