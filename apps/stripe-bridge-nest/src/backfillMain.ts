import { parseArgs } from 'node:util'
import { runBackfill } from '@/backfill.js'
import { wizarrClient } from '@/clients/wizarr.js'
import { backfillExpiryDays, mapDbPath, wizarrApiKey, wizarrBaseUrl } from '@/config.js'

// The one-time Invited backfill, run by hand inside the bridge container,
// where the bridge's own environment already points at production:
//
//   docker exec stripe-bridge node dist/backfillMain.js --dry-run
//
// Drop --dry-run to apply. Always run --dry-run first and read the summary.
// BACKFILL_EXPIRY_DAYS overrides the 14-day window.

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } })

const baseUrl = wizarrBaseUrl()
const apiKey = wizarrApiKey()
if (!baseUrl || !apiKey) {
  console.error('WIZARR_BASE_URL and WIZARR_API_KEY must be set')
  process.exit(1)
}

await runBackfill({
  dbPath: mapDbPath(),
  wizarr: wizarrClient({ baseUrl, apiKey }),
  dryRun: values['dry-run'],
  expiryDays: backfillExpiryDays(),
})
