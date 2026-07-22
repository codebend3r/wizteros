import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import MembersTable from '@/components/MembersTable/MembersTable'
import type { Member } from '@/lib/adminApi'

const makeMember = (overrides: Partial<Member>): Member => ({
  member: 'user',
  email: 'user@x.com',
  tier: 'unknown',
  downloads: null,
  expires: null,
  servers: ['Meleys'],
  libraries: {},
  subscribed: false,
  invited_at: null,
  tag: null,
  ...overrides,
})

test('shows a status per row; subscribed members get Re-invite, the rest Invite', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({
            email: 'sub@x.com',
            subscribed: true,
            expires: '2099-01-01T00:00:00+00:00',
          }),
          makeMember({ email: 'free@x.com' }),
          makeMember({ email: 'pending@x.com', servers: [] }),
          makeMember({
            email: 'old@x.com',
            subscribed: true,
            expires: '2020-01-01T00:00:00+00:00',
          }),
        ]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText('Subscribed Monthly')).toBeInTheDocument()
  expect(screen.getByText('Uninvited')).toBeInTheDocument()
  expect(screen.getByText('Invited')).toBeInTheDocument()
  expect(screen.getByText('Expired Member')).toBeInTheDocument()
  // Uninvited, Invited, and Expired rows offer Invite; Subscribed offers Re-invite.
  expect(screen.getAllByRole('button', { name: 'Invite' })).toHaveLength(3)
  expect(screen.getAllByRole('button', { name: 'Re-invite' })).toHaveLength(1)
})

test('Re-invite opens the same tier menu for a subscribed member', async () => {
  const onSelectTier = vi.fn()
  const target = makeMember({
    email: 'sub@x.com',
    subscribed: true,
    expires: '2099-01-01T00:00:00+00:00',
  })
  render(
    <MemoryRouter>
      <MembersTable members={[target]} onSelectTier={onSelectTier} invitingEmail={null} />
    </MemoryRouter>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Re-invite' }))
  await userEvent.click(screen.getByRole('menuitem', { name: /Silver Tier/ }))
  expect(onSelectTier).toHaveBeenCalledWith({ member: target, tier: 'silver' })
})

test('shows a tier icon next to Subscribed Monthly for paid tiers', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({
            email: 'sub@x.com',
            tier: 'gold',
            subscribed: true,
            expires: '2099-01-01T00:00:00+00:00',
          }),
        ]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  // One icon beside the tier name, one beside Subscribed Monthly.
  expect(screen.getAllByRole('img', { name: 'gold tier' })).toHaveLength(2)
})

test('emails link to the /user detail route', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[makeMember({ email: 'cj+plex@x.com' })]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.getByRole('link', { name: 'cj+plex@x.com' })).toHaveAttribute(
    'href',
    '/user?email=cj%2Bplex%40x.com',
  )
})

test('paginates at 25 rows per page', async () => {
  const members = Array.from({ length: 30 }, (_, index) =>
    makeMember({ member: `u${index}`, email: `u${index}@x.com` }),
  )
  render(
    <MemoryRouter>
      <MembersTable members={members} onSelectTier={vi.fn()} invitingEmail={null} />
    </MemoryRouter>,
  )

  expect(screen.getByText('u0')).toBeInTheDocument()
  expect(screen.queryByText('u25')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByText('u25')).toBeInTheDocument()
})

test('Invite opens a tier menu and picking one calls onSelectTier', async () => {
  const onSelectTier = vi.fn()
  const target = makeMember({ email: 'free@x.com' })
  render(
    <MemoryRouter>
      <MembersTable members={[target]} onSelectTier={onSelectTier} invitingEmail={null} />
    </MemoryRouter>,
  )

  await userEvent.click(screen.getByRole('button', { name: 'Invite' }))
  await userEvent.click(screen.getByRole('menuitem', { name: /Gold Tier/ }))
  expect(onSelectTier).toHaveBeenCalledWith({ member: target, tier: 'gold' })
  expect(screen.queryByRole('menu')).toBeNull()
})

test('the tier menu lists all four paid tiers', async () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[makeMember({ email: 'free@x.com' })]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Invite' }))
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    ' Bronze Tier',
    ' Silver Tier',
    ' Gold Tier',
    ' Youth Tier',
  ])
})

test('shows Inviting… and disables the button for the in-flight row', () => {
  const target = makeMember({ email: 'free@x.com' })
  render(
    <MemoryRouter>
      <MembersTable members={[target]} onSelectTier={vi.fn()} invitingEmail="free@x.com" />
    </MemoryRouter>,
  )
  expect(screen.getByRole('button', { name: 'Inviting…' })).toBeDisabled()
})

test('renders downloads as ✓ / ✗ / — including the null case', () => {
  const dated = { expires: '2099-09-01T00:00:00+00:00' } // non-null so the only — comes from downloads
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({ email: 'y@x.com', downloads: true, ...dated }),
          makeMember({ email: 'n@x.com', downloads: false, ...dated }),
          makeMember({ email: 'u@x.com', downloads: null, ...dated }),
        ]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText('✓')).toBeInTheDocument()
  expect(screen.getByText('✗')).toBeInTheDocument()
  expect(screen.getByText('—')).toBeInTheDocument()
})

test('formats a real expiry date and shows — for null', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({ email: 'd@x.com', downloads: true, expires: '2099-09-01T00:00:00+00:00' }),
        ]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(
    screen.getByText(new Date('2099-09-01T00:00:00+00:00').toLocaleDateString()),
  ).toBeInTheDocument()
})
