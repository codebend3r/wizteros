import { Controller, Get, NotFoundException } from '@nestjs/common'
import { HttpAdapterHost } from '@nestjs/core'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpDetailFilter, httpError } from './httpDetail.js'

@Controller('probe')
class ProbeController {
  @Get('detail')
  detail(): never {
    throw httpError({ status: 422, detail: 'unknown host: ghost' })
  }

  @Get('structured')
  structured(): never {
    throw httpError({ status: 422, detail: [{ loc: ['query', 'days'], msg: 'too large' }] })
  }

  @Get('bare')
  bare(): never {
    throw new NotFoundException()
  }

  @Get('crash')
  crash(): never {
    throw new Error('boom')
  }
}

describe('HttpDetailFilter', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.useGlobalFilters(new HttpDetailFilter(app.get(HttpAdapterHost)))
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('sends a thrown detail as the whole body, with its status', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe/detail' })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({ detail: 'unknown host: ghost' })
  })

  it('keeps a structured detail as it was thrown', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe/structured' })
    expect(response.json()).toEqual({ detail: [{ loc: ['query', 'days'], msg: 'too large' }] })
  })

  it('answers an error without a detail with its status phrase, like Starlette', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe/bare' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ detail: 'Not Found' })
  })

  it("answers an unknown route the way FastAPI does, not with Nest's message", async () => {
    const response = await app.inject({ method: 'GET', url: '/nowhere' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ detail: 'Not Found' })
  })

  it('turns a crash into a 500 without leaking the error', async () => {
    const response = await app.inject({ method: 'GET', url: '/probe/crash' })
    expect(response.statusCode).toBe(500)
    expect(response.json()).toEqual({ detail: 'Internal Server Error' })
  })
})
