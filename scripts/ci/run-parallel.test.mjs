import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./run-parallel.sh', import.meta.url))

const runParallel = (tasks) => {
  const dir = mkdtempSync(join(tmpdir(), 'run-parallel-'))
  const summary = join(dir, 'summary.md')
  try {
    writeFileSync(summary, '')
    const started = Date.now()
    const result = spawnSync('bash', [script, ...tasks], {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
      timeout: 10000,
    })
    assert.ifError(result.error)
    const elapsed = Date.now() - started
    return {
      status: result.status,
      stdout: result.stdout,
      summary: readFileSync(summary, 'utf8'),
      elapsed,
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('tasks run concurrently, not one after another', () => {
  const { status, elapsed } = runParallel(['a=sleep 1', 'b=sleep 1', 'c=sleep 1'])
  assert.equal(status, 0)
  assert.ok(elapsed < 2500, `three 1s tasks took ${elapsed}ms`)
})

test('every log is printed whole in its own group, in argument order', () => {
  const { status, stdout, summary } = runParallel([
    'slow=sleep 0.3; echo first-out; echo first-err >&2',
    'fast=echo second-out',
  ])
  assert.equal(status, 0)
  assert.equal(
    stdout,
    [
      '::group::✅ passed  slow',
      'first-out',
      'first-err',
      '::endgroup::',
      '::group::✅ passed  fast',
      'second-out',
      '::endgroup::',
      '',
    ].join('\n'),
  )
  assert.equal(summary, '- ✅ passed: slow\n- ✅ passed: fast\n')
})

test('one failure fails the run but every other task still finishes', () => {
  const { status, stdout, summary } = runParallel([
    'broken=exit 3',
    'healthy=sleep 0.2; echo still-ran',
  ])
  assert.equal(status, 1)
  assert.ok(stdout.includes('::group::❌ failed  broken'))
  assert.ok(stdout.includes('::error title=broken::'))
  assert.ok(stdout.includes('still-ran'))
  assert.equal(summary, '- ❌ failed: broken\n- ✅ passed: healthy\n')
})

test('a command keeps any further equals signs', () => {
  const { status, stdout } = runParallel(['env=FOO=bar; echo "$FOO"'])
  assert.equal(status, 0)
  assert.ok(stdout.includes('\nbar\n'))
})

test('malformed or missing tasks are rejected before anything runs', () => {
  assert.equal(runParallel(['no-separator']).status, 2)
  assert.equal(runParallel([]).status, 2)
})

// The temp log directory is removed even when a task fails.
test('logs do not outlive the run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-parallel-tmp-'))
  try {
    const result = spawnSync('bash', [script, 'x=exit 1'], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: dir, GITHUB_STEP_SUMMARY: '/dev/null' },
    })
    assert.equal(result.status, 1)
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
