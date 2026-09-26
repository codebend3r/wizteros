// Parity check: the Python fleet-monitor API and its NestJS port, side by side,
// against the same copy of a fleet.db, on every route and a grid of filters.
//
//   node apps/fleet-monitor-nest/scripts/parity.mjs --db /path/to/fleet-copy.db
//
// Run from the repo root after `bun run setup:py:monitor` and
// `bunx nx run fleet-monitor-nest:build`. Point it at a COPY: both APIs open
// the file, and the Python one runs its schema setup on start.
//
// Both servers verify real ES256 tokens against a fake Supabase that this
// script serves, so the guard is exercised rather than bypassed. Responses are
// compared as parsed JSON. Two differences are expected and normalised away:
// timestamps are compared at millisecond precision (a JS Date cannot hold the
// microseconds Python wrote), and fields measured from "now" may differ by the
// time between the two calls.

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    'py-port': { type: 'string', default: '18110' },
    'nest-port': { type: 'string', default: '8010' },
    verbose: { type: 'boolean', default: false },
  },
})

if (!values.db) {
  console.error('usage: parity.mjs --db <copy of fleet.db>')
  process.exit(2)
}

const ROOT = process.cwd()
const DB = resolve(values.db)
const EMAIL = 'parity@example.com'
const KID = 'parity-key'

// --- a fake Supabase that publishes one key --------------------------------

const keys = await generateKeyPair('ES256')
const jwk = { ...(await exportJWK(keys.publicKey)), kid: KID, alg: 'ES256', use: 'sig' }
const supabase = createServer((request, response) => {
  if (request.url === '/auth/v1/.well-known/jwks.json') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ keys: [jwk] }))
    return
  }
  response.writeHead(404)
  response.end()
})
await new Promise((ready) => supabase.listen(0, '127.0.0.1', ready))
const supabaseUrl = `http://127.0.0.1:${supabase.address().port}`
const token = await new SignJWT({ email: EMAIL })
  .setProtectedHeader({ alg: 'ES256', kid: KID })
  .setIssuer(`${supabaseUrl}/auth/v1`)
  .setAudience('authenticated')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(keys.privateKey)

// --- the two servers --------------------------------------------------------

const env = {
  ...process.env,
  FM_DB_PATH: DB,
  FM_SUPABASE_URL: supabaseUrl,
  FM_ADMIN_ALLOWED_EMAILS: EMAIL,
}

const children = [
  spawn(
    resolve(ROOT, 'apps/fleet-monitor/.venv/bin/uvicorn'),
    ['fleet_monitor.api:app', '--port', values['py-port'], '--log-level', 'warning'],
    { cwd: resolve(ROOT, 'apps/fleet-monitor'), env, stdio: 'inherit' },
  ),
  spawn('node', ['dist/main.js'], {
    cwd: resolve(ROOT, 'apps/fleet-monitor-nest'),
    env,
    stdio: values.verbose ? 'inherit' : 'ignore',
  }),
]

const stop = () => {
  children.forEach((child) => child.kill())
  supabase.close()
}
process.on('exit', stop)

const PY = `http://127.0.0.1:${values['py-port']}`
const NEST = `http://127.0.0.1:${values['nest-port']}`

const waitFor = async (base) => {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const up = await fetch(`${base}/health`).then(
      (response) => response.ok,
      () => false,
    )
    if (up) {
      return
    }
    await sleep(250)
  }
  throw new Error(`${base} never answered /health`)
}
await Promise.all([waitFor(PY), waitFor(NEST)])

// --- comparison ---------------------------------------------------------------

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

// Fields measured from the moment of the request, which two calls a few
// milliseconds apart cannot agree on to the digit.
const CLOCK_FIELDS = /age_seconds$|_ago$|^now$/

const normalise = (value, key = '') => {
  if (typeof value === 'string' && TIMESTAMP.test(value)) {
    return new Date(value).toISOString()
  }
  if (typeof value === 'number' && CLOCK_FIELDS.test(key)) {
    return Math.round(value)
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalise(item))
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, item]) => [name, normalise(item, name)]),
    )
  }
  return value
}

const differences = (a, b, path = '$') => {
  if (JSON.stringify(a) === JSON.stringify(b)) {
    return []
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const lengths = a.length === b.length ? [] : [`${path}: length ${a.length} vs ${b.length}`]
    return [
      ...lengths,
      ...a
        .slice(0, Math.min(a.length, b.length))
        .flatMap((item, index) => differences(item, b[index], `${path}[${index}]`)),
    ]
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const names = [...new Set([...Object.keys(a), ...Object.keys(b)])]
    return names.flatMap((name) => differences(a[name], b[name], `${path}.${name}`))
  }
  return [`${path}: python ${JSON.stringify(a)} vs nest ${JSON.stringify(b)}`]
}

const read = async ({ base, path, auth }) => {
  const response = await fetch(`${base}${path}`, {
    headers: auth ? { authorization: `Bearer ${token}` } : {},
  })
  const text = await response.text()
  const body = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  })()
  return { status: response.status, body }
}

// A validation failure only has to agree on the status: FastAPI's 422 body is
// pydantic's own error list, which the portal never parses.
const compare = async ({ path, auth = true, bodyMatters = true }) => {
  const [python, nest] = await Promise.all([
    read({ base: PY, path, auth }),
    read({ base: NEST, path, auth }),
  ])
  const statusDiff =
    python.status === nest.status ? [] : [`status ${python.status} vs ${nest.status}`]
  const bodyDiff =
    bodyMatters && python.status < 422
      ? differences(normalise(python.body), normalise(nest.body))
      : []
  return { path, python, problems: [...statusDiff, ...bodyDiff] }
}

// --- the grid -------------------------------------------------------------------

const HOSTS = ['meleys', 'vermithor', 'caraxes', 'syrax', 'vhagar']
const KINDS = ['movie', 'episode', 'track']
const QUALITIES = ['4k', '1080p', '720p', 'other']
const DAYS = [0, 1, 7, 30, 365]

const filterGrid = [
  ...DAYS.map((days) => `days=${days}`),
  ...HOSTS.map((host) => `days=365&host=${host}`),
  ...KINDS.map((kind) => `days=0&kind=${kind}`),
  ...QUALITIES.map((quality) => `days=0&quality=${quality}`),
  'days=30&host=meleys&kind=episode&quality=1080p',
]

const fixed = [
  { path: '/health' },
  { path: '/fleet', auth: false },
  { path: '/fleet' },
  ...['cpu', 'memory', 'gpu', 'network'].flatMap((family) =>
    [2, 60, 1440, 10080].map((minutes) => ({ path: `/fleet/${family}?minutes=${minutes}` })),
  ),
  { path: '/fleet/cpu?minutes=1', bodyMatters: false },
  { path: '/fleet/cpu?minutes=10081', bodyMatters: false },
  ...[1, 24, 720, 43800].map((hours) => ({ path: `/incidents?hours=${hours}` })),
  { path: '/incidents?hours=0', bodyMatters: false },
  ...filterGrid.flatMap((query) => [
    { path: `/plays/overview?${query}` },
    { path: `/plays/users?${query}` },
    { path: `/plays/top?${query}&metric=plays` },
    { path: `/plays/top?${query}&metric=rewatches&limit=100` },
    { path: `/plays/never-played?${query}` },
  ]),
  { path: '/plays/never-played?days=0&page=2&page_size=200' },
  { path: '/plays/never-played?days=0&q=the' },
  { path: '/plays/sync' },
  { path: '/plays/overview?host=ghost', bodyMatters: false },
  { path: '/plays/top?metric=nope', bodyMatters: false },
  { path: '/nowhere' },
]

const results = await Promise.all(fixed.map((check) => compare(check)))

// Routes keyed by ids the data itself names: the top viewers' histories and
// the top titles' histories, a page or two each.
const users = results.find(({ path }) => path === '/plays/users?days=0')?.python.body
const titles = results.find(({ path }) => path === '/plays/top?days=0&metric=plays')?.python.body
const accountIds = (users?.users ?? []).slice(0, 5).map((user) => user.account_id)
const titleKeys = (titles?.titles ?? []).slice(0, 5).map((title) => title.key)

const derived = await Promise.all([
  ...accountIds.flatMap((id) =>
    [1, 2].map((page) => compare({ path: `/plays/users/${id}/history?days=0&page=${page}` })),
  ),
  ...titleKeys.map((key) =>
    compare({ path: `/plays/title?days=0&key=${encodeURIComponent(key)}` }),
  ),
  compare({ path: '/plays/title?days=0&key=movie%3Ano%20such%20title%3A1999' }),
])

const all = [...results, ...derived]
const failed = all.filter(({ problems }) => problems.length > 0)
failed.forEach(({ path, problems }) => {
  console.log(`\n✗ ${path}`)
  problems.slice(0, 20).forEach((problem) => console.log(`    ${problem}`))
  if (problems.length > 20) {
    console.log(`    ... and ${problems.length - 20} more`)
  }
})
console.log(`\n${all.length - failed.length}/${all.length} routes match`)
stop()
process.exit(failed.length === 0 ? 0 : 1)
