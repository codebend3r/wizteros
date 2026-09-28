import { Logger } from '@nestjs/common'
import { vi } from 'vitest'
import { asBridge, type FakeBridge, fakeBridge } from '@/test/fakes.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import type { CustomerRow, WizarrLibrary } from '@/types.js'
import { handleEvent } from '@/webhook/handlers.js'

// The webhook handlers under test: a fresh bridge per test (a temp SQLite db,
// a faked Wizarr, Stripe and mailer) behind the readers the assertions share,
// plus builders for the events Stripe delivers. Operator alerts are faked for
// every test: a checkout now mails the admin, and nothing here may reach a
// real SMTP host. No plex.tv by default: the library list is trusted as given.

// Every tier shares from Meleys alone; the trailing Vermithor entry is a
// retired server's "(switch to Meleys)" mirror and must never reach an invite.
export const FIXTURE_LIBRARIES: readonly WizarrLibrary[] = [
  { id: 17, name: '05. TV Shows', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 20, name: '04. 4K Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 22, name: '14. Kid Shows', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 24, name: '03. Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 37, name: '99. Tutorials', server_id: 2, server_name: 'Meleys', enabled: true },
  {
    id: 41,
    name: '01. TV Shows (switch to Meleys)',
    server_id: 1,
    server_name: 'Vermithor',
    enabled: true,
  },
]

export const DAY_MS = 86_400_000

export type WebhookHarness = Readonly<{
  bridge: FakeBridge
  /** Hand one event to handleEvent over the bridge. */
  handle: (event: unknown) => Promise<void>
  /** Wizarr answering with the fixture libraries and minting invite `code`. */
  wizarrMints: (code: string) => void
  /** The customer row the store holds for an email. */
  rowFor: (email: string) => CustomerRow | undefined
  /** The record ids setExpiry was called with, in call order. */
  setExpiryIds: () => number[]
  /** The expiries setExpiry was called with, in call order. */
  setExpiryValues: () => string[]
  /** The record ids disableUser was called with, in call order. */
  disabledIds: () => number[]
}>

/** A fresh bridge over a temp store with every service faked and the logs silenced; for a beforeEach. */
export const webhookHarness = (): WebhookHarness => {
  const bridge = fakeBridge({ dbPath: tempDbPath() })
  bridge.store.init()
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
  return {
    bridge,
    handle: (event) => handleEvent({ bridge: asBridge(bridge), event }),
    wizarrMints: (code) => {
      bridge.wizarr.listLibraries.mockResolvedValue([...FIXTURE_LIBRARIES])
      bridge.wizarr.createInvite.mockResolvedValue({ code, url: `http://x/j/${code}` })
    },
    rowFor: (email) => bridge.store.allCustomerRows().get(email),
    setExpiryIds: () => bridge.wizarr.setExpiry.mock.calls.map(([call]) => call.userId),
    setExpiryValues: () => bridge.wizarr.setExpiry.mock.calls.map(([call]) => call.expires ?? ''),
    disabledIds: () => bridge.wizarr.disableUser.mock.calls.map(([id]) => id),
  }
}

/** Restore the silenced logs and remove the temp stores; for an afterEach. */
export const stopWebhookHarness = (): void => {
  vi.restoreAllMocks()
  removeTempDirs()
}

export const byNumber = (a: number, b: number): number => a - b

/** A checkout.session.completed event carrying `session`. */
export const checkout = ({ id, session }: { id: string; session: Record<string, unknown> }) => ({
  type: 'checkout.session.completed',
  id,
  data: { object: session },
})

export const invoicePaid = ({
  id,
  customer,
  email,
  billingReason = 'subscription_cycle',
}: {
  id: string
  customer: string
  email: string
  billingReason?: string
}) => ({
  type: 'invoice.paid',
  id,
  data: { object: { customer, customer_email: email, billing_reason: billingReason } },
})

export const paymentFailed = ({
  id,
  invoice,
}: {
  id: string
  invoice: Record<string, unknown>
}) => ({
  type: 'invoice.payment_failed',
  id,
  data: { object: invoice },
})

export const cancel = ({ id, customer }: { id: string; customer: string }) => ({
  type: 'customer.subscription.deleted',
  id,
  data: { object: { customer } },
})
