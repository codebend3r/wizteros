import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildRules,
  dedupe,
  isPrivateIp,
  parseArgs,
  parseHistory,
  readAllowlist,
  readDenylist,
  renderReport,
  scanPath,
  scanText,
  scanTree,
} from './scan.mjs'

// Fixtures are assembled at runtime so this file never contains a leak-shaped
// literal of its own for the scanner to trip over.
const ip = (...octets) => octets.join('.')
const unix = (...parts) => ['', ...parts, ''].join('/')
const at = (local, domain) => `${local}@${domain}`
const FAKE_KEY = `${'sk'}_${'live'}_${'A'.repeat(24)}`

const rules = buildRules({ denylist: [] })
const hits = ({ text, ruleSet = rules }) => scanText({ path: 'x.md', text, rules: ruleSet })
const matches = ({ text, rule }) =>
  hits({ text })
    .filter((hit) => hit.rule === rule)
    .map((hit) => hit.match)

test('flags each private range and nothing public or documentary', () => {
  const flagged = [
    ip(192, 168, 1, 20),
    ip(10, 0, 0, 7),
    ip(172, 16, 4, 4),
    ip(172, 31, 255, 1),
    ip(100, 64, 0, 9),
    ip(169, 254, 1, 1),
  ]
  const clean = [
    ip(127, 0, 0, 1),
    ip(0, 0, 0, 0),
    ip(192, 0, 2, 5),
    ip(198, 51, 100, 7),
    ip(203, 0, 113, 9),
    ip(8, 8, 8, 8),
    ip(172, 32, 0, 1),
    ip(100, 128, 0, 1),
  ]
  assert.deepEqual(matches({ text: flagged.join(' '), rule: 'private-ip' }), flagged)
  assert.deepEqual(matches({ text: clean.join(' '), rule: 'private-ip' }), [])
})

test('does not read a version string as an address', () => {
  assert.deepEqual(matches({ text: 'plex 1.43.4.10903-e5521bd8c', rule: 'private-ip' }), [])
  assert.deepEqual(matches({ text: 'v10.2.3.4.5', rule: 'private-ip' }), [])
  assert.equal(isPrivateIp({ ip: ip(10, 1, 2, 3) }), true)
})

test('flags a tailnet host but not its placeholder', () => {
  const tailnet = `${'tail'}${'abc123'}.ts.net`
  assert.deepEqual(matches({ text: `https://box.${tailnet}/x`, rule: 'tailnet-name' }), [tailnet])
  assert.deepEqual(matches({ text: 'https://<node>.<tailnet>.ts.net/x', rule: 'tailnet-name' }), [])
})

test('flags a real email, allows documentation domains and git remotes', () => {
  assert.deepEqual(matches({ text: at('someone', 'gmail.com'), rule: 'email' }), [
    at('someone', 'gmail.com'),
  ])
  const allowed = [
    at('a', 'example.com'),
    at('a', 'sub.example.org'),
    at('git', 'github.com'),
    at('1234+x', 'users.noreply.github.com'),
    at('me', 'host.invalid'),
    '@nestjs/common',
    "from '@/config.js'",
    'bun@1.4.2',
  ]
  assert.deepEqual(matches({ text: allowed.join(' '), rule: 'email' }), [])
})

test('accepts allowlisted placeholder addresses and the .example tld, nothing near them', () => {
  const withList = buildRules({
    allowlist: { domains: ['x.com'], emails: ['alice@gmail.com'] },
  })
  const run = (text) => hits({ text, ruleSet: withList }).map((hit) => hit.match)
  assert.deepEqual(
    run(`${at('anyone', 'x.com')} ${at('Alice', 'gmail.com')} ${at('a', 'relay.example')}`),
    [],
  )
  assert.deepEqual(run(at('bob', 'gmail.com')), [at('bob', 'gmail.com')])
  assert.deepEqual(run(at('anyone', 'ax.com')), [at('anyone', 'ax.com')])
})

test('the committed allowlist is valid and names only placeholder domains', () => {
  const list = readAllowlist()
  assert.ok(Array.isArray(list.domains) && Array.isArray(list.emails))
  assert.ok(list.emails.every((email) => email.includes('@')))
})

test('flags a home path, allows tilde and CI users', () => {
  assert.deepEqual(matches({ text: unix('Users', 'alice', 'repo'), rule: 'home-path' }), [
    unix('Users', 'alice'),
  ])
  assert.deepEqual(matches({ text: unix('home', 'runner', 'work'), rule: 'home-path' }), [])
  assert.deepEqual(matches({ text: '~/Developer/repo', rule: 'home-path' }), [])
})

test('flags a secret but only ever reports it masked', () => {
  const found = hits({ text: `STRIPE=${FAKE_KEY}` }).filter((hit) => hit.rule === 'secret')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'critical')
  assert.ok(!found[0].match.includes(FAKE_KEY))
  assert.match(found[0].match, /^sk_liv…\(\d+ chars\)$/)
  assert.deepEqual(matches({ text: 'STRIPE_API_KEY=sk_live_replace_me', rule: 'secret' }), [])
})

test('reports 1-based line numbers', () => {
  const found = scanText({ path: 'a.md', text: `ok\nok\n${ip(10, 1, 1, 1)}`, rules })
  assert.equal(found[0].line, 3)
})

test('skips a line carrying the ignore marker', () => {
  assert.deepEqual(hits({ text: `${ip(10, 1, 1, 1)} security-audit:ignore` }), [])
})

test('matches denylist entries case-insensitively', () => {
  const withList = buildRules({ denylist: ['Hidden Name'] })
  const found = hits({ text: 'written by hidden name today', ruleSet: withList })
  assert.deepEqual(
    found.map((hit) => hit.rule),
    ['denylist'],
  )
  assert.equal(found[0].match, 'Hidden Name')
})

test('flags secret-shaped paths but not the example templates', () => {
  const flagged = [
    '.env',
    'apps/x/.env.local',
    'id_ed25519',
    'a/b.pem',
    'data/bridge.db',
    'fleet-monitor-ssh/known_hosts',
  ]
  const clean = ['.env.example', 'apps/x/.env.example', 'id_ed25519.pub', 'src/env.ts', 'README.md']
  assert.deepEqual(
    flagged.filter((path) => scanPath({ path }).length > 0),
    flagged,
  )
  assert.deepEqual(
    clean.filter((path) => scanPath({ path }).length > 0),
    [],
  )
})

test('parseHistory keeps only added lines, with commit and file', () => {
  const log = [
    '@@commit aaaa1111',
    'diff --git a/f.md b/f.md',
    '--- a/f.md',
    '+++ b/f.md',
    '@@ -1 +1 @@',
    '-old line',
    '+new line',
    '@@commit bbbb2222',
    '--- a/g.md',
    '+++ /dev/null',
    '-deleted line',
    '@@commit cccc3333',
    '+++ b/h.md',
    '+another',
  ].join('\n')
  assert.deepEqual(parseHistory({ log }), [
    { commit: 'aaaa1111', path: 'f.md', text: 'new line' },
    { commit: 'cccc3333', path: 'h.md', text: 'another' },
  ])
})

const finding = (commit) => ({ rule: 'email', match: 'x', commit })

test('dedupe keeps the first finding per rule and match', () => {
  assert.deepEqual(
    dedupe({ findings: [finding('new'), finding('old')] }).map((f) => f.commit),
    ['new'],
  )
})

test('parseArgs accepts the flags and rejects anything else', () => {
  assert.deepEqual(parseArgs({ argv: ['--history', '--json'] }), {
    history: true,
    json: true,
    all: false,
  })
  assert.throws(() => parseArgs({ argv: ['--fix'] }), /unknown argument --fix/)
})

test('renderReport says clean, and caps a long rule unless asked for all', () => {
  assert.match(renderReport({ findings: [], rules, scope: 'tree' }), /clean/)
  const many = Array.from({ length: 40 }, (_, index) => ({
    rule: 'email',
    severity: 'high',
    path: `f${index}.md`,
    line: 1,
    match: 'x',
  }))
  const capped = renderReport({ findings: many, rules, scope: 'tree' })
  assert.match(capped, /15 more/)
  assert.doesNotMatch(
    renderReport({ findings: many, rules, all: true, scope: 'tree' }),
    /more \(--all\)/,
  )
})

test('readDenylist merges the env value with the gitignored file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-deny-'))
  try {
    writeFileSync(join(dir, '.security-audit-denylist'), '# note\nfirst\n\nsecond\n')
    assert.deepEqual(
      readDenylist({ cwd: dir, env: { SECURITY_AUDIT_DENYLIST: 'third, fourth' } }),
      ['first', 'second', 'third', 'fourth'],
    )
    assert.deepEqual(readDenylist({ cwd: dir, env: {} }), ['first', 'second'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('scanTree reads what git would publish and nothing it ignores', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-tree-'))
  // Hooks can export GIT_INDEX_FILE/GIT_DIR. A cwd alone does not isolate Git:
  // fixture staging must never write into the invoking repository's index.
  const originalEnv = process.env
  process.env = Object.fromEntries(
    Object.entries(originalEnv).filter(([key]) => !key.startsWith('GIT_')),
  )
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })
    git('init', '-q')
    mkdirSync(join(dir, 'docs'))
    writeFileSync(join(dir, '.gitignore'), 'ignored.md\n')
    writeFileSync(join(dir, 'docs', 'leak.md'), `host ${ip(192, 168, 9, 9)}\n`)
    writeFileSync(join(dir, 'docs', 'fine.md'), `host ${ip(192, 0, 2, 9)}\n`)
    writeFileSync(join(dir, 'ignored.md'), `host ${ip(192, 168, 9, 10)}\n`)
    writeFileSync(join(dir, 'bun.lock'), `${ip(10, 9, 9, 9)}\n`)
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, ...Buffer.from(ip(10, 8, 8, 8))]))
    writeFileSync(join(dir, '.env'), 'X=1\n')
    git('add', '-f', 'docs', '.gitignore', 'bun.lock', 'blob.bin', '.env')
    const found = scanTree({ cwd: dir, rules })
    assert.deepEqual(found.map((hit) => `${hit.rule}:${hit.path}`).toSorted(), [
      'private-ip:docs/leak.md',
      'sensitive-file:.env',
    ])
  } finally {
    process.env = originalEnv
    rmSync(dir, { recursive: true, force: true })
  }
})
