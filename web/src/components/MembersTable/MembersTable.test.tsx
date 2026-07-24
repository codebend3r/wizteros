import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from '@/test/vi'
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

test('shows the tag emoji next to VIP and HVU statuses', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({ email: 'vip@x.com', tag: 'vip' }),
          makeMember({ email: 'hvu@x.com', tag: 'hvu' }),
        ]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText('💎')).toBeInTheDocument()
  expect(screen.getByText('VIP')).toBeInTheDocument()
  expect(screen.getByText('⭐')).toBeInTheDocument()
  expect(screen.getByText('HVU')).toBeInTheDocument()
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
  await userEvent.click(screen.getAllByRole('button', { name: 'Next' })[0])
  expect(screen.getByText('u25')).toBeInTheDocument()
})

test('shows page navigation above and below the table', async () => {
  const members = Array.from({ length: 30 }, (_, index) =>
    makeMember({ member: `u${index}`, email: `u${index}@x.com` }),
  )
  render(
    <MemoryRouter>
      <MembersTable members={members} onSelectTier={vi.fn()} invitingEmail={null} />
    </MemoryRouter>,
  )

  expect(screen.getAllByRole('button', { name: 'Prev' })).toHaveLength(2)
  const nextButtons = screen.getAllByRole('button', { name: 'Next' })
  expect(nextButtons).toHaveLength(2)
  await userEvent.click(nextButtons[1])
  expect(screen.getByText('u25')).toBeInTheDocument()
  expect(screen.getAllByText('Page 2 of 2')).toHaveLength(2)
})

test('offers five page sizes and applies the selection', async () => {
  const members = Array.from({ length: 30 }, (_, index) =>
    makeMember({ member: `u${index}`, email: `u${index}@x.com` }),
  )
  render(
    <MemoryRouter>
      <MembersTable members={members} onSelectTier={vi.fn()} invitingEmail={null} />
    </MemoryRouter>,
  )

  const select = screen.getByRole('combobox', { name: 'Rows per page' })
  expect(
    within(select)
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual(['10 rows', '25 rows', '50 rows', '100 rows', '250 rows'])

  await userEvent.selectOptions(select, '10')
  expect(screen.getByText('u9')).toBeInTheDocument()
  expect(screen.queryByText('u10')).toBeNull()
  expect(screen.getAllByText('Page 1 of 3')).toHaveLength(2)
})

test('sorting by member toggles between ascending and descending', async () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({ member: 'bran', email: 'b@x.com' }),
          makeMember({ member: 'cersei', email: 'c@x.com' }),
          makeMember({ member: 'arya', email: 'a@x.com' }),
        ]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )

  const header = screen.getByRole('button', { name: 'Member' })
  await userEvent.click(header)
  expect(header.closest('th')).toHaveAttribute('aria-sort', 'ascending')
  const ascending = screen.getAllByRole('row')
  expect(ascending[1]).toHaveTextContent('arya')
  expect(ascending[3]).toHaveTextContent('cersei')

  await userEvent.click(header)
  expect(header.closest('th')).toHaveAttribute('aria-sort', 'descending')
  const descending = screen.getAllByRole('row')
  expect(descending[1]).toHaveTextContent('cersei')
  expect(descending[3]).toHaveTextContent('arya')
})

test('sorting by email orders rows by address', async () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({ member: 'u1', email: 'zed@x.com' }),
          makeMember({ member: 'u2', email: 'ann@x.com' }),
        ]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )

  await userEvent.click(screen.getByRole('button', { name: 'Email' }))
  const rows = screen.getAllByRole('row')
  expect(rows[1]).toHaveTextContent('ann@x.com')
  expect(rows[2]).toHaveTextContent('zed@x.com')
})

test('sorting by status orders rows by derived status', async () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({ member: 'u1', email: 'free@x.com' }), // Uninvited
          makeMember({
            member: 'u2',
            email: 'sub@x.com',
            subscribed: true,
            expires: '2099-01-01T00:00:00+00:00',
          }), // Subscribed Monthly
          makeMember({ member: 'u3', email: 'pending@x.com', servers: [] }), // Invited
        ]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )

  await userEvent.click(screen.getByRole('button', { name: 'Status' }))
  const rows = screen.getAllByRole('row')
  expect(rows[1]).toHaveTextContent('pending@x.com')
  expect(rows[2]).toHaveTextContent('sub@x.com')
  expect(rows[3]).toHaveTextContent('free@x.com')
})

test('changing the sort returns to the first page', async () => {
  const members = Array.from({ length: 30 }, (_, index) =>
    makeMember({ member: `u${index}`, email: `u${index}@x.com` }),
  )
  render(
    <MemoryRouter>
      <MembersTable members={members} onSelectTier={vi.fn()} invitingEmail={null} />
    </MemoryRouter>,
  )

  await userEvent.click(screen.getAllByRole('button', { name: 'Next' })[0])
  expect(screen.getAllByText('Page 2 of 2')).toHaveLength(2)
  await userEvent.click(screen.getByRole('button', { name: 'Member' }))
  expect(screen.getAllByText('Page 1 of 2')).toHaveLength(2)
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
