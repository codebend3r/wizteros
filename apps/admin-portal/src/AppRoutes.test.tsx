import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from '@/test/vi'
import { AppRoutes } from '@/AppRoutes'
import { useAuthStore } from '@/stores/authStore'

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('renders the landing page at /', () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(
    screen.getByRole('heading', { name: 'Four levels of server capability' }),
  ).toBeInTheDocument()
})

test('gates /manage behind the Supabase login when signed out', () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  render(
    <MemoryRouter initialEntries={['/manage']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
})

// Held in flight so no route assertion here depends on a live fleet monitor.
const renderFleetRoute = () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  )
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter initialEntries={['/fleet']}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// /fleet is the one lazily-loaded route, so both of these await the chunk
// rather than asserting on the Suspense fallback that renders first.
test('gates /fleet behind the Supabase login when signed out', async () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  renderFleetRoute()
  expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { level: 1, name: 'Fleet' })).toBeNull()
})

test('serves the fleet overview at /fleet once past the gate', async () => {
  useAuthStore.setState({ enabled: false })
  renderFleetRoute()
  expect(await screen.findByRole('heading', { level: 1, name: 'Fleet' })).toBeInTheDocument()
})

test('serves the single login page at /login', () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  render(
    <MemoryRouter initialEntries={['/login']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByRole('heading', { name: 'Admin login' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
})

test('gates the hidden annual preview at /annual when signed out', () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  render(
    <MemoryRouter initialEntries={['/annual']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  expect(screen.queryByRole('radio', { name: /Annual/ })).toBeNull()
})

test('serves the annual preview at /annual once past the gate', () => {
  useAuthStore.setState({ enabled: false })
  render(
    <MemoryRouter initialEntries={['/annual']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.getByLabelText('Preview notice')).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: 'Monthly' })).toBeChecked()
})

test('keeps the landing page free of the cadence toggle', () => {
  useAuthStore.setState({ enabled: false })
  render(
    <MemoryRouter initialEntries={['/']}>
      <AppRoutes />
    </MemoryRouter>,
  )
  expect(screen.queryByRole('radio', { name: /Annual/ })).toBeNull()
  expect(screen.queryByLabelText('Preview notice')).toBeNull()
})
