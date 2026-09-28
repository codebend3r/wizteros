import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { httpError, isoformat, parseIso, SupabaseAdminGuard } from '@wizteros/server-common'
import { z } from 'zod'
import {
  EmailBody,
  EmailQuery,
  LinkAddressBody,
  NotesBody,
  OptionalEmailQuery,
  ReissueInviteBody,
  ResetExpiryBody,
  ResetTierBody,
  SetDownloadsBody,
  SetTagBody,
} from '@/admin/bodies.js'
import { MEMBERS_SNAPSHOT, type MembersSnapshot } from '@/admin/membersSnapshot.js'
import { BRIDGE } from '@/bridgeToken.js'
import { PlexUnavailable } from '@/clients/plex.js'
import { liveScope, mint, TierScopeEmpty } from '@/invites.js'
import { assembleMembers, memberFromCustomer, withOverrides, withPlexAccess } from '@/roster.js'
import { eachInOrder, mapInOrder } from '@/sequence.js'
import { normalizeTier, staleRecordIds, TIER_DOWNLOADS } from '@/tiers.js'
import type {
  Bridge,
  EventRow,
  Member,
  PlexShares,
  StripeSubscription,
  WizarrInvitation,
} from '@/types.js'
import { stackOf } from '@/errors.js'

const log = new Logger('bridge.admin')

// banned is the one tag with teeth: the bridge refuses to invite, extend or
// restore a banned address, whatever Stripe says about it.
export const MEMBER_TAGS: readonly string[] = ['vip', 'hvu', 'banned']

const DAY_MS = 86_400_000

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
 * Now plus `days`, as an ISO stamp. A span that leaves years 1 to 9999 throws
 * rather than sending Wizarr a date its schema cannot parse.
 */
const daysFromNow = (days: number): string => {
  const at = new Date(Date.now() + days * DAY_MS)
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

// Every admin route sits behind the Supabase session gate, and answers both
// bare and under /stripe: the Funnel strips the prefix and direct calls keep
// it. Every POST is pinned to 200, what the portal expects, where Nest would
// answer 201.
@Controller(['admin', 'stripe/admin'])
@UseGuards(SupabaseAdminGuard)
export class AdminController {
  constructor(
    @Inject(BRIDGE) private readonly bridge: Bridge,
    @Inject(MEMBERS_SNAPSHOT) private readonly snapshot: MembersSnapshot,
  ) {}

  /** Stamp each member with the admin overrides the store holds. */
  private withOverrides(members: readonly Member[]): Member[] {
    return withOverrides({
      members,
      tags: this.bridge.store.allMemberTags(),
      downloads: this.bridge.store.allMemberDownloads(),
    })
  }

  /**
   * Every member: Wizarr users AND Stripe subscribers who haven't joined yet.
   *
   * Wizarr's user list only has people who redeemed an invite, so subscribers
   * still holding a pending invite are unioned in from the bridge's
   * customer_map, and each row's servers/libraries are reconciled against the
   * live plex.tv share. The slow upstream reads come from the warm snapshot
   * (only a cold first call pays the full ~15s); tags, downloads, and tier
   * joins stay live from the DB.
   */
  @Get('members')
  async listMembers(): Promise<Member[]> {
    const snap = await this.snapshot.get()
    const members = assembleMembers({
      users: snap.users,
      libraries: snap.libraries,
      invitations: snap.invitations,
      customers: this.bridge.store.allCustomerRows(),
      links: this.bridge.store.allMemberLinks(),
    })
    return this.withOverrides(withPlexAccess({ members, access: snap.plex_access }))
  }

  /**
   * The member's Stripe customer id, looked up live when the store has none.
   *
   * customer_map only holds a real `cus_...` for members the bridge itself put
   * there through a checkout. Anyone invited by an admin, or carried over in
   * the baseline backfill, gets an "admin:<email>" placeholder instead, and the
   * member page then showed no Stripe link at all even when a real customer
   * existed at that exact address. Ask Stripe rather than concluding from our
   * own row that they never paid.
   */
  private async stripeCustomerIdFor(email: string): Promise<string | null> {
    try {
      return await this.bridge.stripe.searchCustomerId(email)
    } catch (error) {
      log.error(`stripe customer lookup failed for ${email}`, stackOf(error))
      return null
    }
  }

  /** Fill in a missing customer_id from Stripe; leaves a known one alone. */
  private async withStripeCustomer(member: Member): Promise<Member> {
    if (member.customer_id || !member.email) {
      return member
    }
    return { ...member, customer_id: await this.stripeCustomerIdFor(member.email) }
  }

  /** A member by email: a Wizarr user, or a Stripe subscriber not yet joined; else 404. */
  @Get('member')
  async getMember(
    @Query({ schema: EmailQuery }) query: z.output<typeof EmailQuery>,
  ): Promise<Member> {
    const { email } = query
    const customers = this.bridge.store.allCustomerRows()
    const libraries = await this.bridge.wizarr.listLibraries()
    const users = await this.bridge.wizarr.listUsers()
    // Best effort: a Wizarr that will not list invitations costs the member
    // page its Stripe-email row, not the page itself.
    const invitations = await this.bridge.wizarr
      .listInvitations()
      .catch((error: unknown): WizarrInvitation[] => {
        log.error(`could not read invitations while resolving ${email}`, stackOf(error))
        return []
      })
    const members = assembleMembers({
      users,
      libraries,
      invitations,
      customers,
      links: this.bridge.store.allMemberLinks(),
    })
    const wanted = email.toLowerCase()
    const listed = members.find((m) => m.email.toLowerCase() === wanted)
    // A customer standing as someone else's Stripe address is kept out of the
    // list on purpose, but asking for it by name still has to answer.
    const row = customers.get(wanted)
    const found =
      listed ?? (row === undefined ? undefined : memberFromCustomer({ email, row, libraries }))
    if (found === undefined) {
      throw httpError({ status: 404, detail: 'no member for that email' })
    }
    const [stamped] = this.withOverrides([found])
    return this.withStripeCustomer(stamped ?? found)
  }

  /** The email's actual plex.tv share per server — covers uninvited legacy shares too. */
  @Get('plex-access')
  async getPlexAccess(
    @Query({ schema: EmailQuery }) query: z.output<typeof EmailQuery>,
  ): Promise<{ email: string; servers: PlexShares }> {
    const { email } = query
    if (!this.bridge.plex.hasToken()) {
      throw httpError({ status: 503, detail: 'PLEX_TOKEN not configured' })
    }
    try {
      return { email, servers: await this.bridge.plex.sharedAccessForEmail(email) }
    } catch (error) {
      if (!(error instanceof PlexUnavailable)) {
        throw error
      }
      log.error(`plex.tv lookup failed for ${email}: ${error.message}`)
      throw httpError({ status: 502, detail: 'plex.tv lookup failed' })
    }
  }

  /**
   * A member's action history (invites, renewals, cancels), newest first.
   *
   * Without an email, the whole log across every member: what the income
   * page reads its months and its timeline from.
   */
  @Get('events')
  getEvents(
    @Query({ schema: OptionalEmailQuery }) query: z.output<typeof OptionalEmailQuery>,
  ): EventRow[] {
    return query.email === undefined
      ? this.bridge.store.allEvents()
      : this.bridge.store.eventsForEmail({ email: query.email })
  }

  /** The admin's notes for an email; empty when none have been saved yet. */
  @Get('notes')
  getNotes(@Query({ schema: EmailQuery }) query: z.output<typeof EmailQuery>): {
    email: string
    notes: string
  } {
    return {
      email: query.email,
      notes: this.bridge.store.getMemberNotes({ email: query.email }),
    }
  }

  /** Save (overwrite) the admin's notes for an email. */
  @Post('notes')
  @HttpCode(200)
  saveNotes(@Body({ schema: NotesBody }) body: z.output<typeof NotesBody>): {
    email: string
    notes: string
  } {
    this.bridge.store.setMemberNotes({ email: body.email, notes: body.notes })
    return { email: body.email, notes: body.notes }
  }

  /**
   * Set (or clear, with tag null) the member's manual designation.
   *
   * Purely a bridge-side label — Plex access, tier, and expiry are untouched.
   */
  @Post('set-tag')
  @HttpCode(200)
  setTag(@Body({ schema: SetTagBody }) body: z.output<typeof SetTagBody>): {
    email: string
    tag: string | null
  } {
    const { email, tag } = body
    if (tag !== null && !MEMBER_TAGS.includes(tag)) {
      throw httpError({ status: 400, detail: `unknown tag ${JSON.stringify(tag)}` })
    }
    this.bridge.store.setMemberTag({ email, tag })
    this.bridge.store.recordEvent({
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
  @Post('set-downloads')
  @HttpCode(200)
  setDownloads(@Body({ schema: SetDownloadsBody }) body: z.output<typeof SetDownloadsBody>): {
    email: string
    downloads: boolean
  } {
    const { email, allow } = body
    this.bridge.store.setMemberDownloads({ email, allow })
    this.bridge.store.recordEvent({
      email,
      action: 'Downloads toggled',
      detail: `turned ${allow ? 'on' : 'off'} by admin`,
    })
    return { email, downloads: allow }
  }

  /**
   * Declare that `stripe_email` bills for the member watching as `plex_email`.
   *
   * The two then read as one member everywhere: one row on the list, the
   * paying customer behind it, and a renewal on the Stripe address extending
   * the Plex account's records instead of finding nothing and re-inviting.
   *
   * Purely a bridge-side statement of identity. No subscription is cancelled,
   * no refund is issued, and neither Stripe customer is altered. A member
   * paying twice still needs that settled in Stripe. Pass a null `plex_email`
   * to undo the link.
   */
  @Post('link-address')
  @HttpCode(200)
  linkAddress(@Body({ schema: LinkAddressBody }) body: z.output<typeof LinkAddressBody>): {
    stripe_email: string
    plex_email: string | null
  } {
    const stripeEmail = body.stripe_email.trim().toLowerCase()
    const plexEmail = body.plex_email ? body.plex_email.trim().toLowerCase() : null
    if (!stripeEmail) {
      throw httpError({ status: 400, detail: 'stripe_email is required' })
    }
    if (plexEmail === stripeEmail) {
      throw httpError({ status: 400, detail: 'an address cannot link to itself' })
    }
    // Chains would make "whose row is this" depend on resolution order, and the
    // shape they describe (A pays for B, B pays for C) is not a real one.
    const links = this.bridge.store.allMemberLinks()
    const payer = plexEmail ? links.get(plexEmail) : undefined
    if (plexEmail && payer !== undefined) {
      throw httpError({
        status: 400,
        detail: `${plexEmail} already pays under ${payer}; unlink it first`,
      })
    }

    this.bridge.store.setMemberLink({ stripeEmail, plexEmail })
    if (plexEmail) {
      this.bridge.store.recordEvent({
        email: plexEmail,
        action: 'Address linked',
        detail: `pays under ${stripeEmail}`,
      })
      this.bridge.store.recordEvent({
        email: stripeEmail,
        action: 'Address linked',
        detail: `billing address for ${plexEmail}`,
      })
    } else {
      this.bridge.store.recordEvent({
        email: stripeEmail,
        action: 'Address unlinked',
        detail: 'stands as its own member again',
      })
    }
    return { stripe_email: stripeEmail, plex_email: plexEmail }
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
  private async flagSubscriptions(email: string): Promise<Flagged> {
    const mapped = this.bridge.store.customerIdsForEmail({ email })
    const customerIds =
      mapped.length > 0 ? mapped : await this.bridge.stripe.customerIdsForEmail(email)
    const perCustomer = await mapInOrder({
      items: customerIds,
      run: async (customerId) => {
        const subscriptions = await this.bridge.stripe.subscriptionsFor(customerId)
        const already = subscriptions.filter((sub) => sub.cancel_at_period_end)
        const flagged = await mapInOrder({
          items: subscriptions.filter((sub) => !sub.cancel_at_period_end),
          run: (sub) => this.bridge.stripe.cancelAtPeriodEnd(sub.id),
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
  @Post('cancel-subscription')
  @HttpCode(200)
  async cancelSubscription(@Body({ schema: EmailBody }) body: z.output<typeof EmailBody>): Promise<{
    email: string
    canceled: number
    cancel_at: string | null
  }> {
    const { email } = body
    const { found, flagged, already } = await this.flagSubscriptions(email)
    if (!found) {
      throw httpError({ status: 404, detail: 'no stripe customer for that email' })
    }
    if (flagged.length === 0 && already.length === 0) {
      throw httpError({ status: 404, detail: 'no active subscription for that email' })
    }
    const cancelAt = cancelAtOf([...flagged, ...already])
    if (flagged.length > 0) {
      this.bridge.store.recordEvent({
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
  @Post('ban')
  @HttpCode(200)
  async banMember(@Body({ schema: EmailBody }) body: z.output<typeof EmailBody>): Promise<{
    email: string
    disabled: number
    canceled: number
    cancel_at: string | null
  }> {
    const { email } = body
    this.bridge.store.setMemberTag({ email, tag: 'banned' })
    const ids = await this.bridge.wizarr.findUserIdsByEmail(email)
    await eachInOrder({ items: ids, run: (id) => this.bridge.wizarr.disableUser(id) })
    const billing = await this.flagSubscriptions(email).then(
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
    this.bridge.store.recordEvent({
      email,
      action: 'Banned',
      detail: `${revoked}; ${billing.line}`,
    })
    this.snapshot.refreshAsync()
    return {
      email,
      disabled: ids.length,
      canceled: billing.flagged.length,
      cancel_at: billing.cancelAt,
    }
  }

  /**
   * Set (or clear) the expiry on every record for an email. In-place.
   *
   * expires_at (an absolute ISO datetime) wins over days; with neither set the
   * expiry is cleared.
   */
  @Post('reset-expiry')
  @HttpCode(200)
  async resetExpiry(
    @Body({ schema: ResetExpiryBody }) body: z.output<typeof ResetExpiryBody>,
  ): Promise<{
    updated: number
    expires: string | null
  }> {
    const ids = await this.bridge.wizarr.findUserIdsByEmail(body.email)
    if (ids.length === 0) {
      throw httpError({ status: 404, detail: 'no member for that email' })
    }
    const { expires, detail } = this.expiryFor(body)
    await eachInOrder({
      items: ids,
      run: (userId) => this.bridge.wizarr.setExpiry({ userId, expires }),
    })
    this.bridge.store.recordEvent({ email: body.email, action: 'Expiry reset', detail })
    this.snapshot.refreshAsync()
    return { updated: ids.length, expires }
  }

  /** The expiry a reset-expiry body asks for, and how the event log words it. */
  private expiryFor(body: z.output<typeof ResetExpiryBody>): {
    expires: string | null
    detail: string
  } {
    if (body.expires_at !== null) {
      const expires = absoluteExpiry(body.expires_at)
      if (expires === null) {
        throw httpError({ status: 400, detail: 'expires_at is not an ISO datetime' })
      }
      return { expires, detail: `to ${expires}` }
    }
    if (body.days !== null) {
      return { expires: daysFromNow(body.days), detail: `${body.days} days` }
    }
    return { expires: null, detail: 'cleared' }
  }

  /**
   * Hard-set the member's recorded tier in place — no re-invite, no disable.
   *
   * Only rewrites the bridge's record (which drives the displayed tier,
   * downloads, and library derivation); the member's actual Plex shares are
   * untouched. Use reissue-invite when access itself must change.
   */
  @Post('reset-tier')
  @HttpCode(200)
  resetTier(@Body({ schema: ResetTierBody }) body: z.output<typeof ResetTierBody>): {
    email: string
    tier: string
  } {
    const { email, tier } = body
    if (!TIER_DOWNLOADS.has(tier)) {
      throw httpError({ status: 400, detail: `unknown tier ${JSON.stringify(tier)}` })
    }
    this.bridge.store.setTier({ email, tier })
    this.bridge.store.recordEvent({ email, action: 'Tier reset', detail: `hard reset to ${tier}` })
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
   * Returns the public re-join URL.
   */
  @Post('reissue-invite')
  @HttpCode(200)
  async reissueInvite(
    @Body({ schema: ReissueInviteBody }) body: z.output<typeof ReissueInviteBody>,
  ): Promise<{ url: string; code: string; tier: string; disabled: number; emailed: boolean }> {
    const { email } = body
    const { wizarr, plex, mailer, settings, store } = this.bridge
    if (!settings.publicInviteBase) {
      throw httpError({ status: 500, detail: 'PUBLIC_INVITE_BASE not configured' })
    }
    if (store.getMemberTag({ email }) === 'banned') {
      throw httpError({ status: 409, detail: 'member is banned; clear the tag first' })
    }
    const tier = normalizeTier(body.tier)
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
    const invite = await mint({ wizarr, settings, tier, scope: access, allowDownloads: override })
    // The store row keeps the member on /admin/members while the invite is
    // pending and stamps invited_at for the grace-period status.
    store.upsertPendingByEmail({ email, inviteCode: invite.code, tier })
    const stale = staleRecordIds({ records, coveredServers: access.server_names })
    await eachInOrder({ items: stale, run: (id) => wizarr.disableUser(id) })
    const url = `${settings.publicInviteBase}/j/${invite.code}`
    // An SMTP failure must not fail the reissue (it already happened); report
    // it so the admin sends the link manually instead of re-inviting.
    const emailed = await mailer.sendInvite({ to: email, inviteUrl: url }).then(
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
    this.snapshot.refreshAsync()
    return { url, code: invite.code, tier, disabled: stale.length, emailed }
  }
}
