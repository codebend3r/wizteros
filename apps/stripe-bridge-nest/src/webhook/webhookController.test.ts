import { Logger } from '@nestjs/common'
import type { NestFastifyApplication } from '@nestjs/platform-fastify'
import { Stripe } from 'stripe'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, isEventProcessed } from '@/store.js'
import { asBridge, type FakeBridge, fakeBridge } from '@/test/fakes.js'
import { serve } from '@/test/serve.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import type { WizarrLibrary } from '@/types.js'
import { serialQueue } from '@/webhook/webhookController.js'
import { WebhookModule } from '@/webhook/webhookModule.js'

// The route as Stripe reaches it: the signature checked against the exact
// bytes sent, on both of the paths the Funnel and a direct call use.

const SECRET = 'whsec_test'

const FIXTURE_LIBRARIES: readonly WizarrLibrary[] = [
  { id: 17, name: '05. TV Shows', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 22, name: '14. Kid Shows', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 24, name: '03. Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
]

let bridge: FakeBridge
let app: NestFastifyApplication

beforeEach(async () => {
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', SECRET)
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
  bridge = fakeBridge({ dbPath: tempDbPath() })
  initDb({ path: bridge.dbPath })
  app = await serve({ imports: [WebhookModule], bridge: asBridge(bridge) })
})

afterEach(async () => {
  await app.close()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  removeTempDirs()
})

/** POST `payload` to `url`, signed for SECRET unless a signature is given. */
const deliver = ({
  payload,
  url = '/stripe/webhook',
  signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET }),
}: {
  payload: string
  url?: string
  signature?: string
}) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    payload,
  })

const checkoutPayload = (id: string): string =>
  JSON.stringify({
    id,
    type: 'checkout.session.completed',
    data: {
      object: { id: 'cs_1', customer: 'cus_1', customer_details: { email: 'a@x.com' } },
    },
  })

describe('POST /webhook', () => {
  it('handles a real Stripe event end to end', async () => {
    // A delivery Stripe actually signed, driven through the route rather than
    // handed to the handler, to prove the parsed event is what the table reads
    // and the answer is a 200, not a 500.
    bridge.wizarr.listLibraries.mockResolvedValue([...FIXTURE_LIBRARIES])
    bridge.wizarr.createInvite.mockResolvedValue({ code: 'abc', url: 'http://x/j/abc' })
    const response = await deliver({ payload: checkoutPayload('evt_route_1') })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ ok: true })
    expect(bridge.mailer.sendInvite).toHaveBeenCalledExactlyOnceWith({
      to: 'a@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
  })

  it('rejects an invalid signature', async () => {
    const response = await deliver({
      payload: checkoutPayload('evt_bad_sig'),
      signature: 't=1,v1=bad',
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ detail: 'invalid signature' })
    expect(bridge.wizarr.createInvite).not.toHaveBeenCalled()
    expect(isEventProcessed({ path: bridge.dbPath, eventId: 'evt_bad_sig' })).toBe(false)
  })

  it('is served on both Funnel paths', async () => {
    // Tailscale Funnel strips the /stripe prefix; direct/local calls don't.
    // Both paths must route to the same handler.
    const bare = await deliver({
      url: '/webhook',
      payload: JSON.stringify({ id: 'evt_bare', type: 'ping', data: { object: {} } }),
    })
    const prefixed = await deliver({
      url: '/stripe/webhook',
      payload: JSON.stringify({ id: 'evt_prefixed', type: 'ping', data: { object: {} } }),
    })
    expect([bare.statusCode, prefixed.statusCode]).toEqual([200, 200])
    expect(isEventProcessed({ path: bridge.dbPath, eventId: 'evt_bare' })).toBe(true)
    expect(isEventProcessed({ path: bridge.dbPath, eventId: 'evt_prefixed' })).toBe(true)
  })

  it('checks the signature against the raw bytes, not a re-serialized body', async () => {
    // Stripe signs exactly what it sent. Whitespace a JSON round trip would
    // drop must still verify, or every real delivery would be a 400.
    const payload = JSON.stringify(
      { id: 'evt_spaced', type: 'ping', data: { object: {} } },
      null,
      2,
    )
    const response = await deliver({ payload })
    expect(response.statusCode).toBe(200)
  })

  it('handles concurrent deliveries one at a time', async () => {
    // Stripe can deliver the same checkout twice at once (a retry racing a
    // slow first attempt). Handled together, both would pass the processed
    // check before either marked it, and both would mint an invite.
    bridge.wizarr.listLibraries.mockResolvedValue([...FIXTURE_LIBRARIES])
    bridge.wizarr.createInvite.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { code: 'abc', url: 'http://x/j/abc' }
    })
    const payload = checkoutPayload('evt_twice')
    const responses = await Promise.all([deliver({ payload }), deliver({ payload })])
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200])
    expect(bridge.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(bridge.mailer.sendInvite).toHaveBeenCalledOnce()
  })

  it('a failed delivery leaves the event for a retry and does not block the next', async () => {
    bridge.wizarr.listLibraries.mockRejectedValueOnce(new Error('wizarr down'))
    const failed = await deliver({ payload: checkoutPayload('evt_fails') })
    const next = await deliver({
      payload: JSON.stringify({ id: 'evt_next', type: 'ping', data: { object: {} } }),
    })
    expect(failed.statusCode).toBe(500)
    expect(isEventProcessed({ path: bridge.dbPath, eventId: 'evt_fails' })).toBe(false)
    expect(next.statusCode).toBe(200)
  })
})

describe('serialQueue', () => {
  it('starts each job only after the previous one settles, failed or not', async () => {
    const serially = serialQueue()
    const order: string[] = []
    const job =
      ({ name, ms, fail = false }: { name: string; ms: number; fail?: boolean }) =>
      async (): Promise<string> => {
        order.push(`start ${name}`)
        await new Promise((resolve) => setTimeout(resolve, ms))
        order.push(`end ${name}`)
        if (fail) {
          throw new Error(name)
        }
        return name
      }
    const results = await Promise.allSettled([
      serially(job({ name: 'a', ms: 20, fail: true })),
      serially(job({ name: 'b', ms: 1 })),
    ])
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b'])
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled'])
  })
})
