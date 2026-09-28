// The session gate in front of every admin route, verified against real
// ES256 tokens, and the two mounts every route answers on.

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { type CryptoKey, createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AdminModule } from '@/admin/adminModule.js'
import { mapInOrder } from '@/sequence.js'
import { asBridge, fakeBridge, subscription } from '@/test/fakes.js'
import { serve } from '@/test/serve.js'
import { tempDbPath } from '@/test/support.js'
import { harness, stopServed, get, post } from '@/test/adminHarness.js'

afterEach(stopServed)

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
    const bridge = fakeBridge({ dbPath: tempDbPath() })
    bridge.store.init()
    vi.stubEnv('SUPABASE_URL', SUPABASE_URL)
    vi.stubEnv('ADMIN_ALLOWED_EMAILS', 'cj.rivas.dev@gmail.com')
    app = await serve({
      imports: [AdminModule],
      bridge: asBridge(bridge),
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
      h.bridge.store.upsertPending({
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
