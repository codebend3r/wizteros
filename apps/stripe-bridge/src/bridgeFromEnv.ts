import { smtpMailer } from '@/clients/mailer.js'
import { plexApi } from '@/clients/plex.js'
import { stripeApi } from '@/clients/stripe.js'
import { wizarrClient } from '@/clients/wizarr.js'
import {
  accessDays,
  alertAddresses,
  baselineExpiresDays,
  inviteDays,
  mapDbPath,
  plexToken,
  plexTvBase,
  publicInviteBase,
  smtpConfig,
  stripeApiKey,
  wizarrApiKey,
  wizarrBaseUrl,
} from '@/config.js'
import { openStore } from '@/store/openStore.js'
import type { Bridge } from '@/types.js'

/**
 * The production bridge: the real Wizarr, Stripe, plex.tv and SMTP clients
 * over the environment's settings, built once when the app starts.
 */
export const bridgeFromEnv = (): Bridge => ({
  store: openStore(mapDbPath()),
  wizarr: wizarrClient({ baseUrl: wizarrBaseUrl(), apiKey: wizarrApiKey() }),
  stripe: stripeApi({ apiKey: stripeApiKey() }),
  plex: plexApi({ token: plexToken(), base: plexTvBase() }),
  mailer: smtpMailer({
    smtp: smtpConfig(),
    alertAddresses: alertAddresses(),
    inviteDays: inviteDays(),
  }),
  settings: {
    publicInviteBase: publicInviteBase(),
    accessDays: accessDays(),
    inviteDays: inviteDays(),
    baselineExpiresDays: baselineExpiresDays(),
  },
})
