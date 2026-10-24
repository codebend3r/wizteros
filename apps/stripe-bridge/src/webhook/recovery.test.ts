import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { webhookHarness, stopWebhookHarness, type WebhookHarness } from '@/test/webhookHarness.js'

let h: WebhookHarness
beforeEach(() => {
  h = webhookHarness()
  h.wizarrMints('recovered')
})
afterEach(stopWebhookHarness)

const payment = ({
  eventId = 'evt_recover',
  invoiceId = 'in_1',
}: { eventId?: string; invoiceId?: string } = {}) => ({
  id: eventId,
  type: 'invoice.paid',
  data: {
    object: {
      id: invoiceId,
      customer: 'cus_1',
      customer_email: 'a@x.com',
      billing_reason: 'subscription_cycle',
    },
  },
})

describe('recovery invitation retries', () => {
  it('reuses the recorded invite after SMTP fails, including after schema reinitialization', async () => {
    h.bridge.mailer.sendInvite.mockRejectedValueOnce(new Error('SMTP offline'))
    await expect(h.handle(payment())).rejects.toThrow('SMTP offline')
    expect(h.bridge.store.isEventProcessed({ eventId: 'evt_recover' })).toBe(false)
    h.bridge.store.init()
    await h.handle(payment())
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(h.bridge.mailer.sendInvite.mock.calls).toEqual([
      [{ to: 'a@x.com', inviteUrl: 'http://inv.test/j/recovered' }],
      [{ to: 'a@x.com', inviteUrl: 'http://inv.test/j/recovered' }],
    ])
  })

  it('deduplicates by invoice even when Stripe delivers a new event id', async () => {
    await h.handle(payment())
    await h.handle(payment({ eventId: 'evt_other' }))
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledOnce()
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledOnce()
    expect(h.bridge.mailer.sendAlert).toHaveBeenCalledOnce()
  })

  it('gives a later invoice its own recovery operation', async () => {
    await h.handle(payment())
    await h.handle(payment({ eventId: 'evt_later', invoiceId: 'in_2' }))
    expect(h.bridge.wizarr.createInvite).toHaveBeenCalledTimes(2)
    expect(h.bridge.mailer.sendInvite).toHaveBeenCalledTimes(2)
  })

  it('refuses recovery without a durable invoice id', async () => {
    const event = payment()
    await expect(
      h.handle({ ...event, data: { object: { ...event.data.object, id: undefined } } }),
    ).rejects.toThrow('id')
    expect(h.bridge.wizarr.createInvite).not.toHaveBeenCalled()
  })
})
