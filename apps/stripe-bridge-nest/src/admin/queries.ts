import { Logger } from '@nestjs/common'
import { httpError } from '@wizteros/server-common'
import type { Upstream } from '@/admin/membersSnapshot.js'
import { PlexUnavailable } from '@/clients/plex.js'
import { assembleMembers, memberFromCustomer, withOverrides, withPlexAccess } from '@/roster.js'
import type { Bridge, Member, PlexShares, WizarrInvitation } from '@/types.js'
import { stackOf } from '@/errors.js'

// What the admin GET routes answer, over a Bridge. A refusal is thrown as the
// HTTP error the route answers with, since these exist for the portal's routes
// and nothing else calls them.

const log = new Logger('bridge.admin')

/** Stamp each member with the admin overrides the store holds. */
const stamped = ({ bridge, members }: { bridge: Bridge; members: readonly Member[] }): Member[] =>
  withOverrides({
    members,
    tags: bridge.store.allMemberTags(),
    downloads: bridge.store.allMemberDownloads(),
  })

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
export const listMembers = ({
  bridge,
  upstream,
}: {
  bridge: Bridge
  upstream: Upstream
}): Member[] => {
  const members = assembleMembers({
    users: upstream.users,
    libraries: upstream.libraries,
    invitations: upstream.invitations,
    customers: bridge.store.allCustomerRows(),
    links: bridge.store.allMemberLinks(),
  })
  return stamped({ bridge, members: withPlexAccess({ members, access: upstream.plex_access }) })
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
const stripeCustomerIdFor = async ({
  bridge,
  email,
}: {
  bridge: Bridge
  email: string
}): Promise<string | null> => {
  try {
    return await bridge.stripe.searchCustomerId(email)
  } catch (error) {
    log.error(`stripe customer lookup failed for ${email}`, stackOf(error))
    return null
  }
}

/** Fill in a missing customer_id from Stripe; leaves a known one alone. */
const withStripeCustomer = async ({
  bridge,
  member,
}: {
  bridge: Bridge
  member: Member
}): Promise<Member> => {
  if (member.customer_id || !member.email) {
    return member
  }
  return { ...member, customer_id: await stripeCustomerIdFor({ bridge, email: member.email }) }
}

/** A member by email: a Wizarr user, or a Stripe subscriber not yet joined; else 404. */
export const getMember = async ({
  bridge,
  email,
}: {
  bridge: Bridge
  email: string
}): Promise<Member> => {
  const customers = bridge.store.allCustomerRows()
  const libraries = await bridge.wizarr.listLibraries()
  const users = await bridge.wizarr.listUsers()
  // Best effort: a Wizarr that will not list invitations costs the member
  // page its Stripe-email row, not the page itself.
  const invitations = await bridge.wizarr
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
    links: bridge.store.allMemberLinks(),
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
  const [member] = stamped({ bridge, members: [found] })
  return withStripeCustomer({ bridge, member: member ?? found })
}

/** The email's actual plex.tv share per server — covers uninvited legacy shares too. */
export const plexAccessFor = async ({
  bridge,
  email,
}: {
  bridge: Bridge
  email: string
}): Promise<{ email: string; servers: PlexShares }> => {
  if (!bridge.plex.hasToken()) {
    throw httpError({ status: 503, detail: 'PLEX_TOKEN not configured' })
  }
  try {
    return { email, servers: await bridge.plex.sharedAccessForEmail(email) }
  } catch (error) {
    if (!(error instanceof PlexUnavailable)) {
      throw error
    }
    log.error(`plex.tv lookup failed for ${email}: ${error.message}`)
    throw httpError({ status: 502, detail: 'plex.tv lookup failed' })
  }
}
