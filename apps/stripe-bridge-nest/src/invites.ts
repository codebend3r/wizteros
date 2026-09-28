import { Logger } from '@nestjs/common'
import { resolveTierAccess, type Tier, withoutStale } from '@/tiers.js'
import type {
  CreatedInvite,
  PlexApi,
  Settings,
  TierScope,
  WizarrApi,
  WizarrLibrary,
} from '@/types.js'

// The one way an invite is scoped and minted, wherever it is asked for.
//
// A checkout, an access recovery, an admin reissue and the baseline rotation
// all hand a member the same kind of link, so they resolve the tier's
// libraries and call Wizarr through here rather than each repeating the
// pipeline. What differs between them is only the reaction to a tier that
// resolves to nothing, which is why that case is thrown rather than decided
// here: the webhook wants the event left unmarked for Stripe to retry, the
// admin route wants a 502, and the rotation wants to skip the tier and carry
// on.

const log = new Logger('bridge.invites')

/**
 * A tier resolved to no libraries, so there is nothing to issue an invite for.
 *
 * Always a misconfiguration or a library rename, never a normal state: an
 * invite scoped to nothing grants nothing, and handing one to a member who
 * just paid is worse than refusing to mint it.
 */
export class TierScopeEmpty extends Error {
  override readonly name = 'TierScopeEmpty'
}

/**
 * The tier's access over the given library list; throws TierScopeEmpty when empty.
 *
 * `context` names the caller in the error, so an operator reading a stack
 * knows which delivery or route hit it.
 */
export const tierScope = ({
  tier,
  libraries,
  context,
}: {
  tier: Tier
  libraries: readonly WizarrLibrary[]
  context: string
}): TierScope => {
  const access = resolveTierAccess({ tier, libraries })
  if (access.library_ids.length === 0) {
    throw new TierScopeEmpty(`no libraries resolved for tier '${tier}' on '${context}'`)
  }
  return access
}

/**
 * The tier's access over the live library list; throws TierScopeEmpty when empty.
 *
 * Rows Wizarr's cache still names the old way are dropped first: Plex rejects
 * an invite carrying a stale name whole, so the member is better off with
 * everything else than with nothing, and the scope check alerts on the drop.
 */
export const liveScope = async ({
  wizarr,
  plex,
  tier,
  context,
}: {
  wizarr: WizarrApi
  plex: PlexApi
  tier: Tier
  context: string
}): Promise<TierScope> => {
  const libraries = withoutStale({
    libraries: await wizarr.listLibraries(),
    live: await plex.liveSectionsOrNone(),
  })
  return tierScope({ tier, libraries, context })
}

/**
 * Create one tier-scoped Wizarr invite and return its code and url.
 *
 * `allowDownloads` left out takes the tier's own setting; an admin override is
 * passed in instead. `unlimited` is sent only when it is on, since Wizarr
 * defaults it off and a single-use link is what every member-facing path
 * wants; only the baseline rotation mints a shareable one.
 */
export const mint = async ({
  wizarr,
  settings,
  tier,
  scope,
  allowDownloads = null,
  expiresInDays = settings.inviteDays,
  unlimited = false,
}: {
  wizarr: WizarrApi
  settings: Settings
  tier: Tier
  scope: TierScope
  allowDownloads?: boolean | null
  expiresInDays?: number
  unlimited?: boolean
}): Promise<CreatedInvite> => {
  const invite = await wizarr.createInvite({
    serverIds: scope.server_ids,
    expiresInDays,
    duration: settings.accessDuration,
    libraryIds: scope.library_ids,
    allowDownloads: allowDownloads ?? scope.allow_downloads,
    ...(unlimited ? { unlimited: true } : {}),
  })
  log.log(
    `created ${tier} invite (${scope.library_ids.length} libraries, servers [${scope.server_ids.join(', ')}])`,
  )
  return invite
}
