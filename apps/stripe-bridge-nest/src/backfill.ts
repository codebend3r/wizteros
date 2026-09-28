import { Logger } from '@nestjs/common'
import { eachInOrder, mapInOrder } from '@/sequence.js'
import { holdsStandingGrant } from '@/standing.js'
import type { BridgeStore } from '@/store/openStore.js'
import type { WizarrApi } from '@/types.js'
import { addSeconds, isoformat } from '@wizteros/server-common'

// One-time backfill: mark the 44 non-VIP members Invited with a 14-day expiry.
//
// For each listed member this stamps invited_at = now in the bridge (so they
// read "Invited") and sets a real Wizarr access expiry 14 days out (so Wizarr
// removes their access if they don't sign up). It does NOT set the payment
// flag — their status stays "Invited" until a real Stripe payment flips it to
// "Subscribed Monthly".
//
// Idempotent and safe to re-run. Two members are skipped untouched:
//   - anyone tagged `vip` (VIP access is never time-boxed), and
//   - anyone already carrying a confirmed payment (`subscribed`).
//
// Deploy the payment-flag bridge changes FIRST — otherwise the old logic would
// read these members as "Subscribed Monthly" the moment they get an expiry.

const log = new Logger('bridge.backfill')

const DAY_SECONDS = 24 * 60 * 60

/** The expiry default, BACKFILL_EXPIRY_DAYS in the Python script's env. */
export const BACKFILL_EXPIRY_DAYS = 14

// The 44 non-VIP members (the full Wizarr roster minus the 5 VIP emails).
// Auditable — remove any address here to leave that member untouched.
export const BACKFILL_EMAILS: readonly string[] = [
  'amolsharma@me.com',
  'andrewmasonmac@gmail.com',
  'andrew.a.donald@gmail.com',
  'oe.andy0102@gmail.com',
  'artirawal2009@gmail.com',
  'ayosalawu@gmail.com',
  'codebenderinc@gmail.com',
  'chrismanocchio@gmail.com',
  'christopherlukestewart@gmail.com',
  'cuallijulius@gmail.com',
  'danny.p.79@icloud.com',
  'davejmcg@gmail.com',
  'harpreetmand@gmail.com',
  'harmancheema07@gmail.com',
  'higorsalesart@gmail.com',
  'jamal.tobias@gmail.com',
  'jean.abousaab@gmail.com',
  'jeffreceno@hotmail.com',
  'jimmyvo768@gmail.com',
  'jroberts0985@gmail.com',
  'karensjahn@gmail.com',
  'kensuong@gmail.com',
  'kkalawi@gmail.com',
  'lauramjbowers@gmail.com',
  '809lenny@gmail.com',
  'luxman.thevathasan@gmail.com',
  'm.mcphaden@live.ca',
  'macklewis16@gmail.com',
  'mattbk.cb@gmail.com',
  'stefuraknataliia@gmail.com',
  'nicklhw@gmail.com',
  'pollux527@hotmail.com',
  'contactprerit@gmail.com',
  'ramiandari@gmail.com',
  'rita.duchak@icloud.com',
  'rodrigobocaiuva@gmail.com',
  'rorosha13@gmail.com',
  'ryan.duchak@gmail.com',
  'schopra86@live.com',
  'canexan@gmail.com',
  'jbloco26@gmail.com',
  'gmacgregor@gmail.com',
  'Toronto0442@gmail.com',
  'william@wcarroll.com',
]

export type BackfillSummary = Readonly<{ stamped: number; skipped: number; total: number }>

type Verdict = 'vip' | 'subscribed' | 'eligible'

/**
 * Stamp each eligible member Invited and set their Wizarr expiry.
 *
 * VIPs and members already carrying a confirmed payment are skipped untouched.
 * A dry run logs what would change and writes nothing, neither to the store
 * nor to Wizarr. Wizarr is called one record at a time, in list order.
 */
export const runBackfill = async ({
  store,
  wizarr,
  dryRun,
  emails = BACKFILL_EMAILS,
  expiryDays = BACKFILL_EXPIRY_DAYS,
  now = new Date(),
}: {
  store: BridgeStore
  wizarr: WizarrApi
  dryRun: boolean
  emails?: readonly string[]
  expiryDays?: number
  now?: Date
}): Promise<BackfillSummary> => {
  const tags = store.allMemberTags()
  const rows = store.allCustomerRows()
  const expires = isoformat(addSeconds({ at: now, seconds: expiryDays * DAY_SECONDS }))
  const prefix = dryRun ? '[dry-run] ' : ''

  const verdictFor = (key: string): Verdict => {
    if (holdsStandingGrant(tags.get(key) ?? null)) {
      return 'vip'
    }
    return (rows.get(key)?.subscribed ?? false) ? 'subscribed' : 'eligible'
  }

  const verdicts = await mapInOrder({
    items: emails,
    run: async (email): Promise<Verdict> => {
      const verdict = verdictFor(email.toLowerCase())
      if (verdict === 'vip') {
        log.log(`skip ${email} — VIP (never time-boxed)`)
        return verdict
      }
      if (verdict === 'subscribed') {
        log.log(`skip ${email} — already subscribed (confirmed payment)`)
        return verdict
      }

      const uids = await wizarr.findUserIdsByEmail(email)
      log.log(
        `${prefix}${email} — stamp Invited, expire ${uids.length} Wizarr record(s) at ${expires.slice(0, 10)}`,
      )
      if (dryRun) {
        return verdict
      }

      store.stampInvited({ email })
      await eachInOrder({
        items: uids,
        run: (userId) => wizarr.setExpiry({ userId, expires }),
      })
      store.recordEvent({
        email,
        action: 'Invited',
        detail: `manual — access ends ${expires.slice(0, 10)}`,
      })
      return verdict
    },
  })

  const stamped = verdicts.filter((verdict) => verdict === 'eligible').length
  const skipped = verdicts.length - stamped
  log.log(`${prefix}done: ${stamped} stamped, ${skipped} skipped, ${emails.length} total`)
  return { stamped, skipped, total: emails.length }
}
