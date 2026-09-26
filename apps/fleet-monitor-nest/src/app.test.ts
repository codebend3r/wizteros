import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '@/app.js'

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
    expect(String(preflight.headers['access-control-allow-methods'])).toContain('GET')
    expect(String(preflight.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    )
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
