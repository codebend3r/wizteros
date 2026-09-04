import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from '@/test/vi'
import type { Member, MemberEvent } from '@/lib/adminApi'
import type { IncidentFeed } from '@/lib/fleetApi'
import { Income } from '@/pages/Income/Income'
import { useAuthStore } from '@/stores/authStore'

import * as adminApiOriginal from '@/lib/adminApi'
import * as fleetApiOriginal from '@/lib/fleetApi'

vi.mock('@/lib/adminApi', () => ({
  ...adminApiOriginal,
  fetchMembers: vi.fn(),
  fetchAllEvents: vi.fn(),
}))

vi.mock('@/lib/fleetApi', () => ({
  ...fleetApiOriginal,
  fetchIncidents: vi.fn(),
}))

const { fetchMembers, fetchAllEvents } = await import('@/lib/adminApi')
const { fetchIncidents } = await import('@/lib/fleetApi')

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

const logRow = ({
  id,
  at,
  email,
  action,
  detail,
}: {
  id: number
  at: string
  email: string
  action: string
  detail: string
}): MemberEvent => ({ id, at, email, action, detail })

const members = [
  makeMember({ member: 'ann', email: 'ann@x.com', tier: 'gold' }),
  makeMember({ member: 'bob', email: 'bob@x.com', tier: 'bronze' }),
  makeMember({ member: 'cat', email: 'cat@x.com', tier: 'silver', subscribed: false }),
]

const log = [
  logRow({
    id: 3,
    at: '2026-08-15T00:00:00+00:00',
    email: 'cat@x.com',
    action: 'Canceled',
    detail: 'subscription ended — 1 server record(s) disabled',
  }),
  logRow({
    id: 2,
    at: '2026-07-05T00:00:00+00:00',
    email: 'cat@x.com',
    action: 'Signed up',
    detail: 'silver tier — invite emailed',
  }),
  logRow({
    id: 1,
    at: '2026-06-10T00:00:00+00:00',
    email: 'ann@x.com',
    action: 'Signed up',
    detail: 'gold tier — invite emailed',
  }),
]

const noOutages: IncidentFeed = { open: [], recent: [] }

const renderIncome = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useAuthStore.setState({ enabled: false })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/income']}>
        <Income />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('leads with the income the members add up to today', async () => {
  vi.mocked(fetchMembers).mockResolvedValue(members)
  vi.mocked(fetchAllEvents).mockResolvedValue(log)
  vi.mocked(fetchIncidents).mockResolvedValue(noOutages)
  renderIncome()

  expect(await screen.findByRole('heading', { level: 1, name: 'Income' })).toBeInTheDocument()
  const hero = await screen.findByRole('region', { name: 'Monthly income' })
  expect(within(hero).getByText('$28')).toBeInTheDocument()
  expect(within(hero).getByText('2 paying members')).toBeInTheDocument()
  // one tile per tier, each stating its own arithmetic
  expect(within(hero).getByText('1 × $20')).toBeInTheDocument()
  expect(within(hero).getByText('1 × $8')).toBeInTheDocument()
  expect(within(hero).getByText('0 × $14')).toBeInTheDocument()
})

test('shows a loading state while the members are in flight', () => {
  vi.mocked(fetchMembers).mockReturnValue(new Promise(() => {}))
  vi.mocked(fetchAllEvents).mockReturnValue(new Promise(() => {}))
  vi.mocked(fetchIncidents).mockReturnValue(new Promise(() => {}))
  renderIncome()

  expect(screen.getByRole('status')).toHaveTextContent(/Loading members/)
  expect(screen.queryByRole('region', { name: 'Monthly income' })).not.toBeInTheDocument()
})

test('draws the growth line and the movements bars from the log, and offers a table', async () => {
  vi.mocked(fetchMembers).mockResolvedValue(members)
  vi.mocked(fetchAllEvents).mockResolvedValue(log)
  vi.mocked(fetchIncidents).mockResolvedValue(noOutages)
  renderIncome()

  expect(await screen.findByRole('img', { name: 'Monthly income by month' })).toBeInTheDocument()
  expect(screen.getByRole('img', { name: 'Income gained and lost by month' })).toBeInTheDocument()

  // folded behind a <details>, so the queries must not skip hidden content
  const table = screen.getByRole('table', { name: 'Income by month', hidden: true })
  const rows = within(table).getAllByRole('row', { hidden: true }).slice(1)
  expect(
    rows.map((row) => within(row).getByRole('rowheader', { hidden: true }).textContent),
  ).toEqual(['Jun 2026', 'Jul 2026', 'Aug 2026', expect.stringMatching(/\d{4}$/)])
  // bob is paying with no signup in the log, so he counts from the start;
  // July adds cat's silver on top of ann's gold, and August loses it again
  const income = (row: HTMLElement | undefined): string =>
    row === undefined
      ? ''
      : (within(row).getAllByRole('cell', { hidden: true })[0]?.textContent ?? '')
  expect(income(rows[0])).toBe('$28')
  expect(income(rows[1])).toBe('$42')
  expect(income(rows[2])).toBe('$28')
})

test('lists every movement newest first and filters it by kind', async () => {
  const user = userEvent.setup()
  vi.mocked(fetchMembers).mockResolvedValue(members)
  vi.mocked(fetchAllEvents).mockResolvedValue(log)
  vi.mocked(fetchIncidents).mockResolvedValue({
    open: [],
    recent: [
      {
        id: 9,
        target: 'host:meleys',
        reason: 'ssh timed out',
        opened_at: '2026-08-01T01:00:00+00:00',
        closed_at: '2026-08-01T02:00:00+00:00',
      },
    ],
  })
  renderIncome()

  const timeline = await screen.findByRole('list', { name: 'Income timeline' })
  // the kind column is the one span classed `kind` in each row
  const kinds = () =>
    within(timeline)
      .getAllByRole('listitem')
      .map((row) => row.querySelector('.kind')?.textContent ?? '')
  expect(kinds()).toEqual(['Cancellation', 'Outage', 'Signup', 'Signup'])
  expect(within(timeline).getByText('host:meleys down for 1 hour')).toBeInTheDocument()
  // cat signed up and then cancelled, so the address links twice
  expect(within(timeline).getAllByRole('link', { name: 'cat@x.com' })[0]).toHaveAttribute(
    'href',
    '/user?email=cat%40x.com',
  )
  expect(within(timeline).getByText('-$14/mo')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Cancellations 1' }))
  expect(kinds()).toEqual(['Cancellation'])
  await user.click(screen.getByRole('button', { name: 'Outages 1' }))
  expect(kinds()).toEqual(['Outage'])
  await user.click(screen.getByRole('button', { name: 'All 4' }))
  expect(kinds()).toHaveLength(4)
})

test('keeps the headline when the log cannot be read, and says so', async () => {
  vi.mocked(fetchMembers).mockResolvedValue(members)
  vi.mocked(fetchAllEvents).mockRejectedValue(new Error('Request failed (422)'))
  vi.mocked(fetchIncidents).mockResolvedValue(noOutages)
  renderIncome()

  const hero = await screen.findByRole('region', { name: 'Monthly income' })
  expect(within(hero).getByText('$28')).toBeInTheDocument()
  expect(await screen.findByRole('alert')).toHaveTextContent(/History is unavailable/)
  expect(screen.getByRole('alert')).toHaveTextContent(/Request failed \(422\)/)
})

test('names the income at risk when a charge is failing', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([
    ...members,
    makeMember({ member: 'dan', email: 'dan@x.com', tier: 'youth', payment_state: 'past_due' }),
  ])
  vi.mocked(fetchAllEvents).mockResolvedValue(log)
  vi.mocked(fetchIncidents).mockResolvedValue(noOutages)
  renderIncome()

  const hero = await screen.findByRole('region', { name: 'Monthly income' })
  expect(within(hero).getByText('$38')).toBeInTheDocument()
  expect(within(hero).getByText('$10 at risk: 1 payment failing')).toBeInTheDocument()
})

test('reports an unreachable bridge instead of an empty page', async () => {
  vi.mocked(fetchMembers).mockRejectedValue(new Error('Request failed (502)'))
  vi.mocked(fetchAllEvents).mockRejectedValue(new Error('Request failed (502)'))
  vi.mocked(fetchIncidents).mockResolvedValue(noOutages)
  renderIncome()

  const alerts = await screen.findAllByRole('alert')
  expect(alerts[0]).toHaveTextContent(/Could not load members/)
  expect(screen.queryByRole('region', { name: 'Monthly income' })).not.toBeInTheDocument()
})
