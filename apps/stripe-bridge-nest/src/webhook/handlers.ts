import { Logger } from '@nestjs/common'
import { isoformat, isRow, type Row } from '@wizteros/server-common'
import { accessRestored, bannedCheckout, describeInvoice, paymentFailed, signup } from '@/alerts.js'
import { liveScope, mint, TierScopeEmpty } from '@/invites.js'
import { accessLine, liveSiblingCustomer, resolveUserIds } from '@/members.js'
import { eachInOrder } from '@/sequence.js'
import {
  allCustomerRows,
  allMemberLinks,
  customerRow,
  getMapping,
  getMemberTag,
  getSessionInvite,
  isEventProcessed,
  markEventProcessed,
  markSessionInviteEmailed,
  PAYMENT_STATE_BY_STATUS,
  recordEvent,
  recordSessionInvite,
  setPaymentState,
  setSubscribed,
  upsertPending,
  upsertPendingByEmail,
} from '@/store.js'
import { normalizeTier, staleRecordIds } from '@/tiers.js'
import type { Bridge, Settings, TierScope } from '@/types.js'

// Stripe events in, Wizarr and store changes out: checkout -> invite,
// renewal -> extend, dunning -> flag, cancel -> disable.
//
// Events arrive as the parsed JSON Stripe signed, so every field is read
// through the small typed readers below rather than trusted. Python's
// truthiness is kept exactly: an empty string is as absent as a missing key,
// which is what `obj.get(...) or ...` meant there.

const log = new Logger('bridge')

/** One Stripe object (an event, a session, an invoice, a subscription) as parsed JSON. */
export type StripeObject = Row

/** A handler for one event type, handed the event's `data.object`. */
export type EventHandler = (args: { bridge: Bridge; obj: StripeObject }) => Promise<void>

/** A field that is a non-empty string, or null: the value Python's `or` would keep. */
const truthyText = ({ obj, key }: { obj: StripeObject; key: string }): string | null => {
  const value = obj[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** A nested object, or an empty one when absent or falsy: Python's `obj.get(key) or {}`. */
const nested = ({ obj, key }: { obj: StripeObject; key: string }): StripeObject => {
  const value = obj[key]
  return isRow(value) ? value : {}
}

/**
 * A field Python read as `obj[key]`: a missing key raised KeyError, which left
 * the event unmarked for Stripe to retry. Throws the same way here.
 */
const requiredText = ({ obj, key }: { obj: StripeObject; key: string }): string => {
  if (!(key in obj)) {
    throw new Error(`KeyError: '${key}'`)
  }
  const value = obj[key]
  if (typeof value !== 'string') {
    throw new TypeError(`${key} is not a string: ${JSON.stringify(value)}`)
  }
  return value
}

/** What Python's `%s` printed for a value: `None` for null. */
const shown = (value: unknown): string =>
  value === null || value === undefined ? 'None' : String(value)

// Python's int(): surrounding whitespace and one sign are fine, anything else
// raises, which is what a malformed ACCESS_DURATION should do.
const INTEGER = /^\s*[+-]?\d+\s*$/

/** ACCESS_DURATION as a whole number of days, as Python's `int(ACCESS_DURATION)`. */
export const accessDays = (settings: Settings): number => {
  if (!INTEGER.test(settings.accessDuration)) {
    throw new Error(`ACCESS_DURATION is not an integer: ${JSON.stringify(settings.accessDuration)}`)
  }
  return Number.parseInt(settings.accessDuration, 10)
}

/** `at` moved forward by a number of whole days: `at + timedelta(days=days)`. */
export const plusDays = ({ at, days }: { at: Date; days: number }): Date =>
  new Date(at.getTime() + days * 86_400_000)

/**
 * Email on the Stripe customer record, or null if they have none on file.
 *
 * A missing customer id throws, as `stripe.Customer.retrieve(None)` did, so
 * the event is left unmarked rather than acted on with no one to act for.
 */
export const customerEmail = async ({
  bridge,
  customerId,
}: {
  bridge: Bridge
  customerId: string | null
}): Promise<string | null> => {
  if (!customerId) {
    throw new Error(
      'Could not determine which URL to request: Customer instance has invalid ID: None',
    )
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
  dbPath,
  email,
}: {
  dbPath: string
  email: string
}): ReadonlySet<string> => {
  const links = allMemberLinks({ path: dbPath })
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
  dbPath,
  email,
}: {
  dbPath: string
  email: string
}): string | null => {
  const rows = allCustomerRows({ path: dbPath })
  const lowered = email.toLowerCase()
  const others = [...linkedAddresses({ dbPath, email })]
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
  bridge.mailer.sendAlert(signup({ email, tier, session, inviteUrl: inviteUrl({ bridge, code }) }))

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
        wizarr: bridge.wizarr,
        dbPath: bridge.dbPath,
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
    upsertPending({ path: bridge.dbPath, customerId, email, inviteCode: code, tier: resolved })
  } else {
    upsertPendingByEmail({ path: bridge.dbPath, email, inviteCode: code, tier: resolved })
  }
  await bridge.mailer.sendInvite({ to: email, inviteUrl: inviteUrl({ bridge, code }) })
  log.error(`payment for ${email} found no records; reissued ${resolved} invite ${code}`)
  recordEvent({
    path: bridge.dbPath,
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
    setPaymentState({
      path: bridge.dbPath,
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
  sessionId: unknown
  customerId: unknown
}): Promise<void> => {
  log.error(`checkout ${shown(sessionId)} by banned member ${email}; no invite issued`)
  recordEvent({
    path: bridge.dbPath,
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
      : await resolveUserIds({ wizarr: bridge.wizarr, dbPath: bridge.dbPath, customerId, email })
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
  if (!email) {
    log.warn(`no email on session ${shown(obj.id)}`)
    return
  }
  const sessionId = truthyText({ obj, key: 'id' })
  const tier = normalizeTier(nested({ obj, key: 'metadata' }).tier)
  const tag = getMemberTag({ path: bridge.dbPath, email })
  // A banned address can still reach a Payment Link. Nothing is issued
  // and nothing is recorded against the customer; the operator is told,
  // because the charge itself went through and is theirs to refund.
  if (tag === 'banned') {
    await blockBannedCheckout({
      bridge,
      email,
      tier,
      sessionId: obj.id,
      customerId: obj.customer,
    })
    return
  }
  const access = await resolveTierScope({ bridge, tier, context: `checkout ${shown(obj.id)}` })
  // Everything below the invite can throw (a slow Wizarr write, SMTP), and
  // a throw leaves the event unmarked so Stripe retries the whole handler.
  // The session -> invite binding is what stops that retry from minting a
  // second invite and mailing the member a second link.
  const issued = sessionId ? getSessionInvite({ path: bridge.dbPath, sessionId }) : null
  const code = issued
    ? issued.invite_code
    : (await mint({ wizarr: bridge.wizarr, settings: bridge.settings, tier, scope: access })).code
  if (issued) {
    log.log(`checkout ${shown(sessionId)} already has invite ${code}; reusing it`)
  } else if (sessionId) {
    recordSessionInvite({ path: bridge.dbPath, sessionId, inviteCode: code })
  }
  if (customerId) {
    upsertPending({ path: bridge.dbPath, customerId, email, inviteCode: code, tier })
  }
  // A completed checkout settles whatever failed on the previous cycle.
  setPaymentState({ path: bridge.dbPath, email, state: null })
  if (!(issued?.emailed ?? false)) {
    await bridge.mailer.sendInvite({ to: email, inviteUrl: inviteUrl({ bridge, code }) })
    log.log(`sent invite to ${email}`)
    if (sessionId) {
      markSessionInviteEmailed({ path: bridge.dbPath, sessionId })
    }
    recordEvent({
      path: bridge.dbPath,
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
    setPaymentState({ path: bridge.dbPath, email, state: null })
  }
  if (obj.billing_reason === 'subscription_create') {
    log.log(`skipping first (signup) invoice for ${shown(obj.customer)}`)
    return
  }
  const tag = email ? getMemberTag({ path: bridge.dbPath, email }) : null
  // A ban outranks a payment: nothing is extended and nothing restored.
  if (email && tag === 'banned') {
    log.warn(`renewal: ${email} is banned; access not extended`)
    recordEvent({
      path: bridge.dbPath,
      email,
      action: 'Payment received',
      detail: 'banned; access not extended',
    })
    return
  }
  if (email) {
    setSubscribed({ path: bridge.dbPath, email, value: true })
  }
  // VIP access is never time-boxed — acknowledge the payment, leave expiry alone.
  if (email && tag === 'vip') {
    log.log(`renewal: ${email} is VIP — expiry untouched`)
    recordEvent({
      path: bridge.dbPath,
      email,
      action: 'Payment received',
      detail: 'VIP — expiry untouched',
    })
    return
  }
  const ids = await resolveUserIds({
    wizarr: bridge.wizarr,
    dbPath: bridge.dbPath,
    customerId,
    email,
  })
  const expires = accessExpiryIso(bridge.settings)
  await eachInOrder({ items: ids, run: (userId) => bridge.wizarr.setExpiry({ userId, expires }) })
  if (ids.length > 0) {
    log.log(`renewed ${ids.length} record(s) for ${shown(email)} (expires ${expires})`)
    if (email) {
      recordEvent({
        path: bridge.dbPath,
        email,
        action: 'Payment received',
        detail: `access extended to ${expires.slice(0, 10)}`,
      })
    } else {
      // Python handed None to record_event, whose own guard logged the
      // failed write and carried on; the same line, without the write.
      log.error('event log write failed for None / Payment received')
    }
  } else if (email) {
    // Paid, but nothing to extend. Never leave this as a log line: the
    // member is locked out right now and only a new invite fixes it.
    const row = customerRow({ path: bridge.dbPath, email })
    await restoreAccess({ bridge, email, customerId, tier: row ? row.tier : null })
  } else {
    log.warn(`renewal: no wizarr user for ${customerId} / ${shown(email)}`)
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
    log.warn(`payment failed for ${shown(obj.customer)} with no resolvable email`)
    return
  }
  setPaymentState({ path: bridge.dbPath, email, state: 'past_due' })
  log.warn(`payment failed for ${email} (invoice ${shown(obj.id)})`)
  recordEvent({
    path: bridge.dbPath,
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
  const mapping = customerId ? getMapping({ path: bridge.dbPath, customerId }) : null
  const email =
    (mapping ? mapping.email : null) ||
    (customerId ? await customerEmail({ bridge, customerId }) : null)
  syncPaymentState({ bridge, email, status })
  log.log(`subscription for ${shown(email)} is ${status}`)
}

/** Disable the member's records, unless somebody still pays for them. */
const onSubscriptionDeleted: EventHandler = async ({ bridge, obj }) => {
  const customerId = requiredText({ obj, key: 'customer' })
  const mapping = getMapping({ path: bridge.dbPath, customerId })
  const email = (mapping ? mapping.email : null) || (await customerEmail({ bridge, customerId }))
  // This customer really did stop, but the person behind it may not
  // have: a second customer at the same address (they re-checked out
  // from scratch), or a linked second address (they pay under another
  // email). subscribed and payment_state are per email, so they only
  // move when nothing of theirs at this address still pays.
  const sibling = email
    ? await liveSiblingCustomer({
        stripe: bridge.stripe,
        dbPath: bridge.dbPath,
        email,
        deadCustomer: customerId,
      })
    : null
  if (email && sibling) {
    setPaymentState({ path: bridge.dbPath, email, state: null })
  } else if (email) {
    setSubscribed({ path: bridge.dbPath, email, value: false })
  }
  // A VIP's access is a standing grant, not something the subscription
  // buys. The renewal handler already leaves their expiry alone and the
  // sweep skips them; disabling them here undid both.
  if (email && getMemberTag({ path: bridge.dbPath, email }) === 'vip') {
    log.log(`cancel: ${email} is VIP; access left alone`)
    recordEvent({
      path: bridge.dbPath,
      email,
      action: 'Canceled',
      detail: 'subscription ended; access kept, VIP',
    })
    return
  }
  const paying =
    sibling || (email ? stillSubscribedElsewhere({ dbPath: bridge.dbPath, email }) : null)
  if (paying) {
    log.log(`cancel: ${shown(email)} still pays under ${paying}; access left alone`)
    if (email) {
      recordEvent({
        path: bridge.dbPath,
        email,
        action: 'Canceled',
        detail: `subscription ended; access kept, still paying under ${paying}`,
      })
    }
    return
  }
  const ids = await resolveUserIds({
    wizarr: bridge.wizarr,
    dbPath: bridge.dbPath,
    customerId,
    email,
  })
  await eachInOrder({ items: ids, run: (userId) => bridge.wizarr.disableUser(userId) })
  if (ids.length > 0) {
    log.log(`disabled ${ids.length} record(s) for ${shown(email)}`)
  } else {
    log.log(`cancel: no wizarr user for ${customerId} / ${shown(email)}`)
  }
  if (email) {
    recordEvent({
      path: bridge.dbPath,
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

/** `value[key]` as Python's subscript read it: a missing key, or a non-object, throws. */
const subscript = ({ value, key }: { value: unknown; key: string }): unknown => {
  if (!isRow(value)) {
    throw new TypeError(`cannot read '${key}' of ${JSON.stringify(value)}`)
  }
  if (!(key in value)) {
    throw new Error(`KeyError: '${key}'`)
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
  if (eventId && isEventProcessed({ path: bridge.dbPath, eventId })) {
    log.log(`skipping already-processed event ${eventId}`)
    return
  }

  const type = subscript({ value: event, key: 'type' })
  const obj = subscript({ value: subscript({ value: event, key: 'data' }), key: 'object' })
  log.log(`stripe event: ${shown(type)}`)

  const handler = typeof type === 'string' ? HANDLERS.get(type) : undefined
  if (handler) {
    if (!isRow(obj)) {
      throw new TypeError(`${type} carries no object: ${JSON.stringify(obj)}`)
    }
    await handler({ bridge, obj })
  }

  if (eventId) {
    markEventProcessed({ path: bridge.dbPath, eventId })
  }
}
