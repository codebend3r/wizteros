import type { ReactNode } from 'react'
import type { InviteResult } from '@/lib/adminApi'
import styles from '@/components/InviteResultNotice/InviteResultNotice.module.scss'

type InviteResultNoticeProps = {
  result: InviteResult
  /** Anything the page wants after the link, such as a way to the member. */
  children?: ReactNode
}

/**
 * What an invite came back with. The link is shown either way: when the email
 * failed it is the only copy of it there is.
 */
export const InviteResultNotice = ({ result, children }: InviteResultNoticeProps) => (
  <p className={styles.notice}>
    {result.emailed ? 'Invite emailed. Link: ' : 'Email failed — send this link manually: '}
    <a href={result.url}>{result.url}</a>
    {!!children && ' '}
    {children}
  </p>
)
