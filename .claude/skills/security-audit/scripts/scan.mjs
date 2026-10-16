#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Scans what this repo would publish for personal and infrastructure details:
// private addresses, tailnet names, real emails, home paths, secrets, secret-
// shaped files, plus anything on a private denylist. Read-only. The repo is
// public, so a hit here is a leak, not a style issue.
//
//   node .claude/skills/security-audit/scripts/scan.mjs [--history] [--json] [--all]
//
// A line carrying the marker below is skipped, for the rare string that has to
// look like a leak (the scanner's own fixtures, a documented example).

const IGNORE_MARKER = 'security-audit:ignore'
const MAX_BYTES = 2_000_000
const PER_RULE_LIMIT = 25
const DENYLIST_FILE = '.security-audit-denylist'

const LOCKFILE = /(^|\/)(bun\.lockb?|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/

const OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)'
// Not glued to more digits or dots, so a version such as 1.43.4.10903 is not read as an address.
const IPV4 = new RegExp(`(?<![\\d.])${OCTET}(?:\\.${OCTET}){3}(?!\\.?\\d)`, 'g')

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const EXAMPLE_DOMAIN =
  /(^|\.)(example(\.(com|org|net))?|invalid|test|localhost|local|users\.noreply\.github\.com|noreply\.github\.com|github\.com)$/i

const HOME_PATH = /\/(?:Users|home)\/([A-Za-z0-9._-]+)\//g
const GENERIC_HOME_NAMES = new Set([
  'runner',
  'node',
  'user',
  'you',
  'me',
  'name',
  'username',
  'example',
  'app',
  'shared',
  'x',
])

const TAILNET = /[A-Za-z0-9-]+\.ts\.net\b/g

const SECRET_PATTERNS = [
  /\b[sr]k_live_[A-Za-z0-9]{10,}/g,
  /\bwhsec_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
]

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]+)?$/,
  /\.(pem|key|p12|pfx|sqlite3?|db|db-wal|db-shm)$/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/,
  /(^|\/)fleet-monitor-ssh\//,
]

/** True for the address ranges that only exist on a private network or tailnet. */
export const isPrivateIp = ({ ip }) => {
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  )
}

/** A secret shown as its first characters and length, so a report never re-leaks it. */
const mask = ({ value }) => `${value.slice(0, 6)}…(${value.length} chars)`

/**
 * The rules that read one line of text. Each returns the matches it objects
 * to. A denylist entry is matched case-insensitively as a plain substring; the
 * allowlist ({ domains, emails }) names placeholder addresses that are not people.
 */
export const buildRules = ({ denylist = [], allowlist = {} } = {}) => [
  {
    id: 'private-ip',
    severity: 'high',
    hint: 'Move the address to .env (FM_HOST_IPS for the fleet) and read it from there; use a documentation range (192.0.2.x) in tests and a placeholder like <meleys-ip> in docs.',
    find: ({ line }) => (line.match(IPV4) ?? []).filter((ip) => isPrivateIp({ ip })),
  },
  {
    id: 'tailnet-name',
    severity: 'high',
    hint: 'Use <node>.<tailnet>.ts.net in docs and read the real base URL from an env var.',
    find: ({ line }) => line.match(TAILNET) ?? [],
  },
  {
    id: 'email',
    severity: 'high',
    hint: 'Use an @example.com address in tests and docs; real addresses belong in .env or the live store.',
    find: ({ line }) =>
      (line.match(EMAIL) ?? []).filter((email) => {
        const domain = email.split('@')[1]
        return (
          !EXAMPLE_DOMAIN.test(domain) &&
          !(allowlist.domains ?? []).includes(domain.toLowerCase()) &&
          !(allowlist.emails ?? []).includes(email.toLowerCase())
        )
      }),
  },
  {
    id: 'home-path',
    severity: 'medium',
    hint: 'Write ~/… instead of an absolute home directory.',
    find: ({ line }) =>
      [...line.matchAll(HOME_PATH)]
        .filter((hit) => !GENERIC_HOME_NAMES.has(hit[1].toLowerCase()))
        .map((hit) => hit[0]),
  },
  {
    id: 'secret',
    severity: 'critical',
    hint: 'Rotate the credential first, then remove it. Removing it from the tree does not un-leak it.',
    find: ({ line }) =>
      SECRET_PATTERNS.flatMap((pattern) => line.match(pattern) ?? []).map((value) =>
        mask({ value }),
      ),
  },
  {
    id: 'denylist',
    severity: 'high',
    hint: `Matched a private entry from ${DENYLIST_FILE} or SECURITY_AUDIT_DENYLIST.`,
    find: ({ line }) =>
      denylist.filter((entry) => line.toLowerCase().includes(entry.toLowerCase())),
  },
]

/** Findings for one file's text, one per rule match, with 1-based line numbers. */
export const scanText = ({ path, text, rules }) =>
  text.split('\n').flatMap((line, index) =>
    line.includes(IGNORE_MARKER)
      ? []
      : rules.flatMap((rule) =>
          rule.find({ line }).map((match) => ({
            rule: rule.id,
            severity: rule.severity,
            path,
            line: index + 1,
            match,
          })),
        ),
  )

/** Findings for a path that should never be published, whatever it holds. */
export const scanPath = ({ path }) =>
  SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path))
    ? [
        {
          rule: 'sensitive-file',
          severity: 'critical',
          path,
          line: 0,
          match: path,
        },
      ]
    : []

/** True when the first bytes hold a NUL, the cheap tell for a binary file. */
const isBinary = ({ buffer }) => buffer.subarray(0, 8000).includes(0)

/** Every file git would publish: tracked, plus untracked and not ignored. */
export const publishableFiles = ({ cwd }) =>
  execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((path) => !!path && existsSync(join(cwd, path)))

/** Scan the working tree: every publishable file's name, then its text. */
export const scanTree = ({ cwd, rules }) =>
  publishableFiles({ cwd }).flatMap((path) => {
    const pathFindings = scanPath({ path })
    if (LOCKFILE.test(path)) {
      return pathFindings
    }
    const buffer = readFileSync(join(cwd, path))
    return buffer.length > MAX_BYTES || isBinary({ buffer })
      ? pathFindings
      : [...pathFindings, ...scanText({ path, text: buffer.toString('utf8'), rules })]
  })

/**
 * Turn `git log -p -U0` output into the lines history ever added, each with
 * its commit and file. The log must be requested with `--format=@@commit %H`.
 */
export const parseHistory = ({ log }) =>
  log.split('\n').reduce(
    (state, line) => {
      if (line.startsWith('@@commit ')) {
        return { ...state, commit: line.slice('@@commit '.length).trim(), path: '' }
      }
      if (line.startsWith('+++ ')) {
        const target = line.slice(4)
        return { ...state, path: target.startsWith('b/') ? target.slice(2) : '' }
      }
      return line.startsWith('+') && !!state.path
        ? {
            ...state,
            added: [
              ...state.added,
              { commit: state.commit, path: state.path, text: line.slice(1) },
            ],
          }
        : state
    },
    { commit: '', path: '', added: [] },
  ).added

/**
 * Scan every line any commit on any branch ever added, reporting each distinct
 * rule and match once, at the newest commit that carries it.
 */
export const scanHistory = ({ cwd, rules }) => {
  const log = execFileSync(
    'git',
    ['log', '--all', '-p', '-U0', '--no-color', '--no-ext-diff', '--format=@@commit %H'],
    { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 },
  )
  const paths = execFileSync('git', ['log', '--all', '--name-only', '--format='], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean)
  const lineFindings = parseHistory({ log })
    .filter(({ path }) => !LOCKFILE.test(path))
    .flatMap(({ commit, path, text }) =>
      scanText({ path, text, rules }).map((finding) => ({ ...finding, line: 0, commit })),
    )
  const pathFindings = [...new Set(paths)].flatMap((path) => scanPath({ path }))
  return dedupe({ findings: [...lineFindings, ...pathFindings] })
}

/** One finding per rule and match, the first one seen. */
export const dedupe = ({ findings }) =>
  findings.filter(
    (finding, index) =>
      findings.findIndex(
        (other) => other.rule === finding.rule && other.match === finding.match,
      ) === index,
  )

/** The denylist: SECURITY_AUDIT_DENYLIST (comma separated) plus the gitignored file, one entry per line. */
export const readDenylist = ({ cwd, env = process.env }) => {
  const file = join(cwd, DENYLIST_FILE)
  const fromFile = existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !!line && !line.startsWith('#'))
    : []
  const fromEnv = (env.SECURITY_AUDIT_DENYLIST ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return [...fromFile, ...fromEnv]
}

/** The committed list of placeholder addresses, or an empty one when the file is absent. */
export const readAllowlist = ({
  file = fileURLToPath(new URL('./allowlist.json', import.meta.url)),
} = {}) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})

const SEVERITY_ORDER = ['critical', 'high', 'medium']

/** Where a finding lives: commit and file for history, file and line for the tree. */
const where = ({ hit }) =>
  hit.commit
    ? `${hit.commit.slice(0, 8)}  ${hit.path}`
    : `${hit.path}${hit.line ? `:${hit.line}` : ''}`

/** A grouped plain-text report, worst rule first, capped per rule unless `all`. */
export const renderReport = ({ findings, rules, all = false, scope }) => {
  if (findings.length === 0) {
    return `security-audit (${scope}): clean`
  }
  const byRule = Object.groupBy(findings, ({ rule }) => rule)
  const hints = Object.fromEntries(rules.map(({ id, hint }) => [id, hint]))
  hints['sensitive-file'] = 'Remove it from the repo, rotate anything it held, and gitignore it.'
  const sections = Object.entries(byRule)
    .toSorted(
      ([, a], [, b]) =>
        SEVERITY_ORDER.indexOf(a[0].severity) - SEVERITY_ORDER.indexOf(b[0].severity),
    )
    .map(([rule, hits]) => {
      const shown = all ? hits : hits.slice(0, PER_RULE_LIMIT)
      return [
        `${rule} [${hits[0].severity}] ${hits.length} hit${hits.length === 1 ? '' : 's'}: ${hints[rule] ?? ''}`,
        ...shown.map((hit) => `  ${where({ hit })}  ${hit.match}`),
        ...(shown.length < hits.length ? [`  … ${hits.length - shown.length} more (--all)`] : []),
      ].join('\n')
    })
  return [`security-audit (${scope}): ${findings.length} finding(s)`, '', ...sections].join('\n\n')
}

const FLAGS = new Set(['--history', '--json', '--all'])

/** Reject an unknown flag rather than guess what it was meant to do. */
export const parseArgs = ({ argv }) => {
  const unknown = argv.filter((arg) => !FLAGS.has(arg))
  if (unknown.length > 0) {
    throw new Error(`unknown argument ${unknown.join(', ')} (expected --history, --json, --all)`)
  }
  return {
    history: argv.includes('--history'),
    json: argv.includes('--json'),
    all: argv.includes('--all'),
  }
}

/** Run the scan in the repo this script lives in; exit 1 when anything is found. */
export const main = () => {
  const args = parseArgs({ argv: process.argv.slice(2) })
  const cwd = fileURLToPath(new URL('../../../../', import.meta.url))
  const rules = buildRules({ denylist: readDenylist({ cwd }), allowlist: readAllowlist() })
  const scope = args.history ? 'tree + history' : 'tree'
  const findings = [
    ...scanTree({ cwd, rules }),
    ...(args.history ? scanHistory({ cwd, rules }) : []),
  ]
  process.stdout.write(
    args.json
      ? `${JSON.stringify({ scope, findings }, null, 2)}\n`
      : `${renderReport({ findings, rules, all: args.all, scope })}\n`,
  )
  return findings.length === 0 ? 0 : 1
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // exitCode, not exit(): exiting at once can cut a large report short on a pipe
  try {
    process.exitCode = main()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 2
  }
}
