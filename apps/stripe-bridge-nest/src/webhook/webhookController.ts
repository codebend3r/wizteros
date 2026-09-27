import { Controller, Headers, HttpCode, Inject, Post, Req } from '@nestjs/common'
import { httpError } from '@wizteros/server-common'
import { BRIDGE } from '@/bridgeToken.js'
import { isSignatureError, verifyWebhook } from '@/clients/stripe.js'
import { stripeWebhookSecret } from '@/config.js'
import type { Bridge } from '@/types.js'
import { handleEvent } from '@/webhook/handlers.js'

/**
 * The slice of the request the webhook reads: the exact bytes Stripe signed,
 * which Nest keeps because the app is created with `rawBody: true`. Nest's
 * `RawBodyRequest<FastifyRequest>`, without a direct fastify dependency.
 */
type SignedRequest = Readonly<{ rawBody?: Buffer }>

/**
 * A runner that starts each job only once the one before it has settled.
 *
 * The Python route was an `async def` doing synchronous work, so the event
 * loop handled one delivery start to finish before the next. Here the
 * handlers await between their Wizarr, Stripe and store calls, and two
 * deliveries would interleave: two copies of one checkout could both pass
 * the processed check and both mint an invite. Chaining every delivery onto
 * the last keeps them one at a time. A failed job settles the chain too, so
 * one bad delivery never blocks the ones behind it.
 */
export const serialQueue = (): (<T>(job: () => Promise<T>) => Promise<T>) => {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

// Public URL is /stripe/webhook. Tailscale Funnel mounts the bridge with
// --set-path=/stripe and strips that prefix, so behind Funnel the request
// arrives as /webhook. Both paths are served so direct/local calls (README,
// `stripe listen`) and Funnel-proxied calls hit the same handler.
@Controller()
export class WebhookController {
  private readonly serially = serialQueue()

  constructor(@Inject(BRIDGE) private readonly bridge: Bridge) {}

  /**
   * Verify the Stripe signature against the raw body, then hand the parsed
   * event to handleEvent. A bad signature is a 400; a handler failure is a
   * 500, which leaves the event unmarked so Stripe redelivers it.
   */
  @Post(['webhook', 'stripe/webhook'])
  @HttpCode(200)
  async webhook(
    @Req() request: SignedRequest,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ ok: true }> {
    const payload = request.rawBody ?? Buffer.alloc(0)
    try {
      verifyWebhook({ payload, signature, secret: stripeWebhookSecret() })
    } catch (error) {
      if (isSignatureError(error)) {
        throw httpError({ status: 400, detail: 'invalid signature' })
      }
      throw error
    }
    // The verified bytes are the event; parse them as Python's
    // json.loads(payload) did rather than trust a body parser's copy.
    const event: unknown = JSON.parse(payload.toString('utf8'))
    await this.serially(() => handleEvent({ bridge: this.bridge, event }))
    return { ok: true }
  }
}
