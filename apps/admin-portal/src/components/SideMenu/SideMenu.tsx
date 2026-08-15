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
  { label: 'Design', path: '/design' },
] as const

export const SideMenu = () => {
  const open = useMenuStore((state) => state.open)
  const setOpen = useMenuStore((state) => state.setOpen)
  const status = useAuthStore((state) => state.status)
  const signOut = useAuthStore((state) => state.signOut)
  const navRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    navRef.current?.focus()
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

  return (
    <aside className={styles.sideMenu}>
      {open && (
        <button
          className={styles.backdrop}
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen({ open: false })}
        />
      )}
      <nav
        ref={navRef}
        tabIndex={-1}
        className={open ? `${styles.menu} ${styles.menuOpen}` : styles.menu}
        aria-label="Sections"
      >
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
