import { Logger } from '@nestjs/common'
import { addDays, isoformat, isRow, type Row } from '@wizteros/server-common'
import {
  accessRestored,
  bannedCheckout,
  describeInvoice,
  duplicateNotRetired,
  paymentFailed,
  signup,
} from '@/alerts.js'
import { retireDuplicates } from '@/duplicates.js'
import { issueInvite, liveScope, rescopeRecords, TierScopeEmpty } from '@/invites.js'
import type { Identity, IdentitySnapshot } from '@/identity.js'
import {
  accessLine,
  identitySnapshot,
  liveSiblingCustomer,
  resolveIdentity,
  standingOf,
  stillSubscribedElsewhere,
} from '@/members.js'
import { eachInOrder } from '@/sequence.js'
import { holdsStandingGrant, isBanned } from '@/standing.js'
import { statusRule } from '@/subscriptionStatus.js'
import { normalizeTier, type Tier } from '@/tiers.js'
import type { Bridge, Settings, TierScope } from '@/types.js'

// Stripe events in, Wizarr and store changes out: checkout -> invite,
// renewal -> extend, dunning -> flag, cancel -> disable.
//
// Events arrive as the parsed JSON Stripe signed, so every field is read
// through the small typed readers below rather than trusted. An empty string
// counts as absent, the same as a missing key.

const log = new Logger('bridge')

/** One Stripe object (an event, a session, an invoice, a subscription) as parsed JSON. */
export type StripeObject = Row

/** A handler for one event type, handed the event's `data.object`. */
export type EventHandler = (args: { bridge: Bridge; obj: StripeObject }) => Promise<void>

/** A field that is a non-empty string, or null. */
const truthyText = ({ obj, key }: { obj: StripeObject; key: string }): string | null => {
  const value = obj[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** A nested object, or an empty one when absent or not an object. */
const nested = ({ obj, key }: { obj: StripeObject; key: string }): StripeObject => {
  const value = obj[key]
  return isRow(value) ? value : {}
}

/**
 * A field the handler cannot act without. Throwing leaves the event unmarked,
 * so Stripe redelivers it rather than the bridge acting for nobody.
 */
const requiredText = ({ obj, key }: { obj: StripeObject; key: string }): string => {
  const value = obj[key]
  if (typeof value !== 'string') {
    throw new TypeError(`the Stripe object carries no ${key}: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Email on the Stripe customer record, or null if they have none on file.
 *
 * A missing customer id throws, so the event is left unmarked rather than
 * acted on with no one to act for.
 */
export const customerEmail = async ({
  bridge,
  customerId,
}: {
  bridge: Bridge
  customerId: string | null
}): Promise<string | null> => {
  if (!customerId) {
    throw new Error('the event names no customer to look an email up for')
  }
  return bridge.stripe.customerEmail(customerId)
}

/**
 * The address a Stripe object is about.
 *
 * Its own email first (a session's customer_details, an invoice's
 * customer_email), then the address the bridge recorded for the customer,
 * and only then a round trip to Stripe's customer record. Null when none of
 * them has one, or when there is no customer to ask about.
 */
const payerEmail = async ({
  bridge,
  obj,
  customerId,
}: {
  bridge: Bridge
  obj: StripeObject
  customerId: string | null
}): Promise<string | null> => {
  const own =
    truthyText({ obj: nested({ obj, key: 'customer_details' }), key: 'email' }) ??
    truthyText({ obj, key: 'customer_email' })
  if (own || !customerId) {
    return own
  }
  return (
    (bridge.store.getMapping({ customerId })?.email ?? null) ||
    (await customerEmail({ bridge, customerId }))
  )
}

/** Absolute expiry for a paid record: the update time plus the access window. */
const accessExpiryIso = (settings: Settings): string =>
  isoformat(addDays({ at: new Date(), days: settings.accessDays }))

/**
 * The tier's live library scope, or throw so the delivery is retried.
 *
 * An empty scope means the tier's library names no longer match anything on
 * the server (a rename, a disabled library). Issuing the invite anyway would
 * hand the member an invite that grants nothing, so the handler throws and
 * leaves the Stripe event unmarked for redelivery. The log line is what says
 * a webhook was abandoned on purpose, which is why it lives here rather than
 * in invites, whose other callers do not retry.
 */
export const resolveTierScope = async ({
  bridge,
  tier,
  context,
}: {
  bridge: Bridge
  tier: Tier
  context: string
}): Promise<TierScope> => {
  try {
    return await liveScope({ wizarr: bridge.wizarr, plex: bridge.plex, tier, context })
  } catch (error) {
    if (error instanceof TierScopeEmpty) {
      log.error(`no libraries resolved for ${tier} tier ${context}; aborting for retry`)
    }
    throw error
  }
}

/**
 * Re-invite a paid-up member who holds no Wizarr records.
 *
 * A payment landing on a member with nothing to extend is the shape of the
 * worst failure this bridge has: they are paid, they are locked out, and the
 * only trace used to be one WARNING line nobody reads. Their records can be
 * gone because a lapsed window expired them out while an earlier invoice sat
 * unpaid, or because the payment arrived on a second Stripe customer whose
 * email never had records of its own. Either way the remedy is the same one
 * an admin would press by hand (issue a tier-scoped invite and mail it), so
 * the bridge does it itself and tells the operator it happened.
 */
const restoreAccess = async ({
  bridge,
  email,
  customerId,
  tier,
}: {
  bridge: Bridge
  email: string
  customerId: string | null
  tier: Tier | null
}): Promise<void> => {
  // Stripe metadata is the only tier normalized from free text; a member the
  // bridge holds no known tier for is restored at the entry tier.
  if (tier === null) {
    log.warn(`no known tier recorded for ${email}; restoring access at bronze`)
  }
  const resolved = tier ?? 'bronze'
  const scope = await resolveTierScope({
    bridge,
    tier: resolved,
    context: `access recovery for ${email}`,
  })
  const { code, url } = await issueInvite({ bridge, email, tier: resolved, scope, customerId })
  await bridge.mailer.sendInvite({ to: email, inviteUrl: url })
  log.error(`payment for ${email} found no records; reissued ${resolved} invite ${code}`)
  bridge.store.recordEvent({
    email,
    action: 'Access restored',
    detail: `paid with no active records; ${resolved} invite reissued`,
  })
  await bridge.mailer.sendAlert(accessRestored({ email, tier: resolved }))
}

/** Record and alert on a banned member's checkout; no invite, no access. */
const blockBannedCheckout = async ({
  bridge,
  email,
  tier,
  sessionId,
  customerId,
}: {
  bridge: Bridge
  email: string
  tier: Tier
  sessionId: string | null
  customerId: string | null
}): Promise<void> => {
  log.error(`checkout ${sessionId ?? 'with no id'} by banned member ${email}; no invite issued`)
  bridge.store.recordEvent({
    email,
    action: 'Checkout blocked',
    detail: `banned member paid for ${tier}; no invite issued`,
  })
  await bridge.mailer.sendAlert(bannedCheckout({ email, tier, sessionId, customerId }))
}

/** Disable the records the new tier no longer covers and re-stamp the rest. */
const resetExistingRecords = async ({
  bridge,
  snapshot,
  email,
  customerId,
  access,
}: {
  bridge: Bridge
  snapshot: IdentitySnapshot
  email: string
  customerId: string | null
  access: TierScope
}): Promise<void> => {
  // Coverage can only be judged for records under the member's own address;
  // found any other way (Plex email differs), the reset fails closed.
  const identity = resolveIdentity({ bridge, snapshot, customerId, email })
  const { disabled, surviving } = await rescopeRecords({
    wizarr: bridge.wizarr,
    records: identity.records,
    coveredServers: access.server_names,
    evaluable: identity.via === 'email',
  })
  if (disabled.length > 0) {
    log.log(`reset ${disabled.length} existing record(s) for ${email} pending re-join`)
  }
  // Covered records keep access without ever redeeming the new invite,
  // so the purchase itself must stamp the paid expiry — otherwise a
  // shorter pre-signup window (e.g. the 14-day Invited backfill) would
  // survive the checkout.
  const expires = accessExpiryIso(bridge.settings)
  await eachInOrder({
    items: surviving,
    run: (record) => bridge.wizarr.setExpiry({ userId: record.id, expires }),
  })
  if (surviving.length > 0) {
    log.log(`stamped expiry ${expires} on ${surviving.length} surviving record(s) for ${email}`)
  }
}

/** Stamp the paid expiry on every record the person holds: the ids stamped, and the expiry. */
const renewRecords = async ({
  bridge,
  identity,
  who,
}: {
  bridge: Bridge
  identity: Identity
  who: string
}): Promise<{ ids: number[]; expires: string }> => {
  const ids = identity.records.map((record) => record.id)
  const expires = accessExpiryIso(bridge.settings)
  await eachInOrder({ items: ids, run: (userId) => bridge.wizarr.setExpiry({ userId, expires }) })
  if (ids.length > 0) {
    log.log(`renewed ${ids.length} record(s) for ${who} (expires ${expires})`)
  }
  return { ids, expires }
}

/** Disable every record the person holds; how many there were. */
const disableRecords = async ({
  bridge,
  identity,
  customerId,
  email,
}: {
  bridge: Bridge
  identity: Identity
  customerId: string
  email: string | null
}): Promise<number> => {
  const ids = identity.records.map((record) => record.id)
  await eachInOrder({ items: ids, run: (userId) => bridge.wizarr.disableUser(userId) })
  if (ids.length > 0) {
    log.log(`disabled ${ids.length} record(s) for ${email ?? customerId}`)
  } else {
    log.log(`cancel: no wizarr user for ${customerId} / ${email ?? 'no email'}`)
  }
  return ids.length
}

/** Who a customer is, read from a fresh snapshot, with the snapshot it came from. */
const resolveLive = async ({
  bridge,
  customerId,
  email,
}: {
  bridge: Bridge
  customerId: string | null
  email: string | null
}): Promise<{ snapshot: IdentitySnapshot; identity: Identity }> => {
  const snapshot = await identitySnapshot(bridge)
  return { snapshot, identity: resolveIdentity({ bridge, snapshot, customerId, email }) }
}

/** Mint and mail the tier invite for a completed checkout, once per session. */
const onCheckoutCompleted: EventHandler = async ({ bridge, obj }) => {
  const customerId = truthyText({ obj, key: 'customer' })
  const sessionId = truthyText({ obj, key: 'id' })
  // Only the session's own address: a checkout that names nobody is not
  // looked up, since there is no one it can be said to have paid for.
  const email = await payerEmail({ bridge, obj, customerId: null })
  if (!email) {
    log.warn(`no email on session ${sessionId ?? 'with no id'}`)
    return
  }
  const tier = normalizeTier(nested({ obj, key: 'metadata' }).tier)
  // Read before anything is minted or stored: the tag governing the person is
  // the strongest across every address of theirs, and the one the payer's
  // earlier invite was redeemed under is usually the one an admin tagged.
  // Finding that address needs Wizarr's users list, so the invite now waits
  // on it (~15s), and a Wizarr outage leaves the event for Stripe to retry
  // rather than mailing an invite a ban might have stopped.
  const { snapshot, identity } = await resolveLive({ bridge, customerId, email })
  const tag = standingOf({ bridge, identity })
  // A banned person can still reach a Payment Link. Nothing is issued
  // and nothing is recorded against the customer; the operator is told,
  // because the charge itself went through and is theirs to refund.
  if (isBanned(tag)) {
    await blockBannedCheckout({ bridge, email, tier, sessionId, customerId })
    return
  }
  const access = await resolveTierScope({
    bridge,
    tier,
    context: `checkout ${sessionId ?? 'with no id'}`,
  })
  // A Stripe retry of this session gets back the invite already minted.
  const { url, emailed } = await issueInvite({
    bridge,
    email,
    tier,
    scope: access,
    customerId,
    sessionId,
    settlesPayment: true,
  })
  if (!emailed) {
    await bridge.mailer.sendInvite({ to: email, inviteUrl: url })
    log.log(`sent invite to ${email}`)
    if (sessionId) {
      bridge.store.markSessionInviteEmailed({ sessionId })
    }
    bridge.store.recordEvent({
      email,
      action: 'Signed up',
      detail: `${tier} tier — invite emailed`,
    })
    // Inside the once-per-checkout branch on purpose: a Stripe retry of
    // a session whose invite already went out must not mail twice.
    await bridge.mailer.sendAlert(
      signup({ email, tier, session: obj, sessionId, customerId, inviteUrl: url }),
    )
  }
  // A member whose card failed often checks out again instead of fixing it,
  // and the old subscription keeps retrying. The row above maps this
  // customer to the address, which is what keeps the cancel's own webhook
  // from disabling the access they just paid for. The invite is out by
  // now, so a Stripe failure is told to the admin, not thrown for a retry.
  if (customerId) {
    const { status } = await retireDuplicates({ bridge, email, payingUnder: customerId })
    if (status === 'failed') {
      await bridge.mailer.sendAlert(duplicateNotRetired({ email, payingUnder: customerId }))
    }
  }
  // VIP access is never time-boxed or reshuffled — a VIP's checkout is
  // just a contribution, so their records stay exactly as they are (no
  // disable, no expiry stamp).
  if (holdsStandingGrant(tag)) {
    log.log(`${email} is VIP — existing records left untouched`)
    return
  }
  await resetExistingRecords({ bridge, snapshot, email, customerId, access })
}

/** Extend a renewal's access, or restore it when the payer holds no records. */
const onInvoicePaid: EventHandler = async ({ bridge, obj }) => {
  const customerId = requiredText({ obj, key: 'customer' })
  const email = await payerEmail({ bridge, obj, customerId })
  // A paid invoice settles any dunning, including the signup one that is
  // otherwise skipped below. A retry that finally succeeds is exactly
  // the case this flag exists to close out.
  if (email) {
    bridge.store.setPaymentState({ email, state: null })
  }
  if (obj.billing_reason === 'subscription_create') {
    log.log(`skipping first (signup) invoice for ${customerId}`)
    return
  }
  if (!email) {
    // Nobody to record the payment against; the records the customer's
    // invite resolves to still get their window.
    const { identity } = await resolveLive({ bridge, customerId, email: null })
    const { ids } = await renewRecords({ bridge, identity, who: customerId })
    if (ids.length === 0) {
      log.warn(`renewal: no wizarr user for ${customerId}, which has no email`)
    }
    return
  }
  const { identity } = await resolveLive({ bridge, customerId, email })
  const tag = standingOf({ bridge, identity })
  // A ban outranks a payment: nothing is extended and nothing restored.
  if (isBanned(tag)) {
    log.warn(`renewal: ${email} is banned; access not extended`)
    bridge.store.recordEvent({
      email,
      action: 'Payment received',
      detail: 'banned; access not extended',
    })
    return
  }
  bridge.store.setSubscribed({ email, value: true })
  // VIP access is never time-boxed — acknowledge the payment, leave expiry alone.
  if (holdsStandingGrant(tag)) {
    log.log(`renewal: ${email} is VIP — expiry untouched`)
    bridge.store.recordEvent({
      email,
      action: 'Payment received',
      detail: 'VIP — expiry untouched',
    })
    return
  }
  const { ids, expires } = await renewRecords({ bridge, identity, who: email })
  if (ids.length > 0) {
    bridge.store.recordEvent({
      email,
      action: 'Payment received',
      detail: `access extended to ${expires.slice(0, 10)}`,
    })
    return
  }
  // Paid, but nothing to extend. Never leave this as a log line: the
  // member is locked out right now and only a new invite fixes it.
  const row = bridge.store.customerRow({ email })
  await restoreAccess({ bridge, email, customerId, tier: row?.tier ?? null })
}

/**
 * Flag the payer as past due, alert, and point the member at the card; access
 * is held while Stripe retries. A charge on a duplicate of a customer that is
 * already paying is cancelled instead, before its retry can succeed.
 */
const onPaymentFailed: EventHandler = async ({ bridge, obj }) => {
  // Stripe retries a failed charge for weeks before giving up. Access is
  // deliberately untouched for that whole window (they have paid for the
  // period they are in), but the admin UI stops calling them healthy, so
  // a member in dunning is visible before their window runs out.
  const customerId = truthyText({ obj, key: 'customer' })
  const email = await payerEmail({ bridge, obj, customerId })
  if (!email) {
    log.warn(`payment failed for ${customerId ?? 'no customer'} with no resolvable email`)
    return
  }
  // The checkout retires duplicates, so this only catches one it missed
  // (Stripe was down then, or the sibling predates this bridge).
  const payingUnder = customerId
    ? await liveSiblingCustomer({ bridge, email, deadCustomer: customerId })
    : null
  // They are paying, so this charge is a duplicate: neither the dunning flag
  // nor the member mail applies, and anything short of retiring it is a
  // double charge for the admin to stop.
  if (payingUnder) {
    const { status } = await retireDuplicates({ bridge, email, payingUnder })
    if (status !== 'retired') {
      await bridge.mailer.sendAlert(duplicateNotRetired({ email, payingUnder, invoice: obj }))
    }
    return
  }
  bridge.store.setPaymentState({ email, state: 'past_due' })
  log.warn(
    `payment failed for ${email} (invoice ${truthyText({ obj, key: 'id' }) ?? 'with no id'})`,
  )
  bridge.store.recordEvent({
    email,
    action: 'Payment failed',
    detail: `Stripe charge declined; access held while it retries (${describeInvoice(obj)})`,
  })
  // Each declined attempt is a day closer to a cancel, so the admin hears
  // about every one.
  await bridge.mailer.sendAlert(
    paymentFailed({ email, invoice: obj, access: await accessLine({ bridge, customerId, email }) }),
  )
  // Told nothing, a member whose card failed tends to sign up again, which
  // is how one person ends up with two subscriptions.
  if (bridge.settings.billingPortalUrl) {
    await bridge.mailer.sendPaymentFailed({
      to: email,
      portalUrl: bridge.settings.billingPortalUrl,
    })
  }
}

/** Mirror the subscription's new status onto the member's dunning flag. */
const onSubscriptionUpdated: EventHandler = async ({ bridge, obj }) => {
  const customerId = truthyText({ obj, key: 'customer' })
  const status = truthyText({ obj, key: 'status' }) ?? ''
  const email = await payerEmail({ bridge, obj, customerId })
  const rule = statusRule(status)
  if (email && rule !== undefined) {
    bridge.store.setPaymentState({ email, state: rule.paymentState })
  }
  log.log(`subscription for ${email ?? customerId ?? 'no customer'} is ${status}`)
}

/** Disable the member's records, unless somebody still pays for them. */
const onSubscriptionDeleted: EventHandler = async ({ bridge, obj }) => {
  const customerId = requiredText({ obj, key: 'customer' })
  const email = await payerEmail({ bridge, obj, customerId })
  if (!email) {
    // Nobody to record the cancellation against; the records the customer's
    // invite resolves to are still disabled.
    const { identity } = await resolveLive({ bridge, customerId, email: null })
    await disableRecords({ bridge, identity, customerId, email: null })
    return
  }
  // This customer really did stop, but the person behind it may not
  // have: a second customer at the same address (they re-checked out
  // from scratch), or a linked second address (they pay under another
  // email). subscribed and payment_state are per email, so they only
  // move when nothing of theirs at this address still pays.
  const sibling = await liveSiblingCustomer({ bridge, email, deadCustomer: customerId })
  if (sibling) {
    bridge.store.setPaymentState({ email, state: null })
  } else {
    bridge.store.setSubscribed({ email, value: false })
  }
  // A VIP's access is a standing grant, not something the subscription
  // buys. The renewal handler already leaves their expiry alone and the
  // sweep skips them; disabling them here undid both.
  const { identity } = await resolveLive({ bridge, customerId, email })
  if (holdsStandingGrant(standingOf({ bridge, identity }))) {
    log.log(`cancel: ${email} is VIP; access left alone`)
    bridge.store.recordEvent({
      email,
      action: 'Canceled',
      detail: 'subscription ended; access kept, VIP',
    })
    return
  }
  const paying = sibling || stillSubscribedElsewhere({ bridge, email, identity })
  if (paying) {
    log.log(`cancel: ${email} still pays under ${paying}; access left alone`)
    bridge.store.recordEvent({
      email,
      action: 'Canceled',
      detail: `subscription ended; access kept, still paying under ${paying}`,
    })
    return
  }
  const disabled = await disableRecords({ bridge, identity, customerId, email })
  bridge.store.recordEvent({
    email,
    action: 'Canceled',
    detail: `subscription ended — ${disabled} server record(s) disabled`,
  })
}

// Every event type the bridge acts on. A type missing from the table falls
// through handleEvent untouched and is still marked processed, so Stripe
// stops redelivering it.
export const HANDLERS: ReadonlyMap<string, EventHandler> = new Map([
  ['checkout.session.completed', onCheckoutCompleted],
  ['invoice.paid', onInvoicePaid],
  ['invoice.payment_failed', onPaymentFailed],
  ['customer.subscription.updated', onSubscriptionUpdated],
  ['customer.subscription.deleted', onSubscriptionDeleted],
])

/** A key the event envelope must carry; a missing one fails the delivery for a retry. */
const envelopeField = ({ value, key }: { value: unknown; key: string }): unknown => {
  if (!isRow(value) || !(key in value)) {
    throw new TypeError(`the Stripe event carries no ${key}`)
  }
  return value[key]
}

/**
 * Act on one Stripe event: checkout -> invite, renewal -> extend, cancel -> disable.
 *
 * Duplicate deliveries (Stripe retries) are dropped via the processed_events
 * table. The event is only marked processed after the type-specific handling
 * below completes without throwing, so a crash mid-handler (e.g. Wizarr
 * unreachable, no libraries resolved) leaves the event unmarked and Stripe's
 * retry reprocesses it instead of the signup being silently lost.
 */
export const handleEvent = async ({
  bridge,
  event,
}: {
  bridge: Bridge
  event: unknown
}): Promise<void> => {
  const eventId = isRow(event) ? truthyText({ obj: event, key: 'id' }) : null
  if (eventId && bridge.store.isEventProcessed({ eventId })) {
    log.log(`skipping already-processed event ${eventId}`)
    return
  }

  const type = envelopeField({ value: event, key: 'type' })
  const obj = envelopeField({ value: envelopeField({ value: event, key: 'data' }), key: 'object' })
  log.log(`stripe event: ${String(type)}`)

  const handler = typeof type === 'string' ? HANDLERS.get(type) : undefined
  if (handler) {
    if (!isRow(obj)) {
      throw new TypeError(`${type} carries no object: ${JSON.stringify(obj)}`)
    }
    await handler({ bridge, obj })
  }

  if (eventId) {
    bridge.store.markEventProcessed({ eventId })
  }
}
