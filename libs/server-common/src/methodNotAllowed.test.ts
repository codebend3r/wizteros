import { Controller, Get, Post } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpDetailFilter } from './httpDetail.js'
import { starletteMethodNotAllowed } from './methodNotAllowed.js'

@Controller('probe')
class ProbeController {
  @Post('hook')
  hook(): { ok: boolean } {
    return { ok: true }
  }

  @Get('items')
  items(): string[] {
    return []
  }

  @Get('users/:id/history')
  history(): string[] {
    return []
  }
}

describe('starletteMethodNotAllowed', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.useGlobalFilters(new HttpDetailFilter(app.get(HttpAdapterHost)))
    starletteMethodNotAllowed(app)
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('answers a wrong method on a known path with 405, like Starlette', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe/hook' })
    expect(response.statusCode).toBe(405)
    expect(response.json()).toEqual({ detail: 'Method Not Allowed' })
    expect(response.headers.allow).toBe('POST')
  })

  it('lists HEAD beside GET in the Allow header, as Starlette does', async () => {
    const response = await app.inject({ method: 'POST', url: '/probe/items' })
    expect(response.statusCode).toBe(405)
    expect(response.headers.allow).toBe('GET, HEAD')
  })

  it('matches a path parameter segment', async () => {
    const response = await app.inject({ method: 'DELETE', url: '/probe/users/7/history' })
    expect(response.statusCode).toBe(405)
    expect(response.headers.allow).toBe('GET, HEAD')
  })

  it('ignores the query string when matching the path', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe/hook?source=stripe' })
    expect(response.statusCode).toBe(405)
  })

  it('still answers an unknown path with 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe/nowhere' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ detail: 'Not Found' })
  })

  it('leaves a request with the right method alone', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe/items' })
    expect(response.statusCode).toBe(200)
  })
})
