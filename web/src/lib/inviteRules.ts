import type { PaidTier } from '@/lib/adminApi'

export const PAID_TIERS: ReadonlyArray<PaidTier> = ['bronze', 'silver', 'gold', 'kids']

export const TIER_LABELS: Record<PaidTier, string> = {
  bronze: 'Bronze',
  silver: 'Silver',
  gold: 'Gold',
  kids: 'Youth',
}

// Mirrors the bridge's tiers.TIER_DOWNLOADS — downloads are a tier perk.
export const TIER_DOWNLOADS: Record<PaidTier, boolean> = {
  bronze: false,
  silver: false,
  gold: true,
  kids: true,
}

// Mirrors the bridge's INVITE_EXPIRES_DAYS / ACCESS_DURATION env config.
export const INVITE_LINK_DAYS = 7
export const ACCESS_DAYS = 35

export const isPaidTier = (value: unknown): value is PaidTier =>
  typeof value === 'string' && PAID_TIERS.some((tier) => tier === value)
