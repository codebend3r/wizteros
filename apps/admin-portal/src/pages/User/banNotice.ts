import type { BanResult } from '@wizteros/wire'

/** Revocation succeeded even when billing still needs the operator's attention. */
export const formatBanNotice = (result: BanResult): string => {
  const records = `${result.disabled} server record${result.disabled === 1 ? '' : 's'} disabled`
  const stops = result.cancel_at
    ? `billing stops ${new Date(result.cancel_at).toLocaleDateString()}.`
    : 'cancellation scheduled.'
  const messages: Record<BanResult['billing_status'], string> = {
    scheduled: stops,
    already_scheduled: `cancellation was already scheduled; ${stops}`,
    absent: 'no subscription to cancel.',
    failed: 'billing cancellation failed; check Stripe and cancel manually.',
    partial: 'some billing cancellations failed; check remaining subscriptions in Stripe.',
  }
  return `Banned. ${records}; ${messages[result.billing_status]}`
}
