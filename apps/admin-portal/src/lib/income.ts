import type { Member, MemberEvent, PaidTier } from '@/lib/adminApi'
import { amountOf } from '@/lib/billing'
import type { Incident } from '@/lib/fleetApi'
import { isPaidTier } from '@/lib/inviteRules'
import { siteConfig } from '@/site.config'

/** What moved the income, or what happened around it. The first four carry a
    signed monthly amount; the rest are context and carry zero. */
export type IncomeKind =
  | 'signup'
  | 'upgrade'
  | 'downgrade'
  | 'cancel'
  | 'cancel_scheduled'
  | 'payment_failed'
  | 'outage'

export type IncomeEvent = {
  readonly id: string
  readonly at: string
  readonly kind: IncomeKind
  /** null for an outage, which belongs to a host rather than a member. */
  readonly email: string | null
  readonly tier: PaidTier | null
  /** The tier a change moved away from; null on everything but a tier change. */
  readonly fromTier: PaidTier | null
  /** Dollars per month gained (positive) or lost (negative). */
  readonly delta: number
  readonly detail: string
}

export type IncomeMonth = {
  readonly month: string
  /** Dollars per month the subscribers added up to at the end of the month. */
  readonly income: number
  readonly members: number
  readonly signups: number
  readonly upgrades: number
  readonly downgrades: number
  readonly churn: number
  readonly outages: number
  readonly paymentFailures: number
}

export type TierTally = {
  readonly count: number
  readonly amount: number
}

export type CurrentIncome = {
  readonly total: number
  readonly paying: number
  readonly byTier: Record<PaidTier, TierTally>
  /** Subscribers whose latest charge failed: still counted, still at risk. */
  readonly atRisk: TierTally
  /** Subscribed members with no tier on record, who cannot be priced. */
  readonly untiered: number
}

type PayingState = {
  readonly paying: boolean
  readonly tier: PaidTier | null
  /** Paying is a guess from a renewal, not a signup the log saw: the member
      predates the log, so their real signup row (if one arrives) still counts. */
  readonly inferred: boolean
}

const EMPTY_STATE: PayingState = { paying: false, tier: null, inferred: false }

/** The monthly figure the landing page quotes for a tier, as a number. */
export const tierPrice = ({ tier }: { tier: PaidTier }): number =>
  amountOf(siteConfig.tiers.find((candidate) => candidate.id === tier)?.price ?? '$0')

const priceOf = (tier: PaidTier | null): number => (tier === null ? 0 : tierPrice({ tier }))

export const formatMoney = (amount: number): string => {
  const magnitude = Math.abs(amount)
  const figure = Number.isInteger(magnitude) ? String(magnitude) : magnitude.toFixed(2)
  return `${amount < 0 ? '-' : ''}$${figure}`
}

export const monthLabel = (month: string): string => {
  const [year, monthNumber] = month.split('-').map(Number)
  return new Date(Date.UTC(year ?? 1970, (monthNumber ?? 1) - 1, 1)).toLocaleString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

const monthOf = (iso: string): string => iso.slice(0, 7)

const monthKey = (ms: number): string => new Date(ms).toISOString().slice(0, 7)

/** The first instant after a month, as a timestamp. */
const monthEnd = (month: string): number => {
  const [year, monthNumber] = month.split('-').map(Number)
  return Date.UTC(year ?? 1970, monthNumber ?? 1, 1)
}

const nextMonth = (month: string): string => monthKey(monthEnd(month))

const monthsBetween = ({ first, last }: { first: string; last: string }): readonly string[] =>
  first >= last
    ? [last]
    : Array.from({ length: 240 }).reduce<readonly string[]>(
        (keys) =>
          keys[keys.length - 1] === last
            ? keys
            : [...keys, nextMonth(keys[keys.length - 1] ?? first)],
        [first],
      )

const isExpired = ({ member, now }: { member: Member; now: number }): boolean => {
  const expiresAt = member.expires ? new Date(member.expires).getTime() : null
  return expiresAt !== null && !Number.isNaN(expiresAt) && expiresAt < now
}

/** Whether a member is paying today: subscribed, not lapsed, not banned. A
    VIP who also subscribes is paying like anyone else. */
const isPaying = ({ member, now }: { member: Member; now: number }): boolean =>
  member.subscribed && member.tag !== 'banned' && !isExpired({ member, now })

type PricedMember = {
  readonly member: Member
  readonly tier: PaidTier
  readonly amount: number
}

const tally = (rows: readonly PricedMember[]): TierTally => ({
  count: rows.length,
  amount: rows.reduce((sum, row) => sum + row.amount, 0),
})

/** Today's income, straight from who is subscribed at which tier. */
export const currentIncome = ({
  members,
  now,
}: {
  members: readonly Member[]
  now: number
}): CurrentIncome => {
  const paying = members.filter((member) => isPaying({ member, now }))
  const priced = paying.flatMap((member): PricedMember[] =>
    isPaidTier(member.tier)
      ? [{ member, tier: member.tier, amount: tierPrice({ tier: member.tier }) }]
      : [],
  )
  const whole = tally(priced)
  return {
    total: whole.amount,
    paying: whole.count,
    byTier: {
      bronze: tally(priced.filter((row) => row.tier === 'bronze')),
      silver: tally(priced.filter((row) => row.tier === 'silver')),
      gold: tally(priced.filter((row) => row.tier === 'gold')),
      youth: tally(priced.filter((row) => row.tier === 'youth')),
    },
    atRisk: tally(priced.filter((row) => row.member.payment_state === 'past_due')),
    untiered: paying.length - priced.length,
  }
}

// The log names tiers in prose ("gold tier, invite emailed", "hard reset to
// silver"); kids is the pre-rebrand name for youth and still appears in old rows.
const TIER_IN_DETAIL = /\b(bronze|silver|gold|youth|kids)\b/i

export const tierFromDetail = (detail: string): PaidTier | null => {
  const found = TIER_IN_DETAIL.exec(detail)?.[1]?.toLowerCase() ?? null
  if (found === 'kids') return 'youth'
  return isPaidTier(found) ? found : null
}

const DURATION_UNITS = [
  { ms: 86_400_000, name: 'day' },
  { ms: 3_600_000, name: 'hour' },
  { ms: 60_000, name: 'minute' },
] as const

/** "2 hours 30 minutes": the two largest units that are not zero. */
const describeDuration = (ms: number): string => {
  const parts = DURATION_UNITS.reduce<{ rest: number; words: readonly string[] }>(
    ({ rest, words }, unit) => {
      const count = Math.floor(rest / unit.ms)
      return count > 0
        ? {
            rest: rest - count * unit.ms,
            words: [...words, `${count} ${unit.name}${count === 1 ? '' : 's'}`],
          }
        : { rest, words }
    },
    { rest: ms, words: [] },
  ).words
  return parts.length === 0 ? 'under a minute' : parts.slice(0, 2).join(' ')
}

const outageEvent = (incident: Incident): IncomeEvent => {
  const opened = Date.parse(incident.opened_at)
  const closed = incident.closed_at === null ? null : Date.parse(incident.closed_at)
  const span =
    closed === null || Number.isNaN(closed) || Number.isNaN(opened)
      ? 'still down'
      : `down for ${describeDuration(closed - opened)}`
  return {
    id: `outage-${incident.id}`,
    at: incident.opened_at,
    kind: 'outage',
    email: null,
    tier: null,
    fromTier: null,
    delta: 0,
    detail: `${incident.target} ${span}`,
  }
}

const memberEvent = ({
  source,
  kind,
  tier,
  fromTier = null,
  delta,
}: {
  source: MemberEvent
  kind: IncomeKind
  tier: PaidTier | null
  fromTier?: PaidTier | null
  delta: number
}): IncomeEvent => ({
  id: `member-${source.id}`,
  at: source.at,
  kind,
  email: source.email,
  tier,
  fromTier,
  delta,
  detail: source.detail,
})

const tierChange = ({
  source,
  from,
  to,
}: {
  source: MemberEvent
  from: PaidTier
  to: PaidTier
}): IncomeEvent => {
  const delta = tierPrice({ tier: to }) - tierPrice({ tier: from })
  return memberEvent({
    source,
    kind: delta > 0 ? 'upgrade' : 'downgrade',
    tier: to,
    fromTier: from,
    delta,
  })
}

/** What one log row means for the member's income, given where they stood.
    Returns the new standing and the event to list, if any. */
const stepMember = ({
  state,
  source,
}: {
  state: PayingState
  source: MemberEvent
}): { state: PayingState; event: IncomeEvent | null } => {
  const named = tierFromDetail(source.detail)
  switch (source.action) {
    case 'Signed up':
    case 'Access restored': {
      const tier = named ?? state.tier
      const known = state.paying && !state.inferred
      if (known && state.tier !== null && named !== null && named !== state.tier) {
        return {
          state: { paying: true, tier: named, inferred: false },
          event: tierChange({ source, from: state.tier, to: named }),
        }
      }
      if (known) {
        // Same tier again. A restore is worth listing (they had been locked
        // out); a repeat signup at the same tier moved nothing and says nothing.
        return {
          state: { paying: true, tier, inferred: false },
          event:
            source.action === 'Access restored'
              ? memberEvent({ source, kind: 'signup', tier, delta: 0 })
              : null,
        }
      }
      return {
        state: { paying: true, tier, inferred: false },
        event: memberEvent({ source, kind: 'signup', tier, delta: priceOf(tier) }),
      }
    }
    case 'Tier reset':
    case 'Invite issued': {
      if (named === null) return { state, event: null }
      if (state.paying && state.tier !== null && named !== state.tier) {
        return {
          state: { ...state, tier: named },
          event: tierChange({ source, from: state.tier, to: named }),
        }
      }
      return { state: { ...state, tier: named }, event: null }
    }
    case 'Canceled':
    case 'Banned': {
      if (!state.paying) return { state, event: null }
      return {
        state: { paying: false, tier: state.tier, inferred: false },
        event: memberEvent({
          source,
          kind: 'cancel',
          tier: state.tier,
          delta: -priceOf(state.tier),
        }),
      }
    }
    case 'Cancellation scheduled':
      return {
        state,
        event: memberEvent({ source, kind: 'cancel_scheduled', tier: state.tier, delta: 0 }),
      }
    case 'Payment failed':
      return {
        state,
        event: memberEvent({ source, kind: 'payment_failed', tier: state.tier, delta: 0 }),
      }
    case 'Payment received':
      // A renewal for someone the log never saw sign up: they were paying
      // before the log began. Nothing to list, but they now stand as paying.
      return state.paying
        ? { state, event: null }
        : { state: { ...state, paying: true, inferred: true }, event: null }
    default:
      return { state, event: null }
  }
}

const byTime = (first: { at: string }, second: { at: string }): number =>
  Date.parse(first.at) - Date.parse(second.at)

/** The member log and the fleet's outages as one list of income events, newest first. */
export const toIncomeEvents = ({
  events,
  outages,
}: {
  events: readonly MemberEvent[]
  outages: readonly Incident[]
}): readonly IncomeEvent[] => {
  const ordered = [...events].sort((first, second) => byTime(first, second) || first.id - second.id)
  const walked = ordered.reduce<{
    states: ReadonlyMap<string, PayingState>
    out: readonly IncomeEvent[]
  }>(
    ({ states, out }, source) => {
      const key = source.email.toLowerCase()
      const { state, event } = stepMember({ state: states.get(key) ?? EMPTY_STATE, source })
      return {
        states: new Map(states).set(key, state),
        out: event === null ? out : [...out, event],
      }
    },
    { states: new Map(), out: [] },
  )
  return [...walked.out, ...outages.map(outageEvent)].sort((first, second) => byTime(second, first))
}

/** Where every member stood just before a moment, walking the listed events. */
const statesBefore = ({
  events,
  boundary,
}: {
  events: readonly IncomeEvent[]
  boundary: number
}): ReadonlyMap<string, PayingState> =>
  [...events]
    .filter((event) => event.email !== null && Date.parse(event.at) < boundary)
    .sort(byTime)
    .reduce<ReadonlyMap<string, PayingState>>((states, event) => {
      const key = (event.email ?? '').toLowerCase()
      const state = states.get(key) ?? EMPTY_STATE
      const next: PayingState =
        event.kind === 'signup'
          ? { paying: true, tier: event.tier ?? state.tier, inferred: false }
          : event.kind === 'upgrade' || event.kind === 'downgrade'
            ? { paying: true, tier: event.tier, inferred: false }
            : event.kind === 'cancel'
              ? { paying: false, tier: state.tier, inferred: false }
              : state
      return new Map(states).set(key, next)
    }, new Map())

/** One month's row: the standing figures plus what moved that month. */
const monthRow = ({
  month,
  income,
  members,
  movements,
}: {
  month: string
  income: number
  members: number
  movements: Omit<IncomeMonth, 'month' | 'income' | 'members'>
}): IncomeMonth => ({ month, income, members, ...movements })

const sumWhere = ({
  events,
  kind,
  pick,
}: {
  events: readonly IncomeEvent[]
  kind: IncomeKind
  pick: (event: IncomeEvent) => number
}): number =>
  events.filter((event) => event.kind === kind).reduce((sum, event) => sum + pick(event), 0)

/** Income at the end of each month, from the first signup on record to today.

    Past months are rebuilt from the log: a member counts from their signup
    until their cancellation, at the tier the log last recorded. A member the
    log never saw sign up counts from the date they were invited (or from the
    start, when even that is unknown) at the tier they hold now. The current
    month is today's members list, so the line always ends on the headline. */
export const monthlySeries = ({
  members,
  events,
  now,
}: {
  members: readonly Member[]
  events: readonly IncomeEvent[]
  now: number
}): readonly IncomeMonth[] => {
  const current = currentIncome({ members, now })
  const thisMonth = monthKey(now)
  const loggedSignups = new Set(
    events
      .filter((event) => event.kind === 'signup')
      .map((event) => (event.email ?? '').toLowerCase()),
  )
  // Paying today with no signup on record: they predate the log.
  const unlogged = members.flatMap(
    (member): { key: string; tier: PaidTier; since: number | null }[] =>
      isPaying({ member, now }) &&
      isPaidTier(member.tier) &&
      !loggedSignups.has(member.email.toLowerCase())
        ? [
            {
              key: member.email.toLowerCase(),
              tier: member.tier,
              since: member.invited_at === null ? null : Date.parse(member.invited_at),
            },
          ]
        : [],
  )
  const currentTiers = new Map(
    members.flatMap((member): [string, PaidTier][] =>
      isPaidTier(member.tier) ? [[member.email.toLowerCase(), member.tier]] : [],
    ),
  )
  const firstMonth = [
    ...events.map((event) => monthOf(event.at)),
    ...unlogged.flatMap(({ since }) =>
      since === null || Number.isNaN(since) ? [] : [monthKey(since)],
    ),
  ].reduce<string>((earliest, month) => (month < earliest ? month : earliest), thisMonth)

  return monthsBetween({ first: firstMonth, last: thisMonth }).map((month) => {
    const boundary = month === thisMonth ? now : monthEnd(month)
    const inMonth = events.filter((event) => monthOf(event.at) === month)
    const movements = {
      signups: sumWhere({ events: inMonth, kind: 'signup', pick: (event) => event.delta }),
      upgrades: sumWhere({ events: inMonth, kind: 'upgrade', pick: (event) => event.delta }),
      downgrades: sumWhere({ events: inMonth, kind: 'downgrade', pick: (event) => -event.delta }),
      churn: sumWhere({ events: inMonth, kind: 'cancel', pick: (event) => -event.delta }),
      outages: inMonth.filter((event) => event.kind === 'outage').length,
      paymentFailures: inMonth.filter((event) => event.kind === 'payment_failed').length,
    }
    if (month === thisMonth) {
      return monthRow({ month, income: current.total, members: current.paying, movements })
    }
    const states = statesBefore({ events, boundary })
    const logged = [...states.entries()]
      .filter(([, state]) => state.paying)
      .map(([key, state]) => priceOf(state.tier ?? currentTiers.get(key) ?? null))
    const early = unlogged
      .filter(({ key }) => !states.has(key))
      .filter(({ since }) => since === null || Number.isNaN(since) || since < boundary)
      .map(({ tier }) => tierPrice({ tier }))
    return monthRow({
      month,
      income: [...logged, ...early].reduce((sum, amount) => sum + amount, 0),
      members: logged.length + early.length,
      movements,
    })
  })
}
