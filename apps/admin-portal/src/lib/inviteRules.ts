import type { Member, PaidTier } from '@/lib/adminApi'
import { DAY_MS } from '@/lib/dates'
import type { MemberStatus } from '@/lib/memberStatus'

export const PAID_TIERS: ReadonlyArray<PaidTier> = ['bronze', 'silver', 'gold', 'youth']

export const TIER_LABELS: Record<PaidTier, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  youth: 'Youth',
}

// Mirrors the bridge's tiers.TIER_DOWNLOADS — downloads are a tier perk.
export const TIER_DOWNLOADS: Record<PaidTier, boolean> = {
  bronze: false,
  silver: false,
  gold: true,
  youth: true,
}

// Mirrors the bridge's INVITE_EXPIRES_DAYS / ACCESS_DURATION env config.
export const INVITE_LINK_DAYS = 14
export const ACCESS_DAYS = 35

// How long an unredeemed invite reads as "Invited" before it ages into
// "Declined Invite". Matches INVITE_LINK_DAYS so the status flips right as
// the link itself stops working.
export const INVITE_GRACE_DAYS = 14

// The invite link stops working INVITE_LINK_DAYS after it was sent, which is
// also when the status ages from Invited into Declined Invite.
export const inviteWindowEnd = ({ invitedAt }: { invitedAt: Date }): Date =>
  new Date(invitedAt.getTime() + INVITE_LINK_DAYS * DAY_MS)

export const isPaidTier = (value: unknown): value is PaidTier =>
  typeof value === 'string' && PAID_TIERS.some((tier) => tier === value)

// A member already holding access gets "Re-invite"; one in dunning still holds
// theirs, so the failed charge must not relabel their action button.
const HOLDS_ACCESS: ReadonlySet<MemberStatus> = new Set<MemberStatus>([
  'Subscribed Monthly',
  'Payment Failed',
])

/** What the invite control reads for a member in this state. */
export const inviteActionLabel = ({ status }: { status: MemberStatus }): 'Invite' | 'Re-invite' =>
  HOLDS_ACCESS.has(status) ? 'Re-invite' : 'Invite'

/**
 * The row an address becomes the moment its first invite is sent: everything
 * the tier already decides, and nothing the member has done yet. It stands in
 * until the bridge's own record of them arrives.
 */
export const pendingMember = ({ email, tier }: { email: string; tier: PaidTier }): Member => ({
  member: email.split('@')[0] ?? email,
  email,
  tier,
  downloads: TIER_DOWNLOADS[tier],
  expires: null,
  servers: [],
  libraries: {},
  entitled: {},
  subscribed: false,
  payment_state: null,
  invited_at: new Date().toISOString(),
  tag: null,
  customer_id: null,
  stripe_email: null,
})
