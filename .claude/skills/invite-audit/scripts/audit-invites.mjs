#!/usr/bin/env node
// Read-only audit of the Wizarr invitation set, on one screen.
//
//   Baseline    the four per-tier links the bridge mints and rotates at 03:00
//   Member      per-checkout invites, listed but never judged against the rules
//   Strays      unlimited invites the bridge did not mint — reported, not touched
//
// STRICTLY READ-ONLY. Rotation lives in the bridge (stripe_bridge/baseline.py)
// and runs unattended; this script only looks. The SQLite handle is opened
// mode=ro and every HTTP call is a GET, so nothing here can change live state.
//
// The checks are written against the same rules as tiers.py but deliberately
// re-derived here rather than imported, so a bug in the Python is not mirrored
// by the thing meant to catch it — the same reasoning as e2e-tiers.mjs.
//
// Run: node --env-file=<env file> .claude/skills/invite-audit/scripts/audit-invites.mjs
// `.env` is gitignored, so whether one exists is a property of the working copy,
// not of the repo: use it when it is there, otherwise pass whichever file holds
// the values locally, or export them for the command.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const { WIZARR_BASE_URL, WIZARR_API_KEY } = process.env

const WIZARR = (WIZARR_BASE_URL ?? '').replace(/\/+$/, '')
const NAS_HOST = process.env.WZ_NAS_HOST ?? 'crivas@192.168.50.2'
const DOCKER = '/usr/local/bin/docker' // the NOPASSWD sudoers rule matches this literal path
const SERVICE = 'stripe-bridge'
const HOUR = 3_600_000

// Mirrors tiers.py: every tier resolves to this one server, and the others are
// retired from signups. A baseline invite naming any other server is a finding.
const SHARE_SERVER = 'Meleys'
const TIERS = ['bronze', 'gold', 'silver', 'youth']
// A baseline is stale once it is older than one rotation plus a margin: past
// that the 03:00 loop has demonstrably not run.
const STALE_AFTER_HOURS = 26

if (!WIZARR || !WIZARR_API_KEY) {
  console.error('Missing WIZARR_BASE_URL / WIZARR_API_KEY')
  process.exit(2)
}

const say = (line = '') => console.log(line)
const bullet = (line) => say(`      ${line}`)
const heading = (title) => say(`\n── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`)

const wz = async (path) => {
  const r = await fetch(`${WIZARR}${path}`, { headers: { 'X-API-Key': WIZARR_API_KEY } })
  if (!r.ok) throw new Error(`GET ${path} -> ${r.status}`)
  return r.json()
}

// Wizarr emits naive ISO strings that are really UTC; without the suffix the
// JS parser would read them as local time and skew every age by the offset.
const asDate = (value) => {
  if (!value) return null
  const stamped = /[Zz]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`
  const parsed = new Date(stamped)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

const ago = (date, now) => {
  const hours = (now - date) / HOUR
  if (hours < 1) return `${Math.round(hours * 60)}m ago`
  if (hours < 48) return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

// ─── The NAS: which codes the bridge minted ──────────────────────────────────

const ssh = async (command) => {
  const { stdout } = await execFileAsync(
    'ssh',
    ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', NAS_HOST, command],
    { maxBuffer: 8 * 1024 * 1024 },
  )
  return stdout
}

// SELECT-only, against a connection opened mode=ro so the process could not
// write even by accident. Shipped base64 so the Python survives ssh re-parsing
// the remote command through the login shell.
const storeProgram = `
import json, os, sqlite3
db = sqlite3.connect("file:" + os.environ.get("MAP_DB_PATH", "/data/bridge.db") + "?mode=ro", uri=True)
db.row_factory = sqlite3.Row
try:
    rows = [dict(r) for r in db.execute(
        "SELECT code, tier, created_at, expires_at FROM baseline_invites")]
except sqlite3.OperationalError:
    rows = None  # table absent: bridge predates the baseline rotation
print(json.dumps({"baselines": rows}))
`

const readStore = async () => {
  const encoded = Buffer.from(storeProgram, 'utf8').toString('base64')
  const out = await ssh(
    `sudo -n ${DOCKER} exec ${SERVICE} python3 -c ` +
      `"import base64;exec(base64.b64decode('${encoded}'))"`,
  )
  return JSON.parse(out).baselines
}

// ─── Report ──────────────────────────────────────────────────────────────────

const main = async () => {
  const now = new Date()
  say('Invitation audit')
  say(`  wizarr ${WIZARR}   nas ${NAS_HOST}   ${now.toISOString().slice(0, 16)}Z`)

  const invitations = await wz('/api/invitations').then((d) => d.invitations ?? [])

  const owned = await readStore().catch((cause) => {
    say(`\n  bridge store unavailable: ${cause.message}`)
    return undefined
  })

  const ownedByCode = new Map((owned ?? []).map((row) => [row.code, row]))
  const findings = []

  heading('Baseline invites (bridge-minted, one set per tier)')
  if (owned === undefined) {
    bullet('unavailable — cannot tell baseline from stray, so nothing below is conclusive')
  } else if (owned === null) {
    bullet('baseline_invites table absent: the deployed bridge predates the rotation')
    findings.push('Bridge on the NAS has no baseline_invites table — deploy the rotation')
  } else if (owned.length === 0) {
    bullet('none recorded yet — the 03:00 rotation has not run since deploy')
    findings.push('No baseline invites recorded; rotation has not run yet')
  }

  const liveByTier = new Map(TIERS.map((tier) => [tier, []]))
  for (const inv of invitations) {
    const row = ownedByCode.get(inv.code)
    if (!row) continue
    const expires = asDate(inv.expires)
    if (expires && expires <= now) continue
    liveByTier.get(row.tier)?.push({ inv, row, expires })
  }

  for (const tier of TIERS) {
    const live = liveByTier.get(tier) ?? []
    if (live.length === 0) {
      if (owned?.length) findings.push(`Tier "${tier}" has no live baseline invite`)
      say(`  ${tier.padEnd(8)} none live`)
      continue
    }
    for (const { inv, row, expires } of live) {
      const servers = [...(inv.server_names ?? [])].sort()
      const created = asDate(row.created_at)
      const scopeOk = servers.length === 1 && servers[0] === SHARE_SERVER
      const flags = []
      if (!expires) {
        flags.push('NO EXPIRY')
        findings.push(`Baseline ${inv.code} (${tier}) never expires`)
      }
      if (!scopeOk) {
        flags.push(`SCOPE ${servers.join(',')}`)
        findings.push(
          `Baseline ${inv.code} (${tier}) grants ${servers.join(', ')} — only ${SHARE_SERVER} is allowed`,
        )
      }
      say(
        `  ${tier.padEnd(8)} ${inv.code}  expires ${inv.expires?.slice(0, 16) ?? 'NEVER'}` +
          `  minted ${created ? ago(created, now) : 'unknown'}` +
          (flags.length ? `  [${flags.join('; ')}]` : ''),
      )
    }
    const newest = live
      .map(({ row }) => asDate(row.created_at))
      .filter(Boolean)
      .sort((a, b) => b - a)[0]
    if (newest && (now - newest) / HOUR > STALE_AFTER_HOURS) {
      findings.push(
        `Tier "${tier}" newest baseline is ${ago(newest, now)} — the 03:00 rotation has stopped`,
      )
    }
  }

  heading('Strays (unlimited, not minted by the bridge)')
  const strays = invitations.filter((inv) => inv.unlimited && !ownedByCode.has(inv.code))
  if (strays.length === 0) {
    bullet('none')
  }
  for (const inv of strays) {
    const servers = [...(inv.server_names ?? [])].sort().join(', ')
    say(
      `  ${inv.code}  expires ${inv.expires?.slice(0, 16) ?? 'NEVER'}` +
        `  created ${inv.created?.slice(0, 10) ?? '?'}  servers ${servers || 'none'}`,
    )
    findings.push(
      `Stray unlimited invite ${inv.code}${inv.expires ? '' : ' (never expires)'} — review by hand`,
    )
  }

  heading('Member invites (per-checkout, not governed by the baseline rules)')
  const members = invitations.filter((inv) => !inv.unlimited && !ownedByCode.has(inv.code))
  if (members.length === 0) bullet('none')
  for (const inv of members) {
    say(
      `  ${inv.code}  ${inv.used_by ? `used by ${inv.used_by}` : 'unused'}` +
        `  expires ${inv.expires?.slice(0, 16) ?? 'NEVER'}`,
    )
  }

  heading('Findings')
  if (findings.length === 0) {
    bullet('none — the baseline set matches the rules')
  }
  for (const finding of findings) say(`  ✗ ${finding}`)
  say('\nRunbook: .claude/skills/invite-audit/SKILL.md maps each finding to one remedy.')
  process.exitCode = findings.length ? 1 : 0
}

main().catch((cause) => {
  console.error(`audit failed: ${cause.message}`)
  process.exit(2)
})
