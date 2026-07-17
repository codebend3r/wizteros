import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test } from 'vitest'
import AdminGate from '@/components/AdminGate/AdminGate'

afterEach(() => {
  sessionStorage.clear()
})

test('hides children until a password is entered', async () => {
  render(
    <AdminGate title="Test gate">
      <p>secret content</p>
    </AdminGate>,
  )
  expect(screen.queryByText('secret content')).toBeNull()

  await userEvent.type(screen.getByLabelText('Password'), 'morty8229!')
  await userEvent.click(screen.getByRole('button', { name: 'Enter' }))

  expect(screen.getByText('secret content')).toBeInTheDocument()
})
