import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify'
import { Test, type TestingModuleBuilder } from '@nestjs/testing'
import {
  ADMIN_AUTH_OPTIONS,
  type AdminAuthOptions,
  SupabaseAdminGuard,
} from '@wizteros/server-common'
import type { JWTVerifyGetKey } from 'jose'
import { configureApp } from '@/app.js'
import { AppModule } from '@/appModule.js'
import { adminAuthConfig } from '@/config.js'

// The API as the route tests drive it: AppModule under the same setup main.ts
// serves, initialized (so the schema is created on startup, as the Python
// lifespan did) and driven through `inject`. FM_DB_PATH has to be stubbed
// before either of these is called, since startup reads it.

const serve = async (builder: TestingModuleBuilder): Promise<NestFastifyApplication> => {
  const moduleRef = await builder.compile()
  const app = configureApp(
    moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
      logger: false,
    }),
  )
  await app.init()
  await app.getHttpAdapter().getInstance().ready()
  return app
}

/**
 * The app with its gate verifying for real, against `keySet` rather than a
 * fetch of Supabase's published keys. The config is still read from
 * FM_SUPABASE_URL and FM_ADMIN_ALLOWED_EMAILS on every request, so a test sets
 * those with vi.stubEnv as the Python tests set them with monkeypatch.
 */
export const appBehindTheGate = (keySet: JWTVerifyGetKey): Promise<NestFastifyApplication> => {
  const options: AdminAuthOptions = { readConfig: adminAuthConfig, keySetFor: () => keySet }
  return serve(
    Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ADMIN_AUTH_OPTIONS)
      .useValue(options),
  )
}

/**
 * The app already past the admin gate, the Python suites' dependency override
 * on `require_admin`. What a test built on this asserts is the data, not who
 * may read it; the gate itself is tested for real in auth.test.ts.
 */
export const appPastTheGate = (): Promise<NestFastifyApplication> =>
  serve(
    Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(SupabaseAdminGuard)
      .useValue({ canActivate: () => true }),
  )
