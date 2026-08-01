import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from '@/test/vi'
import { Header } from '@/components/Header/Header'
import { menuRoutes, SideMenu } from '@/components/SideMenu/SideMenu'
import { useAuthStore } from '@/stores/authStore'
import { useMenuStore } from '@/stores/menuStore'

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
  // Also pins the scss-modules test loader: without it `styles.link` resolves
  // to String.prototype.link and React drops the className entirely.
  expect(screen.getByRole('link', { name: 'Invite' })).toHaveClass('link', 'linkActive')
  expect(screen.getByRole('link', { name: 'Home' })).toHaveClass('link')
})

test('home link is only active on exactly /', () => {
  render(
    <MemoryRouter initialEntries={['/manage']}>
      <SideMenu />
    </MemoryRouter>,
  )
  expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
})

test('the header hamburger opens the drawer and a link click closes it', async () => {
  useMenuStore.setState({ open: false })
  render(
    <MemoryRouter initialEntries={['/']}>
      <Header brandName="Westeroz" />
      <SideMenu />
    </MemoryRouter>,
  )
  const toggle = screen.getByRole('button', { name: 'Menu' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  const drawer = screen.getByRole('navigation', { name: 'Sections' })
  await userEvent.click(within(drawer).getByRole('link', { name: 'Members' }))
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
})

test('clicking away from the drawer closes it', async () => {
  useMenuStore.setState({ open: true })
  render(
    <MemoryRouter initialEntries={['/']}>
      <SideMenu />
    </MemoryRouter>,
  )
  await userEvent.click(screen.getByRole('button', { name: 'Close menu' }))
  expect(useMenuStore.getState().open).toBe(false)
})

test('Escape closes the drawer', async () => {
  useMenuStore.setState({ open: true })
  render(
    <MemoryRouter initialEntries={['/']}>
      <SideMenu />
    </MemoryRouter>,
  )
  await userEvent.keyboard('{Escape}')
  expect(useMenuStore.getState().open).toBe(false)
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
