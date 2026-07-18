import { Link } from 'react-router-dom'
import styles from '@/components/Header/Header.module.scss'

type HeaderProps = {
  brandName: string
}

const Header = ({ brandName }: HeaderProps) => (
  <header className={styles.header}>
    <Link className={styles.brand} to="/">
      {brandName}
    </Link>
    <nav className={styles.nav} aria-label="Admin">
      <Link className={styles.navLink} to="/manage">
        Members
      </Link>
    </nav>
  </header>
)

export default Header
