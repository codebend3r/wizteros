// The admin gate on this app's own routes. The guard's every rule (strangers,
// forged or foreign tokens, malformed headers, an empty allowlist) is tested in
// the lib; what is tested here is that the monitor puts it on every route the
// portal calls, reads its config from the FM_ variables, and leaves /health
// open.

import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { bearer, supabaseSigner } from '@wizteros/server-common/testing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb } from '@/schema.js'
import { appBehindTheGate } from '@/test/apiApp.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'

const SUPABASE_URL = 'https://project.supabase.co'
const ADMIN_EMAIL = 'admin@example.com'

// Every route the portal calls. /health is deliberately absent: the container
// healthcheck and the Funnel both probe it without a session. The play history
// routes carry every member's completed plays, which is admin data, so they
// sit behind the same gate.
const GATED = [
  '/fleet',
  '/fleet/cpu',
  '/incidents',
  '/plays/overview',
  '/plays/history',
  '/plays/users',
  '/plays/users/1/history',
  '/plays/title?key=movie:heat:1995',
  '/plays/top',
  '/plays/never-played',
  '/plays/sync',
]

// A throwaway ES256 keypair standing in for Supabase's, so a token really
// verifies rather than a stubbed-out verifier passing whatever it is handed.
const { keySet: publicKeySet, mint: token } = await supabaseSigner({
  supabaseUrl: SUPABASE_URL,
  email: ADMIN_EMAIL,
})

describe('the admin gate', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    const db = tempDbPath()
    initDb(db)
    vi.stubEnv('FM_DB_PATH', db)
    vi.stubEnv('FM_SUPABASE_URL', SUPABASE_URL)
    vi.stubEnv('FM_ADMIN_ALLOWED_EMAILS', ` ${ADMIN_EMAIL.toUpperCase()} ,other@example.com`)
    // Stands in for the network fetch of Supabase's public keys. The
    // signature is still verified for real against the key this hands back.
    app = await appBehindTheGate(publicKeySet)
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
    removeTempDirs()
  })

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers })

  it.each(GATED)('rejects an unauthenticated read of %s', async (path) => {
    expect((await get(path)).statusCode).toBe(401)
  })

  it.each(GATED)('serves an allowlisted session on %s', async (path) => {
    expect((await get(path, bearer(await token()))).statusCode).toBe(200)
  })

  it('keeps /health open so the container probe needs no session', async () => {
    expect((await get('/health')).statusCode).toBe(200)
  })

  // The container is reachable from the public internet through the Funnel,
  // so half-configured must mean closed, not open. The lib tests every way the
  // guard closes; this one proves the url it reads is FM_SUPABASE_URL.
  it('closes the API when the Supabase url is unset', async () => {
    vi.stubEnv('FM_SUPABASE_URL', undefined)
    expect((await get('/fleet', bearer(await token()))).statusCode).toBe(401)
  })

  it('lets the portal send its bearer through the preflight', async () => {
    // Without `authorization` among the allowed headers the browser never
    // sends the real request, and the page reads as a monitor that is down.
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/fleet',
      headers: {
        origin: 'https://westeroz.netlify.app',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(String(response.headers['access-control-allow-headers']).toLowerCase()).toContain(
      'authorization',
    )
  })
})
