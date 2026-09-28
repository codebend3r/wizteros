import type { Alert } from '@/types.js'

// Every operational alert the bridge mails an admin, as a subject and a body.
//
// One file so the whole operator-facing voice can be read, and audited for the
// server-cost framing, in one pass instead of being found inline in a webhook
// handler, a recovery path and two sweeps.
//
// Nothing here sends anything: each builder returns the alert its caller hands
// to the mailer. That keeps the send where the caller's own logging and error
// handling already are.

/** Stripe's minor-unit integer as '8.00 CAD'; 'unknown amount' when absent. */
export const money = ({ amount, currency }: { amount: unknown; currency: unknown }): string => {
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    return 'unknown amount'
  }
  const code = typeof currency === 'string' ? currency.toUpperCase() : ''
  return `${(amount / 100).toFixed(2)} ${code}`.trim()
}

/** One line of what Stripe knows about a failed invoice, for an alert body. */
export const describeInvoice = (invoice: Readonly<Record<string, unknown>>): string => {
  const amount = money({ amount: invoice.amount_due, currency: invoice.currency })
  const attempts = typeof invoice.attempt_count === 'number' ? invoice.attempt_count : 0
  const retry = invoice.next_payment_attempt
  const when =
    typeof retry === 'number' && retry !== 0
      ? new Date(retry * 1000).toISOString().slice(0, 10)
      : 'none scheduled; Stripe has given up on this invoice'
  const id = typeof invoice.id === 'string' ? invoice.id : 'with no id'
  return `${amount}, attempt ${attempts}, next retry ${when} (invoice ${id})`
}

/** Tell the admin who just signed up, with the same link the member got. */
export const signup = ({
  email,
  tier,
  session,
  sessionId,
  customerId,
  inviteUrl,
}: {
  email: string
  tier: string
  session: Readonly<Record<string, unknown>>
  sessionId: string | null
  customerId: string | null
  inviteUrl: string
}): Alert => ({
  subject: `${email} signed up for ${tier}`,
  body:
    `${email} completed a ${tier} checkout for ` +
    `${money({ amount: session.amount_total, currency: session.currency })}.\n\n` +
    `  session  ${sessionId ?? 'none'}\n` +
    `  customer ${customerId ?? 'none'}\n` +
    `  invite   ${inviteUrl}\n\n` +
    `The invite link has been emailed to them; they hold no new access ` +
    `until they open it.\n`,
})

/** Tell the admin about one declined attempt; each is a day closer to a cancel. */
export const paymentFailed = ({
  email,
  invoice,
  access,
}: {
  email: string
  invoice: Readonly<Record<string, unknown>>
  access: string
}): Alert => ({
  subject: `${email} missed a payment`,
  body:
    `Stripe could not charge ${email}.\n\n` +
    `  ${describeInvoice(invoice)}\n\n` +
    `${access}\n\n` +
    `Access is not changed by a failed charge. If the retries all fail, ` +
    `Stripe cancels the subscription and the bridge disables them then.\n`,
})

/** Tell the admin a banned address paid; the charge is theirs to refund. */
export const bannedCheckout = ({
  email,
  tier,
  sessionId,
  customerId,
}: {
  email: string
  tier: string
  sessionId: string | null
  customerId: string | null
}): Alert => ({
  subject: `banned member ${email} checked out`,
  body:
    `${email} is banned but completed a ${tier} checkout ` +
    `(session ${sessionId ?? 'none'}, customer ${customerId ?? 'none'}).\n\n` +
    `No invite was issued and no access was granted. Refund or ` +
    `cancel the subscription in Stripe.\n`,
})

/** Tell the admin a payment landed on a member holding nothing, and what was done. */
export const accessRestored = ({ email, tier }: { email: string; tier: string }): Alert => ({
  subject: `reissued access for ${email}`,
  body:
    `${email} paid but held no Wizarr records, so the bridge issued a fresh ` +
    `${tier} invite and emailed it.\n\n` +
    `They are locked out until they open that link. If they were paying under ` +
    `a second Stripe customer or a different Plex address, reconcile the two ` +
    `before the next renewal.\n`,
})

/** One member the dunning sweep newly found past due, and whether they can still watch. */
export type DunningFinding = Readonly<{ email: string; status: string; line: string }>

/** One mail for every member the sweep newly found past due. */
export const dunningSweep = (found: readonly DunningFinding[]): Alert => ({
  subject: `${found.length} member(s) missed a payment`,
  body:
    `Stripe has these members in dunning, and no payment_failed webhook ever ` +
    `reached the bridge for them:\n\n` +
    `${found.map(({ email, status, line }) => `- ${email}: subscription ${status}. ${line}`).join('\n')}\n\n` +
    `Nothing was changed except the admin UI now reads them as Payment Failed. ` +
    `Check the card on file with them before Stripe's last retry cancels the ` +
    `subscription.\n`,
})

/** Tell the admin which standing grants currently grant nothing. */
export const vipsWithoutAccess = (stranded: readonly string[]): Alert => ({
  subject: `${stranded.length} VIP(s) hold no server access`,
  body:
    `These VIP members have no Wizarr record on any server:\n\n` +
    `${stranded.map((email) => `- ${email}`).join('\n')}\n\n` +
    `VIP access is meant to be permanent. Either they never redeemed ` +
    `their invite, or something disabled them.\n`,
})

/** Tell the admin which tiers no longer resolve against the live libraries. */
export const tierScopes = (problems: Readonly<Record<string, string>>): Alert => ({
  subject: `${Object.keys(problems).length} invite scope problem(s)`,
  body:
    `Invites no longer line up with the live library list:\n\n` +
    `${Object.entries(problems)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tier, reason]) => `- ${tier}: ${reason}`)
      .join('\n')}\n\n` +
    `Members cannot sign up cleanly until the names line up again.\n`,
})
