import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  bridgeOps,
  nasHost,
  shellQuote,
  ssh,
  SSH_OPTIONS,
  stripeGet,
  stripeList,
  wizarrGet,
} from './ops.mjs'

// A hook can export GIT_DIR and friends; nothing spawned here needs Git, and a
// child must never inherit a repository it could write to.
// The variables nas-host.sh would read from the environment ahead of its env
// file are dropped too, so the file under test is what answers.
const cleanEnv = ({ drop = [] } = {}) =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('GIT_') && !drop.includes(name),
    ),
  )

// A fetch that answers from a queue and records every request it was handed.
const fakeFetch = (answers) => {
  const calls = []
  const queue = [...answers]
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), init })
    const { status = 200, body = {} } = queue.shift() ?? {}
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }
  return { fetch, calls }
}

test('nasHost prefers WZ_NAS_HOST and never runs the script then', () => {
  const host = nasHost({
    env: { WZ_NAS_HOST: 'ops@192.0.2.9' },
    run: () => assert.fail('nas-host.sh should not run'),
  })
  assert.equal(host, 'ops@192.0.2.9')
})

test('nasHost falls back to scripts/nas-host.sh for meleys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ops-nas-host-'))
  try {
    const envFile = join(dir, '.env')
    writeFileSync(envFile, 'FM_SSH_USER=fleet\nFM_HOST_IPS=192.0.2.2,192.0.2.3\n')
    const env = {
      ...cleanEnv({ drop: ['WZ_NAS_HOST', 'FM_SSH_USER', 'FM_HOST_IPS'] }),
      WZ_ENV_FILE: envFile,
    }
    assert.equal(nasHost({ env }), 'fleet@192.0.2.2')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ssh passes the command as one argv element after the batch options', async () => {
  const calls = []
  const out = await ssh({
    command: "sudo -n docker ps --format '{{.Names}}'",
    host: 'ops@192.0.2.9',
    run: async (file, args, options) => {
      calls.push({ file, args, options })
      return { stdout: 'stripe-bridge\n' }
    },
  })
  assert.equal(out, 'stripe-bridge\n')
  assert.deepEqual(calls[0].file, 'ssh')
  assert.deepEqual(calls[0].args, [
    ...SSH_OPTIONS,
    'ops@192.0.2.9',
    "sudo -n docker ps --format '{{.Names}}'",
  ])
  assert.ok(calls[0].args.includes('BatchMode=yes'))
})

test('stripeList walks has_more with starting_after until the last page', async () => {
  const { fetch, calls } = fakeFetch([
    { body: { data: [{ id: 'sub_1' }, { id: 'sub_2' }], has_more: true } },
    { body: { data: [{ id: 'sub_3' }], has_more: false } },
  ])
  const rows = await stripeList({
    key: 'sk_test_x',
    path: '/subscriptions',
    params: [
      ['status', 'all'],
      ['expand[]', 'data.customer'],
    ],
    fetch,
  })
  assert.deepEqual(
    rows.map((row) => row.id),
    ['sub_1', 'sub_2', 'sub_3'],
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url.pathname, '/v1/subscriptions')
  assert.equal(calls[0].url.searchParams.get('limit'), '100')
  assert.equal(calls[0].url.searchParams.get('expand[]'), 'data.customer')
  assert.equal(calls[0].url.searchParams.get('starting_after'), null)
  assert.equal(calls[1].url.searchParams.get('starting_after'), 'sub_2')
  assert.equal(calls[1].url.searchParams.get('status'), 'all')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk_test_x')
})

test('stripeList stops on an empty page even if Stripe claims more', async () => {
  const { fetch, calls } = fakeFetch([
    { body: { data: [{ id: 'cus_1' }], has_more: true } },
    { body: { data: [], has_more: true } },
  ])
  const rows = await stripeList({
    key: 'k',
    path: 'customers',
    params: { email: 'a@x.com' },
    fetch,
  })
  assert.deepEqual(
    rows.map((row) => row.id),
    ['cus_1'],
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url.searchParams.get('email'), 'a@x.com')
})

test('a failed Stripe read reports its status and never the key', async () => {
  const { fetch } = fakeFetch([{ status: 404, body: { error: { message: 'sk_test_secret' } } }])
  await assert.rejects(
    stripeGet({ key: 'sk_test_secret', path: 'customers/cus_gone', fetch }),
    (error) => {
      assert.equal(error.status, 404)
      assert.equal(error.message, 'Stripe GET /v1/customers/cus_gone responded 404')
      assert.ok(!error.message.includes('sk_test_secret'))
      return true
    },
  )
})

test('wizarrGet sends the API key, trims the base and reports a failure by status', async () => {
  const { fetch, calls } = fakeFetch([{ body: { users: [{ id: 1 }] } }, { status: 503 }])
  const body = await wizarrGet({
    base: 'http://wizarr.invalid/',
    key: 'wk',
    path: '/api/users',
    fetch,
  })
  assert.deepEqual(body, { users: [{ id: 1 }] })
  assert.equal(calls[0].url.href, 'http://wizarr.invalid/api/users')
  assert.equal(calls[0].init.headers['X-API-Key'], 'wk')
  assert.ok(calls[0].init.signal instanceof AbortSignal)
  await assert.rejects(
    wizarrGet({ base: 'http://wizarr.invalid', key: 'wk', path: '/api/invitations', fetch }),
    { message: 'Wizarr GET /api/invitations responded 503', status: 503 },
  )
})

test('shellQuote leaves nothing for a shell to expand', () => {
  assert.equal(shellQuote("o'brien@x.com"), "'o'\\''brien@x.com'")
  assert.equal(shellQuote('$(rm -rf /)'), "'$(rm -rf /)'")
})

test('bridgeOps runs the read-only CLI in the bridge container and parses its answer', async () => {
  const commands = []
  const answer = await bridgeOps({
    args: ['member', "o'brien@x.com"],
    run: async ({ command }) => {
      commands.push(command)
      return '{"email":"o\'brien@x.com","customer":null}\n'
    },
  })
  assert.deepEqual(answer, { email: "o'brien@x.com", customer: null })
  assert.deepEqual(commands, [
    "sudo -n /usr/local/bin/docker exec stripe-bridge node dist/opsCli.js 'member' 'o'\\''brien@x.com'",
  ])
})
