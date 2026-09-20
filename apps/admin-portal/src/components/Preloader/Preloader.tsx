import { Spinner } from '@/components/Spinner/Spinner'
import styles from '@/components/Preloader/Preloader.module.scss'

type PreloaderProps = {
  message?: string
}

export const Preloader = ({ message }: PreloaderProps) => (
  <div className={styles.preloader} role="status">
    <Spinner size="block" />
    {!!message && <p className={styles.message}>{message}</p>}
  </div>
)
