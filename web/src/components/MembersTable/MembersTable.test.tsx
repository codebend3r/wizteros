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
