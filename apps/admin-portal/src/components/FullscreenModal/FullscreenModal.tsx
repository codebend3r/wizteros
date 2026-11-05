import { useEffect, useId, useRef, type ReactNode, type SyntheticEvent } from 'react'
import { Icon } from '@/components/Icon/Icon'
import styles from '@/components/FullscreenModal/FullscreenModal.module.scss'

type FullscreenModalProps = {
  /** The dialog's heading, and so its accessible name. */
  readonly title: string
  readonly onClose: () => void
  /** Controls that belong beside the title, such as a range picker. */
  readonly tools?: ReactNode
  readonly children: ReactNode
}

/** One view across the whole screen, over everything else on the page.
 *
 * A native modal dialog, so the browser does the modal work itself: it puts
 * the dialog in the top layer over every stacking context, makes the page
 * behind inert to the pointer, the keyboard and the screen reader alike, and
 * turns Escape into a cancel. What is left here is moving focus to the close
 * button on open, handing it back to whatever opened the view, and holding the
 * page still behind it.
 *
 * Mounted only while open: the page renders it on demand rather than toggling
 * it, so opening and closing are the effect's start and cleanup.
 *
 * The body is a grid row of whatever height the screen leaves under the header,
 * which is what a chart inside stretches into.
 */
export const FullscreenModal = ({ title, onClose, tools, children }: FullscreenModalProps) => {
  const titleId = useId()
  const dialog = useRef<HTMLDialogElement | null>(null)
  const closeButton = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const element = dialog.current
    const opener = document.activeElement
    const scroll = document.body.style.overflow
    element?.showModal()
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    return () => {
      element?.close()
      document.body.style.overflow = scroll
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [])

  // Escape arrives as a cancel. The browser would close the dialog itself and
  // leave the page still rendering it, so the page closes it instead.
  const onCancel = (event: SyntheticEvent<HTMLDialogElement>): void => {
    event.preventDefault()
    onClose()
  }

  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId} onCancel={onCancel}>
      <header className={styles.header}>
        <h2 className={styles.title} id={titleId}>
          {title}
        </h2>
        {!!tools && <div className={styles.tools}>{tools}</div>}
        <button
          ref={closeButton}
          type="button"
          className={styles.close}
          aria-label="Close full screen"
          title="Close full screen"
          onClick={onClose}
        >
          <Icon name="close" size={20} strokeWidth={1.75} />
        </button>
      </header>
      <div className={styles.body}>{children}</div>
    </dialog>
  )
}
