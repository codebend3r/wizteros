import type { Member } from '@/lib/adminApi'

export type MemberStatus = 'Uninvited' | 'Invited' | 'Subscribed Monthly' | 'VIP' | 'Expired Member'

/**
 * Derive a member's lifecycle status from the bridge's member record.
 *
 * - Expired Member: their access expiry is in the past
 * - Subscribed Monthly: active access with an expiry (paying member)
 * - Invited: known to the bridge but not on any server yet (unredeemed invite)
 * - Uninvited: legacy Plex share that never went through the Stripe flow
 * - VIP: never derived yet — reserved for a manual designation, defined later
 */
export const deriveStatus = ({ member }: { member: Member }): MemberStatus => {
  const expiresAt = member.expires ? new Date(member.expires).getTime() : null
  if (expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt < Date.now()) {
    return 'Expired Member'
  }
  if (member.subscribed) {
    return 'Subscribed Monthly'
  }
  if (!member.servers.length) {
    return 'Invited'
  }
  return 'Uninvited'
}
