import { Controller, Get, Module, UseGuards } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { generateKeyPair, type JWTVerifyGetKey } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AdminAuthModule, SupabaseAdminGuard } from './adminAuth.js'
import { parseEmailAllowlist, trimTrailingSlashes } from './env.js'
import { bearer, supabaseSigner } from './testing.js'

const SUPABASE_URL = 'https://project.supabase.co'
const ADMIN_EMAIL = 'admin@example.com'

@Controller('gated')
@UseGuards(SupabaseAdminGuard)
class GatedController {
  @Get()
  read(): { ok: boolean } {
    return { ok: true }
  }
}

// A second gated controller in a module of its own. Nest builds one guard
// instance per module, which is how a cache kept on the guard came apart.
@Controller('elsewhere')
@UseGuards(SupabaseAdminGuard)
class ElsewhereController {
  @Get()
  read(): { ok: boolean } {
    return { ok: true }
  }
}

@Module({ controllers: [ElsewhereController] })
class ElsewhereModule {}

const { keySet: publicKeySet, mint } = await supabaseSigner({
  supabaseUrl: SUPABASE_URL,
  email: ADMIN_EMAIL,
})

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
        ElsewhereModule,
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

  it('reads its config on every request rather than capturing it once', async () => {
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

  it('shares that one lookup with the guards in every other module', async () => {
    const token = await mint()
    expect((await read(bearer(token))).statusCode).toBe(200)
    const elsewhere = await app.inject({ method: 'GET', url: '/elsewhere', headers: bearer(token) })
    expect(elsewhere.statusCode).toBe(200)
    expect(jwksUrls).toHaveLength(1)
  })

  it('gates a controller in another module too', async () => {
    const response = await app.inject({ method: 'GET', url: '/elsewhere' })
    expect(response.statusCode).toBe(401)
  })
})
