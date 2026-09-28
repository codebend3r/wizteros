import { Logger } from '@nestjs/common'
import { isoformat, parseIso } from '@wizteros/server-common'
import { mint, tierScope, TierScopeEmpty } from '@/invites.js'
import { mapInOrder } from '@/sequence.js'
import { allBaselineInvites, forgetBaselineInvite, recordBaselineInvite } from '@/store.js'
import { SHARE_SERVER, TIER_DOWNLOADS, tierScopeProblems, withoutStale } from '@/tiers.js'
import type { Bridge, CreatedInvite, WizarrInvitation, WizarrLibrary } from '@/types.js'
import { stackOf } from '@/errors.js'

const log = new Logger('bridge.baseline')

// The four tiers a prospective member can be handed a link for. Derived from
// the tier rules rather than hard-coded so a new tier cannot be added without
// the baseline set following it.
export const BASELINE_TIERS: readonly string[] = [...TIER_DOWNLOADS.keys()].toSorted()

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

/** One baseline tier minted by a rotation. */
export type MintedBaseline = Readonly<{ tier: string; code: string }>

/** What one rotation did: tiers minted, tiers skipped, expired codes reaped. */
export type RotationResult = Readonly<{
  minted: readonly MintedBaseline[]
  skipped: readonly string[]
  reaped: readonly string[]
}>

/** One live baseline invite, as the audit lists it under its tier. */
export type LiveBaseline = Readonly<{ code: string; expires: string | null }>

/** How the live invitation set diverges from the baseline rules. */
export type BaselineAudit = Readonly<{
  tiers_missing: readonly string[]
  no_expiry: readonly Readonly<{ code: string; tier: string }>[]
  wrong_scope: readonly Readonly<{ code: string; tier: string; servers: readonly string[] }>[]
  rotation_stale: readonly string[]
  strays: readonly Readonly<{
    code: string | null
    servers: readonly string[]
    expires: string | null
  }>[]
  live_by_tier: Readonly<Record<string, readonly LiveBaseline[]>>
  ok: boolean
}>

/**
 * Parse a Wizarr/store timestamp into a UTC instant, or null.
 *
 * Wizarr emits naive ISO strings that are really UTC, so a missing offset is
 * read as UTC rather than guessed from the host's local zone. Empty or
 * unparseable input is null.
 */
export const parseStamp = (value: string | null | undefined): Date | null => {
  if (!value) return null
  try {
    return parseIso(value)
  } catch {
    return null
  }
}

/** The invitation list keyed by code; a repeated code keeps the last. */
const byCodeOf = (
  invitations: readonly WizarrInvitation[],
): ReadonlyMap<string | null, WizarrInvitation> =>
  new Map(invitations.map((inv) => [inv.code ?? null, inv] as const))

/**
 * Create one tier's baseline invite and record it as ours; null if it fails.
 *
 * Recording the code is what licenses a later rotation to reap it, so the
 * write happens immediately after the invite exists.
 */
export const mintBaselineInvite = async ({
  bridge,
  tier,
  libraries,
  now,
}: {
  bridge: Bridge
  tier: string
  libraries: readonly WizarrLibrary[]
  now: Date
}): Promise<CreatedInvite | null> => {
  const access = (() => {
    try {
      return tierScope({ tier, libraries, context: `baseline rotation for ${tier}` })
    } catch (error) {
      if (error instanceof TierScopeEmpty) return null
      throw error
    }
  })()
  if (access === null) {
    log.error(`baseline: ${tier} resolves to no libraries; refusing to mint`)
    return null
  }
  const days = bridge.settings.baselineExpiresDays
  const expiresAt = isoformat(new Date(now.getTime() + days * DAY_MS))
  const invite = await mint({
    wizarr: bridge.wizarr,
    settings: bridge.settings,
    tier,
    scope: access,
    expiresInDays: days,
    unlimited: true,
  })
  recordBaselineInvite({
    path: bridge.dbPath,
    code: invite.code,
    tier,
    expiresAt,
    createdAt: isoformat(now),
  })
  log.log(
    `baseline: minted ${tier} invite ${invite.code} (${access.library_ids.length} libraries, ` +
      `servers ${access.server_ids.join(', ')}, expires ${expiresAt})`,
  )
  return invite
}

/**
 * Delete baselines we minted that have already passed their own expiry.
 *
 * Two guards make this safe: only codes recorded in baseline_invites are
 * considered at all, and among those only ones already expired are removed.
 * A member's checkout invite satisfies neither, so it can never be reaped.
 * A code that has vanished upstream is simply forgotten locally.
 */
export const reapExpiredBaselines = async ({
  bridge,
  invitations,
  now,
}: {
  bridge: Bridge
  invitations: readonly WizarrInvitation[]
  now: Date
}): Promise<string[]> => {
  const byCode = byCodeOf(invitations)
  const outcomes = await mapInOrder({
    items: allBaselineInvites({ path: bridge.dbPath }),
    run: async (row): Promise<string | null> => {
      const expiresAt = parseStamp(row.expires_at)
      if (expiresAt === null || expiresAt.getTime() > now.getTime()) return null
      const live = byCode.get(row.code)
      if (live === undefined) {
        forgetBaselineInvite({ path: bridge.dbPath, code: row.code })
        return null
      }
      try {
        await bridge.wizarr.deleteInvitation(live.id)
      } catch (error) {
        log.error(`baseline: could not delete expired invite ${row.code}`, stackOf(error))
        return null
      }
      forgetBaselineInvite({ path: bridge.dbPath, code: row.code })
      return row.code
    },
  })
  const reaped = outcomes.filter((code): code is string => code !== null)
  if (reaped.length > 0) {
    log.log(`baseline: reaped ${reaped.length} expired invite(s): ${reaped.join(', ')}`)
  }
  return reaped
}

/** How one tier fared in a rotation: minted with a code, or skipped. */
type TierOutcome = Readonly<{ tier: string; code: string | null }>

/**
 * Mint a fresh baseline invite per tier, then reap the ones already expired.
 *
 * Minting precedes reaping so that a failure part-way through leaves extra
 * invites rather than none. A tier whose scope is currently broken is skipped
 * with an alarm and keeps its existing invite, so a Plex library rename can
 * never empty the baseline set.
 */
export const rotateBaselineInvites = async ({
  bridge,
  now = new Date(),
}: {
  bridge: Bridge
  now?: Date
}): Promise<RotationResult> => {
  // Stale cache rows are dropped as on every other invite path: Plex rejects
  // an invite carrying a name it no longer knows, whole.
  const libraries = withoutStale({
    libraries: await bridge.wizarr.listLibraries(),
    live: await bridge.plex.liveSectionsOrNone(),
  })
  const broken = tierScopeProblems({ libraries })
  const outcomes = await mapInOrder({
    items: BASELINE_TIERS,
    run: async (tier): Promise<TierOutcome> => {
      if (Object.hasOwn(broken, tier)) {
        log.error(`baseline: skipping ${tier} — ${broken[tier] ?? ''}`)
        return { tier, code: null }
      }
      try {
        const invite = await mintBaselineInvite({ bridge, tier, libraries, now })
        return { tier, code: invite?.code ?? null }
      } catch (error) {
        log.error(`baseline: minting ${tier} failed`, stackOf(error))
        return { tier, code: null }
      }
    },
  })
  const minted = outcomes.flatMap(({ tier, code }): MintedBaseline[] =>
    code === null ? [] : [{ tier, code }],
  )
  const skipped = outcomes.filter(({ code }) => code === null).map(({ tier }) => tier)
  const reaped = await reapExpiredBaselines({
    bridge,
    invitations: await bridge.wizarr.listInvitations(),
    now,
  })
  return { minted, skipped, reaped }
}

/** One owned baseline that is still live, with how it failed the rules. */
type OwnedLive = Readonly<{
  code: string
  tier: string
  noExpiry: boolean
  servers: readonly string[]
  expires: string | null
}>

/**
 * Report how the live invitation set diverges from the baseline rules.
 *
 * Read-only. Scope is judged on server_names because Wizarr's serializer
 * reports specific_libraries as [] even for a correctly scoped invite, so
 * that field cannot separate a scoped invite from an unscoped one.
 */
export const auditBaselineInvites = async ({
  bridge,
  now = new Date(),
}: {
  bridge: Bridge
  now?: Date
}): Promise<BaselineAudit> => {
  const invitations = await bridge.wizarr.listInvitations()
  const owned = new Map(allBaselineInvites({ path: bridge.dbPath }).map((row) => [row.code, row]))
  const byCode = byCodeOf(invitations)

  // An owned invite with no expiry is still live (and flagged); one whose
  // expiry has passed drops out of every other check.
  const live = [...owned.values()].flatMap((row): OwnedLive[] => {
    const inv = byCode.get(row.code)
    if (inv === undefined) return []
    const expires = parseStamp(inv.expires)
    if (expires !== null && expires.getTime() <= now.getTime()) return []
    return [
      {
        code: row.code,
        tier: row.tier,
        noExpiry: expires === null,
        servers: [...(inv.server_names ?? [])].toSorted(),
        expires: inv.expires ?? null,
      },
    ]
  })
  const noExpiry = live
    .filter(({ noExpiry: missing }) => missing)
    .map(({ code, tier }) => ({ code, tier }))
  const wrongScope = live
    .filter(({ servers }) => !(servers.length === 1 && servers[0] === SHARE_SERVER))
    .map(({ code, tier, servers }) => ({ code, tier, servers }))
  // Tiers in the order their first live invite was seen.
  const liveByTier: Readonly<Record<string, readonly LiveBaseline[]>> = Object.fromEntries(
    [...new Set(live.map(({ tier }) => tier))].map((tier) => [
      tier,
      live.filter((entry) => entry.tier === tier).map(({ code, expires }) => ({ code, expires })),
    ]),
  )

  const missing = BASELINE_TIERS.filter((tier) => (liveByTier[tier] ?? []).length === 0)
  const stale = Object.entries(liveByTier)
    .filter(([, entries]) =>
      entries.every(({ code }) => {
        const created = parseStamp(owned.get(code)?.created_at ?? null)
        return created === null || now.getTime() - created.getTime() > 24 * HOUR_MS
      }),
    )
    .map(([tier]) => tier)
  const strays = invitations
    .filter((inv) => !!inv.unlimited && (inv.code == null || !owned.has(inv.code)))
    .map((inv) => ({
      code: inv.code ?? null,
      servers: [...(inv.server_names ?? [])].toSorted(),
      expires: inv.expires ?? null,
    }))
  return {
    tiers_missing: missing,
    no_expiry: noExpiry,
    wrong_scope: wrongScope,
    rotation_stale: stale.toSorted(),
    strays,
    live_by_tier: liveByTier,
    ok: !(missing.length > 0 || noExpiry.length > 0 || wrongScope.length > 0 || stale.length > 0),
  }
}
