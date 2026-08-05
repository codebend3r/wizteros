import { Link } from 'react-router-dom'
import styles from '@/components/AdminLoginButton/AdminLoginButton.module.scss'
import { useAuthStore } from '@/stores/authStore'

// Hidden while Supabase is dormant (env vars unset), same convention as the
// gate itself, and it avoids advertising admin access on a misconfigured build.
export const AdminLoginButton = () => {
  const enabled = useAuthStore((state) => state.enabled)
  if (!enabled) {
    return null
  }
  return (
    <Link className={styles.button} to="/login">
      Admin login
    </Link>
  )
}
