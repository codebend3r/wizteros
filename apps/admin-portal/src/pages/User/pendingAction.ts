import type { PaidTier } from '@/lib/adminApi'

/**
 * The one action waiting on a confirmation.
 *
 * Every control on the member page stages one of these instead of owning its
 * own boolean, so two confirmations can never be open at once and the modal
 * has a single thing to render.
 */
export type PendingAction =
  | { kind: 'invite'; tier: PaidTier }
  | { kind: 'hardReset'; tier: PaidTier }
  | { kind: 'expiry'; expiresAt: string }
  | { kind: 'neverExpire' }
  | { kind: 'cancelSub' }
  | { kind: 'ban' }
  | { kind: 'downloads'; allow: boolean }

/** The call each confirmed action makes. */
export type MemberActionRunners = {
  invite: (input: { tier: PaidTier }) => void
  hardReset: (input: { tier: PaidTier }) => void
  expiry: (input: { expiresAt: string }) => void
  neverExpire: () => void
  cancelSub: () => void
  ban: () => void
  downloads: (input: { allow: boolean }) => void
}
