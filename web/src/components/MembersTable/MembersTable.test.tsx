import { render, screen } from '@testing-library/react'
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
  subscribed: false,
  ...overrides,
})

test('shows Subscribed for members with an expiry and an Invite button otherwise', () => {
  render(
    <MembersTable
      members={[
        makeMember({ email: 'sub@x.com', subscribed: true }),
        makeMember({ email: 'free@x.com', subscribed: false }),
      ]}
      onInvite={vi.fn()}
      invitingEmail={null}
    />,
  )
  expect(screen.getByText('Subscribed')).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: 'Invite' })).toHaveLength(1)
})

test('paginates at 25 rows per page', async () => {
  const members = Array.from({ length: 30 }, (_, index) =>
    makeMember({ member: `u${index}`, email: `u${index}@x.com` }),
  )
  render(<MembersTable members={members} onInvite={vi.fn()} invitingEmail={null} />)

  expect(screen.getByText('u0')).toBeInTheDocument()
  expect(screen.queryByText('u25')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Next' }))
  expect(screen.getByText('u25')).toBeInTheDocument()
})

test('calls onInvite with the member when Invite is clicked', async () => {
  const onInvite = vi.fn()
  const target = makeMember({ email: 'free@x.com', subscribed: false })
  render(<MembersTable members={[target]} onInvite={onInvite} invitingEmail={null} />)
  await userEvent.click(screen.getByRole('button', { name: 'Invite' }))
  expect(onInvite).toHaveBeenCalledWith(target)
})

test('shows Inviting… and disables the button for the in-flight row', () => {
  const target = makeMember({ email: 'free@x.com', subscribed: false })
  render(<MembersTable members={[target]} onInvite={vi.fn()} invitingEmail="free@x.com" />)
  expect(screen.getByRole('button', { name: 'Inviting…' })).toBeDisabled()
})

test('renders downloads as ✓ / ✗ / — including the null case', () => {
  const dated = { expires: '2026-09-01T00:00:00+00:00' } // non-null so the only — comes from downloads
  render(
    <MembersTable
      members={[
        makeMember({ email: 'y@x.com', downloads: true, ...dated }),
        makeMember({ email: 'n@x.com', downloads: false, ...dated }),
        makeMember({ email: 'u@x.com', downloads: null, ...dated }),
      ]}
      onInvite={vi.fn()}
      invitingEmail={null}
    />,
  )
  expect(screen.getByText('✓')).toBeInTheDocument()
  expect(screen.getByText('✗')).toBeInTheDocument()
  expect(screen.getByText('—')).toBeInTheDocument()
})

test('formats a real expiry date and shows — for null', () => {
  render(
    <MembersTable
      members={[
        makeMember({ email: 'd@x.com', downloads: true, expires: '2026-09-01T00:00:00+00:00' }),
        makeMember({ email: 'z@x.com', downloads: true, expires: null }),
      ]}
      onInvite={vi.fn()}
      invitingEmail={null}
    />,
  )
  expect(
    screen.getByText(new Date('2026-09-01T00:00:00+00:00').toLocaleDateString()),
  ).toBeInTheDocument()
  expect(screen.getByText('—')).toBeInTheDocument()
})
