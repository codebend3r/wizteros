import { Module } from '@nestjs/common'
import { WebhookController } from '@/webhook/webhookController.js'

/**
 * The Stripe webhook on both of its paths. The `BRIDGE` it acts through comes
 * from the global BridgeModule, so it is not provided here.
 */
@Module({ controllers: [WebhookController] })
export class WebhookModule {}
