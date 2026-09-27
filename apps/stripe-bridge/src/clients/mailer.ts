import { Logger } from '@nestjs/common'
import { createTransport as nodemailerTransport } from 'nodemailer'
import { renderInviteEmail } from '@/clients/emailTemplate.js'
import type { SmtpConfig } from '@/config.js'
import type { Alert, Mailer } from '@/types.js'
import { stackOf } from '@/errors.js'

// SMTP invite mail, shared by the Stripe webhook flow and the admin API, plus
// the operator alerts every flow copies to the admins.

const log = new Logger('bridge.mailer')

/** How the transport is opened: STARTTLS on the submission port, then login. */
export type SmtpTransportOptions = Readonly<{
  host: string
  port: number
  secure: false
  requireTLS: true
  auth: Readonly<{ user: string; pass: string }>
}>

/** One message: plain text always, the HTML alternative only for invites. */
export type MailMessage = Readonly<{
  from: string
  to: string
  subject: string
  text: string
  html?: string
}>

/** The slice of a nodemailer transport the mailer uses. */
export type MailTransport = Readonly<{
  sendMail: (message: MailMessage) => Promise<unknown>
  close: () => void
}>

/** Opens a transport; a test hands in a fake so no socket is ever opened. */
export type CreateTransport = (options: SmtpTransportOptions) => MailTransport

const defaultCreateTransport: CreateTransport = (options) => nodemailerTransport(options)

/** The plain-text invite body. */
const inviteText = ({ inviteUrl, inviteDays }: { inviteUrl: string; inviteDays: number }): string =>
  `Thanks for contributing to server costs!

Click the link below to set up your account. You'll sign in with a Plex account;
if you don't have one yet, create it with this same email address so your access
stays linked to your contribution.

The invite expires in ${inviteDays} days, so please complete signup soon.

  ${inviteUrl}

If you cancel your contribution, access will be removed at the end of the current cycle.`

/**
 * A mailer over the SMTP host in `smtp`. Each message opens its own
 * connection and closes it after, so a dead host never poisons the next
 * send; `requireTLS` insists on STARTTLS before login.
 */
export const smtpMailer = ({
  smtp,
  alertAddresses,
  inviteDays,
  createTransport = defaultCreateTransport,
}: {
  smtp: SmtpConfig
  alertAddresses: readonly string[]
  inviteDays: number
  createTransport?: CreateTransport
}): Mailer => {
  /** Open a connection, send one message, and close it whether or not it went. */
  const send = async (message: MailMessage): Promise<void> => {
    const transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: false,
      requireTLS: true,
      auth: { user: smtp.user, pass: smtp.pass },
    })
    try {
      await transport.sendMail(message)
    } finally {
      transport.close()
    }
  }

  /**
   * Compose the invite email (plain text + styled HTML) and send it over SMTP
   * with STARTTLS. A failure propagates on purpose, so Stripe retries the one
   * mail the member cannot do without.
   */
  const sendInvite = async ({ to, inviteUrl }: { to: string; inviteUrl: string }): Promise<void> =>
    send({
      from: smtp.from,
      to,
      subject: 'Your Westeroz access link',
      text: inviteText({ inviteUrl, inviteDays }),
      html: renderInviteEmail({ inviteUrl, expiresDays: inviteDays }),
    })

  /**
   * Mail an operational alert to the admins; never throws.
   *
   * No-op when no address is configured, and a dead SMTP host is logged and
   * swallowed: an alert is a copy for the operator, and the flow it reports on
   * (a signup, a sweep, a failed charge) must complete whether or not the copy
   * gets out. Contrast sendInvite, which throws on purpose so Stripe retries
   * the one mail the member cannot do without.
   *
   * Plain text on purpose: these are for the operator, not members, and must
   * stay readable in any client and quotable into an incident note.
   */
  const sendAlert = async ({ subject, body }: Alert): Promise<void> => {
    if (alertAddresses.length === 0) {
      return
    }
    try {
      await send({
        from: smtp.from,
        to: alertAddresses.join(', '),
        subject: `[westeroz] ${subject}`,
        text: body,
      })
    } catch (error) {
      log.error(`alert email failed: ${subject}`, stackOf(error))
    }
  }

  return { sendInvite, sendAlert }
}
