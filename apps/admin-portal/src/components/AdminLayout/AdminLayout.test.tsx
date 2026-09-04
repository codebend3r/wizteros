import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from '@/test/vi'
import { AdminLayout } from '@/components/AdminLayout/AdminLayout'
import { useMenuStore } from '@/stores/menuStore'

// The menu store is a persisted singleton; every test starts and ends collapsed.
afterEach(() => {
  useMenuStore.setState({ open: false })
  localStorage.removeItem('wz-menu')
})

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

  // Collapsed until asked for, at every width.
  expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Menu' }))
  expect(screen.getByRole('navigation', { name: 'Sections' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Email' })).toHaveAttribute('href', '/email')

  await userEvent.click(screen.getByRole('button', { name: 'Hard refresh' }))
  expect(invalidate).toHaveBeenCalled()
})

test('the open menu takes a column beside the page rather than covering it', async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AdminLayout>
          <main>page content</main>
        </AdminLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  const body = screen.getByText('page content').parentElement?.parentElement
  expect(body).toHaveClass('body')
  expect(body).not.toHaveClass('bodyOpen')
  await userEvent.click(screen.getByRole('button', { name: 'Menu' }))
  expect(body).toHaveClass('body', 'bodyOpen')
})

test('leaves the hard refresh off a page that polls on its own clock', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AdminLayout showHardRefresh={false}>
          <main>page content</main>
        </AdminLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  expect(screen.getByText('page content')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Hard refresh' })).toBeNull()
})
