import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import AdminLayout from '@/components/AdminLayout/AdminLayout'

test('wraps children in the site chrome with a hard refresh button', async () => {
  const queryClient = new QueryClient()
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AdminLayout>
          <main>page content</main>
        </AdminLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(screen.getByRole('banner')).toBeInTheDocument()
  expect(screen.getByText('page content')).toBeInTheDocument()
  expect(screen.getByRole('contentinfo')).toBeInTheDocument()

  await userEvent.click(screen.getByRole('button', { name: 'Hard refresh' }))
  expect(invalidate).toHaveBeenCalled()
})
