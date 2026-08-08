import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import logoImage from '@/assets/logo.jpg'
import styles from '@/components/Header/Header.module.scss'
import { useMenuStore } from '@/stores/menuStore'

type HeaderProps = {
  brandName: string
}

export const Header = ({ brandName }: HeaderProps) => {
  const open = useMenuStore((state) => state.open)
  const setOpen = useMenuStore((state) => state.setOpen)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  // Whatever closes the drawer (backdrop, Escape, a nav link), focus comes
  // back to the control that opened it.
  useEffect(() => {
    if (wasOpen.current && !open) {
      toggleRef.current?.focus()
    }
    wasOpen.current = open
  }, [open])

  return (
    <header className={styles.header}>
      <div className={styles.brandGroup}>
        <button
          ref={toggleRef}
          className={styles.menuToggle}
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          onClick={() => setOpen({ open: !open })}
        >
          <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
            <path
              d="M2 5h16M2 10h16M2 15h16"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <Link className={styles.brand} to="/">
          <span className={styles.logoFrame}>
            <img className={styles.logoImage} src={logoImage} alt="" />
          </span>
          {brandName}
        </Link>
      </div>
      <nav className={styles.nav} aria-label="Admin">
        <Link className={styles.navLink} to="/manage">
          Members
        </Link>
      </nav>
    </header>
  )
}
