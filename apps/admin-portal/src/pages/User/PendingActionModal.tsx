import type { ReactNode } from 'react'
import { ConfirmActionModal } from '@/components/ConfirmActionModal/ConfirmActionModal'
import {
  ConfirmInviteModal,
  reissueInviteNote,
} from '@/components/ConfirmInviteModal/ConfirmInviteModal'
import { TierIcon } from '@/components/TierIcon/TierIcon'
import type { Member } from '@/lib/adminApi'
import { TIER_LABELS } from '@/lib/inviteRules'
import type { MemberActionRunners, PendingAction } from '@/pages/User/pendingAction'
import styles from '@/pages/User/PendingActionModal.module.scss'

type PendingActionModalProps = {
  member: Member
  pending: PendingAction
  actions: MemberActionRunners
  /** True while the invite call is in flight, the one action that waits. */
  sending: boolean
  onClose: () => void
}

type Confirmation = {
  title: string
  confirmLabel: string
  body: ReactNode
  run: () => void
}

/**
 * The title, button, copy, and call that make up one confirmation.
 *
 * `invite` is not here: it confirms through ConfirmInviteModal, which shows
 * the whole invite rather than a sentence.
 */
const confirmationFor = ({
  member,
  pending,
  actions,
}: {
  member: Member
  pending: Exclude<PendingAction, { kind: 'invite' }>
  actions: MemberActionRunners
}): Confirmation => {
  if (pending.kind === 'hardReset') {
    return {
      title: 'Confirm tier reset',
      confirmLabel: 'Hard reset',
      run: () => actions.hardReset({ tier: pending.tier }),
      body: (
        <>
          <p>
            Hard reset {member.member} ({member.email}) to <TierIcon tier={pending.tier} />{' '}
            {TIER_LABELS[pending.tier]}.
          </p>
          <p className={styles.hint}>
            Rewrites the recorded tier instantly — no new invite is sent and Plex access is
            unchanged.
          </p>
        </>
      ),
    }
  }
  if (pending.kind === 'expiry') {
    return {
      title: 'Confirm expiry change',
      confirmLabel: 'Set expiry',
      run: () => actions.expiry({ expiresAt: pending.expiresAt }),
      body: (
        <>
          <p>
            Set the expiry for {member.member} ({member.email}) to{' '}
            {new Date(pending.expiresAt).toLocaleString()}.
          </p>
          <p className={styles.hint}>Applies to every server record for this email.</p>
        </>
      ),
    }
  }
  if (pending.kind === 'downloads') {
    return {
      title: 'Confirm downloads change',
      confirmLabel: pending.allow ? 'Turn on downloads' : 'Turn off downloads',
      run: () => actions.downloads({ allow: pending.allow }),
      body: (
        <>
          <p>
            Turn downloads {pending.allow ? 'on' : 'off'} for {member.member} ({member.email}).
          </p>
          <p className={styles.hint}>
            The record updates immediately; the Plex-side permission applies with the member's next
            reissued invite.
          </p>
        </>
      ),
    }
  }
  if (pending.kind === 'neverExpire') {
    return {
      title: 'Confirm never expire',
      confirmLabel: 'Never expire',
      run: () => actions.neverExpire(),
      body: (
        <>
          <p>
            Set {member.member} ({member.email}) to never expire.
          </p>
          <p className={styles.hint}>
            Clears the expiry on every server record for this email — access stays on until you
            change it again.
          </p>
        </>
      ),
    }
  }
  if (pending.kind === 'cancelSub') {
    return {
      title: 'Confirm subscription cancellation',
      confirmLabel: 'Cancel subscription',
      run: () => actions.cancelSub(),
      body: (
        <>
          <p>
            Cancel the Stripe subscription for {member.member} ({member.email}).
          </p>
          <p className={styles.hint}>
            They keep access until the end of the period they already contributed for; the bridge
            shuts them off automatically when it ends.
          </p>
        </>
      ),
    }
  }
  return {
    title: 'Confirm ban',
    confirmLabel: 'Ban member',
    run: () => actions.ban(),
    body: (
      <>
        <p>
          Ban {member.member} ({member.email}).
        </p>
        <p className={styles.hint}>
          Every server record is disabled the moment you confirm, and their Stripe subscription is
          flagged to cancel at the end of the period. Any refund is made in Stripe.
        </p>
      </>
    ),
  }
}

/**
 * The member page's one confirmation dialog, rendering whichever action is
 * staged. Everything but an invite closes the moment it is confirmed; an
 * invite stays up until the bridge answers, because its result is the link.
 */
export const PendingActionModal = ({
  member,
  pending,
  actions,
  sending,
  onClose,
}: PendingActionModalProps) => {
  if (pending.kind === 'invite') {
    return (
      <ConfirmInviteModal
        name={member.member}
        email={member.email}
        tier={pending.tier}
        note={reissueInviteNote({ tier: pending.tier })}
        sending={sending}
        onConfirm={() => actions.invite({ tier: pending.tier })}
        onCancel={onClose}
      />
    )
  }
  const { title, confirmLabel, body, run } = confirmationFor({ member, pending, actions })
  return (
    <ConfirmActionModal
      title={title}
      confirmLabel={confirmLabel}
      onConfirm={() => {
        run()
        onClose()
      }}
      onCancel={onClose}
    >
      {body}
    </ConfirmActionModal>
  )
}
