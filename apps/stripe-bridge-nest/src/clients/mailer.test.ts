import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CreateTransport,
  type MailMessage,
  type SmtpTransportOptions,
  smtpMailer,
} from '@/clients/mailer.js'
import type { SmtpConfig } from '@/config.js'

// The environment the Python suite set before importing the module.
const SMTP: SmtpConfig = {
  host: 'smtp.test',
  port: 587,
  user: 'u',
  pass: 'p',
  from: 'server@test',
}

/**
 * A transport factory that records what it was opened with and every message
 * handed to it, standing in for the MagicMock'd smtplib.SMTP. No socket opens.
 */
const fakeSmtp = ({ fail = null }: { fail?: Error | null } = {}) => {
  const opened: SmtpTransportOptions[] = []
  const sent: MailMessage[] = []
  const closed = vi.fn<() => void>()
  const createTransport = vi.fn<CreateTransport>((options) => {
    opened.push(options)
    return {
      sendMail: async (message) => {
        if (fail !== null) {
          throw fail
        }
        sent.push(message)
        return {}
      },
      close: closed,
    }
  })
  return { createTransport, opened, sent, closed }
}

const mailer = ({
  alertAddresses = ['ops@test'],
  createTransport,
}: {
  alertAddresses?: readonly string[]
  createTransport: CreateTransport
}) => smtpMailer({ smtp: SMTP, alertAddresses, inviteDays: 14, createTransport })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('smtpMailer', () => {
  it('alert email never throws', async () => {
    // Every alert is a copy for the operator, sent from the middle of a flow
    // (a signup, a sweep, a failed charge) that must complete either way.
    // The swallow lives here, once, so no caller has to wrap it.
    const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const createTransport = vi.fn<CreateTransport>(() => {
      throw new Error('smtp down')
    })
    await expect(
      mailer({ alertAddresses: ['ops@test'], createTransport }).sendAlert({
        subject: 'something broke',
        body: 'details',
      }),
    ).resolves.toBeUndefined()
    expect(error.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
      'alert email failed: something broke',
    )
  })

  it('alert email is a no-op with nobody to tell', async () => {
    const smtp = fakeSmtp()
    await mailer({ alertAddresses: [], createTransport: smtp.createTransport }).sendAlert({
      subject: 'something broke',
      body: 'details',
    })
    expect(smtp.createTransport).not.toHaveBeenCalled()
  })

  it('alert email reaches every configured address', async () => {
    const smtp = fakeSmtp()
    await mailer({
      alertAddresses: ['a@test', 'b@test'],
      createTransport: smtp.createTransport,
    }).sendAlert({ subject: 'something broke', body: 'details' })
    const [sent] = smtp.sent
    expect(sent?.to).toBe('a@test, b@test')
    expect(sent?.subject).toBe('[westeroz] something broke')
    // Plain text only: the operator's copy carries no HTML part.
    expect(sent?.text).toBe('details')
    expect(sent?.html).toBeUndefined()
    expect(sent?.from).toBe('server@test')
  })

  it('invite mail carries the plain text and the HTML alternative over STARTTLS', async () => {
    const smtp = fakeSmtp()
    await mailer({ createTransport: smtp.createTransport }).sendInvite({
      to: 'member@x.com',
      inviteUrl: 'http://inv.test/j/abc',
    })
    expect(smtp.opened).toEqual([
      {
        host: 'smtp.test',
        port: 587,
        secure: false,
        requireTLS: true,
        auth: { user: 'u', pass: 'p' },
      },
    ])
    const [sent] = smtp.sent
    expect(sent?.subject).toBe('Your Westeroz access link')
    expect(sent?.from).toBe('server@test')
    expect(sent?.to).toBe('member@x.com')
    expect(sent?.text.startsWith('Thanks for contributing to server costs!')).toBe(true)
    expect(sent?.text.endsWith('removed at the end of the current cycle.')).toBe(true)
    expect(sent?.text).toContain('The invite expires in 14 days')
    expect(sent?.text).toContain('\n  http://inv.test/j/abc\n')
    expect(sent?.html).toContain('href="http://inv.test/j/abc"')
    expect(sent?.html).toContain('14 days')
    expect(smtp.closed).toHaveBeenCalledOnce()
  })

  it('alert is skipped when no address is configured', async () => {
    const smtp = fakeSmtp()
    const send = mailer({ alertAddresses: [], createTransport: smtp.createTransport })
    await send.sendAlert({ subject: 'x', body: 'y' })
    expect(smtp.sent).toEqual([])
    expect(smtp.opened).toEqual([])
  })

  it('swallows an alert SMTP failure but propagates an invite failure', async () => {
    // Stripe retries a webhook whose invite mail failed; an alert is only a copy.
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {})
    const smtp = fakeSmtp({ fail: new Error('smtp down') })
    const send = mailer({ createTransport: smtp.createTransport })
    await expect(send.sendAlert({ subject: 's', body: 'b' })).resolves.toBeUndefined()
    await expect(
      send.sendInvite({ to: 'member@x.com', inviteUrl: 'http://inv.test/j/abc' }),
    ).rejects.toThrow('smtp down')
    // The connection is closed even when the send fails.
    expect(smtp.closed).toHaveBeenCalledTimes(2)
  })
})
