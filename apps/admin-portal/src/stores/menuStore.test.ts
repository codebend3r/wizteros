import { afterEach, expect, test } from '@/test/vi'
import { useMenuStore } from '@/stores/menuStore'

// The store is a module singleton sharing one localStorage with the suite, so
// every test hands back the collapsed default it started from.
afterEach(() => {
  useMenuStore.setState({ open: false })
  localStorage.removeItem('wz-menu')
})

test('the menu starts collapsed', () => {
  expect(useMenuStore.getState().open).toBe(false)
})

test('opening the menu is written through to localStorage', () => {
  useMenuStore.getState().setOpen({ open: true })

  expect(useMenuStore.getState().open).toBe(true)
  expect(localStorage.getItem('wz-menu')).toContain('true')
})

test('an open menu survives rehydration', async () => {
  localStorage.setItem('wz-menu', JSON.stringify({ state: { open: true }, version: 0 }))

  await useMenuStore.persist.rehydrate()

  expect(useMenuStore.getState().open).toBe(true)
})

test('a closed menu survives rehydration', async () => {
  useMenuStore.setState({ open: true })
  localStorage.setItem('wz-menu', JSON.stringify({ state: { open: false }, version: 0 }))

  await useMenuStore.persist.rehydrate()

  expect(useMenuStore.getState().open).toBe(false)
})

test('a stored value that is not a boolean rehydrates as collapsed', async () => {
  // a hand-edited entry, or a shape an older build never wrote
  localStorage.setItem('wz-menu', JSON.stringify({ state: { open: 'yes' }, version: 0 }))

  await useMenuStore.persist.rehydrate()

  expect(useMenuStore.getState().open).toBe(false)
})
