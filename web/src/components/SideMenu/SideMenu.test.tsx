import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import { menuRoutes, SideMenu } from '@/components/SideMenu/SideMenu'

test('lists a link for every route', () => {
  render(
    <MemoryRouter initialEntries={['/manage']}>
      <SideMenu />
    </MemoryRouter>,
  )
  menuRoutes.forEach(({ label, path }) => {
    expect(screen.getByRole('link', { name: label })).toHaveAttribute('href', path)
  })
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
