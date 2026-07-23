import type { Member } from '@/lib/adminApi'
import { INVITE_GRACE_DAYS } from '@/lib/inviteRules'

export type MemberStatus =
  | 'Uninvited'
  | 'Invited'
  | 'Declined Invite'
  | 'Subscribed Monthly'
  | 'VIP'
  | 'HVU'
  | 'Expired Member'

const GRACE_MS = INVITE_GRACE_DAYS * 24 * 60 * 60 * 1000

/**
 * Derive a member's lifecycle status from the bridge's member record.
 *
 * - VIP / HVU (High-Volume User): the admin's manual tag — overrides every
 *   derived status
 * - Expired Member: their access expiry is in the past
 * - Subscribed Monthly: active access with an expiry (paying member)
 * - Invited: unredeemed invite still inside the grace period — whether the
 *   member has no access yet, or holds a legacy share while an invite is out
 * - Declined Invite: the invite sat unredeemed past the grace period
 * - Uninvited: legacy Plex share that never went through the Stripe flow
 */
export const deriveStatus = ({ member }: { member: Member }): MemberStatus => {
  if (member.tag === 'vip') {
    return 'VIP'
  }
  if (member.tag === 'hvu') {
    return 'HVU'
  }
  const expiresAt = member.expires ? new Date(member.expires).getTime() : null
  if (expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt < Date.now()) {
    return 'Expired Member'
  }
  if (member.subscribed) {
    return 'Subscribed Monthly'
  }
  const invitedAt = member.invited_at ? new Date(member.invited_at).getTime() : null
  const hasInviteStamp = invitedAt !== null && !Number.isNaN(invitedAt)
  if (!member.servers.length || hasInviteStamp) {
    if (hasInviteStamp && Date.now() - invitedAt > GRACE_MS) {
      return 'Declined Invite'
    }
    return 'Invited'
  }
  return 'Uninvited'
}
