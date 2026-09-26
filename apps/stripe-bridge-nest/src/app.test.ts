import { Controller, Get, UseGuards } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { SupabaseAdminGuard } from '@wizteros/server-common'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app.js'
import { AppModule } from '@/appModule.js'

const PORTAL = 'https://westeroz.netlify.app'

// A CORS list header as its lowercased entries, whatever separator spacing
// the plugin chose.
const entries = (header: unknown): string[] =>
  String(header)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())

const preflight = ({ app, origin }: { app: NestFastifyApplication; origin: string }) =>
  app.inject({
    method: 'OPTIONS',
    url: '/admin/members',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  })

describe('createApp', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    vi.stubEnv('ADMIN_ALLOWED_ORIGINS', ` ${PORTAL} , http://localhost:5173`)
    app = await createApp({ quiet: true })
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
  })

  it('lets an allowed portal origin preflight an admin write', async () => {
    const response = await preflight({ app, origin: PORTAL })
    expect(response.statusCode).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe(PORTAL)
    expect(entries(response.headers['access-control-allow-methods'])).toEqual(['get', 'post'])
    expect(entries(response.headers['access-control-allow-headers'])).toEqual([
      'accept',
      'accept-language',
      'authorization',
      'content-language',
      'content-type',
    ])
    // Starlette let a browser reuse a preflight for ten minutes
    expect(response.headers['access-control-max-age']).toBe('600')
  })

  it('gives any other origin no CORS grant', async () => {
    const response = await preflight({ app, origin: 'https://evil.example.com' })
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})

@Controller('gated')
@UseGuards(SupabaseAdminGuard)
class GatedProbeController {
  @Get()
  read(): { ok: boolean } {
    return { ok: true }
  }
}

// Through this app's own module graph, not the lib's: if the app and the lib
// ever resolved two copies of @nestjs/common, the guard's 401 would stop being
// an HttpException to this app and every admin read would turn into a 500.
describe('a gated route in this app', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [GatedProbeController],
    }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('answers a read without a session with the 401 the portal expects', async () => {
    const response = await app.inject({ method: 'GET', url: '/gated' })
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ detail: 'unauthorized' })
  })
})
