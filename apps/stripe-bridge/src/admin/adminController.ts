import { Body, Controller, Get, HttpCode, Inject, Post, Query, UseGuards } from '@nestjs/common'
import { SupabaseAdminGuard } from '@wizteros/server-common'
import type { z } from 'zod'
import * as actions from '@/admin/actions.js'
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
import * as queries from '@/admin/queries.js'
import { BRIDGE } from '@/bridgeToken.js'
import type { Bridge, EventRow, Member, PlexShares } from '@/types.js'

// Every admin route sits behind the Supabase session gate, and answers both
// bare and under /stripe: the Funnel strips the prefix and direct calls keep
// it. Every POST is pinned to 200, what the portal expects, where Nest would
// answer 201. Each route reads its query or body and hands it to the query or
// action it stands for; a route that changes what Wizarr holds also kicks the
// members snapshot so the list catches up.
@Controller(['admin', 'stripe/admin'])
@UseGuards(SupabaseAdminGuard)
export class AdminController {
  constructor(
    @Inject(BRIDGE) private readonly bridge: Bridge,
    @Inject(MEMBERS_SNAPSHOT) private readonly snapshot: MembersSnapshot,
  ) {}

  /** Every member, from the warm snapshot of Wizarr and plex.tv. */
  @Get('members')
  async listMembers(): Promise<Member[]> {
    return queries.listMembers({ bridge: this.bridge, upstream: await this.snapshot.get() })
  }

  /** A member by email, read live. */
  @Get('member')
  getMember(@Query({ schema: EmailQuery }) query: z.output<typeof EmailQuery>): Promise<Member> {
    return queries.getMember({ bridge: this.bridge, email: query.email })
  }

  /** The email's actual plex.tv share per server. */
  @Get('plex-access')
  getPlexAccess(
    @Query({ schema: EmailQuery }) query: z.output<typeof EmailQuery>,
  ): Promise<{ email: string; servers: PlexShares }> {
    return queries.plexAccessFor({ bridge: this.bridge, email: query.email })
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
  getNotes(@Query({ schema: EmailQuery }) query: z.output<typeof EmailQuery>): actions.NotesResult {
    return { email: query.email, notes: this.bridge.store.getMemberNotes({ email: query.email }) }
  }

  @Post('notes')
  @HttpCode(200)
  saveNotes(@Body({ schema: NotesBody }) body: z.output<typeof NotesBody>): actions.NotesResult {
    return actions.saveNotes({ bridge: this.bridge, email: body.email, notes: body.notes })
  }

  @Post('set-tag')
  @HttpCode(200)
  setTag(@Body({ schema: SetTagBody }) body: z.output<typeof SetTagBody>): actions.TagResult {
    return actions.setTag({ bridge: this.bridge, email: body.email, tag: body.tag })
  }

  @Post('set-downloads')
  @HttpCode(200)
  setDownloads(
    @Body({ schema: SetDownloadsBody }) body: z.output<typeof SetDownloadsBody>,
  ): actions.DownloadsResult {
    return actions.setDownloads({ bridge: this.bridge, email: body.email, allow: body.allow })
  }

  @Post('link-address')
  @HttpCode(200)
  linkAddress(
    @Body({ schema: LinkAddressBody }) body: z.output<typeof LinkAddressBody>,
  ): actions.LinkResult {
    return actions.linkAddress({
      bridge: this.bridge,
      stripeEmail: body.stripe_email,
      plexEmail: body.plex_email,
    })
  }

  @Post('cancel-subscription')
  @HttpCode(200)
  cancelSubscription(
    @Body({ schema: EmailBody }) body: z.output<typeof EmailBody>,
  ): Promise<actions.CancelResult> {
    return actions.cancelSubscription({ bridge: this.bridge, email: body.email })
  }

  @Post('ban')
  @HttpCode(200)
  async banMember(
    @Body({ schema: EmailBody }) body: z.output<typeof EmailBody>,
  ): Promise<actions.BanResult> {
    const result = await actions.banMember({ bridge: this.bridge, email: body.email })
    this.snapshot.refreshAsync()
    return result
  }

  @Post('reset-expiry')
  @HttpCode(200)
  async resetExpiry(
    @Body({ schema: ResetExpiryBody }) body: z.output<typeof ResetExpiryBody>,
  ): Promise<actions.ExpiryResult> {
    const result = await actions.resetExpiry({
      bridge: this.bridge,
      email: body.email,
      days: body.days,
      expiresAt: body.expires_at,
    })
    this.snapshot.refreshAsync()
    return result
  }

  @Post('reset-tier')
  @HttpCode(200)
  resetTier(
    @Body({ schema: ResetTierBody }) body: z.output<typeof ResetTierBody>,
  ): actions.TierResult {
    return actions.resetTier({ bridge: this.bridge, email: body.email, tier: body.tier })
  }

  @Post('reissue-invite')
  @HttpCode(200)
  async reissueInvite(
    @Body({ schema: ReissueInviteBody }) body: z.output<typeof ReissueInviteBody>,
  ): Promise<actions.ReissueResult> {
    const result = await actions.reissueInvite({
      bridge: this.bridge,
      email: body.email,
      tier: body.tier,
    })
    this.snapshot.refreshAsync()
    return result
  }
}
