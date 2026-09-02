import type { Member } from '@/lib/adminApi'
import { INVITE_GRACE_DAYS } from '@/lib/inviteRules'

export type MemberStatus =
  | 'Uninvited'
  | 'Invited'
  | 'Declined Invite'
  | 'Subscribed Monthly'
  | 'Payment Failed'
  | 'VIP'
  | 'Expired Member'

const GRACE_MS = INVITE_GRACE_DAYS * 24 * 60 * 60 * 1000

// Status is always emoji plus text, never colour or emoji alone; shared by
// the members table, the member page, and the design reference.
export const STATUS_EMOJI: Record<MemberStatus, string> = {
  'Subscribed Monthly': '🟢',
  'Payment Failed': '🟠',
  'Expired Member': '🔴',
  Invited: '✉️',
  'Declined Invite': '🚫',
  Uninvited: '⚪',
  VIP: '💎',
}

/**
 * Derive a member's lifecycle status from the bridge's member record.
 *
 * - VIP: the admin's manual tag — overrides every derived status. VIP members
 *   keep access with no expiry and are never subject to the invite lifecycle.
 * - Payment Failed: Stripe has a declined charge outstanding. Ranked above
 *   Subscribed Monthly because it is the same member, in trouble: they keep
 *   access while Stripe retries, but showing them as healthy is what let a
 *   member's window lapse with nobody watching.
 * - Subscribed Monthly / Expired Member: gated on `subscribed`, the bridge's
 *   confirmed-payment flag — NOT the presence of an expiry. This lets a member
 *   carry an expiry (a manual access deadline) without reading as a subscriber.
 * - Invited: an outstanding invite still inside the grace period — whether the
 *   member has no access yet, or holds a legacy share while an invite is out.
 * - Declined Invite: the invite sat unredeemed past the grace period.
 * - Uninvited: known to the bridge but with no confirmed payment and no invite.
 *
 * The `hvu` tag is a purely administrative label and does not affect status.
 */
export const deriveStatus = ({ member }: { member: Member }): MemberStatus => {
  if (member.tag === 'vip') {
    return 'VIP'
  }
  const expiresAt = member.expires ? new Date(member.expires).getTime() : null
  const isExpired = expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt < Date.now()
  if (member.payment_state === 'past_due' && !isExpired) {
    return 'Payment Failed'
  }
  if (member.subscribed) {
    return isExpired ? 'Expired Member' : 'Subscribed Monthly'
  }
  const invitedAt = member.invited_at ? new Date(member.invited_at).getTime() : null
  const hasInviteStamp = invitedAt !== null && !Number.isNaN(invitedAt)
  if (hasInviteStamp) {
    return Date.now() - invitedAt > GRACE_MS ? 'Declined Invite' : 'Invited'
  }
  return 'Uninvited'
}
