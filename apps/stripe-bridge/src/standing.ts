// A member's standing: the manual tag an admin puts on them, and what that tag
// changes about how the bridge treats them. Every rule a tag carries is
// answered here, so a handler asks what a tag means instead of which tag it is.

/** The manual designations an admin can give a member. */
export type MemberTag = 'vip' | 'hvu' | 'banned'

export const MEMBER_TAGS: readonly MemberTag[] = ['vip', 'hvu', 'banned']

export const isMemberTag = (value: unknown): value is MemberTag =>
  MEMBER_TAGS.some((tag) => tag === value)

/**
 * Whether the member is banned: the bridge refuses to invite, extend or
 * restore them, whatever Stripe says about them.
 */
export const isBanned = (tag: MemberTag | null): boolean => tag === 'banned'

/**
 * Whether the member's access is a standing grant rather than something a
 * subscription buys: a checkout leaves their records alone, a renewal leaves
 * their expiry alone, and a cancellation leaves their access alone.
 */
export const holdsStandingGrant = (tag: MemberTag | null): boolean => tag === 'vip'

/** Whether the expiry sweep may time-box the member's records. */
export const isTimeBoxed = (tag: MemberTag | null): boolean =>
  !isBanned(tag) && !holdsStandingGrant(tag)
