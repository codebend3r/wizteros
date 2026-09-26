import { Module, type OnModuleInit } from '@nestjs/common'
import { AdminAuthModule } from '@wizteros/server-common'
import { FleetController, HealthController } from '@/api/fleetController.js'
import { PlaysController } from '@/api/playsController.js'
import { initDb } from '@/collector.js'
import { adminAuthConfig, dbPath } from '@/config.js'

@Module({
  imports: [AdminAuthModule.forRoot({ readConfig: adminAuthConfig })],
  controllers: [HealthController, FleetController, PlaysController],
})
export class AppModule implements OnModuleInit {
  /**
   * Create every table this process reads before it serves a request.
   *
   * Opening a SQLite file happily creates an empty one, so without this a
   * fresh FM_DB_PATH turns the first /health into an unhandled 500 on a
   * missing table. The collector and the API may each be the first to run
   * against a new volume, so both call the same idempotent setup.
   */
  onModuleInit(): void {
    initDb(dbPath())
  }
}
