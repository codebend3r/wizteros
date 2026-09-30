import { Module } from '@nestjs/common'
import { AdminController } from '@/admin/adminController.js'
import { MEMBERS_SNAPSHOT, membersSnapshotProvider } from '@/admin/membersSnapshot.js'

/**
 * The admin portal's routes and the members list's warm snapshot.
 *
 * `BRIDGE` comes from the global BridgeModule and the session gate from the
 * global AdminAuthModule, so neither is provided here. The snapshot is
 * exported for the app's background loop, which warms it at boot and
 * refreshes it on an interval.
 */
@Module({
  controllers: [AdminController],
  providers: [membersSnapshotProvider],
  exports: [MEMBERS_SNAPSHOT],
})
export class AdminModule {}
