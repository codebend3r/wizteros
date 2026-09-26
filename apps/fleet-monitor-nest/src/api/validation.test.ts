import { Controller, Get, Query } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { fastApiValidationPipe, intQuery, textQuery } from '@/api/validation.js'

const Probe = z.object({
  minutes: intQuery({ fallback: 60, min: 2, max: 10080 }),
  kind: z.enum(['movie', 'episode', 'track']).optional(),
  q: textQuery({ max: 5 }).optional(),
})

@Controller('probe')
class ProbeController {
  @Get()
  read(@Query({ schema: Probe }) query: z.infer<typeof Probe>): z.infer<typeof Probe> {
    return query
  }
}

describe('FastAPI-style query validation', () => {
  let app: NestFastifyApplication

  const get = (query: string) => app.inject({ method: 'GET', url: `/probe${query}` })

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [ProbeController] }).compile()
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    })
    app.useGlobalPipes(fastApiValidationPipe())
    await app.init()
    await app.getHttpAdapter().getInstance().ready()
  })

  afterEach(async () => {
    await app.close()
  })

  it('applies the default when the parameter is absent', async () => {
    expect((await get('')).json()).toEqual({ minutes: 60 })
  })

  it('parses an in-range integer', async () => {
    expect((await get('?minutes=1440')).json()).toEqual({ minutes: 1440 })
  })

  it.each(['1', '10081', '2.5', '6e1', 'abc', ''])(
    'answers %j with a 422 and a detail list, as FastAPI did',
    async (minutes) => {
      const response = await get(`?minutes=${minutes}`)
      expect(response.statusCode).toBe(422)
      const body: unknown = response.json()
      expect(body).toMatchObject({ detail: [{ loc: ['minutes'] }] })
    },
  )

  it('refuses a literal outside its set', async () => {
    expect((await get('?kind=clip')).statusCode).toBe(422)
  })

  it('refuses text over its length', async () => {
    expect((await get('?q=toolong')).statusCode).toBe(422)
  })

  it('ignores parameters it does not declare, as FastAPI did', async () => {
    expect((await get('?minutes=5&other=1')).json()).toEqual({ minutes: 5 })
  })
})
