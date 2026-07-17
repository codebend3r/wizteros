import styles from '@/components/Preloader/Preloader.module.scss'

type PreloaderProps = {
  message?: string
}

const Preloader = ({ message }: PreloaderProps) => (
  <div className={styles.preloader} role="status">
    <span className={styles.spinner} aria-hidden="true" />
    {!!message && <p className={styles.message}>{message}</p>}
  </div>
)

export default Preloader
