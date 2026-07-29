import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, test, vi } from '@/test/vi'
import { menuRoutes, SideMenu } from '@/components/SideMenu/SideMenu'
import { useAuthStore } from '@/stores/authStore'

const initialState = useAuthStore.getInitialState()

afterEach(() => {
  useAuthStore.setState(initialState, true)
})

test('lists a link for every route', () => {
  render(
    <MemoryRouter initialEntries={['/manage']}>
      <SideMenu />
    </MemoryRouter>,
  )
  expect(
    menuRoutes.map(({ label }) => screen.getByRole('link', { name: label }).getAttribute('href')),
  ).toEqual(menuRoutes.map(({ path }) => path))
  expect(screen.queryByRole('link', { name: 'Member' })).not.toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Reset user' })).not.toBeInTheDocument()
})

test('marks the current route as active', () => {
  render(
    <MemoryRouter initialEntries={['/invite']}>
      <SideMenu />
    </MemoryRouter>,
  )
  expect(screen.getByRole('link', { name: 'Invite' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
})

test('home link is only active on exactly /', () => {
  render(
    <MemoryRouter initialEntries={['/manage']}>
      <SideMenu />
    </MemoryRouter>,
  )
  expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
})

test('toggle opens the drawer and a link click closes it', async () => {
  render(
    <MemoryRouter initialEntries={['/']}>
      <SideMenu />
    </MemoryRouter>,
  )
  const toggle = screen.getByRole('button', { name: 'Menu' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await userEvent.click(screen.getByRole('link', { name: 'Members' }))
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

test('hides the sign-out button while signed out', () => {
  render(
    <MemoryRouter initialEntries={['/manage']}>
      <SideMenu />
    </MemoryRouter>,
  )
  expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
})

test('shows the sign-out button while signed in and signs out on click', async () => {
  const signOut = vi.fn(async () => {})
  useAuthStore.setState({ status: 'signed-in', email: 'cj.rivas.dev@gmail.com', signOut })
  render(
    <MemoryRouter initialEntries={['/manage']}>
      <SideMenu />
    </MemoryRouter>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(signOut).toHaveBeenCalled()
})
