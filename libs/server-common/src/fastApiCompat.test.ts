import { Controller, Get } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fastApiCompat } from './fastApiCompat.js'
import { httpError } from './httpDetail.js'

@Controller('probe')
class ProbeController {
  @Get('items')
  items(): string[] {
    return []
  }

  @Get('teapot')
  teapot(): never {
    throw httpError({ status: 418, detail: 'short and stout' })
  }
}

// Each piece is tested on its own beside it; this proves the one call wires
// all of them onto an app.
describe('fastApiCompat', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile()
    app = fastApiCompat({
      app: moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
        logger: false,
      }),
      cors: { origin: '*', methods: ['GET'], headers: ['Authorization'] },
    })
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it("answers a preflight with Starlette's CORS", async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/probe/items',
      headers: {
        origin: 'https://portal.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe('*')
    expect(response.headers['access-control-max-age']).toBe('600')
  })

  it('answers an error with its detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe/teapot' })
    expect(response.statusCode).toBe(418)
    expect(response.json()).toEqual({ detail: 'short and stout' })
  })

  it('answers an unknown path with the status phrase as its detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/nowhere' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ detail: 'Not Found' })
  })

  it('answers a wrong method on a known path with 405', async () => {
    const response = await app.inject({ method: 'POST', url: '/probe/items' })
    expect(response.statusCode).toBe(405)
    expect(response.headers.allow).toBe('GET, HEAD')
  })
})
