import { expect, test } from '@/test/vi'
import type { Member, MemberEvent } from '@/lib/adminApi'
import type { Incident } from '@/lib/fleetApi'
import {
  currentIncome,
  formatMoney,
  monthLabel,
  monthlySeries,
  tierFromDetail,
  tierPrice,
  toIncomeEvents,
} from '@/lib/income'

const NOW = Date.parse('2026-09-04T12:00:00+00:00')

const makeMember = (overrides: Partial<Member>): Member => ({
  member: 'user',
  email: 'user@x.com',
  tier: 'bronze',
  downloads: null,
  expires: null,
  servers: ['Meleys'],
  libraries: {},
  entitled: {},
  subscribed: true,
  payment_state: null,
  invited_at: null,
  tag: null,
  customer_id: null,
  stripe_email: null,
  ...overrides,
})

// The id only breaks ties between rows stamped at the same instant, and no
// fixture here shares one, so the timestamp itself serves.
const event = ({
  at,
  email,
  action,
  detail = '',
}: {
  at: string
  email: string
  action: string
  detail?: string
}): MemberEvent => ({ id: Date.parse(at) / 1000, at, email, action, detail })

const outage = ({
  id,
  target,
  openedAt,
  closedAt = null,
}: {
  id: number
  target: string
  openedAt: string
  closedAt?: string | null
}): Incident => ({ id, target, reason: 'ssh timed out', opened_at: openedAt, closed_at: closedAt })

test('tierPrice reads the monthly figure the landing page quotes', () => {
  expect(tierPrice({ tier: 'bronze' })).toBe(8)
  expect(tierPrice({ tier: 'silver' })).toBe(14)
  expect(tierPrice({ tier: 'gold' })).toBe(20)
  expect(tierPrice({ tier: 'youth' })).toBe(10)
})

test('formatMoney drops the cents when there are none', () => {
  expect(formatMoney(612)).toBe('$612')
  expect(formatMoney(612.5)).toBe('$612.50')
  expect(formatMoney(0)).toBe('$0')
  expect(formatMoney(-14)).toBe('-$14')
})

test('monthLabel names the month and year', () => {
  expect(monthLabel('2026-08')).toBe('Aug 2026')
})

test('currentIncome adds up every subscribed member at their tier price', () => {
  const members = [
    makeMember({ email: 'a@x.com', tier: 'gold' }),
    makeMember({ email: 'b@x.com', tier: 'bronze' }),
    makeMember({ email: 'c@x.com', tier: 'bronze', subscribed: false }),
    makeMember({ email: 'd@x.com', tier: 'silver', payment_state: 'past_due' }),
  ]
  const income = currentIncome({ members, now: NOW })
  expect(income.total).toBe(42)
  expect(income.paying).toBe(3)
  expect(income.byTier.gold).toEqual({ count: 1, amount: 20 })
  expect(income.byTier.bronze).toEqual({ count: 1, amount: 8 })
  expect(income.byTier.silver).toEqual({ count: 1, amount: 14 })
  expect(income.byTier.youth).toEqual({ count: 0, amount: 0 })
  expect(income.atRisk).toEqual({ count: 1, amount: 14 })
})

test('currentIncome leaves out expired, banned, and untiered members', () => {
  const members = [
    makeMember({ email: 'a@x.com', tier: 'gold', expires: '2026-08-01T00:00:00+00:00' }),
    makeMember({ email: 'b@x.com', tier: 'gold', tag: 'banned' }),
    makeMember({ email: 'c@x.com', tier: 'unknown' }),
    makeMember({ email: 'd@x.com', tier: 'youth', tag: 'vip' }),
  ]
  const income = currentIncome({ members, now: NOW })
  expect(income.total).toBe(10)
  expect(income.paying).toBe(1)
  expect(income.untiered).toBe(1)
})

test('tierFromDetail finds the tier the log named, including the legacy kids name', () => {
  expect(tierFromDetail('gold tier — invite emailed')).toBe('gold')
  expect(tierFromDetail('hard reset to silver')).toBe('silver')
  expect(tierFromDetail('kids tier — invite emailed')).toBe('youth')
  expect(tierFromDetail('subscription ended — 2 server record(s) disabled')).toBeNull()
})

test('toIncomeEvents turns signups and cancellations into priced movements', () => {
  const events = [
    event({
      at: '2026-08-14T10:00:00+00:00',
      email: 'a@x.com',
      action: 'Canceled',
      detail: 'subscription ended — 1 server record(s) disabled',
    }),
    event({
      at: '2026-06-10T10:00:00+00:00',
      email: 'a@x.com',
      action: 'Signed up',
      detail: 'silver tier — invite emailed',
    }),
  ]
  const out = toIncomeEvents({ events, outages: [] })
  expect(out.map((e) => [e.kind, e.delta, e.tier])).toEqual([
    ['cancel', -14, 'silver'],
    ['signup', 14, 'silver'],
  ])
  expect(out[0]?.email).toBe('a@x.com')
})

test('toIncomeEvents reads a tier reset as an upgrade or downgrade against the last tier', () => {
  const events = [
    event({
      at: '2026-08-01T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Tier reset',
      detail: 'hard reset to bronze',
    }),
    event({
      at: '2026-07-01T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Tier reset',
      detail: 'hard reset to gold',
    }),
    event({
      at: '2026-06-10T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Signed up',
      detail: 'silver tier — invite emailed',
    }),
  ]
  const out = toIncomeEvents({ events, outages: [] })
  expect(out.map((e) => [e.kind, e.delta, e.fromTier, e.tier])).toEqual([
    ['downgrade', -12, 'gold', 'bronze'],
    ['upgrade', 6, 'silver', 'gold'],
    ['signup', 14, null, 'silver'],
  ])
})

test('toIncomeEvents reads a second signup at another tier as a tier change, not a new member', () => {
  const events = [
    event({
      at: '2026-08-12T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Signed up',
      detail: 'gold tier — invite emailed',
    }),
    event({
      at: '2026-05-10T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Signed up',
      detail: 'bronze tier — invite emailed',
    }),
  ]
  const out = toIncomeEvents({ events, outages: [] })
  expect(out.map((e) => [e.kind, e.delta])).toEqual([
    ['upgrade', 12],
    ['signup', 8],
  ])
})

test('toIncomeEvents ignores a same-tier re-signup and an invite that changes nothing', () => {
  const events = [
    event({
      at: '2026-08-12T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Invite issued',
      detail: 'bronze tier — link emailed',
    }),
    event({
      at: '2026-07-12T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Signed up',
      detail: 'bronze tier — invite emailed',
    }),
    event({
      at: '2026-05-10T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Signed up',
      detail: 'bronze tier — invite emailed',
    }),
  ]
  const out = toIncomeEvents({ events, outages: [] })
  expect(out.map((e) => e.kind)).toEqual(['signup'])
})

test('toIncomeEvents keeps scheduled cancellations, failed payments, bans, and restores', () => {
  const events = [
    event({
      at: '2026-08-20T00:00:00+00:00',
      email: 'b@x.com',
      action: 'Banned',
      detail: '1 server record(s) disabled; billing stops 2026-09-21',
    }),
    event({
      at: '2026-08-15T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Access restored',
      detail: 'paid with no active records; gold invite reissued',
    }),
    event({
      at: '2026-08-10T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Payment failed',
      detail: 'Stripe charge declined; access held while it retries',
    }),
    event({
      at: '2026-08-05T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Cancellation scheduled',
      detail: 'by admin — access ends 2026-09-01',
    }),
    event({
      at: '2026-07-01T00:00:00+00:00',
      email: 'b@x.com',
      action: 'Signed up',
      detail: 'youth tier — invite emailed',
    }),
    event({
      at: '2026-06-01T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Signed up',
      detail: 'gold tier — invite emailed',
    }),
    event({
      at: '2026-05-01T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Payment received',
      detail: 'access extended to 2026-06-05',
    }),
  ]
  const out = toIncomeEvents({ events, outages: [] })
  expect(out.map((e) => [e.kind, e.delta])).toEqual([
    ['cancel', -10],
    ['signup', 0],
    ['payment_failed', 0],
    ['cancel_scheduled', 0],
    ['signup', 10],
    ['signup', 20],
  ])
  expect(out[1]?.detail).toBe('paid with no active records; gold invite reissued')
})

test('toIncomeEvents merges fleet outages in by time with their duration', () => {
  const events = [
    event({
      at: '2026-08-10T00:00:00+00:00',
      email: 'a@x.com',
      action: 'Signed up',
      detail: 'gold tier — invite emailed',
    }),
  ]
  const outages = [
    outage({
      id: 7,
      target: 'host:meleys',
      openedAt: '2026-08-12T01:00:00+00:00',
      closedAt: '2026-08-12T03:30:00+00:00',
    }),
    outage({ id: 8, target: 'container:vhagar/plex', openedAt: '2026-08-01T01:00:00+00:00' }),
  ]
  const out = toIncomeEvents({ events, outages })
  expect(out.map((e) => [e.kind, e.at])).toEqual([
    ['outage', '2026-08-12T01:00:00+00:00'],
    ['signup', '2026-08-10T00:00:00+00:00'],
    ['outage', '2026-08-01T01:00:00+00:00'],
  ])
  expect(out[0]?.detail).toBe('host:meleys down for 2 hours 30 minutes')
  expect(out[2]?.detail).toBe('container:vhagar/plex still down')
  expect(out[0]?.email).toBeNull()
  expect(out[0]?.id).not.toBe(out[2]?.id)
})

test('monthlySeries walks each member from signup to cancellation, month by month', () => {
  const members = [
    makeMember({ email: 'a@x.com', tier: 'gold' }),
    makeMember({ email: 'c@x.com', tier: 'silver', subscribed: false }),
  ]
  const events = toIncomeEvents({
    events: [
      event({
        at: '2026-08-15T00:00:00+00:00',
        email: 'c@x.com',
        action: 'Canceled',
        detail: 'subscription ended',
      }),
      event({
        at: '2026-07-05T00:00:00+00:00',
        email: 'c@x.com',
        action: 'Signed up',
        detail: 'silver tier — invite emailed',
      }),
      event({
        at: '2026-06-10T00:00:00+00:00',
        email: 'a@x.com',
        action: 'Signed up',
        detail: 'gold tier — invite emailed',
      }),
    ],
    outages: [],
  })
  const series = monthlySeries({ members, events, now: NOW })
  expect(series.map((m) => [m.month, m.income, m.members])).toEqual([
    ['2026-06', 20, 1],
    ['2026-07', 34, 2],
    ['2026-08', 20, 1],
    ['2026-09', 20, 1],
  ])
  expect(series.map((m) => [m.signups, m.churn])).toEqual([
    [20, 0],
    [14, 0],
    [0, 14],
    [0, 0],
  ])
})

test('monthlySeries counts a member the log never saw from their invite date', () => {
  const members = [
    makeMember({ email: 'old@x.com', tier: 'bronze', invited_at: '2026-05-20T00:00:00+00:00' }),
    makeMember({ email: 'older@x.com', tier: 'gold', invited_at: null }),
  ]
  const series = monthlySeries({ members, events: [], now: NOW })
  expect(series.map((m) => [m.month, m.income])).toEqual([
    ['2026-05', 28],
    ['2026-06', 28],
    ['2026-07', 28],
    ['2026-08', 28],
    ['2026-09', 28],
  ])
})

test('monthlySeries ends on the income the members list adds up to today', () => {
  // The log said a@x.com canceled, but the members list still has them
  // subscribed (a re-subscription the log missed): today is the list's call.
  const members = [makeMember({ email: 'a@x.com', tier: 'gold' })]
  const events = toIncomeEvents({
    events: [
      event({
        at: '2026-08-15T00:00:00+00:00',
        email: 'a@x.com',
        action: 'Canceled',
        detail: 'subscription ended',
      }),
      event({
        at: '2026-06-10T00:00:00+00:00',
        email: 'a@x.com',
        action: 'Signed up',
        detail: 'gold tier — invite emailed',
      }),
    ],
    outages: [],
  })
  const series = monthlySeries({ members, events, now: NOW })
  expect(series.map((m) => [m.month, m.income])).toEqual([
    ['2026-06', 20],
    ['2026-07', 20],
    ['2026-08', 0],
    ['2026-09', 20],
  ])
})

test('monthlySeries applies tier changes from the month they happen and counts incidents', () => {
  const members = [makeMember({ email: 'a@x.com', tier: 'bronze' })]
  const events = toIncomeEvents({
    events: [
      event({
        at: '2026-08-10T00:00:00+00:00',
        email: 'a@x.com',
        action: 'Payment failed',
        detail: 'declined',
      }),
      event({
        at: '2026-08-01T00:00:00+00:00',
        email: 'a@x.com',
        action: 'Tier reset',
        detail: 'hard reset to bronze',
      }),
      event({
        at: '2026-07-01T00:00:00+00:00',
        email: 'a@x.com',
        action: 'Tier reset',
        detail: 'hard reset to gold',
      }),
      event({
        at: '2026-06-10T00:00:00+00:00',
        email: 'a@x.com',
        action: 'Signed up',
        detail: 'silver tier — invite emailed',
      }),
    ],
    outages: [
      outage({
        id: 1,
        target: 'host:meleys',
        openedAt: '2026-07-20T00:00:00+00:00',
        closedAt: '2026-07-20T01:00:00+00:00',
      }),
    ],
  })
  const series = monthlySeries({ members, events, now: NOW })
  expect(
    series.map((m) => [m.month, m.income, m.upgrades, m.downgrades, m.outages, m.paymentFailures]),
  ).toEqual([
    ['2026-06', 14, 0, 0, 0, 0],
    ['2026-07', 20, 6, 0, 1, 0],
    ['2026-08', 8, 0, 12, 0, 1],
    ['2026-09', 8, 0, 0, 0, 0],
  ])
})

test('monthlySeries with nothing at all is the current month at zero', () => {
  expect(monthlySeries({ members: [], events: [], now: NOW })).toEqual([
    {
      month: '2026-09',
      income: 0,
      members: 0,
      signups: 0,
      upgrades: 0,
      downgrades: 0,
      churn: 0,
      outages: 0,
      paymentFailures: 0,
    },
  ])
})
