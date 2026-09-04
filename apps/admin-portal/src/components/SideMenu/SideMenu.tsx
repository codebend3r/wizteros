import { useEffect, useRef } from 'react'
import { NavLink } from 'react-router-dom'
import styles from '@/components/SideMenu/SideMenu.module.scss'
import { useAuthStore } from '@/stores/authStore'
import { useMenuStore } from '@/stores/menuStore'

export const menuRoutes = [
  { label: 'Home', path: '/' },
  { label: 'Members', path: '/manage' },
  { label: 'Invite', path: '/invite' },
  { label: 'Email', path: '/email' },
  { label: 'Fleet', path: '/fleet' },
  { label: 'Design', path: '/design' },
] as const

export const SideMenu = () => {
  const open = useMenuStore((state) => state.open)
  const setOpen = useMenuStore((state) => state.setOpen)
  const status = useAuthStore((state) => state.status)
  const signOut = useAuthStore((state) => state.signOut)
  const navRef = useRef<HTMLElement>(null)
  // Seeded with the state the store rehydrated to, so a reload that restores
  // an open drawer lands the caret wherever the page wants it rather than
  // yanking focus into a menu nobody just asked for.
  const wasOpen = useRef(open)

  useEffect(() => {
    if (open && !wasOpen.current) {
      navRef.current?.focus()
    }
    wasOpen.current = open
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen({ open: false })
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, setOpen])

  // Collapsed is the default at every width, so a closed menu leaves nothing
  // behind: no empty column, no hidden links for the keyboard to walk into.
  if (!open) {
    return null
  }

  return (
    <aside className={styles.sideMenu}>
      <button
        className={styles.backdrop}
        type="button"
        aria-label="Close menu"
        onClick={() => setOpen({ open: false })}
      />
      <nav ref={navRef} tabIndex={-1} className={styles.menu} aria-label="Sections">
        <ul className={styles.list}>
          {menuRoutes.map(({ label, path }) => (
            <li className={styles.item} key={path}>
              <NavLink
                className={({ isActive }) =>
                  isActive ? `${styles.link} ${styles.linkActive}` : styles.link
                }
                to={path}
                end={path === '/'}
                onClick={() => setOpen({ open: false })}
              >
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
        {status === 'signed-in' && (
          <button className={styles.signOut} type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        )}
      </nav>
    </aside>
  )
}
