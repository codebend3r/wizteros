import { Logger } from '@nestjs/common'
import { addDays, isoformat, parseIsoOrNull } from '@wizteros/server-common'
import { mint } from '@/invites.js'
import { mapInOrder } from '@/sequence.js'
import { resolveTierAccess, type Tier, TIERS, tierScopeProblems, withoutStale } from '@/tiers.js'
import type { Bridge, CreatedInvite, TierScope, WizarrInvitation } from '@/types.js'
import { stackOf } from '@/errors.js'

const log = new Logger('bridge.baseline')

// The four tiers a prospective member can be handed a link for. Derived from
// the tier rules rather than hard-coded so a new tier cannot be added without
// the baseline set following it.
export const BASELINE_TIERS: readonly Tier[] = TIERS.toSorted()

/** One baseline tier minted by a rotation. */
export type MintedBaseline = Readonly<{ tier: Tier; code: string }>

/** What one rotation did: tiers minted, tiers skipped, expired codes reaped. */
export type RotationResult = Readonly<{
  minted: readonly MintedBaseline[]
  skipped: readonly string[]
  reaped: readonly string[]
}>

/** The invitation list keyed by code; a repeated code keeps the last. */
const byCodeOf = (
  invitations: readonly WizarrInvitation[],
): ReadonlyMap<string | null, WizarrInvitation> =>
  new Map(invitations.map((inv) => [inv.code ?? null, inv] as const))

/**
 * Create one tier's baseline invite and record it as ours.
 *
 * Recording the code is what licenses a later rotation to reap it, so the
 * write happens immediately after the invite exists.
 */
const mintBaselineInvite = async ({
  bridge,
  tier,
  scope,
  now,
}: {
  bridge: Bridge
  tier: Tier
  scope: TierScope
  now: Date
}): Promise<CreatedInvite> => {
  const days = bridge.settings.baselineExpiresDays
  const expiresAt = isoformat(addDays({ at: now, days }))
  const invite = await mint({
    wizarr: bridge.wizarr,
    settings: bridge.settings,
    tier,
    scope,
    expiresInDays: days,
    unlimited: true,
  })
  bridge.store.recordBaselineInvite({
    code: invite.code,
    tier,
    expiresAt,
    createdAt: isoformat(now),
  })
  log.log(
    `baseline: minted ${tier} invite ${invite.code} (${scope.library_ids.length} libraries, ` +
      `servers ${scope.server_ids.join(', ')}, expires ${expiresAt})`,
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
    items: bridge.store.allBaselineInvites(),
    run: async (row): Promise<string | null> => {
      const expiresAt = parseIsoOrNull(row.expires_at)
      if (expiresAt === null || expiresAt.getTime() > now.getTime()) return null
      const live = byCode.get(row.code)
      if (live === undefined) {
        bridge.store.forgetBaselineInvite({ code: row.code })
        return null
      }
      try {
        await bridge.wizarr.deleteInvitation(live.id)
      } catch (error) {
        log.error(`baseline: could not delete expired invite ${row.code}`, stackOf(error))
        return null
      }
      bridge.store.forgetBaselineInvite({ code: row.code })
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
type TierOutcome = Readonly<{ tier: Tier; code: string | null }>

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
        const scope = resolveTierAccess({ tier, libraries })
        const invite = await mintBaselineInvite({ bridge, tier, scope, now })
        return { tier, code: invite.code }
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
