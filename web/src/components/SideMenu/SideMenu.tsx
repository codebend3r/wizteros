import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import styles from '@/components/SideMenu/SideMenu.module.scss'

export const menuRoutes = [
  { label: 'Home', path: '/' },
  { label: 'Members', path: '/manage' },
  { label: 'Invite', path: '/invite' },
  { label: 'Email', path: '/email' },
] as const

export const SideMenu = () => {
  const [open, setOpen] = useState(false)
  return (
    <aside className={styles.sideMenu}>
      <button
        className={styles.toggle}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Menu
      </button>
      <nav
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
                onClick={() => setOpen(false)}
              >
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  )
}
