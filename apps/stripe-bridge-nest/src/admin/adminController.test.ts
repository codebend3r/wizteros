// The admin routes, ported from stripe-bridge/tests/test_admin.py. The Python
// tests called the route functions directly with a MagicMock client; these
// drive the real routes through `inject` over a fake bridge, so every body is
// also read through the portal's own guards (below) and the wire contract is
// checked on every 200. The session gate is bypassed except in the gate tests,
// which verify real ES256 tokens, as the Python's dependency override did.

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { type CryptoKey, createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminModule } from '@/admin/adminModule.js'
import { MEMBERS_SNAPSHOT, type MembersSnapshot } from '@/admin/membersSnapshot.js'
import { PlexUnavailable } from '@/clients/plex.js'
import { wizarrClient } from '@/clients/wizarr.js'
import { mapInOrder } from '@/sequence.js'
import {
  allCustomerTiers,
  allMemberLinks,
  eventsForEmail,
  getMemberTag,
  initDb,
  recordEvent,
  setMemberDownloads,
  setMemberLink,
  setMemberTag,
  upsertPending,
  upsertPendingByEmail,
} from '@/store.js'
import { asBridge, type FakeBridge, fakeBridge, subscription, TEST_SETTINGS } from '@/test/fakes.js'
import { serve } from '@/test/serve.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import type { Bridge, PlexAccess, Settings, WizarrLibrary, WizarrUser } from '@/types.js'

// --- the wire contract, as the portal checks it ------------------------------------
//
// Copied from apps/admin-portal/src/lib/adminApi.ts (and isRecord from
// guards.ts): a body that fails one of these is a page the portal refuses to
// draw. If the portal's guards change, this copy changes with them.

type Guard<T> = (value: unknown) => value is T

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

type Tier = 'bronze' | 'silver' | 'gold' | 'youth' | 'unknown'
type MemberTag = 'vip' | 'hvu' | 'banned'

type PortalMember = {
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

type PlexServerAccess = { all_libraries: boolean; allow_sync: boolean; libraries: string[] }
type PortalPlexAccess = { email: string; servers: Record<string, PlexServerAccess> }
type MemberNotes = { email: string; notes: string }
type MemberEvent = { id: number; at: string; email: string; action: string; detail: string }
type InviteResult = { url: string; code: string; tier: string; disabled: number; emailed: boolean }
type ResetExpiryResult = { updated: number; expires: string | null }
type ResetTierResult = { email: string; tier: string }
type CancelSubscriptionResult = { email: string; canceled: number; cancel_at: string | null }
type SetTagResult = { email: string; tag: MemberTag | null }
type LinkAddressResult = { stripe_email: string; plex_email: string | null }
type SetDownloadsResult = { email: string; downloads: boolean }
type BanResult = { email: string; disabled: number; canceled: number; cancel_at: string | null }

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isLibrariesMap = (value: unknown): value is Record<string, string[]> =>
  isRecord(value) && Object.values(value).every(isStringArray)

const TIERS: ReadonlyArray<Tier> = ['bronze', 'silver', 'gold', 'youth', 'unknown']

const isTier = (value: unknown): value is Tier =>
  typeof value === 'string' && TIERS.some((tier) => tier === value)

const isMemberTag = (value: unknown): value is MemberTag =>
  value === 'vip' || value === 'hvu' || value === 'banned'

type MemberPayload = Omit<
  PortalMember,
  'libraries' | 'entitled' | 'invited_at' | 'tag' | 'customer_id'
> & {
  libraries?: Record<string, string[]>
  entitled?: Record<string, string[]>
  invited_at?: string | null
  tag?: MemberTag | null
  customer_id?: string | null
}

type MemberFieldCheck = { field: string; valid: (value: Record<string, unknown>) => boolean }

const MEMBER_FIELD_CHECKS: ReadonlyArray<MemberFieldCheck> = [
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

const invalidMemberFields = (value: unknown): string[] =>
  isRecord(value)
    ? MEMBER_FIELD_CHECKS.filter(({ valid }) => !valid(value)).map(({ field }) => field)
    : ['(not an object)']

const isMemberPayload = (value: unknown): value is MemberPayload =>
  invalidMemberFields(value).length === 0

const isPlexServerAccess = (value: unknown): value is PlexServerAccess =>
  isRecord(value) &&
  typeof value.all_libraries === 'boolean' &&
  typeof value.allow_sync === 'boolean' &&
  isStringArray(value.libraries)

const isPlexAccess = (value: unknown): value is PortalPlexAccess =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  isRecord(value.servers) &&
  Object.values(value.servers).every(isPlexServerAccess)

const isMemberNotes = (value: unknown): value is MemberNotes =>
  isRecord(value) && typeof value.email === 'string' && typeof value.notes === 'string'

const isMemberEvent = (value: unknown): value is MemberEvent =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.at === 'string' &&
  typeof value.email === 'string' &&
  typeof value.action === 'string' &&
  typeof value.detail === 'string'

const isMemberEventArray = (value: unknown): value is MemberEvent[] =>
  Array.isArray(value) && value.every(isMemberEvent)

const isMemberPayloadArray = (value: unknown): value is MemberPayload[] =>
  Array.isArray(value) && value.every(isMemberPayload)

const isInviteResult = (value: unknown): value is InviteResult =>
  isRecord(value) &&
  typeof value.url === 'string' &&
  typeof value.code === 'string' &&
  typeof value.tier === 'string' &&
  typeof value.disabled === 'number' &&
  typeof value.emailed === 'boolean'

const isResetExpiryResult = (value: unknown): value is ResetExpiryResult =>
  isRecord(value) &&
  typeof value.updated === 'number' &&
  (typeof value.expires === 'string' || value.expires === null)

const isResetTierResult = (value: unknown): value is ResetTierResult =>
  isRecord(value) && typeof value.email === 'string' && typeof value.tier === 'string'

const isCancelSubscriptionResult = (value: unknown): value is CancelSubscriptionResult =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  typeof value.canceled === 'number' &&
  (typeof value.cancel_at === 'string' || value.cancel_at === null)

const isSetTagResult = (value: unknown): value is SetTagResult =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  (value.tag === null || isMemberTag(value.tag))

const isLinkAddressResult = (value: unknown): value is LinkAddressResult =>
  isRecord(value) &&
  typeof value.stripe_email === 'string' &&
  (value.plex_email === null || typeof value.plex_email === 'string')

const isSetDownloadsResult = (value: unknown): value is SetDownloadsResult =>
  isRecord(value) && typeof value.email === 'string' && typeof value.downloads === 'boolean'

const isBanResult = (value: unknown): value is BanResult =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  typeof value.disabled === 'number' &&
  typeof value.canceled === 'number' &&
  (typeof value.cancel_at === 'string' || value.cancel_at === null)

/** What `inject` answers with, as far as reading a body goes. */
type Answer = Readonly<{ statusCode: number; body: string }>

/**
 * A 200's body, vouched for by the guard the portal reads it with. Anything
 * else fails the test with the body in the message.
 */
const bodyOf = <T>({ answer, is }: { answer: Answer; is: Guard<T> }): T => {
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

const USERS: WizarrUser[] = [
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

const LIBRARIES: WizarrLibrary[] = [
  { id: 1, name: '01. Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 2, name: '03. 4K Movies', server_id: 3, server_name: 'Vhagar', enabled: true },
  { id: 3, name: '90. Private', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 4, name: '02. Anime', server_id: 5, server_name: 'Syrax', enabled: false },
  { id: 5, name: '03. Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 6, name: '14. Kid Shows', server_id: 2, server_name: 'Meleys', enabled: true },
]

const GOLD_LIBRARIES = {
  Meleys: ['01. Movies', '03. Family Movies', '14. Kid Shows'],
  Vhagar: ['03. 4K Movies'],
}

const PLEX_SHARES: PlexAccess = {
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
const FIXTURE_LIBRARIES: WizarrLibrary[] = [
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

type Harness = Readonly<{
  app: NestFastifyApplication
  bridge: FakeBridge
  dbp: string
  snapshot: MembersSnapshot
}>

const running: Harness[] = []

/**
 * The admin routes over a fresh store and a fake bridge: the Python fixture.
 * Wizarr lists USERS and LIBRARIES and no redeemed invites (so no Stripe/Plex
 * email linkage); plex.tv has no token, since the members list must be
 * reachable without one and tests that exercise the live union opt in; and
 * Stripe finds no customer, so no test reaches the network.
 */
const harness = async ({
  settings = TEST_SETTINGS,
  adapt = asBridge,
}: {
  settings?: Settings
  adapt?: (bridge: FakeBridge) => Bridge
} = {}): Promise<Harness> => {
  const dbp = tempDbPath()
  initDb({ path: dbp })
  const bridge = fakeBridge({ dbPath: dbp, settings })
  bridge.wizarr.listUsers.mockResolvedValue(USERS)
  bridge.wizarr.listLibraries.mockResolvedValue(LIBRARIES)
  const app = await serve({ imports: [AdminModule], bridge: adapt(bridge) })
  const made = { app, bridge, dbp, snapshot: app.get<MembersSnapshot>(MEMBERS_SNAPSHOT) }
  running.push(made)
  return made
}

afterEach(async () => {
  // A route that kicked a background refresh is let finish before its app goes.
  await Promise.all(
    running.splice(0).map(async ({ app, snapshot }) => {
      await snapshot.settled()
      await app.close()
    }),
  )
  vi.unstubAllEnvs()
  removeTempDirs()
})

const get = ({ h: { app }, url }: { h: Harness; url: string }) => app.inject({ method: 'GET', url })

const post = ({
  h: { app },
  url,
  payload,
}: {
  h: Harness
  url: string
  payload: Record<string, unknown>
}) => app.inject({ method: 'POST', url, payload })

const listMembers = async (h: Harness): Promise<MemberPayload[]> =>
  bodyOf({ answer: await get({ h, url: '/admin/members' }), is: isMemberPayloadArray })

const getMember = async ({ h, email }: { h: Harness; email: string }): Promise<MemberPayload> =>
  bodyOf({
    answer: await get({ h, url: `/admin/member?email=${encodeURIComponent(email)}` }),
    is: isMemberPayload,
  })

const getEvents = async ({ h, email }: { h: Harness; email?: string }): Promise<MemberEvent[]> =>
  bodyOf({
    answer: await get({
      h,
      url:
        email === undefined ? '/admin/events' : `/admin/events?email=${encodeURIComponent(email)}`,
    }),
    is: isMemberEventArray,
  })

/** The members keyed by lowercased email, as the Python tests' `by_email`. */
const byEmail = (members: readonly MemberPayload[]): ReadonlyMap<string, MemberPayload> =>
  new Map(members.map((m) => [m.email.toLowerCase(), m]))

/** One member of the list, failing the test when it is missing. */
const memberOf = ({
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

const resetExpiry = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
  bodyOf({
    answer: await post({ h, url: '/admin/reset-expiry', payload: body }),
    is: isResetExpiryResult,
  })

const reissue = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
  bodyOf({
    answer: await post({ h, url: '/admin/reissue-invite', payload: body }),
    is: isInviteResult,
  })

const cancel = async ({ h, email }: { h: Harness; email: string }) =>
  bodyOf({
    answer: await post({ h, url: '/admin/cancel-subscription', payload: { email } }),
    is: isCancelSubscriptionResult,
  })

const ban = async ({ h, email }: { h: Harness; email: string }) =>
  bodyOf({ answer: await post({ h, url: '/admin/ban', payload: { email } }), is: isBanResult })

const setTag = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
  bodyOf({ answer: await post({ h, url: '/admin/set-tag', payload: body }), is: isSetTagResult })

const setDownloads = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
  bodyOf({
    answer: await post({ h, url: '/admin/set-downloads', payload: body }),
    is: isSetDownloadsResult,
  })

const linkAddress = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
  post({ h, url: '/admin/link-address', payload: body })

// --- require_admin ------------------------------------------------------------------------

const SUPABASE_URL = 'https://project.supabase.co'
const KID = 'supabase-test-key'

// One throwaway ES256 keypair standing in for Supabase's, so a token really
// verifies rather than a stubbed-out decode passing whatever it is handed.
const signingKey = await generateKeyPair('ES256')
const publicKeySet = createLocalJWKSet({
  keys: [{ ...(await exportJWK(signingKey.publicKey)), kid: KID, alg: 'ES256', use: 'sig' }],
})

const token = ({ email, key = signingKey.privateKey }: { email: string; key?: CryptoKey }) =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuer(`${SUPABASE_URL}/auth/v1`)
    .setAudience('authenticated')
    .sign(key)

describe('require_admin', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    const dbp = tempDbPath()
    initDb({ path: dbp })
    vi.stubEnv('SUPABASE_URL', SUPABASE_URL)
    vi.stubEnv('ADMIN_ALLOWED_EMAILS', 'cj.rivas.dev@gmail.com')
    app = await serve({
      imports: [AdminModule],
      bridge: asBridge(fakeBridge({ dbPath: dbp })),
      keySet: publicKeySet,
    })
  })

  afterEach(async () => {
    await app.close()
  })

  const notes = (authorization: string) =>
    app.inject({ method: 'GET', url: '/admin/notes?email=a@x.com', headers: { authorization } })

  it('rejects a missing or malformed bearer', async () => {
    const answers = await Promise.all(['', 'nope', 'Basic abc', 'Bearer '].map(notes))
    expect(answers.map((answer) => answer.statusCode)).toEqual([401, 401, 401, 401])
    expect(answers[0]?.json()).toEqual({ detail: 'unauthorized' })
  })

  it('fails closed without config', async () => {
    // JWKS unconfigured -> reject everything, even a genuinely signed admin
    vi.stubEnv('SUPABASE_URL', undefined)
    const answer = await notes(`Bearer ${await token({ email: 'cj.rivas.dev@gmail.com' })}`)
    expect(answer.statusCode).toBe(401)
  })

  it('accepts an allowlisted supabase session', async () => {
    // mixed case in the claim proves the comparison is case-insensitive
    const answer = await notes(`Bearer ${await token({ email: 'CJ.Rivas.dev@gmail.com' })}`)
    expect(answer.statusCode).toBe(200)
  })

  it('rejects a non-allowlisted email', async () => {
    const answer = await notes(`Bearer ${await token({ email: 'stranger@example.com' })}`)
    expect(answer.statusCode).toBe(401)
  })
})

// --- the members list ---------------------------------------------------------------------

describe('GET /admin/members', () => {
  it('dedupes and joins the tier', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const members = await listMembers(h)

    const cj = memberOf({ members, email: 'a@x.com' })
    expect(cj.member).toBe('cj')
    expect([...cj.servers].toSorted()).toEqual(['Meleys', 'Vhagar']) // 2 records -> 1 person
    expect(cj.expires).toBe('2026-09-10T00:00:00+00:00') // latest wins
    expect(cj.subscribed).toBe(true)
    expect(cj.tier).toBe('gold')
    expect(cj.downloads).toBe(true) // derived from tier
    // per-server access derives from tier rules: only the share server
    // grants anything, and 90. private is never shown
    expect(cj.libraries).toEqual(GOLD_LIBRARIES)

    const nora = memberOf({ members, email: 'nora@x.com' })
    expect(nora.subscribed).toBe(false)
    expect(nora.tier).toBe('unknown')
    expect(nora.downloads).toBeNull()
    expect(nora.libraries).toEqual({ Syrax: [] }) // unknown tier grants nothing
  })

  it('unions the live plex share', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessAll.mockResolvedValue(PLEX_SHARES)
    const members = await listMembers(h)

    const cj = memberOf({ members, email: 'a@x.com' })
    // a server only plex.tv knows about is unioned in with Wizarr's records
    expect(cj.servers).toEqual(['Caraxes', 'Meleys', 'Vhagar'])
    // plex is ground truth where it has an answer...
    expect(cj.libraries?.Meleys).toEqual(['01. Movies', '05. TV Shows'])
    expect(cj.libraries?.Caraxes).toEqual(['09. Basketball'])
    // ...and gold reaches Vhagar too, so the tier derives its library there
    expect(cj.libraries?.Vhagar).toEqual(['03. 4K Movies'])

    // unknown tier derives no libraries, so plex is the only real answer here
    expect(memberOf({ members, email: 'nora@x.com' }).libraries).toEqual({ Syrax: ['02. Anime'] })
  })

  it('gives plex-only servers to a member who never joined', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_max',
      email: 'max@x.com',
      inviteCode: 'INV1',
      tier: 'youth',
    })
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessAll.mockResolvedValue({
      'max@x.com': {
        Meleys: { all_libraries: false, allow_sync: false, libraries: ['03. Family Movies'] },
      },
    })
    const mx = memberOf({ members: await listMembers(h), email: 'max@x.com' })
    expect(mx.servers).toEqual(['Meleys']) // legacy share, no Wizarr record
    expect(mx.libraries).toEqual({ Meleys: ['03. Family Movies'] })
  })

  it('falls back to tier access without a plex token', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.servers).toEqual(['Meleys', 'Vhagar'])
    expect(cj.libraries).toEqual(GOLD_LIBRARIES)
    expect(h.bridge.plex.sharedAccessAll).not.toHaveBeenCalled()
  })

  it('survives a plex.tv failure', async () => {
    // plex.tv is an enrichment, never a dependency: the table must still load.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessAll.mockRejectedValue(new PlexUnavailable('plex.tv down'))
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.servers).toEqual(['Meleys', 'Vhagar'])
    expect(cj.libraries).toEqual(GOLD_LIBRARIES)
  })

  it('reads subscribed off the flag, not the expiry', async () => {
    // a@x.com carries a future Wizarr expiry in USERS, but only an admin-issued
    // invite (no confirmed payment). subscribed must be false despite the expiry
    // — this is what lets a member read "Invited" while a 14-day clock counts down.
    const h = await harness()
    upsertPendingByEmail({ path: h.dbp, email: 'a@x.com', inviteCode: 'INV1', tier: 'gold' })
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.expires).toBe('2026-09-10T00:00:00+00:00') // future expiry present
    expect(cj.subscribed).toBe(false) // but no payment on record
    expect(cj.invited_at).not.toBeNull() // admin invite stamped it
  })

  it('includes subscribers not yet joined', async () => {
    const h = await harness()
    // a Stripe subscriber the bridge knows who never redeemed a Wizarr invite
    upsertPending({
      path: h.dbp,
      customerId: 'cus_max',
      email: 'max@x.com',
      inviteCode: 'INV1',
      tier: 'youth',
    })
    const members = await listMembers(h)
    expect(byEmail(members).has('max@x.com')).toBe(true) // shown despite having no Wizarr record
    const mx = memberOf({ members, email: 'max@x.com' })
    expect(mx.tier).toBe('youth')
    expect(mx.downloads).toBe(true) // derived from youth
    expect(mx.subscribed).toBe(true) // checkout completed -> confirmed payment
    // They have not joined yet, so they hold nothing: servers and libraries are
    // what a member can actually watch, and inventing them from the tier is how
    // a locked-out member reads as fully served on /manage. What redeeming
    // would grant them is carried separately, in entitled.
    expect(mx.servers).toEqual([])
    expect(mx.libraries).toEqual({})
    expect(mx.entitled).toEqual({ Meleys: ['03. Family Movies', '14. Kid Shows'] })
    expect(mx.invited_at).not.toBeNull() // upsert stamped the grace clock
  })

  it("gives a pending subscriber their tier's libraries as entitlement", async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_g',
      email: 'gold@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    upsertPending({
      path: h.dbp,
      customerId: 'cus_y',
      email: 'youth@x.com',
      inviteCode: 'INV2',
      tier: 'youth',
    })
    const members = await listMembers(h)
    // entitled is the tier-derived set; libraries stays empty until they join
    expect(memberOf({ members, email: 'gold@x.com' }).entitled).toEqual(GOLD_LIBRARIES)
    expect(memberOf({ members, email: 'youth@x.com' }).entitled).toEqual({
      Meleys: ['03. Family Movies', '14. Kid Shows'],
    })
    expect(memberOf({ members, email: 'gold@x.com' }).libraries).toEqual({})
  })

  it('shows nothing for a pending subscriber with an unknown tier', async () => {
    // No tier recorded means no basis to claim any access.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_n',
      email: 'notier@x.com',
      inviteCode: 'INV1',
      tier: null,
    })
    const mx = memberOf({ members: await listMembers(h), email: 'notier@x.com' })
    expect(mx.tier).toBe('unknown')
    expect(mx.servers).toEqual([])
    expect(mx.libraries).toEqual({})
  })

  it('never shows a pending subscriber a private library', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_g',
      email: 'gold@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    const mx = memberOf({ members: await listMembers(h), email: 'gold@x.com' })
    const names = Object.values(mx.libraries ?? {}).flat()
    expect(names).not.toContain('90. Private')
  })

  it('never pays for a stripe lookup', async () => {
    // The list is one row per member; a per-row Stripe search would crawl.
    const h = await harness()
    upsertPendingByEmail({ path: h.dbp, email: 'max@x.com', inviteCode: 'INV1', tier: 'youth' })
    await listMembers(h)
    expect(h.bridge.stripe.searchCustomerId).not.toHaveBeenCalled()
  })

  it('serves the warm snapshot', async () => {
    const h = await harness()
    const first = await listMembers(h)
    // Upstream changes but the snapshot keeps serving until a refresh runs.
    h.bridge.wizarr.listUsers.mockResolvedValue([])
    expect(await listMembers(h)).toEqual(first)
    expect(h.bridge.wizarr.listUsers).toHaveBeenCalledTimes(1)
    await h.snapshot.refresh()
    expect(await listMembers(h)).toEqual([])
  })

  it('keeps overrides live on a cached snapshot', async () => {
    const h = await harness()
    await listMembers(h)
    setMemberTag({ path: h.dbp, email: 'a@x.com', tag: 'vip' })
    // DB join fresh despite cached upstream
    expect(memberOf({ members: await listMembers(h), email: 'a@x.com' }).tag).toBe('vip')
  })

  it('carries a pure tier entitlement map', async () => {
    // `libraries` is keyed by the servers a member actually holds records on, so
    // it cannot answer "what does this tier grant". `entitled` is the tier rules
    // alone — the baseline the member page compares the live plex.tv share to.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.entitled).toEqual(GOLD_LIBRARIES)
    // gold entitles Vhagar now, and the member holds a record there
    expect(cj.servers).toContain('Vhagar')
    expect(Object.keys(cj.entitled ?? {})).toContain('Vhagar')
  })

  it('makes entitlement follow the tier, not the records', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'youth',
    })
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.entitled).toEqual({ Meleys: ['03. Family Movies', '14. Kid Shows'] })
  })

  it('entitles an unknown tier to nothing', async () => {
    const h = await harness()
    const nora = memberOf({ members: await listMembers(h), email: 'nora@x.com' })
    expect(nora.tier).toBe('unknown')
    expect(nora.entitled).toEqual({})
  })

  it('keeps the entitlement through the plex union', async () => {
    // withPlexAccess rewrites `libraries` with what plex.tv reports; the
    // entitlement baseline must NOT be overwritten or the comparison collapses.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessAll.mockResolvedValue(PLEX_SHARES)
    const cj = memberOf({ members: await listMembers(h), email: 'a@x.com' })
    expect(cj.libraries?.Meleys).toEqual(['01. Movies', '05. TV Shows']) // plex wins here
    expect(cj.entitled).toEqual(GOLD_LIBRARIES) // tier stands
  })

  it('does not show the pending entitlement as what they hold', async () => {
    // The two must not be conflated: entitled is what the tier grants on
    // redeeming, libraries is what they can watch right now.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_g',
      email: 'gold@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    const mx = memberOf({ members: await listMembers(h), email: 'gold@x.com' })
    expect(mx.entitled).toEqual(GOLD_LIBRARIES)
    expect(mx.libraries).toEqual({})
  })

  it('answers every field of a member, null rather than missing', async () => {
    // The portal tolerates some fields missing for an older bridge; this one
    // always sends every key, as the Python did.
    const h = await harness()
    const [first] = await listMembers(h)
    expect(Object.keys(first ?? {}).toSorted()).toEqual(
      [
        'member',
        'email',
        'tier',
        'downloads',
        'expires',
        'servers',
        'libraries',
        'entitled',
        'subscribed',
        'payment_state',
        'invited_at',
        'customer_id',
        'stripe_email',
        'tag',
      ].toSorted(),
    )
  })
})

// --- one address paying for another ---------------------------------------------------------

describe('the stripe address and the plex address', () => {
  it('reads a member paying under another address as one row, not two', async () => {
    // The Stripe email and the Plex email are two addresses for one person.
    //
    // Someone can check out with one address and create their Plex account with
    // another. Keyed on email alone that is two members: one "subscribed" row
    // holding no access and one Plex row that never paid. The invite is what ties
    // them together, because whoever redeemed it is the person who paid for it.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    // redeemed by nora@x.com
    h.bridge.wizarr.listInvitations.mockResolvedValue([
      { id: 1, code: 'INV1', used_by: '<User 3>' },
    ])
    h.snapshot.clear()

    const members = await listMembers(h)
    // one row, under the Plex address they actually watch with
    expect(byEmail(members).has('nora@x.com')).toBe(true)
    expect(byEmail(members).has('stripe-only@x.com')).toBe(false)
    const nora = memberOf({ members, email: 'nora@x.com' })
    expect(nora.stripe_email).toBe('stripe-only@x.com')
    expect(nora.tier).toBe('gold') // the tier they pay for
    expect(nora.subscribed).toBe(true) // the payment follows the person
    expect(nora.customer_id).toBe('cus_1')
  })

  it('carries no separate stripe email for matching addresses', async () => {
    // The common case must not render the same string twice.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([
      { id: 1, code: 'INV1', used_by: '<User 1>' },
    ])
    h.snapshot.clear()
    expect(memberOf({ members: await listMembers(h), email: 'a@x.com' }).stripe_email).toBeNull()
  })

  it('links nothing through an unredeemed invite', async () => {
    // Until someone redeems it, the bridge has no basis to merge two rows.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([{ id: 1, code: 'INV1', used_by: null }])
    h.snapshot.clear()
    const members = await listMembers(h)
    expect(byEmail(members).has('stripe-only@x.com')).toBe(true) // still stands on its own
    expect(memberOf({ members, email: 'stripe-only@x.com' }).stripe_email).toBeNull()
    expect(memberOf({ members, email: 'nora@x.com' }).subscribed).toBe(false)
  })

  it('collapses through a linked address a pair no invite can join', async () => {
    // The Jimmy case: two customers, one person, and an invite never redeemed.
    //
    // Someone whose card declines and who re-subscribes under a re-typed address
    // already holds access, so the new checkout's invite sits unredeemed forever
    // and `used_by` can never tie the two together. The admin's link is the only
    // thing that can, and it has to produce exactly what the invite join would.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_new',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([{ id: 1, code: 'INV1', used_by: null }])
    setMemberLink({ path: h.dbp, stripeEmail: 'stripe-only@x.com', plexEmail: 'nora@x.com' })
    h.snapshot.clear()

    const members = await listMembers(h)
    expect(byEmail(members).has('stripe-only@x.com')).toBe(false) // no longer its own row
    const nora = memberOf({ members, email: 'nora@x.com' })
    expect(nora.stripe_email).toBe('stripe-only@x.com')
    expect(nora.tier).toBe('gold')
    expect(nora.subscribed).toBe(true)
    expect(nora.customer_id).toBe('cus_new')
  })

  it("lets a link outrank a customer row at the member's own address", async () => {
    // The dead address is usually still a customer; the live one must win.
    //
    // A member who re-subscribed has two Stripe customers: the failing one at
    // their own address and the paying one at the other. Reading billing from
    // the row that merely matches on email would show the abandoned subscription
    // and its tier while the money arrives somewhere else.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_dead',
      email: 'nora@x.com',
      inviteCode: 'INVOLD',
      tier: 'bronze',
    })
    upsertPending({
      path: h.dbp,
      customerId: 'cus_live',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([{ id: 1, code: 'INV1', used_by: null }])
    setMemberLink({ path: h.dbp, stripeEmail: 'stripe-only@x.com', plexEmail: 'nora@x.com' })
    h.snapshot.clear()

    const members = await listMembers(h)
    expect(byEmail(members).has('stripe-only@x.com')).toBe(false)
    const nora = memberOf({ members, email: 'nora@x.com' })
    expect(nora.customer_id).toBe('cus_live') // the one actually paying
    expect(nora.tier).toBe('gold')
    expect(nora.stripe_email).toBe('stripe-only@x.com')
  })

  it('puts an unlinked address back on its own', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_new',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([{ id: 1, code: 'INV1', used_by: null }])
    setMemberLink({ path: h.dbp, stripeEmail: 'stripe-only@x.com', plexEmail: 'nora@x.com' })
    setMemberLink({ path: h.dbp, stripeEmail: 'stripe-only@x.com', plexEmail: null })
    h.snapshot.clear()

    const members = await listMembers(h)
    expect(byEmail(members).has('stripe-only@x.com')).toBe(true)
    expect(memberOf({ members, email: 'nora@x.com' }).stripe_email).toBeNull()
  })

  it('resolves a plain username in used_by too', async () => {
    // Wizarr returns a repr today; a real username must keep working.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([{ id: 1, code: 'INV1', used_by: 'nora' }])
    h.snapshot.clear()
    expect(memberOf({ members: await listMembers(h), email: 'nora@x.com' }).stripe_email).toBe(
      'stripe-only@x.com',
    )
  })

  it('shows the stripe address on the member page', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockResolvedValue([
      { id: 1, code: 'INV1', used_by: '<User 3>' },
    ])
    const m = await getMember({ h, email: 'nora@x.com' })
    expect(m.stripe_email).toBe('stripe-only@x.com')
    expect(m.customer_id).toBe('cus_1')
  })

  it('keeps the member page up when wizarr refuses the invitation list', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'stripe-only@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    h.bridge.wizarr.listInvitations.mockRejectedValue(new Error('wizarr is down'))
    const m = await getMember({ h, email: 'nora@x.com' })
    expect(m.stripe_email).toBeNull() // linkage lost, page still renders
  })
})

describe('POST /admin/link-address', () => {
  it('refuses a self link', async () => {
    const h = await harness()
    const answer = await linkAddress({
      h,
      body: { stripe_email: 'a@x.com', plex_email: 'A@x.com' },
    })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: 'an address cannot link to itself' })
  })

  it('refuses a chain', async () => {
    const h = await harness()
    setMemberLink({ path: h.dbp, stripeEmail: 'b@x.com', plexEmail: 'c@x.com' })
    const answer = await linkAddress({
      h,
      body: { stripe_email: 'a@x.com', plex_email: 'b@x.com' },
    })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: 'b@x.com already pays under c@x.com; unlink it first' })
  })

  it('records both sides', async () => {
    const h = await harness()
    const answer = await linkAddress({
      h,
      body: { stripe_email: 'Pays@x.com', plex_email: 'Watches@x.com' },
    })
    expect(bodyOf({ answer, is: isLinkAddressResult })).toEqual({
      stripe_email: 'pays@x.com',
      plex_email: 'watches@x.com',
    })
    expect(allMemberLinks({ path: h.dbp })).toEqual(new Map([['pays@x.com', 'watches@x.com']]))
    expect(eventsForEmail({ path: h.dbp, email: 'watches@x.com' }).map((e) => e.action)).toEqual([
      'Address linked',
    ])
    expect(eventsForEmail({ path: h.dbp, email: 'pays@x.com' }).map((e) => e.action)).toEqual([
      'Address linked',
    ])
  })
})

// --- the member page ----------------------------------------------------------------------------

describe('GET /admin/member', () => {
  it('finds a member, and 404s a missing one', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const found = await getMember({ h, email: 'a@x.com' })
    expect(found.member).toBe('cj')
    expect(found.libraries).toEqual(GOLD_LIBRARIES)
    const missing = await get({ h, url: '/admin/member?email=ghost@x.com' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toEqual({ detail: 'no member for that email' })
  })

  it("shows a pending subscriber their tier's libraries", async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_g',
      email: 'gold@x.com',
      inviteCode: 'INV1',
      tier: 'gold',
    })
    const m = await getMember({ h, email: 'gold@x.com' })
    // entitled drives the member page's Servers section; holding nothing yet is
    // reported as holding nothing.
    expect(m.entitled).toEqual(GOLD_LIBRARIES)
    expect(m.servers).toEqual([])
    expect(m.libraries).toEqual({})
  })

  it('falls back to the subscriber', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_max',
      email: 'max@x.com',
      inviteCode: 'INV1',
      tier: 'youth',
    })
    const m = await getMember({ h, email: 'max@x.com' })
    expect(m.email.toLowerCase()).toBe('max@x.com')
    expect(m.tier).toBe('youth')
    expect(m.subscribed).toBe(true) // checkout completed -> confirmed payment
    // in neither Wizarr nor customer_map
    expect((await get({ h, url: '/admin/member?email=nobody@nowhere.com' })).statusCode).toBe(404)
  })

  it('carries the stripe customer id on both member payloads', async () => {
    // Real cus_ ids surface on both endpoints; admin placeholders never leak.
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    upsertPendingByEmail({ path: h.dbp, email: 'max@x.com', inviteCode: 'INV1', tier: 'youth' })

    const members = await listMembers(h)
    expect(memberOf({ members, email: 'a@x.com' }).customer_id).toBe('cus_1')
    expect(memberOf({ members, email: 'max@x.com' }).customer_id).toBeNull() // admin:<email> placeholder
    expect(memberOf({ members, email: 'nora@x.com' }).customer_id).toBeNull() // no customer_map row at all

    expect((await getMember({ h, email: 'a@x.com' })).customer_id).toBe('cus_1') // joined member
    expect((await getMember({ h, email: 'max@x.com' })).customer_id).toBeNull() // nothing at Stripe either
  })

  it('finds a stripe customer the store never recorded', async () => {
    // An admin-invited member still links to Stripe when a customer exists there.
    //
    // customer_map only holds a real cus_ for members the bridge put there via a
    // checkout; everyone else carries an "admin:<email>" placeholder. Concluding
    // from that placeholder that they have no Stripe record is how a paying
    // member's billing history became unreachable from their own page.
    const h = await harness()
    upsertPendingByEmail({ path: h.dbp, email: 'max@x.com', inviteCode: 'INV1', tier: 'youth' })
    h.bridge.stripe.searchCustomerId.mockResolvedValue('cus_real')
    expect((await getMember({ h, email: 'max@x.com' })).customer_id).toBe('cus_real')
    expect(h.bridge.stripe.searchCustomerId).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.searchCustomerId).toHaveBeenCalledWith('max@x.com')
  })

  it('survives a stripe lookup failure', async () => {
    const h = await harness()
    upsertPendingByEmail({ path: h.dbp, email: 'max@x.com', inviteCode: 'INV1', tier: 'youth' })
    h.bridge.stripe.searchCustomerId.mockRejectedValue(new Error('stripe is down'))
    expect((await getMember({ h, email: 'max@x.com' })).customer_id).toBeNull() // page still renders
  })

  it('carries the entitlement too', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    const m = await getMember({ h, email: 'a@x.com' })
    expect(m.entitled).toEqual({ Meleys: ['01. Movies', '03. Family Movies', '14. Kid Shows'] })
  })

  it('needs an email, as a 422', async () => {
    const h = await harness()
    const answer = await get({ h, url: '/admin/member' })
    expect(answer.statusCode).toBe(422)
    expect(Array.isArray(answer.json().detail)).toBe(true)
  })
})

// --- plex.tv ------------------------------------------------------------------------------------

describe('GET /admin/plex-access', () => {
  it('requires a token', async () => {
    const h = await harness()
    const answer = await get({ h, url: '/admin/plex-access?email=a@x.com' })
    expect(answer.statusCode).toBe(503)
    expect(answer.json()).toEqual({ detail: 'PLEX_TOKEN not configured' })
  })

  it('returns per-server shares', async () => {
    const h = await harness()
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessForEmail.mockResolvedValue({
      Meleys: { all_libraries: true, allow_sync: true, libraries: ['01. Movies'] },
    })
    const out = bodyOf({
      answer: await get({ h, url: '/admin/plex-access?email=a@x.com' }),
      is: isPlexAccess,
    })
    expect(out.email).toBe('a@x.com')
    expect(out.servers.Meleys?.all_libraries).toBe(true)
  })

  it('maps a plex.tv failure to 502', async () => {
    const h = await harness()
    h.bridge.plex.hasToken.mockReturnValue(true)
    h.bridge.plex.sharedAccessForEmail.mockRejectedValue(new PlexUnavailable('plex.tv down'))
    const answer = await get({ h, url: '/admin/plex-access?email=a@x.com' })
    expect(answer.statusCode).toBe(502)
    expect(answer.json()).toEqual({ detail: 'plex.tv lookup failed' })
  })
})

// --- history and notes ----------------------------------------------------------------------------

describe('history and notes', () => {
  it('appends admin actions to the member history', async () => {
    const h = await harness()
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([])
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    await reissue({ h, body: { email: 'A@X.com', tier: 'gold' } })
    await resetExpiry({ h, body: { email: 'a@x.com', days: 35 } })

    const events = await getEvents({ h, email: 'a@x.com' })
    expect(events.map((e) => e.action)).toEqual(['Expiry reset', 'Invite issued']) // newest first
    expect(events[1]?.detail).toContain('gold tier')
    expect(events[0]?.detail).toBe('35 days')
  })

  it('roundtrips notes, case-insensitive on the email', async () => {
    const h = await harness()
    const notes = async () =>
      bodyOf({ answer: await get({ h, url: '/admin/notes?email=a@x.com' }), is: isMemberNotes })
    expect(await notes()).toEqual({ email: 'a@x.com', notes: '' })
    const out = bodyOf({
      answer: await post({
        h,
        url: '/admin/notes',
        payload: { email: 'A@X.com', notes: 'prefers 4K remuxes' },
      }),
      is: isMemberNotes,
    })
    expect(out).toEqual({ email: 'A@X.com', notes: 'prefers 4K remuxes' })
    expect((await notes()).notes).toBe('prefers 4K remuxes')
  })

  it('lists every member without an email', async () => {
    const h = await harness()
    recordEvent({
      path: h.dbp,
      email: 'a@x.com',
      action: 'Signed up',
      detail: 'gold tier — invite emailed',
    })
    recordEvent({
      path: h.dbp,
      email: 'b@x.com',
      action: 'Signed up',
      detail: 'bronze tier — invite emailed',
    })

    expect((await getEvents({ h })).map((e) => e.email)).toEqual(['b@x.com', 'a@x.com'])
    expect((await getEvents({ h, email: 'a@x.com' })).map((e) => e.email)).toEqual(['a@x.com'])
  })
})

// --- expiry -----------------------------------------------------------------------------------------

describe('POST /admin/reset-expiry', () => {
  it('sets an absolute date on every record', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9, 12])
    const out = await resetExpiry({ h, body: { email: 'a@x.com', days: 15 } })
    expect(out.updated).toBe(2)
    expect(out.expires).not.toBeNull()
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledTimes(2)
  })

  it('clears with null days', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    const out = await resetExpiry({ h, body: { email: 'a@x.com', days: null } })
    expect(out).toEqual({ updated: 1, expires: null })
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledTimes(1)
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledWith({ userId: 9, expires: null })
  })

  it('reaches wizarr as an empty body for never-expire', async () => {
    // Route through the REAL wizarr client down to the wire.
    //
    // The unit tests above fake the client, which is exactly how a
    // serialization bug (a literal null Wizarr 400s) once slipped through —
    // this pins the actual HTTP body a never-expire produces.
    const calls: { url: string; init: RequestInit }[] = []
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      calls.push({ url, init })
      return init.method === 'GET'
        ? Response.json({ users: [{ id: 9, username: 'cj', email: 'a@x.com', server: 'Meleys' }] })
        : Response.json({ message: 'ok', new_expiry: null })
    }
    const h = await harness({
      adapt: (bridge) => ({
        ...bridge,
        wizarr: {
          ...bridge.wizarr,
          ...wizarrClient({ baseUrl: 'http://wizarr.test', apiKey: 'k', fetch }),
        },
      }),
    })
    const out = await resetExpiry({ h, body: { email: 'a@x.com' } })
    expect(out).toEqual({ updated: 1, expires: null })
    expect(calls[1]?.url).toBe('http://wizarr.test/api/users/9/update-expiry')
    const body = calls[1]?.init.body
    expect(typeof body === 'string' ? JSON.parse(body) : body).toEqual({})
  })

  it('accepts an absolute datetime', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    const out = await resetExpiry({
      h,
      body: { email: 'a@x.com', expires_at: '2026-08-01T00:01:00Z' },
    })
    expect(out).toEqual({ updated: 1, expires: '2026-08-01T00:01:00+00:00' })
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledTimes(1)
    expect(h.bridge.wizarr.setExpiry).toHaveBeenCalledWith({
      userId: 9,
      expires: '2026-08-01T00:01:00+00:00',
    })
    const events = await getEvents({ h, email: 'a@x.com' })
    expect(events[0]?.detail).toBe('to 2026-08-01T00:01:00+00:00')
  })

  it('rejects a malformed expires_at', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    const answer = await post({
      h,
      url: '/admin/reset-expiry',
      payload: {
        email: 'a@x.com',
        expires_at: 'next tuesday',
      },
    })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: 'expires_at is not an ISO datetime' })
    expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
  })

  it('404s when there are no records', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])
    const answer = await post({
      h,
      url: '/admin/reset-expiry',
      payload: { email: 'ghost@x.com', days: 15 },
    })
    expect(answer.statusCode).toBe(404)
    expect(answer.json()).toEqual({ detail: 'no member for that email' })
  })

  it('kicks a snapshot refresh', async () => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([1])
    const refreshed = vi.spyOn(h.snapshot, 'refreshAsync').mockImplementation(() => {})
    await resetExpiry({ h, body: { email: 'a@x.com', days: 30 } })
    expect(refreshed).toHaveBeenCalledTimes(1)
  })
})

// --- tier ---------------------------------------------------------------------------------------------

describe('POST /admin/reset-tier', () => {
  const resetTier = async ({ h, body }: { h: Harness; body: Record<string, unknown> }) =>
    bodyOf({
      answer: await post({ h, url: '/admin/reset-tier', payload: body }),
      is: isResetTierResult,
    })

  it('hard-sets the record and logs', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const out = await resetTier({ h, body: { email: 'A@X.com', tier: 'bronze' } })
    expect(out).toEqual({ email: 'A@X.com', tier: 'bronze' })
    expect(allCustomerTiers({ path: h.dbp })).toEqual(new Map([['a@x.com', 'bronze']]))
    const events = await getEvents({ h, email: 'a@x.com' })
    expect(events[0]?.action).toBe('Tier reset')
    expect(events[0]?.detail).toBe('hard reset to bronze')
    // record-only: no invite, no disable, no Wizarr call at all
    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled()
  })

  it.each(['bronze', 'silver', 'gold', 'youth'])('hard-sets each tier: %s', async (tier) => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const out = await resetTier({ h, body: { email: 'a@x.com', tier } })
    expect(out).toEqual({ email: 'a@x.com', tier })
    expect(allCustomerTiers({ path: h.dbp })).toEqual(new Map([['a@x.com', tier]]))
    expect((await getEvents({ h, email: 'a@x.com' }))[0]?.detail).toBe(`hard reset to ${tier}`)
  })

  it('rejects an unknown tier', async () => {
    const h = await harness()
    const answer = await post({
      h,
      url: '/admin/reset-tier',
      payload: { email: 'a@x.com', tier: 'platinum' },
    })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: "unknown tier 'platinum'" })
    expect(allCustomerTiers({ path: h.dbp })).toEqual(new Map())
  })
})

// --- reissue ----------------------------------------------------------------------------------------------

describe('POST /admin/reissue-invite', () => {
  it('keeps covered records enabled', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    // every record sits on a server the new scope covers -> access survives
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Meleys' }])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    const out = await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })

    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled() // redeeming re-scopes in place
    // private 99. and the retired Vermithor mirror excluded -> ids 17 + 20
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledTimes(1)
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledWith({
      serverIds: [2],
      expiresInDays: 14,
      duration: '35',
      libraryIds: [17, 20],
      allowDownloads: false,
    })
    expect(out.disabled).toBe(0)
    expect(out.code).toBe('xyz')
    expect(out.url).toBe('http://inv.test/j/xyz') // public URL, not the LAN one
    expect(out.tier).toBe('silver')
  })

  it('disables all records when a server is uncovered', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    // the retired servers are in no tier's scope and there is no per-server
    // unshare, so the reissue falls back to disable-first
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([
      { id: 9, server: 'Meleys' },
      { id: 12, server: 'Caraxes' },
    ])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    const out = await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })

    expect(h.bridge.wizarr.disableUser).toHaveBeenCalledTimes(2) // all records dropped, not just Caraxes's
    // invite must be created BEFORE any disable, so a create failure can't lock
    // the member out with no link to re-redeem
    const [created] = h.bridge.wizarr.createInvite.mock.invocationCallOrder
    const [firstDisable] = h.bridge.wizarr.disableUser.mock.invocationCallOrder
    expect(created).toBeLessThan(firstDisable ?? 0)
    expect(out.disabled).toBe(2)
  })

  it('emails the link', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    const out = await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledTimes(1)
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledWith({
      to: 'a@x.com',
      inviteUrl: 'http://inv.test/j/xyz',
    })
    expect(out.emailed).toBe(true)
  })

  it('survives an email failure', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Caraxes' }])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    h.bridge.mailer.sendInvite.mockRejectedValue(new Error('smtp down'))
    const out = await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })
    // the reissue itself completed; the admin still gets the link to send manually
    expect(h.bridge.wizarr.disableUser).toHaveBeenCalledTimes(1) // Caraxes retired -> disable path
    expect(out.emailed).toBe(false)
    expect(out.url).toBe('http://inv.test/j/xyz')
  })

  it('keeps the member visible as pending', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Meleys' }])
    h.bridge.wizarr.createInvite.mockResolvedValue({
      code: 'NEW1',
      url: 'http://wizarr-lan/j/NEW1',
    })
    await reissue({ h, body: { email: 'Code@X.com', tier: 'gold' } })

    // even if Wizarr later drops the records, the store row keeps them listed
    h.bridge.wizarr.listUsers.mockResolvedValue([])
    await h.snapshot.settled()
    await h.snapshot.refresh()
    const members = await listMembers(h)
    expect(byEmail(members).has('code@x.com')).toBe(true) // still listed while the invite is pending
    const pending = memberOf({ members, email: 'code@x.com' })
    expect(pending.tier).toBe('gold')
    expect(pending.subscribed).toBe(false)
    expect(pending.invited_at).not.toBeNull() // grace clock started
  })

  it('fails closed without a public base', async () => {
    const h = await harness({ settings: { ...TEST_SETTINGS, publicInviteBase: '' } })
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Caraxes' }])
    const answer = await post({
      h,
      url: '/admin/reissue-invite',
      payload: { email: 'a@x.com', tier: 'silver' },
    })
    expect(answer.statusCode).toBe(500)
    expect(answer.json()).toEqual({ detail: 'PUBLIC_INVITE_BASE not configured' })
    expect(h.bridge.wizarr.disableUser).not.toHaveBeenCalled() // fails before any destructive action
  })

  it('applies the downloads override', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Vermithor' }])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    setMemberDownloads({ path: h.dbp, email: 'a@x.com', allow: true })

    await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })

    // silver's tier default is allowDownloads false; the override wins
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledWith(
      expect.objectContaining({ allowDownloads: true }),
    )
  })

  it('kicks a snapshot refresh', async () => {
    const h = await harness()
    h.bridge.wizarr.listLibraries.mockResolvedValue(FIXTURE_LIBRARIES)
    h.bridge.wizarr.findUsersByEmail.mockResolvedValue([{ id: 9, server: 'Vermithor' }])
    h.bridge.wizarr.createInvite.mockResolvedValue({ code: 'xyz', url: 'http://wizarr-lan/j/xyz' })
    const refreshed = vi.spyOn(h.snapshot, 'refreshAsync').mockImplementation(() => {})
    await reissue({ h, body: { email: 'a@x.com', tier: 'silver' } })
    expect(refreshed).toHaveBeenCalledTimes(1)
  })

  it('refuses a banned member', async () => {
    const h = await harness()
    setMemberTag({ path: h.dbp, email: 'a@x.com', tag: 'banned' })
    const answer = await post({
      h,
      url: '/admin/reissue-invite',
      payload: { email: 'A@X.com', tier: 'gold' },
    })
    expect(answer.statusCode).toBe(409)
    expect(answer.json().detail).toContain('banned')
    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
  })
})

// --- the two mounts ----------------------------------------------------------------------------------------

describe('the two mounts', () => {
  it('mounts the admin routes bare and prefixed', async () => {
    const h = await harness()
    const answers = await Promise.all([
      get({ h, url: '/admin/members' }),
      get({ h, url: '/stripe/admin/members' }),
      post({ h, url: '/admin/reissue-invite', payload: { email: 'a@x.com', tier: 'gold' } }),
      get({ h, url: '/admin/notes?email=a@x.com' }),
      get({ h, url: '/admin/events' }),
    ])
    expect(answers.map((answer) => answer.statusCode)).toEqual([200, 200, 200, 200, 200])
  })

  // Every route the portal calls, with a request each can answer 200 to.
  const ROUTES: readonly (readonly [
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ])[] = [
    ['GET', 'members'],
    ['GET', 'member?email=a@x.com'],
    ['GET', 'plex-access?email=a@x.com'],
    ['GET', 'events'],
    ['GET', 'events?email=a@x.com'],
    ['GET', 'notes?email=a@x.com'],
    ['POST', 'notes', { email: 'a@x.com', notes: 'n' }],
    ['POST', 'set-tag', { email: 'a@x.com', tag: 'vip' }],
    ['POST', 'set-downloads', { email: 'a@x.com', allow: true }],
    ['POST', 'link-address', { stripe_email: 'p@x.com', plex_email: null }],
    ['POST', 'cancel-subscription', { email: 'a@x.com' }],
    ['POST', 'reset-expiry', { email: 'a@x.com', days: 5 }],
    ['POST', 'reset-tier', { email: 'a@x.com', tier: 'gold' }],
    ['POST', 'reissue-invite', { email: 'a@x.com', tier: 'gold' }],
    // last: a banned member's reissue is a 409
    ['POST', 'ban', { email: 'a@x.com' }],
  ]

  it.each(['/admin/', '/stripe/admin/'])(
    'answers every route under %s, POSTs with a 200',
    async (prefix) => {
      const h = await harness()
      upsertPending({
        path: h.dbp,
        customerId: 'cus_1',
        email: 'a@x.com',
        inviteCode: 'abc',
        tier: 'gold',
      })
      h.bridge.plex.hasToken.mockReturnValue(true)
      h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([1])
      h.bridge.stripe.subscriptionsFor.mockResolvedValue([subscription()])
      // one at a time, in order, since the ban has to come last
      const answers = await mapInOrder({
        items: ROUTES,
        run: async ([method, path, body]) => {
          const answer = await h.app.inject({
            method,
            url: `${prefix}${path}`,
            ...(body ? { payload: body } : {}),
          })
          return `${method} ${path} ${answer.statusCode}`
        },
      })
      expect(answers).toEqual(ROUTES.map(([method, path]) => `${method} ${path} 200`))
    },
  )
})

// --- stripe ---------------------------------------------------------------------------------------------------

describe('POST /admin/cancel-subscription', () => {
  it('flags the subscriptions of the stored customer', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_9',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.stripe.subscriptionsFor.mockResolvedValue([subscription({ id: 'sub_1' })])
    h.bridge.stripe.cancelAtPeriodEnd.mockResolvedValue(
      subscription({ id: 'sub_1', cancel_at: 1790000000, cancel_at_period_end: true }),
    )

    const result = await cancel({ h, email: 'A@X.com' })

    expect(h.bridge.stripe.subscriptionsFor).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.subscriptionsFor).toHaveBeenCalledWith('cus_9')
    expect(h.bridge.stripe.cancelAtPeriodEnd).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.cancelAtPeriodEnd).toHaveBeenCalledWith('sub_1')
    expect(h.bridge.stripe.customerIdsForEmail).not.toHaveBeenCalled() // mapping wins over email lookup
    expect(result.canceled).toBe(1)
    expect(result.cancel_at?.startsWith('2026-') ?? false).toBe(true)
    const events = eventsForEmail({ path: h.dbp, email: 'a@x.com' })
    expect(events[0]?.action).toBe('Cancellation scheduled')
    expect(events[0]?.detail).toContain('by admin')
  })

  it('falls back to a stripe email lookup', async () => {
    const h = await harness()
    h.bridge.stripe.subscriptionsFor.mockResolvedValue([subscription({ id: 'sub_2' })])
    h.bridge.stripe.customerIdsForEmail.mockResolvedValue(['cus_via_email'])
    h.bridge.stripe.cancelAtPeriodEnd.mockResolvedValue(
      subscription({ id: 'sub_2', cancel_at: 1790000000, cancel_at_period_end: true }),
    )

    const result = await cancel({ h, email: 'nomap@x.com' })

    expect(h.bridge.stripe.customerIdsForEmail).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.customerIdsForEmail).toHaveBeenCalledWith('nomap@x.com')
    expect(h.bridge.stripe.subscriptionsFor).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.subscriptionsFor).toHaveBeenCalledWith('cus_via_email')
    expect(result.canceled).toBe(1)
  })

  it('404s without a customer or a subscription', async () => {
    const h = await harness()
    const noCustomer = await post({
      h,
      url: '/admin/cancel-subscription',
      payload: { email: 'ghost@x.com' },
    })
    expect(noCustomer.statusCode).toBe(404)
    expect(noCustomer.json()).toEqual({ detail: 'no stripe customer for that email' })

    upsertPending({
      path: h.dbp,
      customerId: 'cus_idle',
      email: 'idle@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    const noSub = await post({
      h,
      url: '/admin/cancel-subscription',
      payload: { email: 'idle@x.com' },
    })
    expect(noSub.statusCode).toBe(404)
    expect(noSub.json()).toEqual({ detail: 'no active subscription for that email' })
  })

  it('is idempotent for already-flagged subscriptions', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_9',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.stripe.subscriptionsFor.mockResolvedValue([
      subscription({ id: 'sub_1', cancel_at: 1790000000, cancel_at_period_end: true }),
    ])

    const result = await cancel({ h, email: 'a@x.com' })

    expect(h.bridge.stripe.cancelAtPeriodEnd).not.toHaveBeenCalled()
    expect(result.canceled).toBe(0)
    expect(result.cancel_at?.startsWith('2026-') ?? false).toBe(true)
    expect(eventsForEmail({ path: h.dbp, email: 'a@x.com' })).toEqual([]) // no duplicate history row
  })
})

// --- tags and downloads ------------------------------------------------------------------------------------------

describe('tags and downloads', () => {
  it('roundtrips a tag through the member payloads', async () => {
    const h = await harness()
    await setTag({ h, body: { email: 'A@X.com', tag: 'vip' } })

    expect((await getMember({ h, email: 'a@x.com' })).tag).toBe('vip')
    const members = await listMembers(h)
    expect(memberOf({ members, email: 'a@x.com' }).tag).toBe('vip')
    expect(memberOf({ members, email: 'nora@x.com' }).tag).toBeNull()

    await setTag({ h, body: { email: 'a@x.com', tag: null } })
    expect((await getMember({ h, email: 'a@x.com' })).tag).toBeNull()

    const events = eventsForEmail({ path: h.dbp, email: 'a@x.com' })
    expect(events.map((e) => e.detail)).toEqual(['tag cleared', 'tagged VIP'])
  })

  it('rejects unknown tags', async () => {
    const h = await harness()
    const answer = await post({
      h,
      url: '/admin/set-tag',
      payload: { email: 'a@x.com', tag: 'whale' },
    })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: "unknown tag 'whale'" })
  })

  it('overrides the tier default in member payloads with the downloads toggle', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    }) // gold -> downloads true

    expect(await setDownloads({ h, body: { email: 'A@X.com', allow: false } })).toEqual({
      email: 'A@X.com',
      downloads: false,
    })

    expect((await getMember({ h, email: 'a@x.com' })).downloads).toBe(false) // override beats gold's true
    expect(memberOf({ members: await listMembers(h), email: 'a@x.com' }).downloads).toBe(false)
    const events = eventsForEmail({ path: h.dbp, email: 'a@x.com' })
    expect(events[0]?.action).toBe('Downloads toggled')
    expect(events[0]?.detail).toBe('turned off by admin')

    await setDownloads({ h, body: { email: 'a@x.com', allow: true } })
    expect((await getMember({ h, email: 'a@x.com' })).downloads).toBe(true)
  })

  it('accepts banned, and clearing it unbans', async () => {
    const h = await harness()
    await setTag({ h, body: { email: 'a@x.com', tag: 'banned' } })
    expect((await getMember({ h, email: 'a@x.com' })).tag).toBe('banned')
    await setTag({ h, body: { email: 'a@x.com', tag: null } })
    expect((await getMember({ h, email: 'a@x.com' })).tag).toBeNull()
  })
})

// --- ban ------------------------------------------------------------------------------------------------------------

describe('POST /admin/ban', () => {
  it('tags the member and cancels their billing', async () => {
    const h = await harness()
    upsertPending({
      path: h.dbp,
      customerId: 'cus_9',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'gold',
    })
    h.bridge.stripe.subscriptionsFor.mockResolvedValue([subscription({ id: 'sub_1' })])
    h.bridge.stripe.cancelAtPeriodEnd.mockResolvedValue(
      subscription({ id: 'sub_1', cancel_at: 1790000000, cancel_at_period_end: true }),
    )
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([1, 2])

    const result = await ban({ h, email: 'A@X.com' })

    expect(result).toEqual({
      email: 'A@X.com',
      disabled: 2,
      canceled: 1,
      cancel_at: '2026-09-21T14:13:20+00:00',
    })
    expect((await getMember({ h, email: 'a@x.com' })).tag).toBe('banned')
    expect(h.bridge.wizarr.disableUser.mock.calls).toEqual([[1], [2]])
    expect(h.bridge.stripe.cancelAtPeriodEnd).toHaveBeenCalledTimes(1)
    expect(h.bridge.stripe.cancelAtPeriodEnd).toHaveBeenCalledWith('sub_1')
    const events = eventsForEmail({ path: h.dbp, email: 'a@x.com' })
    expect(events[0]?.action).toBe('Banned')
    expect(events[0]?.detail).toContain('2 server record(s) disabled')
    expect(events[0]?.detail).toContain('billing stops 2026-09-21')
  })

  it('works for a member with nothing to revoke', async () => {
    // Someone already gone from Wizarr and Stripe can still be marked, so the
    // next checkout or re-invite under that address is refused.
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([])

    const result = await ban({ h, email: 'gone@x.com' })

    expect(result).toEqual({ email: 'gone@x.com', disabled: 0, canceled: 0, cancel_at: null })
    expect(getMemberTag({ path: h.dbp, email: 'gone@x.com' })).toBe('banned')
    expect(eventsForEmail({ path: h.dbp, email: 'gone@x.com' })[0]?.detail).toBe(
      'no server records to disable; no subscription to cancel',
    )
  })

  it('still lands when stripe is down', async () => {
    const h = await harness()
    h.bridge.stripe.subscriptionsFor.mockRejectedValue(new Error('stripe is down'))
    h.bridge.stripe.customerIdsForEmail.mockRejectedValue(new Error('stripe is down'))
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([7])

    const result = await ban({ h, email: 'a@x.com' })

    expect(result.disabled).toBe(1)
    expect(result.canceled).toBe(0)
    expect(getMemberTag({ path: h.dbp, email: 'a@x.com' })).toBe('banned')
    expect(eventsForEmail({ path: h.dbp, email: 'a@x.com' })[0]?.detail).toContain(
      'could not reach Stripe',
    )
  })
})

// --- request bodies ---------------------------------------------------------------------------------------------------
//
// Not in the Python suite: pydantic's lax coercion, pinned so the port refuses
// and accepts what FastAPI did.

describe('request bodies, as pydantic read them', () => {
  it.each([
    [15, 15],
    [15.0, 15],
    ['15', 15],
    [' 15 ', 15],
    ['1_5', 15],
    ['15.00', 15],
    ['+15', 15],
    [true, 1],
  ])('reads days %j as %j', async (days, expected) => {
    const h = await harness()
    h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
    await resetExpiry({ h, body: { email: 'a@x.com', days } })
    expect((await getEvents({ h, email: 'a@x.com' }))[0]?.detail).toBe(`${expected} days`)
  })

  it.each([1.5, '1.5', '1e3', '', 'abc', '_1', [], {}])(
    'refuses days %j with a 422',
    async (days) => {
      const h = await harness()
      h.bridge.wizarr.findUserIdsByEmail.mockResolvedValue([9])
      const answer = await post({
        h,
        url: '/admin/reset-expiry',
        payload: { email: 'a@x.com', days },
      })
      expect(answer.statusCode).toBe(422)
      expect(h.bridge.wizarr.setExpiry).not.toHaveBeenCalled()
    },
  )

  it.each([
    [true, true],
    [1, true],
    ['yes', true],
    ['ON', true],
    ['t', true],
    [false, false],
    [0, false],
    ['No', false],
    ['off', false],
    ['f', false],
  ])('reads allow %j as %j', async (allow, expected) => {
    const h = await harness()
    expect((await setDownloads({ h, body: { email: 'a@x.com', allow } })).downloads).toBe(expected)
  })

  it.each([2, 0.5, '', ' true', 'maybe', null])('refuses allow %j with a 422', async (allow) => {
    const h = await harness()
    expect(
      (await post({ h, url: '/admin/set-downloads', payload: { email: 'a@x.com', allow } }))
        .statusCode,
    ).toBe(422)
  })

  it.each([1, true, null])('refuses a non-string email %j with a 422', async (email) => {
    const h = await harness()
    expect(
      (await post({ h, url: '/admin/notes', payload: { email, notes: 'n' } })).statusCode,
    ).toBe(422)
  })

  it('refuses a missing field with a 422 in the detail shape', async () => {
    const h = await harness()
    const answer = await post({ h, url: '/admin/notes', payload: { email: 'a@x.com' } })
    expect(answer.statusCode).toBe(422)
    expect(Array.isArray(answer.json().detail)).toBe(true)
  })

  it('ignores extra fields, and reads a left-out optional as null', async () => {
    const h = await harness()
    expect(await setTag({ h, body: { email: 'a@x.com', extra: 1 } })).toEqual({
      email: 'a@x.com',
      tag: null,
    })
  })

  it('treats an empty plex_email as an unlink', async () => {
    const h = await harness()
    const answer = await linkAddress({ h, body: { stripe_email: ' Pays@x.com ', plex_email: '' } })
    expect(bodyOf({ answer, is: isLinkAddressResult })).toEqual({
      stripe_email: 'pays@x.com',
      plex_email: null,
    })
    expect(eventsForEmail({ path: h.dbp, email: 'pays@x.com' })[0]?.action).toBe('Address unlinked')
  })

  it('refuses a blank stripe_email', async () => {
    const h = await harness()
    const answer = await linkAddress({ h, body: { stripe_email: '  ' } })
    expect(answer.statusCode).toBe(400)
    expect(answer.json()).toEqual({ detail: 'stripe_email is required' })
  })
})
