// Parity check: the Python stripe-bridge and its NestJS port, side by side,
// against the same copy of a bridge.db, on every admin GET.
//
//   node --env-file=.env apps/stripe-bridge-nest/scripts/parity.mjs --db /path/to/bridge-copy.db
//
// Run from the repo root after `bun run setup:py` and
// `bunx nx run stripe-bridge-nest:build`. Point it at a COPY: both servers
// open the file, and each runs its schema setup on start.
//
// The admin reads are live: Wizarr's users, libraries and invitations,
// plex.tv's shares, Stripe's customer search. So both servers run with the
// environment's real Wizarr, plex.tv and Stripe credentials (hence
// --env-file), and this script only ever sends GETs. Nothing else may reach
// the world:
//   - the background loops are off in both, since the reconcile sweep writes
//     expiries to Wizarr and the rotation mints invites. Python's loop
//     coroutines are swapped for no-ops before uvicorn starts the lifespan;
//     the port is served through @nestjs/testing with its loops provider
//     replaced, so production carries no switch for this.
//   - SMTP points at a host that does not resolve, and no alert address is
//     set, so a code path that did try to mail could not.
//
// Both servers verify real ES256 tokens against a fake Supabase that this
// script serves, so the guard is exercised rather than bypassed. Responses
// are compared as parsed JSON with keys sorted.

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    python: { type: 'string', default: 'apps/stripe-bridge/.venv/bin/python' },
    'py-port': { type: 'string', default: '18100' },
    'nest-port': { type: 'string', default: '18101' },
    members: { type: 'string', default: '10' },
    verbose: { type: 'boolean', default: false },
  },
})

if (!values.db) {
  console.error('usage: parity.mjs --db <copy of bridge.db>')
  process.exit(2)
}

const ROOT = process.cwd()
const DB = resolve(values.db)

// Both servers create an empty database for a path that does not exist, and
// two empty databases agree on everything. Refuse that rather than report it.
if (!existsSync(DB) || statSync(DB).size === 0) {
  console.error(`no database at ${DB}; pass a copy of a real bridge.db`)
  process.exit(2)
}
const missing = ['WIZARR_BASE_URL', 'WIZARR_API_KEY', 'STRIPE_API_KEY'].filter(
  (name) => !process.env[name],
)
if (missing.length > 0) {
  console.error(`missing ${missing.join(', ')}; run with --env-file=.env`)
  process.exit(2)
}

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
  MAP_DB_PATH: DB,
  SUPABASE_URL: supabaseUrl,
  ADMIN_ALLOWED_EMAILS: EMAIL,
  ALERT_EMAILS: '',
  SMTP_HOST: 'smtp.invalid',
  SMTP_USER: 'parity',
  SMTP_PASS: 'parity',
}

const PYTHON_SERVER = `
import uvicorn
from stripe_bridge import stripe_wizarr_bridge as bridge

async def idle():
    return None

bridge._reconcile_loop = idle
bridge._baseline_loop = idle
uvicorn.run(bridge.app, host="127.0.0.1", port=${Number(values['py-port'])}, log_level="warning")
`

const NEST_SERVER = `
import { FastifyAdapter } from '@nestjs/platform-fastify'
import { Test } from '@nestjs/testing'
import { configureApp } from './dist/app.js'
import { AppModule } from './dist/appModule.js'
import { BackgroundLoops } from './dist/loops.js'

const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
  .overrideProvider(BackgroundLoops)
  .useValue({})
  .compile()
const app = configureApp(
  moduleRef.createNestApplication(new FastifyAdapter(), { rawBody: true }),
)
await app.listen({ port: ${Number(values['nest-port'])}, host: '127.0.0.1' })
`

const children = [
  spawn(resolve(ROOT, values.python), ['-c', PYTHON_SERVER], {
    cwd: resolve(ROOT, 'apps/stripe-bridge'),
    env,
    stdio: 'inherit',
  }),
  spawn('node', ['--input-type=module', '-e', NEST_SERVER], {
    cwd: resolve(ROOT, 'apps/stripe-bridge-nest'),
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
    const up = await fetch(`${base}/version`).then(
      (response) => response.ok,
      () => false,
    )
    if (up) {
      return
    }
    await sleep(250)
  }
  throw new Error(`${base} never answered /version`)
}
await Promise.all([waitFor(PY), waitFor(NEST)])

// --- comparison ---------------------------------------------------------------

const normalise = (value) => {
  if (Array.isArray(value)) {
    return value.map(normalise)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([name, item]) => [name, normalise(item)]),
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
    signal: AbortSignal.timeout(120_000),
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
  return { path, auth, python, problems: [...statusDiff, ...bodyDiff] }
}

const inSequence = (checks) =>
  checks.reduce(async (done, check) => [...(await done), await compare(check)], Promise.resolve([]))

// --- the grid -------------------------------------------------------------------

const fixed = await inSequence([
  // Status only: release.sh bumps the port's marker, and the Python bridge's
  // __version__ stays where it was when the marker moved.
  { path: '/version', auth: false, bodyMatters: false },
  { path: '/stripe/version', auth: false, bodyMatters: false },
  { path: '/admin/members', auth: false },
  { path: '/admin/members' },
  { path: '/stripe/admin/members' },
  { path: '/admin/events' },
  { path: '/admin/member', bodyMatters: false },
  { path: '/admin/member?email=nobody%40nowhere.invalid' },
  { path: '/admin/plex-access', bodyMatters: false },
  { path: '/admin/notes', bodyMatters: false },
  { path: '/nowhere' },
])

// Routes keyed by the addresses the data itself names: a spread of members,
// including customers who never joined and anyone paying under a second
// address.
const listed = fixed.find(({ path, auth }) => path === '/admin/members' && auth)?.python
if (!Array.isArray(listed?.body)) {
  console.error(`python /admin/members answered ${listed?.status}: ${JSON.stringify(listed?.body)}`)
  stop()
  process.exit(1)
}
const members = listed.body
const emails = [
  ...new Set(
    members.flatMap((member) => [member.email, member.stripe_email]).filter((email) => !!email),
  ),
].slice(0, Number(values.members))

const perMember = await inSequence(
  emails.flatMap((email) => {
    const query = `email=${encodeURIComponent(email)}`
    return [
      { path: `/admin/member?${query}` },
      { path: `/admin/events?${query}` },
      { path: `/admin/notes?${query}` },
      { path: `/admin/plex-access?${query}` },
      { path: `/stripe/admin/member?${query}` },
    ]
  }),
)

const all = [...fixed, ...perMember]
const failed = all.filter(({ problems }) => problems.length > 0)
failed.forEach(({ path, problems }) => {
  console.log(`\n✗ ${path}`)
  problems.slice(0, 20).forEach((problem) => console.log(`    ${problem}`))
  if (problems.length > 20) {
    console.log(`    ... and ${problems.length - 20} more`)
  }
})
console.log(`\n${all.length - failed.length}/${all.length} routes match (${emails.length} members)`)
stop()
process.exit(failed.length === 0 ? 0 : 1)
