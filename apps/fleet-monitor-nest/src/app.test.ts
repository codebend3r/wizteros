import { Controller, Get, UseGuards } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { SupabaseAdminGuard } from '@wizteros/server-common'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app.js'
import { AppModule } from '@/appModule.js'

// A CORS list header as its lowercased entries, whatever separator spacing
// the plugin chose.
const entries = (header: unknown): string[] =>
  String(header)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())

describe('createApp', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    app = await createApp({ quiet: true })
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterEach(async () => {
    await app.close()
  })

  // Without `authorization` among the allowed headers the browser never
  // sends the real request, and the page reads as a monitor that is down.
  it('lets the portal preflight a read that carries its bearer', async () => {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/fleet',
      headers: {
        origin: 'https://westeroz.netlify.app',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(preflight.statusCode).toBe(200)
    expect(preflight.headers['access-control-allow-origin']).toBe('*')
    expect(entries(preflight.headers['access-control-allow-methods'])).toEqual(['get'])
    expect(entries(preflight.headers['access-control-allow-headers'])).toEqual([
      'accept',
      'accept-language',
      'authorization',
      'content-language',
      'content-type',
    ])
    // Starlette let a browser reuse a preflight for ten minutes
    expect(preflight.headers['access-control-max-age']).toBe('600')
  })

  it('answers cross-origin requests from any origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/fleet',
      headers: { origin: 'http://localhost:5173' },
    })
    expect(response.headers['access-control-allow-origin']).toBe('*')
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
// an HttpException to this app and every gated read would turn into a 500.
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
