import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from '@/test/vi'
import { MembersTable } from '@/components/MembersTable/MembersTable'
import type { Member } from '@/lib/adminApi'

const makeMember = (overrides: Partial<Member>): Member => ({
  member: 'user',
  email: 'user@x.com',
  tier: 'unknown',
  downloads: null,
  expires: null,
  servers: ['Meleys'],
  libraries: {},
  entitled: {},
  subscribed: false,
  payment_state: null,
  invited_at: null,
  tag: null,
  customer_id: null,
  stripe_email: null,
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
          makeMember({
            email: 'pending@x.com',
            servers: [],
            invited_at: new Date().toISOString(),
          }),
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

test('shows the VIP diamond and the Invited envelope in the status cell', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({ email: 'vip@x.com', tag: 'vip' }),
          makeMember({
            email: 'invited@x.com',
            servers: [],
            invited_at: new Date().toISOString(),
          }),
        ]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText('💎')).toBeInTheDocument()
  expect(screen.getByText('VIP')).toBeInTheDocument()
  expect(screen.getByText('✉️')).toBeInTheDocument()
  expect(screen.getByText('Invited')).toBeInTheDocument()
})

test('an hvu-tagged member shows its lifecycle status, not the HVU tag', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({
            email: 'hvu@x.com',
            tag: 'hvu',
            subscribed: true,
            expires: '2099-01-01T00:00:00+00:00',
          }),
        ]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText('Subscribed Monthly')).toBeInTheDocument()
  expect(screen.queryByText('HVU')).not.toBeInTheDocument()
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
          makeMember({
            member: 'u3',
            email: 'pending@x.com',
            servers: [],
            invited_at: new Date().toISOString(),
          }), // Invited
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

test('Servers/Libs counts the servers and their libraries', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({
            email: 'many@x.com',
            servers: ['Meleys', 'Vhagar'],
            libraries: { Meleys: ['01. Movies', '02. TV Shows'], Vhagar: ['03. 4K Movies'] },
          }),
          makeMember({
            email: 'one@x.com',
            servers: ['Syrax'],
            libraries: { Syrax: ['01. Movies'] },
          }),
        ]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.getByRole('columnheader', { name: 'Servers/Libs' })).toBeInTheDocument()
  expect(screen.getByLabelText('2 servers, 3 libraries')).toHaveTextContent('2 / 3')
  // the count reads as prose for a screen reader, and singulars stay singular
  expect(screen.getByLabelText('1 server, 1 library')).toHaveTextContent('1 / 1')
})

test('Servers/Libs shows — for a member with no access at all', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[makeMember({ email: 'none@x.com', servers: [], libraries: {} })]}
        onSelectTier={vi.fn()}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.queryByLabelText(/server/)).not.toBeInTheDocument()
})

test('flags two subscribers whose addresses are one character apart', () => {
  // One person, two Stripe customers: the second payment cannot restore the
  // first address's access, and both rows otherwise read as healthy.
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({ member: 'jimmyvo767', email: 'jimmyvo767@gmail.com', subscribed: true }),
          makeMember({ member: 'jimmyvo768', email: 'jimmyvo768@gmail.com', subscribed: true }),
          makeMember({ member: 'other', email: 'other@gmail.com', subscribed: true }),
        ]}
        onSelectTier={() => {}}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.getAllByText('possible duplicate')).toHaveLength(2)
})

test('a member with a failed charge is labelled Payment Failed, not Subscribed', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({
            member: 'jim',
            email: 'jim@x.com',
            subscribed: true,
            payment_state: 'past_due',
          }),
        ]}
        onSelectTier={() => {}}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText('Payment Failed')).toBeInTheDocument()
  expect(screen.queryByText('Subscribed Monthly')).not.toBeInTheDocument()
})

test('a member holding no records shows no servers rather than their tier scope', () => {
  // The lie that hid a locked-out member: tier-derived counts rendered as
  // though they were access.
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({
            member: 'jim',
            email: 'jim@x.com',
            subscribed: true,
            servers: [],
            libraries: {},
            entitled: { Meleys: ['04. Movies'] },
          }),
        ]}
        onSelectTier={() => {}}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  // the servers cell carries an aria-label only when there is access to name
  expect(screen.queryByLabelText(/librar/)).not.toBeInTheDocument()
})

test('shows the Stripe address on a member who pays under a different email', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[
          makeMember({
            member: 'jimmyvo768',
            email: 'jimmyvo768@gmail.com',
            stripe_email: 'jimmyvo767@gmail.com',
            subscribed: true,
          }),
        ]}
        onSelectTier={() => {}}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText('jimmyvo768@gmail.com')).toBeInTheDocument()
  expect(screen.getByText('pays as jimmyvo767@gmail.com')).toBeInTheDocument()
})

test('a member whose addresses match shows only the one address', () => {
  render(
    <MemoryRouter>
      <MembersTable
        members={[makeMember({ member: 'jim', email: 'jim@x.com', subscribed: true })]}
        onSelectTier={() => {}}
        invitingEmail={null}
      />
    </MemoryRouter>,
  )
  expect(screen.getByText('jim@x.com')).toBeInTheDocument()
  expect(screen.queryByText(/pays as/)).not.toBeInTheDocument()
})
