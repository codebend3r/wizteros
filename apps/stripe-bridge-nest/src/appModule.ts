import { Inject, Module, type OnModuleInit } from '@nestjs/common'
import { AdminAuthModule } from '@wizteros/server-common'
import { AdminModule } from '@/admin/adminModule.js'
import { bridgeFromEnv } from '@/bridgeFromEnv.js'
import { BridgeModule } from '@/bridgeModule.js'
import { BRIDGE } from '@/bridgeToken.js'
import { adminAuthConfig } from '@/config.js'
import { BackgroundLoops } from '@/loops.js'
import type { Bridge } from '@/types.js'
import { VersionController } from '@/version/versionController.js'
import { WebhookModule } from '@/webhook/webhookModule.js'

@Module({
  imports: [
    BridgeModule.forRoot(bridgeFromEnv),
    AdminAuthModule.forRoot({ readConfig: adminAuthConfig }),
    WebhookModule,
    AdminModule,
  ],
  controllers: [VersionController],
  providers: [BackgroundLoops],
})
export class AppModule implements OnModuleInit {
  constructor(@Inject(BRIDGE) private readonly bridge: Bridge) {}

  /**
   * Create the tables and backfill the added columns before anything reads
   * them. Done at startup rather than at import so that loading a module (a
   * test, a script) never has to be able to write the configured database
   * file; the process that serves requests always can.
   */
  onModuleInit(): void {
    this.bridge.store.init()
  }
}
