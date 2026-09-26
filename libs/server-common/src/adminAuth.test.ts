import { Controller, Get, UseGuards } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import {
  type CryptoKey,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWTVerifyGetKey,
  SignJWT,
} from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdminAuthModule, SupabaseAdminGuard } from './adminAuth.js'
import { parseEmailAllowlist, trimTrailingSlashes } from './env.js'

const SUPABASE_URL = 'https://project.supabase.co'
const ADMIN_EMAIL = 'admin@example.com'
const KID = 'supabase-test-key'

@Controller('gated')
@UseGuards(SupabaseAdminGuard)
class GatedController {
  @Get()
  read(): { ok: boolean } {
    return { ok: true }
  }
}

// One throwaway ES256 keypair standing in for Supabase's. The test owns both
// halves so it can mint a token that really verifies, rather than asserting
// against a stubbed-out verifier that would still pass with the check removed.
const signingKey = await generateKeyPair('ES256')
const publicKeySet = createLocalJWKSet({
  keys: [{ ...(await exportJWK(signingKey.publicKey)), kid: KID, alg: 'ES256', use: 'sig' }],
})

const mint = ({
  key = signingKey.privateKey,
  email = ADMIN_EMAIL,
  issuer = `${SUPABASE_URL}/auth/v1`,
  audience = 'authenticated',
  expiresAt = '5m',
}: {
  key?: CryptoKey
  email?: string
  issuer?: string
  audience?: string
  expiresAt?: string | number
} = {}): Promise<string> =>
  new SignJWT({ email })
    .setProtectedHeader({ alg: 'ES256', kid: KID })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(key)

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

describe('SupabaseAdminGuard', () => {
  // Stands in for the environment each app reads its admin config from, so a
  // test can change it between requests the way an operator changes .env.
  const env: Record<string, string | undefined> = {}
  const jwksUrls: string[] = []
  let app: NestFastifyApplication

  const read = async (headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url: '/gated', headers })

  beforeEach(async () => {
    env.SUPABASE_URL = SUPABASE_URL
    env.ADMIN_ALLOWED_EMAILS = ` ${ADMIN_EMAIL.toUpperCase()} ,other@example.com`
    jwksUrls.length = 0

    const moduleRef = await Test.createTestingModule({
      imports: [
        AdminAuthModule.forRoot({
          readConfig: () => ({
            supabaseUrl: trimTrailingSlashes(env.SUPABASE_URL),
            allowedEmails: parseEmailAllowlist(env.ADMIN_ALLOWED_EMAILS),
          }),
          keySetFor: (jwksUrl): JWTVerifyGetKey => {
            jwksUrls.push(jwksUrl)
            return publicKeySet
          },
        }),
      ],
      controllers: [GatedController],
    }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('rejects a read with no session', async () => {
    const response = await read()
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ detail: 'unauthorized' })
  })

  it('serves an allowlisted session', async () => {
    const response = await read(bearer(await mint()))
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
  })

  it('still rejects a valid signature from a stranger', async () => {
    const response = await read(bearer(await mint({ email: 'stranger@example.com' })))
    expect(response.statusCode).toBe(401)
  })

  it('matches the email claim against the allowlist case-insensitively', async () => {
    const response = await read(bearer(await mint({ email: ADMIN_EMAIL.toUpperCase() })))
    expect(response.statusCode).toBe(200)
  })

  it('rejects a token signed by someone else', async () => {
    const forger = await generateKeyPair('ES256')
    const response = await read(bearer(await mint({ key: forger.privateKey })))
    expect(response.statusCode).toBe(401)
  })

  it('rejects a token from another issuer', async () => {
    const response = await read(bearer(await mint({ issuer: 'https://evil.supabase.co/auth/v1' })))
    expect(response.statusCode).toBe(401)
  })

  it('rejects a token for another audience', async () => {
    const response = await read(bearer(await mint({ audience: 'anon' })))
    expect(response.statusCode).toBe(401)
  })

  it('rejects an expired token', async () => {
    const response = await read(
      bearer(await mint({ expiresAt: Math.floor(Date.now() / 1000) - 60 })),
    )
    expect(response.statusCode).toBe(401)
  })

  it.each(['', 'Bearer', 'Bearer ', 'Basic abc', 'token abc', 'nope'])(
    'rejects the malformed authorization header %j',
    async (header) => {
      const response = await read({ authorization: header })
      expect(response.statusCode).toBe(401)
    },
  )

  it('accepts the bearer scheme in any case', async () => {
    const response = await read({ authorization: `bearer ${await mint()}` })
    expect(response.statusCode).toBe(200)
  })

  // Reachable from the public internet through the Funnel, so half-configured
  // has to mean closed, not open.
  it('closes when the Supabase url is unset', async () => {
    delete env.SUPABASE_URL
    const response = await read(bearer(await mint()))
    expect(response.statusCode).toBe(401)
  })

  it('closes when the allowlist is empty', async () => {
    env.ADMIN_ALLOWED_EMAILS = '  ,  '
    const response = await read(bearer(await mint()))
    expect(response.statusCode).toBe(401)
  })

  it('recovers on the next request once its config arrives, without a restart', async () => {
    delete env.SUPABASE_URL
    const token = await mint()
    expect((await read(bearer(token))).statusCode).toBe(401)

    env.SUPABASE_URL = SUPABASE_URL
    expect((await read(bearer(token))).statusCode).toBe(200)
  })

  it('tolerates a trailing slash on the configured url', async () => {
    env.SUPABASE_URL = `${SUPABASE_URL}/`
    const response = await read(bearer(await mint()))
    expect(response.statusCode).toBe(200)
  })

  it("reads the keys from the project's JWKS url, and only builds that lookup once", async () => {
    await read(bearer(await mint()))
    await read(bearer(await mint()))
    expect(jwksUrls).toEqual([`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`])
  })
})
