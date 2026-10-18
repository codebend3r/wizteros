import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./smoke-container.sh', import.meta.url))

// Exercise the real shell control flow without a Docker daemon or HTTP server.
const runSmoke = ({ app, env = {} }) => {
  const dir = mkdtempSync(join(tmpdir(), 'container-smoke-'))
  const log = join(dir, 'calls.jsonl')
  const mock = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'
const command = basename(process.argv[1])
const args = process.argv.slice(2)
appendFileSync(process.env.SMOKE_LOG, JSON.stringify({ command, args }) + '\\n')
if (command === 'curl') {
  if (args.includes('--fail')) {
    process.exit(process.env.SMOKE_READY_FAIL === 'true' ? 22 : 0)
  }
  const url = args.at(-1)
  const status = url.includes('/webhook') ? '400'
    : /\\/(admin|fleet|plays)\\b/.test(url) ? '401' : '200'
  process.stdout.write(process.env.SMOKE_HTTP_STATUS ?? status)
}
`
  const commands = ['docker', 'curl']
  try {
    writeFileSync(log, '')
    commands.forEach((command) => {
      writeFileSync(join(dir, command), mock, { mode: 0o755 })
    })
    const result = spawnSync('bash', [script, app], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...env,
        PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
        SMOKE_LOG: log,
      },
      timeout: 5000,
    })
    assert.ifError(result.error)
    const calls = readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    return { status: result.status, calls }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const dockerCalls = (calls) => calls.filter(({ command }) => command === 'docker')

test('bridge checks both webhook prefixes and cleans up on success', () => {
  const { status, calls } = runSmoke({ app: 'stripe-bridge' })
  assert.equal(status, 0)
  const urls = new Set(
    calls.filter(({ command }) => command === 'curl').map(({ args }) => args.at(-1)),
  )
  assert.ok(urls.has('http://127.0.0.1:8000/webhook'))
  assert.ok(urls.has('http://127.0.0.1:8000/stripe/webhook'))
  assert.ok(urls.has('http://127.0.0.1:8000/admin/members'))
  const readiness = calls.find(({ command }) => command === 'curl')
  assert.ok(readiness.args.includes('--retry-all-errors'))
  assert.ok(readiness.args.includes('--retry-max-time'))
  assert.ok(readiness.args.includes('--max-time'))
  assert.deepEqual(dockerCalls(calls).at(-1).args, ['rm', '-f', 'stripe-bridge-sanity'])
  assert.ok(!dockerCalls(calls).some(({ args }) => args[0] === 'logs'))
})

test('fleet checks auth, the collector artifact and SSH without starting probes', () => {
  const { status, calls } = runSmoke({ app: 'fleet-monitor' })
  assert.equal(status, 0)
  const commands = dockerCalls(calls).map(({ args }) => args)
  assert.ok(commands.some((args) => args.includes('FM_SSH_USER=sanity')))
  assert.ok(
    commands.some(
      (args) => args.join(' ') === 'exec fleet-monitor-sanity test -s dist/collectorMain.js',
    ),
  )
  assert.ok(commands.some((args) => args.join(' ') === 'exec fleet-monitor-sanity ssh -V'))
  assert.ok(!commands.some((args) => args.includes('node')))
  assert.deepEqual(commands.at(-1), ['rm', '-f', 'fleet-monitor-sanity'])
})

test('a failed route prints logs, cleans up and preserves failure', () => {
  const { status, calls } = runSmoke({ app: 'stripe-bridge', env: { SMOKE_HTTP_STATUS: '500' } })
  assert.notEqual(status, 0)
  assert.deepEqual(
    dockerCalls(calls)
      .slice(-2)
      .map(({ args }) => args),
    [
      ['logs', 'stripe-bridge-sanity'],
      ['rm', '-f', 'stripe-bridge-sanity'],
    ],
  )
})

test('a readiness failure fails closed and cleans up', () => {
  const { status, calls } = runSmoke({ app: 'fleet-monitor', env: { SMOKE_READY_FAIL: 'true' } })
  assert.notEqual(status, 0)
  assert.equal(calls.filter(({ command }) => command === 'curl').length, 1)
  assert.deepEqual(
    dockerCalls(calls)
      .slice(-2)
      .map(({ args }) => args),
    [
      ['logs', 'fleet-monitor-sanity'],
      ['rm', '-f', 'fleet-monitor-sanity'],
    ],
  )
})

test('an unknown app is rejected before any container is launched', () => {
  const { status, calls } = runSmoke({ app: 'unknown' })
  assert.notEqual(status, 0)
  assert.deepEqual(calls, [])
})
