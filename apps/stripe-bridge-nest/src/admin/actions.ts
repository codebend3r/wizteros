import { Logger } from '@nestjs/common'
import { addDays, httpError, isoformat, parseIso } from '@wizteros/server-common'
import { z } from 'zod'
import { issueInvite, liveScope, TierScopeEmpty } from '@/invites.js'
import { eachInOrder, mapInOrder } from '@/sequence.js'
import { isBanned, isMemberTag, type MemberTag } from '@/standing.js'
import { isTier, normalizeTier, staleRecordIds, type Tier } from '@/tiers.js'
import type { Bridge, StripeSubscription } from '@/types.js'
import { stackOf } from '@/errors.js'

// What each admin POST does once its body is read, over a Bridge. A refusal
// is thrown as the HTTP error the route answers with: these exist for the
// portal's routes and nothing else calls them, and the status is part of what
// each action means (a 404 for nobody to act on, a 409 for a ban in the way).

const log = new Logger('bridge.admin')

export type NotesResult = Readonly<{ email: string; notes: string }>
export type TagResult = Readonly<{ email: string; tag: MemberTag | null }>
export type DownloadsResult = Readonly<{ email: string; downloads: boolean }>
export type LinkResult = Readonly<{ stripe_email: string; plex_email: string | null }>
export type CancelResult = Readonly<{ email: string; canceled: number; cancel_at: string | null }>
export type BanResult = Readonly<{
  email: string
  disabled: number
  canceled: number
  cancel_at: string | null
}>
export type ExpiryResult = Readonly<{ updated: number; expires: string | null }>
export type TierResult = Readonly<{ email: string; tier: Tier }>
export type ReissueResult = Readonly<{
  url: string
  code: string
  tier: Tier
  disabled: number
  emailed: boolean
}>

/** Save (overwrite) the admin's notes for an email. */
export const saveNotes = ({
  bridge,
  email,
  notes,
}: {
  bridge: Bridge
  email: string
  notes: string
}): NotesResult => {
  bridge.store.setMemberNotes({ email, notes })
  return { email, notes }
}

/**
 * Set (or clear, with tag null) the member's manual designation.
 *
 * Purely a bridge-side label — Plex access, tier, and expiry are untouched.
 */
export const setTag = ({
  bridge,
  email,
  tag,
}: {
  bridge: Bridge
  email: string
  tag: string | null
}): TagResult => {
  if (tag !== null && !isMemberTag(tag)) {
    throw httpError({ status: 400, detail: `unknown tag ${JSON.stringify(tag)}` })
  }
  bridge.store.setMemberTag({ email, tag })
  bridge.store.recordEvent({
    email,
    action: 'Tag changed',
    detail: tag ? `tagged ${tag.toUpperCase()}` : 'tag cleared',
  })
  return { email, tag }
}

/**
 * Toggle the member's allow-downloads override.
 *
 * Wizarr has no per-user downloads endpoint, so this can't touch the
 * member's current Plex share. The override wins over the tier default on
 * every member payload and applies for real on the member's next reissued
 * invite.
 */
export const setDownloads = ({
  bridge,
  email,
  allow,
}: {
  bridge: Bridge
  email: string
  allow: boolean
}): DownloadsResult => {
  bridge.store.setMemberDownloads({ email, allow })
  bridge.store.recordEvent({
    email,
    action: 'Downloads toggled',
    detail: `turned ${allow ? 'on' : 'off'} by admin`,
  })
  return { email, downloads: allow }
}

/**
 * Declare that `stripeEmail` bills for the member watching as `plexEmail`.
 *
 * The two then read as one member everywhere: one row on the list, the
 * paying customer behind it, and a renewal on the Stripe address extending
 * the Plex account's records instead of finding nothing and re-inviting.
 *
 * Purely a bridge-side statement of identity. No subscription is cancelled,
 * no refund is issued, and neither Stripe customer is altered. A member
 * paying twice still needs that settled in Stripe. A null `plexEmail` undoes
 * the link.
 */
export const linkAddress = ({
  bridge,
  stripeEmail: rawStripeEmail,
  plexEmail: rawPlexEmail,
}: {
  bridge: Bridge
  stripeEmail: string
  plexEmail: string | null
}): LinkResult => {
  const stripeEmail = rawStripeEmail.trim().toLowerCase()
  const plexEmail = rawPlexEmail ? rawPlexEmail.trim().toLowerCase() : null
  if (!stripeEmail) {
    throw httpError({ status: 400, detail: 'stripe_email is required' })
  }
  if (plexEmail === stripeEmail) {
    throw httpError({ status: 400, detail: 'an address cannot link to itself' })
  }
  // Chains would make "whose row is this" depend on resolution order, and the
  // shape they describe (A pays for B, B pays for C) is not a real one.
  const payer = plexEmail ? bridge.store.allMemberLinks().get(plexEmail) : undefined
  if (plexEmail && payer !== undefined) {
    throw httpError({
      status: 400,
      detail: `${plexEmail} already pays under ${payer}; unlink it first`,
    })
  }
  bridge.store.setMemberLink({ stripeEmail, plexEmail })
  if (plexEmail) {
    bridge.store.recordEvent({
      email: plexEmail,
      action: 'Address linked',
      detail: `pays under ${stripeEmail}`,
    })
    bridge.store.recordEvent({
      email: stripeEmail,
      action: 'Address linked',
      detail: `billing address for ${plexEmail}`,
    })
  } else {
    bridge.store.recordEvent({
      email: stripeEmail,
      action: 'Address unlinked',
      detail: 'stands as its own member again',
    })
  }
  return { stripe_email: stripeEmail, plex_email: plexEmail }
}

type Flagged = Readonly<{
  /** Whether any Stripe customer answers for the email. */
  found: boolean
  /** Subscriptions this call flagged, as Stripe returned them. */
  flagged: readonly StripeSubscription[]
  /** Subscriptions that were flagged already and were left alone. */
  already: readonly StripeSubscription[]
}>

/**
 * The latest period end among the flagged subscriptions, as an ISO stamp; null
 * when none of them carries a cancel_at.
 */
export const cancelAtOf = (subscriptions: readonly StripeSubscription[]): string | null => {
  const latest = subscriptions.reduce((max, sub) => Math.max(max, sub.cancel_at ?? 0), 0)
  return latest ? isoformat(new Date(latest * 1000)) : null
}

/**
 * Flag every live Stripe subscription for an email to cancel at period end.
 *
 * Answers whether a customer exists, what was newly flagged, and what was
 * flagged already. Customer ids come from the bridge's own mapping first,
 * falling back to a live Stripe email lookup for members who predate the
 * mapping. Subscriptions already flagged are left alone. Nothing here throws
 * for an unknown email or an email with no subscription: the caller decides
 * whether that is an error. Every Stripe call goes out one at a time, in
 * order.
 */
const flagSubscriptions = async ({
  bridge,
  email,
}: {
  bridge: Bridge
  email: string
}): Promise<Flagged> => {
  const mapped = bridge.store.customerIdsForEmail({ email })
  const customerIds = mapped.length > 0 ? mapped : await bridge.stripe.customerIdsForEmail(email)
  const perCustomer = await mapInOrder({
    items: customerIds,
    run: async (customerId) => {
      const subscriptions = await bridge.stripe.subscriptionsFor(customerId)
      const already = subscriptions.filter((sub) => sub.cancel_at_period_end)
      const flagged = await mapInOrder({
        items: subscriptions.filter((sub) => !sub.cancel_at_period_end),
        run: (sub) => bridge.stripe.cancelAtPeriodEnd(sub.id),
      })
      return { flagged, already }
    },
  })
  return {
    found: customerIds.length > 0,
    flagged: perCustomer.flatMap(({ flagged }) => flagged),
    already: perCustomer.flatMap(({ already }) => already),
  }
}

/**
 * Flag every live Stripe subscription for an email to cancel at period end.
 *
 * Mirrors a portal self-cancel: the member keeps access through the period
 * they already contributed for, then Stripe fires
 * customer.subscription.deleted and the webhook disables their records.
 * Nothing is revoked here directly. Idempotent: subscriptions already
 * flagged are left alone and still count as scheduled.
 */
export const cancelSubscription = async ({
  bridge,
  email,
}: {
  bridge: Bridge
  email: string
}): Promise<CancelResult> => {
  const { found, flagged, already } = await flagSubscriptions({ bridge, email })
  if (!found) {
    throw httpError({ status: 404, detail: 'no stripe customer for that email' })
  }
  if (flagged.length === 0 && already.length === 0) {
    throw httpError({ status: 404, detail: 'no active subscription for that email' })
  }
  const cancelAt = cancelAtOf([...flagged, ...already])
  if (flagged.length > 0) {
    bridge.store.recordEvent({
      email,
      action: 'Cancellation scheduled',
      detail: cancelAt ? `by admin — access ends ${cancelAt.slice(0, 10)}` : 'by admin',
    })
  }
  return { email, canceled: flagged.length, cancel_at: cancelAt }
}

/**
 * Revoke a member and mark them so nothing brings them back by accident.
 *
 * Three things, in the order that fails safest: the tag first (from here on
 * the webhooks refuse to invite, extend or restore this address), then every
 * Wizarr record disabled now, then every live Stripe subscription flagged to
 * cancel at period end so no further charge lands. Stripe being down costs
 * the cancellation, not the ban: the tag and the disable have already
 * happened, the event says what was skipped, and the subscription can be
 * cancelled by hand. Refunds are a Stripe decision and are never made here.
 * Clearing the tag (set-tag with null) lifts the ban; access is re-granted
 * only by a fresh invite.
 */
export const banMember = async ({
  bridge,
  email,
}: {
  bridge: Bridge
  email: string
}): Promise<BanResult> => {
  bridge.store.setMemberTag({ email, tag: 'banned' })
  const ids = await bridge.wizarr.findUserIdsByEmail(email)
  await eachInOrder({ items: ids, run: (id) => bridge.wizarr.disableUser(id) })
  const billing = await flagSubscriptions({ bridge, email }).then(
    ({ flagged }) => {
      const cancelAt = cancelAtOf(flagged)
      return {
        flagged,
        cancelAt,
        line: cancelAt ? `billing stops ${cancelAt.slice(0, 10)}` : 'no subscription to cancel',
      }
    },
    (error: unknown) => {
      log.error(`ban: could not flag subscriptions for ${email}`, stackOf(error))
      return {
        flagged: [],
        cancelAt: null,
        line: 'could not reach Stripe, cancel the subscription by hand',
      }
    },
  )
  const revoked =
    ids.length > 0 ? `${ids.length} server record(s) disabled` : 'no server records to disable'
  bridge.store.recordEvent({ email, action: 'Banned', detail: `${revoked}; ${billing.line}` })
  return {
    email,
    disabled: ids.length,
    canceled: billing.flagged.length,
    cancel_at: billing.cancelAt,
  }
}

/**
 * Now plus `days`, as an ISO stamp. A span that leaves years 1 to 9999 throws
 * rather than sending Wizarr a date its schema cannot parse.
 */
const daysFromNow = (days: number): string => {
  const at = addDays({ at: new Date(), days })
  const year = at.getUTCFullYear()
  if (Number.isNaN(at.getTime()) || year < 1 || year > 9999) {
    throw new RangeError(`date value out of range: ${days} days`)
  }
  return isoformat(at)
}

// A calendar-valid ISO datetime, with or without an offset.
const ISO_DATETIME = z.iso.datetime({ offset: true, local: true })

/**
 * An admin's absolute expiry in the form every stored timestamp takes, or
 * null when it is not an ISO datetime. The portal sends toISOString(), which
 * comes back unchanged apart from `Z` becoming `+00:00`; an offset is
 * converted to UTC and a time with none is read as UTC.
 */
const absoluteExpiry = (text: string): string | null => {
  if (!ISO_DATETIME.safeParse(text).success) {
    return null
  }
  try {
    return isoformat(parseIso(text))
  } catch {
    return null
  }
}

/** The expiry a reset asks for, and how the event log words it. */
const expiryFor = ({
  days,
  expiresAt,
}: {
  days: number | null
  expiresAt: string | null
}): { expires: string | null; detail: string } => {
  if (expiresAt !== null) {
    const expires = absoluteExpiry(expiresAt)
    if (expires === null) {
      throw httpError({ status: 400, detail: 'expires_at is not an ISO datetime' })
    }
    return { expires, detail: `to ${expires}` }
  }
  if (days !== null) {
    return { expires: daysFromNow(days), detail: `${days} days` }
  }
  return { expires: null, detail: 'cleared' }
}

/**
 * Set (or clear) the expiry on every record for an email. In-place.
 *
 * `expiresAt` (an absolute ISO datetime) wins over `days`; with neither set
 * the expiry is cleared.
 */
export const resetExpiry = async ({
  bridge,
  email,
  days,
  expiresAt,
}: {
  bridge: Bridge
  email: string
  days: number | null
  expiresAt: string | null
}): Promise<ExpiryResult> => {
  const ids = await bridge.wizarr.findUserIdsByEmail(email)
  if (ids.length === 0) {
    throw httpError({ status: 404, detail: 'no member for that email' })
  }
  const { expires, detail } = expiryFor({ days, expiresAt })
  await eachInOrder({ items: ids, run: (userId) => bridge.wizarr.setExpiry({ userId, expires }) })
  bridge.store.recordEvent({ email, action: 'Expiry reset', detail })
  return { updated: ids.length, expires }
}

/**
 * Hard-set the member's recorded tier in place — no re-invite, no disable.
 *
 * Only rewrites the bridge's record (which drives the displayed tier,
 * downloads, and library derivation); the member's actual Plex shares are
 * untouched. Use reissueInvite when access itself must change.
 */
export const resetTier = ({
  bridge,
  email,
  tier,
}: {
  bridge: Bridge
  email: string
  tier: string
}): TierResult => {
  if (!isTier(tier)) {
    throw httpError({ status: 400, detail: `unknown tier ${JSON.stringify(tier)}` })
  }
  bridge.store.setTier({ email, tier })
  bridge.store.recordEvent({ email, action: 'Tier reset', detail: `hard reset to ${tier}` })
  return { email, tier }
}

/**
 * Issue a fresh tier-scoped invite link; existing access survives the wait.
 *
 * Redeeming the invite re-scopes the member's share in place on every server
 * the invite covers (Wizarr updates the sections for an already-shared
 * account), so nothing is disabled up front and the member keeps their
 * current access until they join through the link. The one exception is a
 * tier that leaves a current server uncovered — Wizarr has no per-server
 * unshare, so that reissue falls back to disable-first (with the access gap).
 * Scope comes from resolveTierAccess (fail-closed on 9X. privates).
 */
export const reissueInvite = async ({
  bridge,
  email,
  tier: requested,
}: {
  bridge: Bridge
  email: string
  tier: string
}): Promise<ReissueResult> => {
  const { wizarr, plex, mailer, settings, store } = bridge
  if (!settings.publicInviteBase) {
    throw httpError({ status: 500, detail: 'PUBLIC_INVITE_BASE not configured' })
  }
  if (isBanned(store.getMemberTag({ email }))) {
    throw httpError({ status: 409, detail: 'member is banned; clear the tag first' })
  }
  const tier = normalizeTier(requested)
  // Stale cache rows are dropped the same way the checkout path does it: an
  // invite carrying a name Plex no longer knows is rejected whole.
  const access = await liveScope({ wizarr, plex, tier, context: `reissue for ${email}` }).catch(
    (error: unknown) => {
      throw error instanceof TierScopeEmpty
        ? httpError({ status: 502, detail: `no libraries resolved for tier ${tier}` })
        : error
    },
  )
  const records = await wizarr.findUsersByEmail(email)
  // The admin's downloads toggle wins over the tier default when set.
  const override = store.getMemberDownloads({ email })
  // Create the invite BEFORE any disable: disableUser is account-wide (it
  // severs the plex.tv friendship on every server), so if createInvite threw
  // after a disable loop the member would be locked out with no link to redeem.
  const invite = await issueInvite({ bridge, email, tier, scope: access, allowDownloads: override })
  const stale = staleRecordIds({ records, coveredServers: access.server_names })
  await eachInOrder({ items: stale, run: (id) => wizarr.disableUser(id) })
  // An SMTP failure must not fail the reissue (it already happened); report
  // it so the admin sends the link manually instead of re-inviting.
  const emailed = await mailer.sendInvite({ to: email, inviteUrl: invite.url }).then(
    () => true,
    (error: unknown) => {
      log.error(`invite email to ${email} failed`, stackOf(error))
      return false
    },
  )
  store.recordEvent({
    email,
    action: 'Invite issued',
    detail: `${tier} tier — ${emailed ? 'link emailed' : 'email failed, link sent manually'}`,
  })
  return { url: invite.url, code: invite.code, tier, disabled: stale.length, emailed }
}
