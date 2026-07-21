import { expect, test } from 'vitest'
import { buildMailto, dedupeEmails } from '@/lib/emails'

test('dedupeEmails trims, drops empties, and dedupes case-insensitively', () => {
  expect(dedupeEmails([' a@x.com ', 'A@X.com', '', 'b@x.com'])).toEqual(['a@x.com', 'b@x.com'])
})

test('buildMailto puts recipients in bcc and percent-encodes subject and body', () => {
  const url = buildMailto({
    recipients: ['a@x.com', 'b@x.com'],
    subject: 'Hi all',
    body: 'Line one',
  })
  expect(url).toBe('mailto:?bcc=a%40x.com%2Cb%40x.com&subject=Hi%20all&body=Line%20one')
})

test('buildMailto omits blank subject and body', () => {
  expect(buildMailto({ recipients: ['a@x.com'], subject: '  ', body: '' })).toBe(
    'mailto:?bcc=a%40x.com',
  )
})
