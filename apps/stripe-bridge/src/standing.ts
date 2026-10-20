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

// How strongly each tag speaks, when one person carries several across their
// addresses: a ban outranks everything, and a standing grant outranks the
// purely informational hvu label.
const TAG_STRENGTH: Readonly<Record<MemberTag, number>> = { banned: 3, vip: 2, hvu: 1 }

/**
 * The tag that governs a person tagged under several addresses, or null when
 * none of them is tagged.
 *
 * An admin tags whichever address the members list showed them, usually the
 * Plex account, while the webhooks arrive under the address Stripe bills. A
 * tag on any of the person's addresses therefore applies to all of them, and
 * the strongest one wins.
 */
export const strongestTag = (tags: readonly (MemberTag | null)[]): MemberTag | null =>
  tags.reduce<MemberTag | null>(
    (strongest, tag) =>
      tag !== null && (strongest === null || TAG_STRENGTH[tag] > TAG_STRENGTH[strongest])
        ? tag
        : strongest,
    null,
  )

/** The tag that governs a person: the strongest one tagged under any of their addresses. */
export const strongestAcross = ({
  tags,
  addresses,
}: {
  tags: ReadonlyMap<string, MemberTag>
  addresses: Iterable<string>
}): MemberTag | null => strongestTag([...addresses].map((address) => tags.get(address) ?? null))
