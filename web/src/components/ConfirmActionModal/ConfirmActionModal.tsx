import { useEffect, useId, type ReactNode } from 'react'
import styles from '@/components/ConfirmActionModal/ConfirmActionModal.module.scss'

type ConfirmActionModalProps = {
  title: string
  confirmLabel: string
  busy?: boolean
  busyLabel?: string
  onConfirm: () => void
  onCancel: () => void
  children: ReactNode
}

const ConfirmActionModal = ({
  title,
  confirmLabel,
  busy = false,
  busyLabel,
  onConfirm,
  onCancel,
  children,
}: ConfirmActionModalProps) => {
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        onCancel()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel, busy])

  return (
    // Backdrop click is a convenience; the keyboard equivalent is the Escape
    // handler above, so no key handler belongs on the overlay itself.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
    <div className={styles.overlay} onClick={() => !busy && onCancel()}>
      {/* The only handler is stopPropagation, which keeps backdrop clicks from
          closing the dialog; it is not an interaction affordance. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions */}
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className={styles.title} id={titleId}>
          {title}
        </h2>
        {children}
        <div className={styles.actions}>
          <button className={styles.cancel} type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className={styles.confirm} type="button" onClick={onConfirm} disabled={busy}>
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}

export default ConfirmActionModal
