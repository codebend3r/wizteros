import type { DynamicModule, Type } from '@nestjs/common'
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { AdminAuthModule, SupabaseAdminGuard } from '@wizteros/server-common'
import type { JWTVerifyGetKey } from 'jose'
import { configureApp } from '@/app.js'
import { BridgeModule } from '@/bridgeModule.js'
import { adminAuthConfig } from '@/config.js'
import type { Bridge } from '@/types.js'

// The app as a route test drives it: the modules under test over a fake
// bridge, with the same setup main.ts serves (CORS, the {detail} filter, the
// 422 pipe) and the raw body the webhook verifies, driven through `inject`.

type Served = Readonly<{
  /** The modules under test, e.g. [AdminModule] or [WebhookModule]. */
  imports: readonly (Type | DynamicModule)[]
  bridge: Bridge
  /**
   * Verify admin sessions for real against this key set, reading
   * SUPABASE_URL and ADMIN_ALLOWED_EMAILS from the environment on every
   * request, as the Python tests did with monkeypatch. Left out, the gate is
   * bypassed, the Python suites' dependency override on `require_admin`.
   */
  keySet?: JWTVerifyGetKey
}>

export const serve = async ({
  imports,
  bridge,
  keySet,
}: Served): Promise<NestFastifyApplication> => {
  const builder = Test.createTestingModule({
    imports: [
      BridgeModule.forRoot(() => bridge),
      AdminAuthModule.forRoot({
        readConfig: adminAuthConfig,
        ...(keySet ? { keySetFor: () => keySet } : {}),
      }),
      ...imports,
    ],
  })
  const moduleRef = await (
    keySet
      ? builder
      : builder.overrideGuard(SupabaseAdminGuard).useValue({ canActivate: () => true })
  ).compile()
  const app = configureApp(
    moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
      rawBody: true,
    }),
  )
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}
