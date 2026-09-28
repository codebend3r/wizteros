// What a Stripe subscription status means for payment_state. A status absent
// here (canceled, incomplete, paused) says nothing about the flag: the end of
// a subscription belongs to the cancel handler.
export const PAYMENT_STATE_BY_STATUS: ReadonlyMap<string, string | null> = new Map([
  ['active', null],
  ['trialing', null],
  ['past_due', 'past_due'],
  ['unpaid', 'past_due'],
])
