import { Module } from '@nestjs/common'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asBridge, fakeBridge } from '@/test/fakes.js'
import { serve } from '@/test/serve.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import { packageVersion, VersionController } from '@/version/versionController.js'

@Module({ controllers: [VersionController] })
class VersionModule {}

describe('the version marker', () => {
  it('is semver, since release.sh bumps it with npm version', () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('is what the handler reports', () => {
    expect(new VersionController().version()).toEqual({ version: packageVersion() })
  })
})

describe('GET /version', () => {
  let app: NestFastifyApplication

  beforeEach(async () => {
    // A real gate with an allowlist, so a route that gained a guard would 401.
    const { publicKey } = await generateKeyPair('ES256')
    const keySet = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k' }] })
    vi.stubEnv('SUPABASE_URL', 'https://project.supabase.co')
    vi.stubEnv('ADMIN_ALLOWED_EMAILS', 'admin@example.com')
    app = await serve({
      imports: [VersionModule],
      bridge: asBridge(fakeBridge({ dbPath: tempDbPath() })),
      keySet,
    })
  })

  afterEach(async () => {
    await app.close()
    vi.unstubAllEnvs()
    removeTempDirs()
  })

  it('answers on both paths, since the Funnel strips the /stripe prefix', async () => {
    const bare = await app.inject({ method: 'GET', url: '/version' })
    const prefixed = await app.inject({ method: 'GET', url: '/stripe/version' })
    expect(bare.json()).toEqual({ version: packageVersion() })
    expect(prefixed.json()).toEqual({ version: packageVersion() })
  })

  it('needs no session, since the deploy check runs before anyone holds a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/version' })
    expect(response.statusCode).toBe(200)
  })
})
