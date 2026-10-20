import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./nx-cloud.sh', import.meta.url))

const overLimit = [
  'This Nx Cloud organization has been disabled due to exceeding the FREE plan.',
  'Your organization can be re-enabled immediately by an organization admin',
  'upgrading to the Team plan. (code: 401)',
].join('\n')

// Messages Nx 23.2 printed, with exit 0, against a bad token and an unreachable API.
const softFailures = [
  'NX   Nx Cloud encountered some problems\nInvalid Credentials (Personal Access Token): An Nx Cloud ID was not provided but is required.',
  "NX   Nx Cloud wasn't able to store artifacts to the remote cache.",
  'NX   No existing Nx Cloud client and failed to download new version\nNx Cloud was not used for this command.',
]

// Run the real script against a fake bunx whose output and exit code depend on
// whether NX_NO_CLOUD turned Nx Cloud off for that call.
const runScript = ({ args, token = 'token', noCloud, cloud = {}, local = {} }) => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-cloud-'))
  const envFile = join(dir, 'github-env')
  const calls = join(dir, 'calls.jsonl')
  const mock = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
const off = process.env.NX_NO_CLOUD === 'true'
appendFileSync(process.env.MODE_LOG, JSON.stringify({ args: process.argv.slice(2), noCloud: process.env.NX_NO_CLOUD }) + '\\n')
process.stdout.write(off ? process.env.LOCAL_OUTPUT : process.env.CLOUD_OUTPUT)
process.exit(Number(off ? process.env.LOCAL_EXIT : process.env.CLOUD_EXIT))
`
  try {
    writeFileSync(envFile, '')
    writeFileSync(calls, '')
    writeFileSync(join(dir, 'bunx'), mock, { mode: 0o755 })
    const env = {
      ...process.env,
      PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
      GITHUB_ENV: envFile,
      GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      NX_CLOUD_ACCESS_TOKEN: token,
      MODE_LOG: calls,
      CLOUD_OUTPUT: cloud.output ?? 'Successfully ran target',
      CLOUD_EXIT: String(cloud.exit ?? 0),
      LOCAL_OUTPUT: local.output ?? 'Successfully ran target',
      LOCAL_EXIT: String(local.exit ?? 0),
    }
    if (noCloud === undefined) {
      delete env.NX_NO_CLOUD
    } else {
      env.NX_NO_CLOUD = noCloud
    }
    const result = spawnSync('bash', [script, ...args], { encoding: 'utf8', env, timeout: 5000 })
    assert.ifError(result.error)
    return {
      status: result.status,
      stdout: result.stdout,
      env: readFileSync(envFile, 'utf8'),
      calls: readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const probe = (options = {}) => runScript({ args: ['probe'], ...options })
const runNx = (options = {}) =>
  runScript({ args: ['run', 'bunx', 'nx', 'affected', '-t', 'test'], ...options })

test('probe uses Nx Cloud when it takes the run cleanly', () => {
  const result = probe()
  assert.equal(result.status, 0)
  assert.equal(result.env, 'NX_NO_CLOUD=false\n')
  assert.equal(result.calls.length, 1)
  assert.equal(result.calls[0].noCloud, 'false')
  assert.ok(result.calls[0].args.includes('@wizteros/server-common:format:check'))
})

test('probe skips Nx Cloud without a token', () => {
  const result = probe({ token: '' })
  assert.equal(result.status, 0)
  assert.equal(result.env, 'NX_NO_CLOUD=true\n')
  assert.equal(result.calls.length, 0)
})

test('probe falls back once the plan limit is hit, whatever the exit code', () => {
  ;[0, 1].forEach((exit) => {
    const result = probe({ cloud: { output: overLimit, exit } })
    assert.equal(result.status, 0)
    assert.equal(result.env, 'NX_NO_CLOUD=true\n')
    assert.match(result.stdout, /::warning title=Nx Cloud off::Nx Cloud refused or failed/)
  })
})

test('probe falls back on the Nx Cloud errors Nx reports with exit 0', () => {
  softFailures.forEach((output) => {
    const result = probe({ cloud: { output } })
    assert.equal(result.env, 'NX_NO_CLOUD=true\n', output)
  })
})

test('probe falls back when it fails for any other reason', () => {
  const result = probe({ cloud: { output: 'getaddrinfo ENOTFOUND', exit: 1 } })
  assert.equal(result.status, 0)
  assert.equal(result.env, 'NX_NO_CLOUD=true\n')
  assert.match(result.stdout, /probe exited 1/)
})

test('run passes a clean cloud run straight through', () => {
  const result = runNx({ noCloud: 'false' })
  assert.equal(result.status, 0)
  assert.equal(result.calls.length, 1)
})

test('run reruns without Nx Cloud when it fails mid-run', () => {
  const result = runNx({ noCloud: 'false', cloud: { output: overLimit, exit: 1 } })
  assert.equal(result.status, 0)
  assert.deepEqual(
    result.calls.map(({ noCloud }) => noCloud),
    ['false', 'true'],
  )
  assert.deepEqual(result.calls[1].args, ['nx', 'affected', '-t', 'test'])
  assert.match(result.stdout, /::warning title=Nx Cloud dropped::/)
})

test('run still fails when the rerun without Nx Cloud fails', () => {
  const result = runNx({
    noCloud: 'false',
    cloud: { output: overLimit, exit: 1 },
    local: { output: 'test failed', exit: 1 },
  })
  assert.equal(result.status, 1)
  assert.equal(result.calls.length, 2)
})

test('run does not rerun a task failure with no Nx Cloud trouble', () => {
  const result = runNx({ noCloud: 'false', cloud: { output: 'test failed', exit: 1 } })
  assert.equal(result.status, 1)
  assert.equal(result.calls.length, 1)
})

test('run does not rerun when Nx Cloud was already off', () => {
  const result = runNx({ noCloud: 'true', local: { output: overLimit, exit: 1 } })
  assert.equal(result.status, 1)
  assert.equal(result.calls.length, 1)
})

test('rejects an unknown mode', () => {
  const result = runScript({ args: ['nope'] })
  assert.equal(result.status, 2)
})
