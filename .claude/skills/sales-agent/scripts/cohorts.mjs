#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { WARMTH, assignCohort, bulkInviteDates, rankLeads } from './classify.mjs'
import { optOut, readLedger, recordContact, stateDir, suppression, writeLedger } from './ledger.mjs'
import { fetchAll, requireConfig } from './sources.mjs'

const PLAYS = Object.keys(WARMTH).sort((a, b) => WARMTH[b] - WARMTH[a])
const SELECTABLE = [...PLAYS, 'uninvited']

const requireValue = ({ value, flag, what }) => {
  /**
   * Validate one flag argument. A missing value, and a value that is itself
   * flag shaped, are both rejected: `--opt-out --json` would otherwise swallow
   * the next flag as its value and write a permanent opt-out keyed "--json",
   * reporting success while the real opt-out never happened.
   */
  if (!value) {
    throw new Error(`${flag} requires ${what}`)
  }
  if (value.startsWith('--')) {
    throw new Error(`${flag} requires ${what}, got the flag "${value}"`)
  }
  return value
}

export const parseArgs = ({ argv }) => {
  /**
   * Parse flags, rejecting anything unrecognized rather than guessing. There
   * are no mutating flags to guess at: --record and --opt-out are the only
   * writes and both name their target explicitly.
   */
  const recordAt = argv.indexOf('--record')
  const optOutAt = argv.indexOf('--opt-out')
  const playFlag = argv.find((arg) => arg.startsWith('--play='))
  const play = playFlag ? playFlag.slice('--play='.length) : null
  if (play && !SELECTABLE.includes(play)) {
    throw new Error(`unknown play "${play}", expected one of ${SELECTABLE.join(', ')}`)
  }
  if (optOutAt >= 0) {
    requireValue({ value: argv[optOutAt + 1], flag: '--opt-out', what: 'an email address' })
  }
  if (recordAt >= 0) {
    requireValue({ value: argv[recordAt + 1], flag: '--record', what: 'an email address' })
    const recordPlay = requireValue({ value: argv[recordAt + 2], flag: '--record', what: 'a play' })
    if (!PLAYS.includes(recordPlay)) {
      throw new Error(`unknown play "${recordPlay}", expected one of ${PLAYS.join(', ')}`)
    }
  }
  const consumed = new Set(
    [
      playFlag,
      '--json',
      '--no-store',
      recordAt >= 0 ? ['--record', argv[recordAt + 1], argv[recordAt + 2]] : [],
      optOutAt >= 0 ? ['--opt-out', argv[optOutAt + 1]] : [],
    ]
      .flat()
      .filter(Boolean),
  )
  const unknown = argv.filter((arg) => !consumed.has(arg))
  if (unknown.length) {
    throw new Error(`unknown flag ${unknown.join(' ')}`)
  }
  return {
    play,
    json: argv.includes('--json'),
    skipStore: argv.includes('--no-store'),
    record: recordAt >= 0 ? { email: argv[recordAt + 1], play: argv[recordAt + 2] } : null,
    optOut: optOutAt >= 0 ? argv[optOutAt + 1] : null,
  }
}

const lastEventFor = ({ member }) => member.expires ?? member.invitedAt ?? null

const localPart = (email) => email.toLowerCase().split('@')[0]?.split('+')[0] ?? ''
const domainPart = (email) => email.toLowerCase().split('@')[1] ?? ''

const isSelfAddress = ({ email, selfAddresses }) =>
  /**
   * True when email matches one of the operator's own addresses on the local
   * part before any + tag, lowercased, plus the domain. This catches a
   * plus-tagged test variant of the operator's address (`name+anything@domain`)
   * alongside the bare address itself.
   */
  selfAddresses.some(
    (self) => localPart(email) === localPart(self) && domainPart(email) === domainPart(self),
  )

export const resolveSelf = ({ envValue = null, gitEmail = null } = {}) => {
  /**
   * Resolve the operator's own address list and where it came from, so the
   * filter is reported and never silent. WZ_SALES_SELF (comma separated)
   * wins when set and non-empty. Failing that, gitEmail (the caller's
   * `git config user.email` read) is used. Failing that, the filter is off
   * and nothing is treated as a self address.
   */
  const fromEnv = (envValue ?? '')
    .split(',')
    .map((addr) => addr.trim())
    .filter(Boolean)
  if (fromEnv.length) {
    return { source: 'WZ_SALES_SELF', addresses: fromEnv }
  }
  if (gitEmail) {
    return { source: 'git config user.email', addresses: [gitEmail] }
  }
  return { source: 'none', addresses: [] }
}

export const filterSelf = ({ members, selfAddresses }) =>
  /**
   * Split members into those kept and those filtered as the operator's own
   * test addresses, so a filtered address is reported, never silently
   * dropped from the run.
   */
  members.reduce(
    (acc, member) =>
      isSelfAddress({ email: member.email, selfAddresses })
        ? { ...acc, filtered: [...acc.filtered, member] }
        : { ...acc, kept: [...acc.kept, member] },
    { kept: [], filtered: [] },
  )

export const buildReport = ({ members, ledger, now, play, selfAddresses = [] }) => {
  /**
   * Filter out the operator's own test addresses, detect this run's bulk
   * invite dates from the members that remain, then assign every member a
   * cohort and split each sellable play into leads and excluded. Excluded
   * people are kept and counted: a thin week has to read as "everyone is in
   * cooldown", never as "there is nobody to contact".
   *
   * Plays come back in warmth order, from WARMTH: lapsed, then backfill, then
   * declined. Leads inside one play are ranked by recency.
   *
   * The detected bulk dates are returned alongside the plays. A backfill block
   * is meaningless without them: the drafting angle depends on which migration
   * a member was stamped by, and more than one date can qualify.
   */
  const { kept, filtered } = filterSelf({ members, selfAddresses })
  const bulkDates = bulkInviteDates({ members: kept })
  const assigned = kept.map((member) => ({
    ...member,
    cohort: assignCohort({ member, now, bulkDates }),
    lastEventAt: lastEventFor({ member }),
  }))
  const wanted = play && PLAYS.includes(play) ? [play] : play ? [] : PLAYS
  const plays = wanted.map((name) => {
    const cohort = assigned.filter((member) => member.cohort === name)
    const withSuppression = cohort.map((member) => ({
      member,
      suppressed: suppression({ record: ledger[member.email], play: name, now }),
    }))
    return {
      play: name,
      cohortSize: cohort.length,
      contactable: withSuppression.filter((entry) => !entry.suppressed).length,
      leads: rankLeads({
        leads: withSuppression.filter((entry) => !entry.suppressed).map((entry) => entry.member),
      }),
      excluded: withSuppression
        .filter((entry) => entry.suppressed)
        .map((entry) => ({ email: entry.member.email, ...entry.suppressed })),
    }
  })
  return {
    plays,
    bulkDates: [...bulkDates].sort(),
    triage: assigned.filter(
      (member) => member.cohort === 'triage-billing' || member.cohort === 'uninvited',
    ),
    selfFiltered: filtered.map((member) => member.email),
  }
}

export const renderReport = ({ report }) => {
  /** Human readable report; the agent consumes --json instead. */
  const blocks = report.plays.map((entry) => {
    const leads = entry.leads
      .map(
        (lead) =>
          `          ${lead.email}  ${lead.cohort}  tier=${lead.tier ?? 'none'}  last=${(lead.lastEventAt ?? 'unknown').slice(0, 10)}`,
      )
      .join('\n')
    const excluded = entry.excluded.map((item) => `${item.email} (${item.reason})`).join(', ')
    return [
      `PLAY  ${entry.play}`,
      `      ${entry.contactable} contactable of ${entry.cohortSize} in cohort`,
      '',
      leads || '          none',
      '',
      `EXCLUDED  ${excluded || 'none'}`,
      '',
    ].join('\n')
  })
  const bulkDates = report.bulkDates?.length
    ? `BULK DATES  ${report.bulkDates.length} bulk invite date(s) behind the backfill play: ${report.bulkDates.join(', ')}`
    : ''
  const triage = report.triage.length
    ? `TRIAGE  ${report.triage.length} routed to member-triage: ${report.triage.map((m) => `${m.email} (${m.cohort})`).join(', ')}`
    : ''
  const selfFiltered = report.selfFiltered?.length
    ? `SELF-FILTERED  ${report.selfFiltered.length} operator test address(es) excluded: ${report.selfFiltered.join(', ')}`
    : ''
  const total = report.plays.reduce((acc, entry) => acc + entry.contactable, 0)
  const footer =
    total || report.triage.length
      ? ''
      : 'Nothing to send. Every cohort is empty or fully suppressed.'
  return [...blocks, bulkDates, triage, selfFiltered, footer].filter(Boolean).join('\n')
}

const gitUserEmail = () => {
  /** Best-effort read of `git config user.email`; null on any failure or empty value. */
  try {
    const value = execFileSync('git', ['config', 'user.email'], { encoding: 'utf8' }).trim()
    return value || null
  } catch {
    return null
  }
}

const main = async () => {
  const args = parseArgs({ argv: process.argv.slice(2) })
  const dir = stateDir({})
  if (args.optOut) {
    writeLedger({ dir, ledger: optOut({ ledger: readLedger({ dir }), email: args.optOut }) })
    process.stdout.write(`opted out ${args.optOut}\n`)
    return 0
  }
  if (args.record) {
    const ledger = recordContact({
      ledger: readLedger({ dir }),
      email: args.record.email,
      play: args.record.play,
      now: Date.now(),
    })
    writeLedger({ dir, ledger })
    process.stdout.write(`recorded ${args.record.email} / ${args.record.play}\n`)
    return 0
  }
  const config = requireConfig({})
  const { members, sources } = await fetchAll({ config, skipStore: args.skipStore })
  const self = resolveSelf({
    envValue: process.env.WZ_SALES_SELF ?? null,
    gitEmail: gitUserEmail(),
  })
  const report = buildReport({
    members,
    ledger: readLedger({ dir }),
    now: Date.now(),
    play: args.play,
    selfAddresses: self.addresses,
  })
  const allSources = {
    ...sources,
    self: self.addresses.length
      ? `${self.source} (${report.selfFiltered.length} filtered)`
      : `${self.source} (no filter)`,
  }
  process.stdout.write(
    args.json
      ? `${JSON.stringify({ ...report, sources: allSources }, null, 2)}\n`
      : `sources: ${Object.entries(allSources)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}\n\n${renderReport({ report })}\n`,
  )
  return 0
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exit(2)
    })
}
