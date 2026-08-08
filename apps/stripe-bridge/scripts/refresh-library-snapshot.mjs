#!/usr/bin/env node
// Refresh the recorded Wizarr library list that stripe-bridge's tier scope
// tests assert against.
//
// The tier rules match Plex library NAMES, so renaming a library on the server
// silently narrows or empties a tier with no code change. Hand-written fixtures
// can never catch that — they are written to agree with the rules. This pulls
// what Wizarr actually returns so the tests compare the rules against reality.
//
// Run after any Plex library rename, then review the diff:
//   bun run refresh:libraries        (from the workspace root)
//
// A failing test after a refresh is the point: it means a rename changed what
// a tier grants. Fix tiers.py to match the new names, never the other way.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { WIZARR_BASE_URL, WIZARR_API_KEY } = process.env

if (!WIZARR_BASE_URL || !WIZARR_API_KEY) {
  console.error('Missing WIZARR_BASE_URL / WIZARR_API_KEY (use --env-file=.env)')
  process.exit(2)
}

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'fixtures',
  'live-libraries.json',
)

// Only the fields the tier rules read. Anything else is noise in the diff and
// would churn the fixture every time Wizarr adds a column.
const FIELDS = ['id', 'name', 'server_id', 'server_name', 'enabled']

const res = await fetch(`${WIZARR_BASE_URL.replace(/\/+$/, '')}/api/libraries`, {
  headers: { 'X-API-Key': WIZARR_API_KEY },
  signal: AbortSignal.timeout(30_000),
})
if (!res.ok) {
  console.error(`GET /api/libraries -> ${res.status}`)
  process.exit(1)
}

const libraries = ((await res.json()).libraries ?? [])
  .map((lib) => Object.fromEntries(FIELDS.map((f) => [f, lib[f] ?? null])))
  // Stable order so an unrelated Wizarr response reshuffle is not a diff.
  .sort((a, b) => a.server_id - b.server_id || a.name.localeCompare(b.name))

if (libraries.length === 0) {
  console.error('Wizarr returned no libraries — refusing to write an empty snapshot')
  process.exit(1)
}

writeFileSync(OUT, `${JSON.stringify({ libraries }, null, 2)}\n`)

const byServer = libraries.reduce((acc, lib) => {
  acc[lib.server_name] = (acc[lib.server_name] ?? 0) + 1
  return acc
}, {})

console.log(`Wrote ${libraries.length} libraries to ${OUT}`)
for (const [server, count] of Object.entries(byServer).sort()) {
  console.log(`  ${server}: ${count}`)
}
console.log('\nReview the diff, then run: bun run test:bridge')
