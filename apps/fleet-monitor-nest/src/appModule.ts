import { Module } from '@nestjs/common'
import { AdminAuthModule } from '@wizteros/server-common'
import { adminAuthConfig } from '@/config.js'

@Module({
  imports: [AdminAuthModule.forRoot({ readConfig: adminAuthConfig })],
})
export class AppModule {}
