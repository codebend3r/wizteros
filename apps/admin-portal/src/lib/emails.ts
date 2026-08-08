// Keeps the first spelling of each address. The lowercased keys ride along so
// the comparison stays case-insensitive without rescanning what came before.
export const dedupeEmails = (emails: ReadonlyArray<string>): string[] => {
  const trimmed = emails.map((email) => email.trim()).filter(Boolean)
  const keys = trimmed.map((email) => email.toLowerCase())
  return trimmed.filter((_, index) => keys.indexOf(keys[index]) === index)
}

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
