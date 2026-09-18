import type { PaidTier } from '@/lib/adminApi'
import { DAY_MS } from '@/lib/dates'

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
