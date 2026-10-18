import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./deploy-nas.sh', import.meta.url))
const root = fileURLToPath(new URL('../../../../', import.meta.url))

const put = (path, body) => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, body)
}

const fixture = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wz-deploy-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  const nas = join(dir, 'nas')
  const bin = join(dir, 'bin')
  ;[repo, nas, bin].forEach((path) => mkdirSync(path))
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' }).toString().trim()
  git('init', '-b', 'main')
  git('config', 'core.hooksPath', '/dev/null')
  git('config', 'user.email', 'fixture@invalid.test')
  git('config', 'user.name', 'Deploy fixture')
  put(
    join(repo, '.gitignore'),
    '.env\n**/data/\n*-data/\ntautulli-config/\nfleet-monitor-ssh/\nnode_modules/\ndist/\n',
  )
  put(join(repo, 'package.json'), '{"name":"fixture","private":true}')
  put(join(repo, 'apps/stripe-bridge/package.json'), '{"version":"0.4.3"}')
  put(join(repo, 'apps/stripe-bridge/src/tiers.ts'), 'committed tier rules\n')
  git('add', '.')
  git('commit', '-m', 'fixture')
  const remote = join(dir, 'origin.git')
  execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' })
  git('remote', 'add', 'origin', remote)
  git('push', '-u', 'origin', 'main')
  const statePaths = [
    '.env',
    'apps/stripe-bridge/data/bridge.db',
    'stripe-bridge-data/bridge.db',
    'wizarr-data/wizarr.db',
    'tautulli-config/config.ini',
    'fleet-monitor-data/fleet.db',
    'fleet-monitor-ssh/id_ed25519',
  ]
  statePaths.forEach((path) => {
    put(join(repo, path), 'LOCAL PRIVATE DATA')
    put(join(nas, path), 'LIVE NAS STATE')
  })
  put(join(repo, 'node_modules/private.txt'), 'local dependency')
  put(join(repo, 'dist/private.txt'), 'local build')
  put(
    join(bin, 'ssh'),
    `#!/usr/bin/env bash
set -euo pipefail
command="\${@: -1}"
printf '%s\\n' "$command" >> "$FAKE_COMMANDS"
case "$command" in
  true) ;;
  'tar -xf '*)
    [ "$FAKE_FAIL" != archive ] || exit 1
    exec sh -c "$command" ;;
  *md5sum*|'cat '*|'printf '*) exec sh -c "$command" ;;
  *'inspect -f'*)
    case "$command" in *'.State.Status'*) echo running ;; esac ;;
  *'compose up'*) ;;
  *'/admin/members'*) printf 401 ;;
  *'/version'*) printf '{"version":"0.4.3"}' ;;
  *'logs --tail'*) printf '%s\\n' "$FAKE_LOGS" ;;
  *) echo "unexpected fake SSH command: $command" >&2; exit 99 ;;
esac
`,
  )
  put(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n')
  execFileSync('chmod', ['+x', join(bin, 'ssh'), join(bin, 'sleep')])
  const run = ({ flags = [], logs = '', fail = '' } = {}) =>
    spawnSync('bash', [script, ...flags], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        WZ_REPO: repo,
        WZ_NAS_HOST: 'fixture-only',
        WZ_NAS_PATH: nas,
        FAKE_LOGS: logs,
        FAKE_FAIL: fail,
        FAKE_COMMANDS: join(dir, 'commands'),
      },
    })
  return {
    repo,
    nas,
    git,
    run,
    statePaths,
    commands: () => readFileSync(join(dir, 'commands'), 'utf8'),
  }
}

test('deploy transfers committed files only and preserves NAS state', (t) => {
  const f = fixture(t)
  const result = f.run({ flags: ['--skip-verify'] })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(
    readFileSync(join(f.nas, 'apps/stripe-bridge/src/tiers.ts'), 'utf8'),
    'committed tier rules\n',
  )
  f.statePaths.forEach((path) =>
    assert.equal(readFileSync(join(f.nas, path), 'utf8'), 'LIVE NAS STATE'),
  )
  assert.equal(existsSync(join(f.nas, 'node_modules')), false)
  assert.equal(existsSync(join(f.nas, 'dist')), false)
  assert.equal(readFileSync(join(f.nas, '.deployed-sha'), 'utf8'), f.git('rev-parse', 'HEAD'))
  assert.match(result.stdout, /tiers: +unverified/)
})

test('dirty source and feature branches stop before SSH', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.repo, 'package.json'), '{}')
  assert.match(f.run().stderr, /working tree is dirty/)
  f.git('checkout', '--', 'package.json')
  f.git('checkout', '-b', 'feature')
  assert.match(f.run().stderr, /not main/)
  assert.throws(f.commands)
})

test('an archive transfer failure stops before rebuilding or recording a deploy', (t) => {
  const f = fixture(t)
  const result = f.run({ fail: 'archive' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /git-archive sync failed/)
  assert.doesNotMatch(f.commands(), /compose up/)
  assert.equal(existsSync(join(f.nas, '.deployed-sha')), false)
})

test('unpushed main stops before SSH', (t) => {
  const f = fixture(t)
  writeFileSync(join(f.repo, 'package.json'), '{}')
  f.git('commit', '-am', 'unpushed change')
  assert.match(f.run().stderr, /main is out of sync/)
  assert.throws(f.commands)
})

test('dry run reports archive transport without syncing or rebuilding', (t) => {
  const f = fixture(t)
  const result = f.run({ flags: ['--dry-run'] })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /git archive HEAD over SSH/)
  assert.doesNotMatch(f.commands(), /tar -xf|compose up/)
})

test('Wizarr read failures are unverified, never a tier alarm', (t) => {
  const f = fixture(t)
  const result = f.run({ logs: 'tier scope check: could not read libraries from Wizarr' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.doesNotMatch(result.stdout, /TIER SCOPE ALARM/)
  assert.match(result.stdout, /tiers: +unverified/)
})

test('real tier marker is reported as an alarm', (t) => {
  const f = fixture(t)
  const result = f.run({
    logs: '[TIER_SCOPE_ALARM] tier scope check: youth -> no libraries resolved',
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /TIER SCOPE ALARM/)
  assert.match(result.stdout, /tiers: +⚠ ALARM/)
})

test('deploy alias has one implementation and all diagnostic scripts use the stable marker', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['deploy:nas'], 'bash .claude/skills/deploy-nas/scripts/deploy-nas.sh')
  assert.equal(existsSync(join(root, 'scripts/deploy-nas.sh')), false)
  ;[
    'deploy-nas/scripts/deploy-nas.sh',
    'stack-health/scripts/stack-health.sh',
    'member-triage/scripts/gather-member.mjs',
  ].forEach((path) => {
    const source = readFileSync(join(root, '.claude/skills', path), 'utf8')
    assert.ok(source.includes('TIER_SCOPE_ALARM'), path)
  })
})
