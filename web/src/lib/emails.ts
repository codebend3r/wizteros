export const dedupeEmails = (emails: ReadonlyArray<string>): string[] =>
  emails
    .map((email) => email.trim())
    .filter(Boolean)
    .reduce<string[]>((acc, email) => {
      const exists = acc.some((seen) => seen.toLowerCase() === email.toLowerCase())
      return exists ? acc : [...acc, email]
    }, [])

type MailtoParams = {
  recipients: ReadonlyArray<string>
  subject: string
  body: string
}

/**
 * Builds a `mailto:` hand-off link. Recipients go in BCC so addresses stay
 * private, and every part is percent-encoded (encodeURIComponent yields %20
 * for spaces, which mail clients read correctly — URLSearchParams' `+` does not).
 */
export const buildMailto = ({ recipients, subject, body }: MailtoParams): string => {
  const query = [
    `bcc=${encodeURIComponent(recipients.join(','))}`,
    subject.trim() && `subject=${encodeURIComponent(subject)}`,
    body.trim() && `body=${encodeURIComponent(body)}`,
  ]
    .filter(Boolean)
    .join('&')
  return `mailto:?${query}`
}
