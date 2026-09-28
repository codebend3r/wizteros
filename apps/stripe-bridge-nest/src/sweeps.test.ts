import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type SweepAlerts, sweepAlerts } from '@/changeAlert.js'
import { checkPaymentStates, checkVipAccess } from '@/sweeps.js'
import { asBridge, type FakeBridge, fakeBridge, subscription } from '@/test/fakes.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import type { Bridge } from '@/types.js'

type Setup = Readonly<{ fake: FakeBridge; bridge: Bridge }>

/** A freshly initialised store and a bridge over it with every service faked. */
const setup = (): Setup => {
  const fake = fakeBridge({ dbPath: tempDbPath() })
  fake.store.init()
  return { fake, bridge: asBridge(fake) }
}

/** Stripe's subscription listing answers with these (customer, status) pairs. */
const stripeSubs = ({
  fake,
  subs,
}: {
  fake: FakeBridge
  subs: readonly Readonly<{ customer: string; status: string }>[]
}): void => {
  fake.stripe.allSubscriptions.mockResolvedValue(subs.map((sub) => subscription(sub)))
}

/** The action names in a member's history. */
const actionsFor = ({ bridge, email }: { bridge: Bridge; email: string }): string[] =>
  bridge.store.eventsForEmail({ email }).map((event) => event.action)

let alerts: SweepAlerts

describe('sweeps', () => {
  // Fresh alarms per test, so the first problem set always mails.
  beforeEach(() => {
    alerts = sweepAlerts()
  })

  afterEach(() => {
    removeTempDirs()
  })

  // --- payment states ---------------------------------------------------------

  it('payment state check finds the member the webhook never reported', async () => {
    // The sweep is the net under the webhook.
    //
    // A member whose payment_failed events never reached the bridge (the event
    // type was not enabled on the endpoint for weeks) sat as Subscribed Monthly
    // while Stripe declined them three times. Stripe's own subscription status
    // is the truth the sweep reads back.
    const { fake, bridge } = setup()
    bridge.store.upsertPending({
      customerId: 'cus_due',
      email: 'due@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    bridge.store.upsertPending({
      customerId: 'cus_ok',
      email: 'ok@x.com',
      inviteCode: 'def',
      tier: 'bronze',
    })
    stripeSubs({
      fake,
      subs: [
        { customer: 'cus_due', status: 'past_due' },
        { customer: 'cus_ok', status: 'active' },
      ],
    })

    expect(await checkPaymentStates(bridge)).toEqual(['due@x.com'])
    const rows = bridge.store.allCustomerRows()
    expect(rows.get('due@x.com')?.payment_state).toBe('past_due')
    expect(rows.get('ok@x.com')?.payment_state).toBeNull()
    expect(rows.get('due@x.com')?.subscribed).toBe(true) // access is never the sweep's to take
    expect(fake.wizarr.disableUser).not.toHaveBeenCalled()
    expect(fake.mailer.sendAlert).toHaveBeenCalledOnce()
    const { subject, body } = fake.mailer.sendAlert.mock.calls[0]?.[0] ?? { subject: '', body: '' }
    expect(subject).toBe('1 member(s) missed a payment')
    expect(body).toContain('due@x.com')
    expect(body).toContain('NO server access')
    expect(body).not.toContain('ok@x.com')
    expect(actionsFor({ bridge, email: 'due@x.com' })).toContain('Payment failed')
    // Writing the flag is what silences the next sweep: no second mail.
    expect(await checkPaymentStates(bridge)).toEqual([])
    expect(fake.mailer.sendAlert).toHaveBeenCalledOnce()
  })

  it('payment state check clears the flag once stripe says active', async () => {
    const { fake, bridge } = setup()
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    bridge.store.setPaymentState({ email: 'a@x.com', state: 'past_due' })
    stripeSubs({ fake, subs: [{ customer: 'cus_1', status: 'active' }] })

    expect(await checkPaymentStates(bridge)).toEqual([])
    expect(bridge.store.allCustomerRows().get('a@x.com')?.payment_state).toBeNull()
    expect(fake.mailer.sendAlert).not.toHaveBeenCalled()
    expect(actionsFor({ bridge, email: 'a@x.com' })).toContain('Payment recovered')
  })

  it('payment state check reads the live subscription past a dead one', async () => {
    // A member who lapsed and re-subscribed holds a canceled sub next to the
    // live one; the live one is what they are paying.
    const { fake, bridge } = setup()
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    stripeSubs({
      fake,
      subs: [
        { customer: 'cus_1', status: 'canceled' },
        { customer: 'cus_1', status: 'active' },
      ],
    })
    expect(await checkPaymentStates(bridge)).toEqual([])
    expect(bridge.store.allCustomerRows().get('a@x.com')?.payment_state).toBeNull()
  })

  it('payment state check leaves unsubscribed and unknown rows alone', async () => {
    const { fake, bridge } = setup()
    bridge.store.upsertPending({
      customerId: 'cus_gone',
      email: 'gone@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    bridge.store.setSubscribed({ email: 'gone@x.com', value: false })
    bridge.store.upsertPending({
      customerId: 'cus_unlisted',
      email: 'quiet@x.com',
      inviteCode: 'def',
      tier: 'bronze',
    })
    // The canceled member's old sub is past_due in Stripe's history; the other
    // member has no subscription in the listing at all.
    stripeSubs({ fake, subs: [{ customer: 'cus_gone', status: 'past_due' }] })

    expect(await checkPaymentStates(bridge)).toEqual([])
    const rows = bridge.store.allCustomerRows()
    expect(rows.get('gone@x.com')?.payment_state).toBeNull()
    expect(rows.get('quiet@x.com')?.payment_state).toBeNull()
    expect(fake.mailer.sendAlert).not.toHaveBeenCalled()
  })

  it('payment state check survives stripe being down', async () => {
    const { fake, bridge } = setup()
    bridge.store.upsertPending({
      customerId: 'cus_1',
      email: 'a@x.com',
      inviteCode: 'abc',
      tier: 'bronze',
    })
    fake.stripe.allSubscriptions.mockRejectedValue(new Error('stripe down'))
    // Unreachable is not a missed payment, and this runs inside the sweep.
    expect(await checkPaymentStates(bridge)).toEqual([])
    expect(bridge.store.allCustomerRows().get('a@x.com')?.payment_state).toBeNull()
    expect(fake.mailer.sendAlert).not.toHaveBeenCalled()
  })

  // --- vip access -------------------------------------------------------------

  it('vip access check flags a vip holding nothing', async () => {
    // The standing guarantee needs an alarm, not just a guard.
    //
    // A VIP can end up with no records for reasons no single guard covers: an
    // invite that was never redeemed, a manual disable, a Plex-side unshare. The
    // sweep is what turns that silence into a mail.
    const { fake, bridge } = setup()
    bridge.store.setMemberTag({ email: 'vip@x.com', tag: 'vip' })
    bridge.store.setMemberTag({ email: 'ok@x.com', tag: 'vip' })
    fake.wizarr.listUsers.mockResolvedValue([
      { id: 1, email: 'ok@x.com', server: 'Meleys', expires: null },
    ])

    expect(await checkVipAccess({ bridge, alert: alerts.vipAccess })).toEqual(['vip@x.com'])
    expect(fake.mailer.sendAlert).toHaveBeenCalledOnce()
    expect(fake.mailer.sendAlert.mock.calls[0]?.[0].body).toContain('vip@x.com')
    // A standing problem mails once, not every sweep.
    expect(await checkVipAccess({ bridge, alert: alerts.vipAccess })).toEqual(['vip@x.com'])
    expect(fake.mailer.sendAlert).toHaveBeenCalledOnce()
  })

  it('vip access check is quiet when every vip holds access', async () => {
    const { fake, bridge } = setup()
    bridge.store.setMemberTag({ email: 'ok@x.com', tag: 'vip' })
    fake.wizarr.listUsers.mockResolvedValue([
      { id: 1, email: 'ok@x.com', server: 'Meleys', expires: null },
    ])
    expect(await checkVipAccess({ bridge, alert: alerts.vipAccess })).toEqual([])
    expect(fake.mailer.sendAlert).not.toHaveBeenCalled()
  })

  it('vip access check survives wizarr being down', async () => {
    const { fake, bridge } = setup()
    bridge.store.setMemberTag({ email: 'vip@x.com', tag: 'vip' })
    fake.wizarr.listUsers.mockRejectedValue(new Error('wizarr down'))
    // Unreachable is not the same as locked out, and this runs inside the sweep.
    expect(await checkVipAccess({ bridge, alert: alerts.vipAccess })).toEqual([])
  })
})
