// The admin routes under test: the portal's wire contract (copied from
// apps/admin-portal/src/lib/adminApi.ts, so a body the portal would refuse
// fails the test), the fixtures, and an app served over a fake bridge with
// one helper per route. Shared by the admin test files.

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { vi } from 'vitest'
import { AdminModule } from '@/admin/adminModule.js'
import { MEMBERS_SNAPSHOT, type MembersSnapshot } from '@/admin/membersSnapshot.js'
import { asBridge, type FakeBridge, fakeBridge, TEST_SETTINGS } from '@/test/fakes.js'
import { serve } from '@/test/serve.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import type { Bridge, PlexAccess, Settings, WizarrLibrary, WizarrUser } from '@/types.js'

// --- the wire contract, as the portal checks it ------------------------------------
//
// Copied from apps/admin-portal/src/lib/adminApi.ts (and isRecord from
// guards.ts): a body that fails one of these is a page the portal refuses to
// draw. If the portal's guards change, this copy changes with them.

export type Guard<T> = (value: unknown) => value is T

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export type Tier = 'bronze' | 'silver' | 'gold' | 'youth' | 'unknown'
export type MemberTag = 'vip' | 'hvu' | 'banned'

export type PortalMember = {
  member: string
  email: string
  tier: Tier
  downloads: boolean | null
  expires: string | null
  servers: string[]
  libraries: Record<string, string[]>
  entitled: Record<string, string[]>
  subscribed: boolean
  payment_state: 'past_due' | null
  invited_at: string | null
  tag: MemberTag | null
  customer_id: string | null
  stripe_email: string | null
}

export type PlexServerAccess = { all_libraries: boolean; allow_sync: boolean; libraries: string[] }
export type PortalPlexAccess = { email: string; servers: Record<string, PlexServerAccess> }
export type MemberNotes = { email: string; notes: string }
export type MemberEvent = { id: number; at: string; email: string; action: string; detail: string }
export type InviteResult = {
  url: string
  code: string
  tier: string
  disabled: number
  emailed: boolean
}
export type ResetExpiryResult = { updated: number; expires: string | null }
export type ResetTierResult = { email: string; tier: string }
export type CancelSubscriptionResult = { email: string; canceled: number; cancel_at: string | null }
export type SetTagResult = { email: string; tag: MemberTag | null }
export type LinkAddressResult = { stripe_email: string; plex_email: string | null }
export type SetDownloadsResult = { email: string; downloads: boolean }
export type BanResult = {
  email: string
  disabled: number
  canceled: number
  cancel_at: string | null
}

export const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

export const isLibrariesMap = (value: unknown): value is Record<string, string[]> =>
  isRecord(value) && Object.values(value).every(isStringArray)

export const TIERS: ReadonlyArray<Tier> = ['bronze', 'silver', 'gold', 'youth', 'unknown']

export const isTier = (value: unknown): value is Tier =>
  typeof value === 'string' && TIERS.some((tier) => tier === value)

export const isMemberTag = (value: unknown): value is MemberTag =>
  value === 'vip' || value === 'hvu' || value === 'banned'

export type MemberPayload = Omit<
  PortalMember,
  'libraries' | 'entitled' | 'invited_at' | 'tag' | 'customer_id'
> & {
  libraries?: Record<string, string[]>
  entitled?: Record<string, string[]>
  invited_at?: string | null
  tag?: MemberTag | null
  customer_id?: string | null
}

export type MemberFieldCheck = { field: string; valid: (value: Record<string, unknown>) => boolean }

export const MEMBER_FIELD_CHECKS: ReadonlyArray<MemberFieldCheck> = [
  { field: 'member', valid: (value) => typeof value.member === 'string' },
  { field: 'email', valid: (value) => typeof value.email === 'string' },
  { field: 'tier', valid: (value) => isTier(value.tier) },
  {
    field: 'downloads',
    valid: (value) => typeof value.downloads === 'boolean' || value.downloads === null,
  },
  {
    field: 'expires',
    valid: (value) => typeof value.expires === 'string' || value.expires === null,
  },
  { field: 'servers', valid: (value) => isStringArray(value.servers) },
  {
    field: 'libraries',
    valid: (value) => value.libraries === undefined || isLibrariesMap(value.libraries),
  },
  {
    field: 'entitled',
    valid: (value) => value.entitled === undefined || isLibrariesMap(value.entitled),
  },
  { field: 'subscribed', valid: (value) => typeof value.subscribed === 'boolean' },
  {
    field: 'invited_at',
    valid: (value) =>
      value.invited_at === undefined ||
      value.invited_at === null ||
      typeof value.invited_at === 'string',
  },
  {
    field: 'tag',
    valid: (value) => value.tag === undefined || value.tag === null || isMemberTag(value.tag),
  },
  {
    field: 'customer_id',
    valid: (value) =>
      value.customer_id === undefined ||
      value.customer_id === null ||
      typeof value.customer_id === 'string',
  },
]

export const invalidMemberFields = (value: unknown): string[] =>
  isRecord(value)
    ? MEMBER_FIELD_CHECKS.filter(({ valid }) => !valid(value)).map(({ field }) => field)
    : ['(not an object)']

export const isMemberPayload = (value: unknown): value is MemberPayload =>
  invalidMemberFields(value).length === 0

export const isPlexServerAccess = (value: unknown): value is PlexServerAccess =>
  isRecord(value) &&
  typeof value.all_libraries === 'boolean' &&
  typeof value.allow_sync === 'boolean' &&
  isStringArray(value.libraries)

export const isPlexAccess = (value: unknown): value is PortalPlexAccess =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  isRecord(value.servers) &&
  Object.values(value.servers).every(isPlexServerAccess)

export const isMemberNotes = (value: unknown): value is MemberNotes =>
  isRecord(value) && typeof value.email === 'string' && typeof value.notes === 'string'

export const isMemberEvent = (value: unknown): value is MemberEvent =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.at === 'string' &&
  typeof value.email === 'string' &&
  typeof value.action === 'string' &&
  typeof value.detail === 'string'

export const isMemberEventArray = (value: unknown): value is MemberEvent[] =>
  Array.isArray(value) && value.every(isMemberEvent)

export const isMemberPayloadArray = (value: unknown): value is MemberPayload[] =>
  Array.isArray(value) && value.every(isMemberPayload)

export const isInviteResult = (value: unknown): value is InviteResult =>
  isRecord(value) &&
  typeof value.url === 'string' &&
  typeof value.code === 'string' &&
  typeof value.tier === 'string' &&
  typeof value.disabled === 'number' &&
  typeof value.emailed === 'boolean'

export const isResetExpiryResult = (value: unknown): value is ResetExpiryResult =>
  isRecord(value) &&
  typeof value.updated === 'number' &&
  (typeof value.expires === 'string' || value.expires === null)

export const isResetTierResult = (value: unknown): value is ResetTierResult =>
  isRecord(value) && typeof value.email === 'string' && typeof value.tier === 'string'

export const isCancelSubscriptionResult = (value: unknown): value is CancelSubscriptionResult =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  typeof value.canceled === 'number' &&
  (typeof value.cancel_at === 'string' || value.cancel_at === null)

export const isSetTagResult = (value: unknown): value is SetTagResult =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  (value.tag === null || isMemberTag(value.tag))

export const isLinkAddressResult = (value: unknown): value is LinkAddressResult =>
  isRecord(value) &&
  typeof value.stripe_email === 'string' &&
  (value.plex_email === null || typeof value.plex_email === 'string')

export const isSetDownloadsResult = (value: unknown): value is SetDownloadsResult =>
  isRecord(value) && typeof value.email === 'string' && typeof value.downloads === 'boolean'

export const isBanResult = (value: unknown): value is BanResult =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  typeof value.disabled === 'number' &&
  typeof value.canceled === 'number' &&
  (typeof value.cancel_at === 'string' || value.cancel_at === null)

/** What `inject` answers with, as far as reading a body goes. */
export type Answer = Readonly<{ statusCode: number; body: string }>

/**
 * A 200's body, vouched for by the guard the portal reads it with. Anything
 * else fails the test with the body in the message.
 */
export const bodyOf = <T>({ answer, is }: { answer: Answer; is: Guard<T> }): T => {
  if (answer.statusCode !== 200) {
    throw new Error(`expected a 200 and got ${answer.statusCode}: ${answer.body}`)
  }
  const value: unknown = JSON.parse(answer.body)
  if (!is(value)) {
    throw new Error(`the portal would refuse this body: ${answer.body}`)
  }
  return value
}

// --- fixtures ------------------------------------------------------------------------

export const USERS: WizarrUser[] = [
  {
    id: 1,
    username: 'cj',
    email: 'A@X.com',
    server: 'Meleys',
    expires: '2026-09-01T00:00:00+00:00',
  },
  {
    id: 2,
    username: 'cj',
    email: 'a@x.com',
    server: 'Vhagar',
    expires: '2026-09-10T00:00:00+00:00',
  },
  { id: 3, username: 'nora', email: 'nora@x.com', server: 'Syrax', expires: null },
]

export const LIBRARIES: WizarrLibrary[] = [
  { id: 1, name: '01. Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 2, name: '03. 4K Movies', server_id: 3, server_name: 'Vhagar', enabled: true },
  { id: 3, name: '90. Private', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 4, name: '02. Anime', server_id: 5, server_name: 'Syrax', enabled: false },
  { id: 5, name: '03. Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 6, name: '14. Kid Shows', server_id: 2, server_name: 'Meleys', enabled: true },
]

export const GOLD_LIBRARIES = {
  Meleys: ['01. Movies', '03. Family Movies', '14. Kid Shows'],
  Vhagar: ['03. 4K Movies'],
}

export const PLEX_SHARES: PlexAccess = {
  'a@x.com': {
    Meleys: { all_libraries: true, allow_sync: true, libraries: ['01. Movies', '05. TV Shows'] },
    Caraxes: { all_libraries: false, allow_sync: false, libraries: ['09. Basketball'] },
  },
  'nora@x.com': {
    Syrax: { all_libraries: false, allow_sync: false, libraries: ['02. Anime'] },
  },
}

// Reissue scope comes from the share server alone; the Vermithor row is a
// retired mirror that must never widen an invite.
export const FIXTURE_LIBRARIES: WizarrLibrary[] = [
  { id: 17, name: '05. TV Shows', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 20, name: '04. 4K Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 37, name: '99. Tutorials', server_id: 2, server_name: 'Meleys', enabled: true },
  {
    id: 41,
    name: '01. TV Shows (switch to Meleys)',
    server_id: 1,
    server_name: 'Vermithor',
    enabled: true,
  },
]

// --- the app under test ----------------------------------------------------------------

export type Harness = Readonly<{
  app: NestFastifyApplication
  bridge: FakeBridge
  snapshot: MembersSnapshot
}>

export const running: Harness[] = []

/**
 * The admin routes over a fresh store and a fake bridge.
 * Wizarr lists USERS and LIBRARIES and no redeemed invites (so no Stripe/Plex
 * email linkage); plex.tv has no token, since the members list must be
 * reachable without one and tests that exercise the live union opt in; and
 * Stripe finds no customer, so no test reaches the network.
 */
export const harness = async ({
  settings = TEST_SETTINGS,
  adapt = asBridge,
}: {
  settings?: Settings
  adapt?: (bridge: FakeBridge) => Bridge
} = {}): Promise<Harness> => {
  const bridge = fakeBridge({ dbPath: tempDbPath(), settings })
  bridge.store.init()
  bridge.wizarr.listUsers.mockResolvedValue(USERS)
  bridge.wizarr.listLibraries.mockResolvedValue(LIBRARIES)
  const app = await serve({ imports: [AdminModule], bridge: adapt(bridge) })
  const made = { app, bridge, snapshot: app.get<MembersSnapshot>(MEMBERS_SNAPSHOT) }
  running.push(made)
  return made
}

/** Close every app `harness` served once its background refresh settles; for an afterEach. */
export const stopServed = async (): Promise<void> => {
  // A route that kicked a background refresh is let finish before its app goes.
  await Promise.all(
    running.splice(0).map(async ({ app, snapshot }) => {
      await snapshot.settled()
      await app.close()
    }),
  )
  vi.unstubAllEnvs()
  removeTempDirs()
}

export const get = ({ h: { app }, url }: { h: Harness; url: string }) =>
  app.inject({ method: 'GET', url })

export const post = ({
  h: { app },
  url,
  payload,
}: {
  h: Harness
  url: string
  payload: Record<string, unknown>
}) => app.inject({ method: 'POST', url, payload })

export const listMembers = async (h: Harness): Promise<MemberPayload[]> =>
  bodyOf({ answer: await get({ h, url: '/admin/members' }), is: isMemberPayloadArray })

export const getMember = async ({
  h,
  email,
}: {
  h: Harness
  email: string
}): Promise<MemberPayload> =>
  bodyOf({
    answer: await get({ h, url: `/admin/member?email=${encodeURIComponent(email)}` }),
    is: isMemberPayload,
  })

export const getEvents = async ({
  h,
  email,
}: {
  h: Harness
  email?: string
}): Promise<MemberEvent[]> =>
  bodyOf({
    answer: await get({
      h,
      url:
        email === undefined ? '/admin/events' : `/admin/events?email=${encodeURIComponent(email)}`,
    }),
    is: isMemberEventArray,
  })

/** Lowercased email -> recorded tier, as the members list reads it. */
export const tiersOf = (h: Harness): ReadonlyMap<string, string | null> =>
  new Map([...h.bridge.store.allCustomerRows()].map(([email, row]) => [email, row.tier]))

/** The members keyed by lowercased email. */
export const byEmail = (members: readonly MemberPayload[]): ReadonlyMap<string, MemberPayload> =>
  new Map(members.map((m) => [m.email.toLowerCase(), m]))

/** One member of the list, failing the test when it is missing. */
export const memberOf = ({
  members,
  email,
}: {
  members: readonly MemberPayload[]
  email: string
}): MemberPayload => {
  const found = byEmail(members).get(email)
  if (found === undefined) {
    throw new Error(`${email} is not on the list`)
  }
  return found
}

export const resetExpiry = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
  bodyOf({
    answer: await post({ h, url: '/admin/reset-expiry', payload: body }),
    is: isResetExpiryResult,
  })

export const reissue = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
  bodyOf({
    answer: await post({ h, url: '/admin/reissue-invite', payload: body }),
    is: isInviteResult,
  })

export const cancel = async ({ h, email }: { h: Harness; email: string }) =>
  bodyOf({
    answer: await post({ h, url: '/admin/cancel-subscription', payload: { email } }),
    is: isCancelSubscriptionResult,
  })

export const ban = async ({ h, email }: { h: Harness; email: string }) =>
  bodyOf({ answer: await post({ h, url: '/admin/ban', payload: { email } }), is: isBanResult })

export const setTag = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
  bodyOf({ answer: await post({ h, url: '/admin/set-tag', payload: body }), is: isSetTagResult })

export const setDownloads = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
  bodyOf({
    answer: await post({ h, url: '/admin/set-downloads', payload: body }),
    is: isSetDownloadsResult,
  })

export const linkAddress = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
  post({ h, url: '/admin/link-address', payload: body })
