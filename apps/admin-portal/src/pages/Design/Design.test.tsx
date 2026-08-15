import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test } from '@/test/vi'
import { Design } from '@/pages/Design/Design'
import { useAuthStore } from '@/stores/authStore'

const renderDesign = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Design />
      </MemoryRouter>
    </QueryClientProvider>,
  )

afterEach(() => {
  useAuthStore.setState({ enabled: false, status: 'signed-out' })
  sessionStorage.clear()
})

test('renders every section of the design reference', () => {
  renderDesign()
  const sections = [
    'Color',
    'Type',
    'Space & radius',
    'Tier icon',
    'Status & tags',
    'Buttons',
    'Inputs',
    'Table',
    'Library pills',
    'Rules',
  ]
  sections.map((name) =>
    expect(screen.getByRole('heading', { name, level: 2 })).toBeInTheDocument(),
  )
})

test('documents the accent token with its declared value', () => {
  renderDesign()
  expect(screen.getByText('--color-accent')).toBeInTheDocument()
  // Amber appears twice by design: --color-accent and --color-state-not-shared.
  expect(screen.getAllByText('#f7b32b')).toHaveLength(2)
})

test('links the on-page nav to each section anchor', () => {
  renderDesign()
  const nav = screen.getByRole('navigation', { name: 'On this page' })
  expect(nav).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Color' })).toHaveAttribute('href', '#color')
  expect(screen.getByRole('link', { name: 'Rules' })).toHaveAttribute('href', '#rules')
})

test('gates the page behind the Supabase login when signed out', () => {
  useAuthStore.setState({ enabled: true, status: 'signed-out' })
  renderDesign()
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Color', level: 2 })).toBeNull()
})
