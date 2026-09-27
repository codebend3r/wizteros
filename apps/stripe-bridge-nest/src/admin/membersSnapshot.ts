import { Logger, type Provider } from '@nestjs/common'
import { BRIDGE } from '@/bridgeToken.js'
import { PlexUnavailable } from '@/clients/plex.js'
import { UpstreamSnapshot } from '@/snapshot.js'
import type { Bridge, PlexAccess, WizarrInvitation, WizarrLibrary, WizarrUser } from '@/types.js'

const log = new Logger('bridge.admin')

/** Everything /admin/members needs from Wizarr and plex.tv, fetched in one sweep. */
export type Upstream = Readonly<{
  users: readonly WizarrUser[]
  libraries: readonly WizarrLibrary[]
  invitations: readonly WizarrInvitation[]
  plex_access: PlexAccess | null
}>

export type MembersSnapshot = UpstreamSnapshot<Upstream>

/**
 * The injection token for the members list's warm snapshot. AdminModule
 * exports it so the app's background loop can warm it at boot and refresh it
 * on an interval.
 */
export const MEMBERS_SNAPSHOT = Symbol('MEMBERS_SNAPSHOT')

/**
 * One slow sweep of everything /admin/members needs from Wizarr and plex.tv.
 *
 * The three Wizarr reads go out one after another, as they did in Python.
 * plex_access is best effort, mirroring withPlexAccess: an unset token or a
 * plex.tv failure yields null and the members list falls back to
 * tier-derived access rather than failing.
 */
export const fetchUpstream = async (bridge: Bridge): Promise<Upstream> => {
  const users = await bridge.wizarr.listUsers()
  const libraries = await bridge.wizarr.listLibraries()
  const invitations = await bridge.wizarr.listInvitations()
  return { users, libraries, invitations, plex_access: await plexAccessOrNull(bridge) }
}

/** Every account's live plex.tv share, or null without a token or when plex.tv fails. */
const plexAccessOrNull = async (bridge: Bridge): Promise<PlexAccess | null> => {
  if (!bridge.plex.hasToken()) {
    return null
  }
  try {
    return await bridge.plex.sharedAccessAll()
  } catch (error) {
    if (!(error instanceof PlexUnavailable)) {
      throw error
    }
    log.error(`plex.tv bulk lookup failed; falling back to tier access: ${error.message}`)
    return null
  }
}

// Wizarr's users list alone takes ~15s, so /admin/members serves the last
// snapshot instantly; the app's background loop keeps it warm from boot.
export const membersSnapshotProvider: Provider = {
  provide: MEMBERS_SNAPSHOT,
  inject: [BRIDGE],
  useFactory: (bridge: Bridge): MembersSnapshot =>
    new UpstreamSnapshot({ fetch: () => fetchUpstream(bridge) }),
}
