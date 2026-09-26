// The admin gate on this app's own routes. The guard's every rule is tested in
// the lib; what is tested here is that the monitor puts it on every route the
// portal calls, reads its config from the FM_ variables, and leaves /health
// open.

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { type CryptoKey, createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb } from '@/collector.js'
import { appBehindTheGate } from '@/test/apiApp.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'

const SUPABASE_URL = 'https://project.supabase.co'
const ADMIN_EMAIL = 'admin@example.com'
const KID = 'supabase-test-key'

// Every route the portal calls. /health is deliberately absent: the container
// healthcheck and the Funnel both probe it without a session. The play history
// routes carry every member's completed plays, which is admin data, so they
// sit behind the same gate.
const GATED = [
  '/fleet',
  '/fleet/cpu',
  '/incidents',
  '/plays/overview',
  '/plays/users',
  '/plays/users/1/history',
  '/plays/title?key=movie:heat:1995',
  '/plays/top',
  '/plays/never-played',
  '/plays/sync',
]

// One throwaway ES256 keypair standing in for Supabase's.
//
// Supabase signs session tokens with ES256 and publishes the public half at a
// JWKS url. The test owns both halves so it can mint a token that really
// verifies, rather than asserting against a stubbed-out verifier that would
// still pass if the signature check were removed.
const signingKey = await generateKeyPair('ES256')
const publicKeySet = createLocalJWKSet({
  keys: [{ ...(await exportJWK(signingKey.publicKey)), kid: KID, alg: 'ES256', use: 'sig' }],
})

const token = ({
  key = signingKey.privateKey,
  email = ADMIN_EMAIL,
  issuer = `${SUPABASE_URL}/auth/v1`,
  audience = 'authenticated',
}: {
  key?: CryptoKey
  email?: string
  issuer?: string
  audience?: string
} = {}): Promise<string> =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuer(issuer)
    .setAudience(audience)
    .sign(key)

const bearer = (value: string): Record<string, string> => ({ authorization: `Bearer ${value}` })

describe('the admin gate', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    const db = tempDbPath()
    initDb(db)
    vi.stubEnv('FM_DB_PATH', db)
    vi.stubEnv('FM_SUPABASE_URL', SUPABASE_URL)
    vi.stubEnv('FM_ADMIN_ALLOWED_EMAILS', ` ${ADMIN_EMAIL.toUpperCase()} ,other@example.com`)
    // Stands in for the network fetch of Supabase's public keys. The
    // signature is still verified for real against the key this hands back.
    app = await appBehindTheGate(publicKeySet)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
    removeTempDirs()
  })

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers })

  it.each(GATED)('rejects an unauthenticated read of %s', async (path) => {
    expect((await get(path)).statusCode).toBe(401)
  })

  it.each(GATED)('serves an allowlisted session on %s', async (path) => {
    expect((await get(path, bearer(await token()))).statusCode).toBe(200)
  })

  it('keeps /health open so the container probe needs no session', async () => {
    expect((await get('/health')).statusCode).toBe(200)
  })

  it('still rejects a valid signature from a stranger', async () => {
    const stranger = await token({ email: 'stranger@example.com' })
    expect((await get('/fleet', bearer(stranger))).statusCode).toBe(401)
  })

  it('matches an email against the allowlist case-insensitively', async () => {
    const shouted = await token({ email: ADMIN_EMAIL.toUpperCase() })
    expect((await get('/fleet', bearer(shouted))).statusCode).toBe(200)
  })

  it('rejects a token signed by someone else', async () => {
    const forger = await generateKeyPair('ES256')
    const forged = await token({ key: forger.privateKey })
    expect((await get('/fleet', bearer(forged))).statusCode).toBe(401)
  })

  it('rejects a token from another issuer', async () => {
    const foreign = await token({ issuer: 'https://evil.supabase.co/auth/v1' })
    expect((await get('/fleet', bearer(foreign))).statusCode).toBe(401)
  })

  it('rejects a token for another audience', async () => {
    const anon = await token({ audience: 'anon' })
    expect((await get('/fleet', bearer(anon))).statusCode).toBe(401)
  })

  it.each(['', 'Bearer', 'Bearer ', 'Basic abc', 'token abc'])(
    'rejects the malformed authorization header %j',
    async (header) => {
      expect((await get('/fleet', { authorization: header })).statusCode).toBe(401)
    },
  )

  // The container is reachable from the public internet through the Funnel,
  // so half-configured must mean closed, not open. Both of these used to be
  // the difference between "LAN-only" and "published".
  it('closes the API when the Supabase url is unset', async () => {
    vi.stubEnv('FM_SUPABASE_URL', undefined)
    expect((await get('/fleet', bearer(await token()))).statusCode).toBe(401)
  })

  it('closes the API when the allowlist is empty', async () => {
    vi.stubEnv('FM_ADMIN_ALLOWED_EMAILS', '  ,  ')
    expect((await get('/fleet', bearer(await token()))).statusCode).toBe(401)
  })

  it('lets the portal send its bearer through the preflight', async () => {
    // Without `authorization` among the allowed headers the browser never
    // sends the real request, and the page reads as a monitor that is down.
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/fleet',
      headers: {
        origin: 'https://westeroz.netlify.app',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    )
  })
})
