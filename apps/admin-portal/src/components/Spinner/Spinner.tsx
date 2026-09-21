import styles from '@/components/Spinner/Spinner.module.scss'

type SpinnerProps = {
  /**
   * What the spinner announces while it is up. Left out inside a region that
   * already announces its own status, which makes the spinner decorative
   * rather than a second live region saying the same thing.
   */
  label?: string
  size?: 'inline' | 'block'
}

/** The one spinner: one animation, one reduced-motion rule, two sizes. */
export const Spinner = ({ label, size = 'inline' }: SpinnerProps) => {
  const decorative = label === undefined
  return (
    <span
      className={`${styles.spinner} ${size === 'block' ? styles.block : styles.inline}`}
      role={decorative ? undefined : 'status'}
      aria-label={label}
      aria-hidden={decorative || undefined}
    />
  )
}
