import { type DynamicModule, Module } from '@nestjs/common'
import { BRIDGE } from '@/bridgeToken.js'
import type { Bridge } from '@/types.js'

/**
 * Provides the one `Bridge` app-wide, so the webhook, the admin routes and the
 * background loops all act through the same store and service ports.
 * Built lazily from a factory, so importing the module reads no environment.
 */
@Module({})
export class BridgeModule {
  static forRoot(build: () => Bridge): DynamicModule {
    return {
      module: BridgeModule,
      global: true,
      providers: [{ provide: BRIDGE, useFactory: build }],
      exports: [BRIDGE],
    }
  }
}
