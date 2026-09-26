import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '@/app.js'

const PORTAL = 'https://westeroz.netlify.app'

// A CORS list header as its lowercased entries, whatever separator spacing
// the plugin chose.
const entries = (header: unknown): string[] =>
  String(header)
    .split(',')
    .map((entry) => entry.trim().toLowerCase())

const preflight = (app: NestFastifyApplication, origin: string) =>
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
    const response = await preflight(app, PORTAL)
    expect(response.statusCode).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe(PORTAL)
    expect(entries(response.headers['access-control-allow-methods'])).toEqual(['get', 'post'])
    expect(entries(response.headers['access-control-allow-headers'])).toEqual([
      'authorization',
      'content-type',
    ])
  })

  it('gives any other origin no CORS grant', async () => {
    const response = await preflight(app, 'https://evil.example.com')
    expect(response.headers['access-control-allow-origin']).toBeUndefined()
  })
})
