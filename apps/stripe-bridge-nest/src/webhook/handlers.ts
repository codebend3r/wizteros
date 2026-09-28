import { Logger } from '@nestjs/common'
import { isoformat, isRow, type Row } from '@wizteros/server-common'
import { accessRestored, bannedCheckout, describeInvoice, paymentFailed, signup } from '@/alerts.js'
import { liveScope, mint, TierScopeEmpty } from '@/invites.js'
import { accessLine, liveSiblingCustomer, resolveUserIds } from '@/members.js'
import { eachInOrder } from '@/sequence.js'
import { PAYMENT_STATE_BY_STATUS } from '@/subscriptionStatus.js'
import { normalizeTier, staleRecordIds } from '@/tiers.js'
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

// Surrounding whitespace and one sign are fine; anything else throws, which is
// what a malformed ACCESS_DURATION should do.
const INTEGER = /^\s*[+-]?\d+\s*$/

/** ACCESS_DURATION as a whole number of days. */
export const accessDays = (settings: Settings): number => {
  if (!INTEGER.test(settings.accessDuration)) {
    throw new Error(`ACCESS_DURATION is not an integer: ${JSON.stringify(settings.accessDuration)}`)
  }
  return Number.parseInt(settings.accessDuration, 10)
}

/** `at` moved forward by a number of whole days. */
export const plusDays = ({ at, days }: { at: Date; days: number }): Date =>
  new Date(at.getTime() + days * 86_400_000)

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

/** Absolute expiry for a paid record: the update time plus ACCESS_DURATION. */
export const accessExpiryIso = (settings: Settings): string =>
  isoformat(plusDays({ at: new Date(), days: accessDays(settings) }))

/**
 * Every address belonging to the same person as `email`, lowercased.
 *
 * Links point payer -> Plex account, so the person is identified by the Plex
 * address: either this address pays for someone (follow the link) or it is
 * the account itself. Both directions matter, since a cancellation can land
 * on either half of the pair.
 */
export const linkedAddresses = ({
  bridge,
  email,
}: {
  bridge: Bridge
  email: string
}): ReadonlySet<string> => {
  const links = bridge.store.allMemberLinks()
  const lowered = email.toLowerCase()
  const owner = links.get(lowered) ?? lowered
  return new Set([
    owner,
    ...[...links].filter(([, plex]) => plex === owner).map(([payer]) => payer),
  ])
}

/**
 * Another address of the same person still carrying a live subscription.
 *
 * A member can hold two Stripe customers, and only one of them dying is the
 * normal way that ends. Records resolve by email, so the dead customer's
 * address is the same one the live member watches under: disabling on its
 * cancellation revokes access somebody is currently paying for.
 */
export const stillSubscribedElsewhere = ({
  bridge,
  email,
}: {
  bridge: Bridge
  email: string
}): string | null => {
  const rows = bridge.store.allCustomerRows()
  const lowered = email.toLowerCase()
  const others = [...linkedAddresses({ bridge, email })]
    .filter((address) => address !== lowered)
    .toSorted()
  return others.find((address) => rows.get(address)?.subscribed ?? false) ?? null
}

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
  tier: string
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

/** The link a member opens, on the public invite origin. */
const inviteUrl = ({ bridge, code }: { bridge: Bridge; code: string }): string =>
  `${bridge.settings.publicInviteBase}/j/${code}`

/** Tell the admin who just signed up, with the same link the member got. */
export const signupAlert = async ({
  bridge,
  email,
  tier,
  session,
  code,
}: {
  bridge: Bridge
  email: string
  tier: string
  session: StripeObject
  code: string
}): Promise<void> =>
  bridge.mailer.sendAlert(
    signup({
      email,
      tier,
      session,
      sessionId: truthyText({ obj: session, key: 'id' }),
      customerId: truthyText({ obj: session, key: 'customer' }),
      inviteUrl: inviteUrl({ bridge, code }),
    }),
  )

/** Tell the admin about one declined attempt; each is a day closer to a cancel. */
export const paymentFailedAlert = async ({
  bridge,
  email,
  invoice,
}: {
  bridge: Bridge
  email: string
  invoice: StripeObject
}): Promise<void> =>
  bridge.mailer.sendAlert(
    paymentFailed({
      email,
      invoice,
      access: await accessLine({
        bridge,
        customerId: truthyText({ obj: invoice, key: 'customer' }),
        email,
      }),
    }),
  )

/**
 * Re-invite a paid-up member who holds no Wizarr records; true when one was sent.
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
export const restoreAccess = async ({
  bridge,
  email,
  customerId,
  tier,
}: {
  bridge: Bridge
  email: string
  customerId: string | null
  tier: string | null
}): Promise<boolean> => {
  const resolved = normalizeTier(tier)
  const access = await resolveTierScope({
    bridge,
    tier: resolved,
    context: `access recovery for ${email}`,
  })
  const { code } = await mint({
    wizarr: bridge.wizarr,
    settings: bridge.settings,
    tier: resolved,
    scope: access,
  })
  if (customerId) {
    bridge.store.upsertPending({ customerId, email, inviteCode: code, tier: resolved })
  } else {
    bridge.store.upsertPendingByEmail({ email, inviteCode: code, tier: resolved })
  }
  await bridge.mailer.sendInvite({ to: email, inviteUrl: inviteUrl({ bridge, code }) })
  log.error(`payment for ${email} found no records; reissued ${resolved} invite ${code}`)
  bridge.store.recordEvent({
    email,
    action: 'Access restored',
    detail: `paid with no active records; ${resolved} invite reissued`,
  })
  await bridge.mailer.sendAlert(accessRestored({ email, tier: resolved }))
  return true
}

/** Mirror a Stripe subscription status onto the member's dunning flag. */
export const syncPaymentState = ({
  bridge,
  email,
  status,
}: {
  bridge: Bridge
  email: string | null
  status: string
}): void => {
  if (email && PAYMENT_STATE_BY_STATUS.has(status)) {
    bridge.store.setPaymentState({
      email,
      state: PAYMENT_STATE_BY_STATUS.get(status) ?? null,
    })
  }
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
  tier: string
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
  email,
  customerId,
  access,
}: {
  bridge: Bridge
  email: string
  customerId: string | null
  access: TierScope
}): Promise<void> => {
  // Existing access survives the invite window: redeeming re-scopes the
  // share in place on every covered server. Disable-first only when the
  // new tier leaves a current server uncovered (no per-server unshare),
  // or when the member is only findable via the invite-code fallback
  // (Plex email differs, so coverage can't be evaluated — fail closed).
  const records = await bridge.wizarr.findUsersByEmail(email)
  const existing =
    records.length > 0
      ? staleRecordIds({ records, coveredServers: access.server_names })
      : await resolveUserIds({ bridge, customerId, email })
  await eachInOrder({ items: existing, run: (userId) => bridge.wizarr.disableUser(userId) })
  if (existing.length > 0) {
    log.log(`reset ${existing.length} existing record(s) for ${email} pending re-join`)
  }
  // Covered records keep access without ever redeeming the new invite,
  // so the purchase itself must stamp the paid expiry — otherwise a
  // shorter pre-signup window (e.g. the 14-day Invited backfill) would
  // survive the checkout.
  const disabled: ReadonlySet<number> = new Set(existing)
  const surviving = records.map((record) => record.id).filter((id) => !disabled.has(id))
  const expires = accessExpiryIso(bridge.settings)
  await eachInOrder({
    items: surviving,
    run: (userId) => bridge.wizarr.setExpiry({ userId, expires }),
  })
  if (surviving.length > 0) {
    log.log(`stamped expiry ${expires} on ${surviving.length} surviving record(s) for ${email}`)
  }
}

/** Mint and mail the tier invite for a completed checkout, once per session. */
const onCheckoutCompleted: EventHandler = async ({ bridge, obj }) => {
  const email =
    truthyText({ obj: nested({ obj, key: 'customer_details' }), key: 'email' }) ??
    truthyText({ obj, key: 'customer_email' })
  const customerId = truthyText({ obj, key: 'customer' })
  const sessionId = truthyText({ obj, key: 'id' })
  if (!email) {
    log.warn(`no email on session ${sessionId ?? 'with no id'}`)
    return
  }
  const tier = normalizeTier(nested({ obj, key: 'metadata' }).tier)
  const tag = bridge.store.getMemberTag({ email })
  // A banned address can still reach a Payment Link. Nothing is issued
  // and nothing is recorded against the customer; the operator is told,
  // because the charge itself went through and is theirs to refund.
  if (tag === 'banned') {
    await blockBannedCheckout({
      bridge,
      email,
      tier,
      sessionId,
      customerId,
    })
    return
  }
  const access = await resolveTierScope({
    bridge,
    tier,
    context: `checkout ${sessionId ?? 'with no id'}`,
  })
  // Everything below the invite can throw (a slow Wizarr write, SMTP), and
  // a throw leaves the event unmarked so Stripe retries the whole handler.
  // The session -> invite binding is what stops that retry from minting a
  // second invite and mailing the member a second link.
  const issued = sessionId ? bridge.store.getSessionInvite({ sessionId }) : null
  const code = issued
    ? issued.invite_code
    : (await mint({ wizarr: bridge.wizarr, settings: bridge.settings, tier, scope: access })).code
  if (issued) {
    log.log(`checkout ${sessionId ?? 'with no id'} already has invite ${code}; reusing it`)
  } else if (sessionId) {
    bridge.store.recordSessionInvite({ sessionId, inviteCode: code })
  }
  bridge.store.transaction((store) => {
    if (customerId) {
      store.upsertPending({ customerId, email, inviteCode: code, tier })
    }
    // A completed checkout settles whatever failed on the previous cycle.
    store.setPaymentState({ email, state: null })
  })
  if (!(issued?.emailed ?? false)) {
    await bridge.mailer.sendInvite({ to: email, inviteUrl: inviteUrl({ bridge, code }) })
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
    await signupAlert({ bridge, email, tier, session: obj, code })
  }
  // VIP access is never time-boxed or reshuffled — a VIP's checkout is
  // just a contribution, so their records stay exactly as they are (no
  // disable, no expiry stamp).
  if (tag === 'vip') {
    log.log(`${email} is VIP — existing records left untouched`)
    return
  }
  await resetExistingRecords({ bridge, email, customerId, access })
}

/** Extend a renewal's access, or restore it when the payer holds no records. */
const onInvoicePaid: EventHandler = async ({ bridge, obj }) => {
  const customerId = requiredText({ obj, key: 'customer' })
  const email =
    truthyText({ obj, key: 'customer_email' }) ?? (await customerEmail({ bridge, customerId }))
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
  const tag = email ? bridge.store.getMemberTag({ email }) : null
  // A ban outranks a payment: nothing is extended and nothing restored.
  if (email && tag === 'banned') {
    log.warn(`renewal: ${email} is banned; access not extended`)
    bridge.store.recordEvent({
      email,
      action: 'Payment received',
      detail: 'banned; access not extended',
    })
    return
  }
  if (email) {
    bridge.store.setSubscribed({ email, value: true })
  }
  // VIP access is never time-boxed — acknowledge the payment, leave expiry alone.
  if (email && tag === 'vip') {
    log.log(`renewal: ${email} is VIP — expiry untouched`)
    bridge.store.recordEvent({
      email,
      action: 'Payment received',
      detail: 'VIP — expiry untouched',
    })
    return
  }
  const ids = await resolveUserIds({ bridge, customerId, email })
  const expires = accessExpiryIso(bridge.settings)
  await eachInOrder({ items: ids, run: (userId) => bridge.wizarr.setExpiry({ userId, expires }) })
  if (ids.length > 0) {
    log.log(`renewed ${ids.length} record(s) for ${email ?? customerId} (expires ${expires})`)
    if (email) {
      bridge.store.recordEvent({
        email,
        action: 'Payment received',
        detail: `access extended to ${expires.slice(0, 10)}`,
      })
    }
  } else if (email) {
    // Paid, but nothing to extend. Never leave this as a log line: the
    // member is locked out right now and only a new invite fixes it.
    const row = bridge.store.customerRow({ email })
    await restoreAccess({ bridge, email, customerId, tier: row ? row.tier : null })
  } else {
    log.warn(`renewal: no wizarr user for ${customerId}, which has no email`)
  }
}

/** Flag the payer as past due and alert; access is held while Stripe retries. */
const onPaymentFailed: EventHandler = async ({ bridge, obj }) => {
  // Stripe retries a failed charge for weeks before giving up. Access is
  // deliberately untouched for that whole window (they have paid for the
  // period they are in), but the admin UI stops calling them healthy, so
  // a member in dunning is visible before their window runs out.
  const customerId = truthyText({ obj, key: 'customer' })
  const email =
    truthyText({ obj, key: 'customer_email' }) ?? (await customerEmail({ bridge, customerId }))
  if (!email) {
    log.warn(`payment failed for ${customerId ?? 'no customer'} with no resolvable email`)
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
  await paymentFailedAlert({ bridge, email, invoice: obj })
}

/** Mirror the subscription's new status onto the member's dunning flag. */
const onSubscriptionUpdated: EventHandler = async ({ bridge, obj }) => {
  const customerId = truthyText({ obj, key: 'customer' })
  const status = truthyText({ obj, key: 'status' }) ?? ''
  const mapping = customerId ? bridge.store.getMapping({ customerId }) : null
  const email =
    (mapping?.email ?? null) || (customerId ? await customerEmail({ bridge, customerId }) : null)
  syncPaymentState({ bridge, email, status })
  log.log(`subscription for ${email ?? customerId ?? 'no customer'} is ${status}`)
}

/** Disable the member's records, unless somebody still pays for them. */
const onSubscriptionDeleted: EventHandler = async ({ bridge, obj }) => {
  const customerId = requiredText({ obj, key: 'customer' })
  const mapping = bridge.store.getMapping({ customerId })
  const email = (mapping?.email ?? null) || (await customerEmail({ bridge, customerId }))
  // This customer really did stop, but the person behind it may not
  // have: a second customer at the same address (they re-checked out
  // from scratch), or a linked second address (they pay under another
  // email). subscribed and payment_state are per email, so they only
  // move when nothing of theirs at this address still pays.
  const sibling = email
    ? await liveSiblingCustomer({ bridge, email, deadCustomer: customerId })
    : null
  if (email && sibling) {
    bridge.store.setPaymentState({ email, state: null })
  } else if (email) {
    bridge.store.setSubscribed({ email, value: false })
  }
  // A VIP's access is a standing grant, not something the subscription
  // buys. The renewal handler already leaves their expiry alone and the
  // sweep skips them; disabling them here undid both.
  if (email && bridge.store.getMemberTag({ email }) === 'vip') {
    log.log(`cancel: ${email} is VIP; access left alone`)
    bridge.store.recordEvent({
      email,
      action: 'Canceled',
      detail: 'subscription ended; access kept, VIP',
    })
    return
  }
  const paying = sibling || (email ? stillSubscribedElsewhere({ bridge, email }) : null)
  if (paying) {
    log.log(`cancel: ${email ?? customerId} still pays under ${paying}; access left alone`)
    if (email) {
      bridge.store.recordEvent({
        email,
        action: 'Canceled',
        detail: `subscription ended; access kept, still paying under ${paying}`,
      })
    }
    return
  }
  const ids = await resolveUserIds({ bridge, customerId, email })
  await eachInOrder({ items: ids, run: (userId) => bridge.wizarr.disableUser(userId) })
  if (ids.length > 0) {
    log.log(`disabled ${ids.length} record(s) for ${email ?? customerId}`)
  } else {
    log.log(`cancel: no wizarr user for ${customerId} / ${email ?? 'no email'}`)
  }
  if (email) {
    bridge.store.recordEvent({
      email,
      action: 'Canceled',
      detail: `subscription ended — ${ids.length} server record(s) disabled`,
    })
  }
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
