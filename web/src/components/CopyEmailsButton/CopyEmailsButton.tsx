import { useEffect, useState } from 'react'
import { dedupeEmails } from '@/lib/emails'
import styles from '@/components/CopyEmailsButton/CopyEmailsButton.module.scss'

type CopyEmailsButtonProps = {
  emails: ReadonlyArray<string>
}

type CopyState = 'idle' | 'copied' | 'failed'

const RESET_MS = 2000

const CopyEmailsButton = ({ emails }: CopyEmailsButtonProps) => {
  const [state, setState] = useState<CopyState>('idle')
  const deduped = dedupeEmails(emails)

  useEffect(() => {
    if (state === 'idle') {
      return
    }
    const timer = setTimeout(() => setState('idle'), RESET_MS)
    return () => clearTimeout(timer)
  }, [state])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(deduped.join(', '))
      setState('copied')
    } catch {
      setState('failed')
    }
  }

  const label =
    state === 'copied'
      ? 'Copied!'
      : state === 'failed'
        ? 'Copy failed'
        : `Copy all emails (${deduped.length})`

  return (
    <button
      className={styles.copy}
      type="button"
      onClick={() => void handleCopy()}
      disabled={!deduped.length}
    >
      {label}
    </button>
  )
}

export default CopyEmailsButton
