#!/usr/bin/env node
import { assignCohort, rankLeads } from './classify.mjs'
import { optOut, readLedger, recordContact, stateDir, suppression, writeLedger } from './ledger.mjs'
import { fetchAll, requireConfig } from './sources.mjs'

const PLAYS = ['declined', 'lapsed']
const SELECTABLE = [...PLAYS, 'uninvited']

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
  if (optOutAt >= 0 && !argv[optOutAt + 1]) {
    throw new Error('--opt-out requires an email address')
  }
  if (recordAt >= 0) {
    if (!argv[recordAt + 1]) {
      throw new Error('--record requires an email address')
    }
    if (!argv[recordAt + 2]) {
      throw new Error('--record requires a play')
    }
    const recordPlay = argv[recordAt + 2]
    if (!PLAYS.includes(recordPlay)) {
      throw new Error(`unknown play "${recordPlay}", expected one of ${PLAYS.join(', ')}`)
    }
  }
  const consumed = new Set(
    [
      playFlag,
      '--all',
      '--json',
      '--no-store',
      recordAt >= 0 ? ['--record', argv[recordAt + 1], argv[recordAt + 2]] : [],
      optOutAt >= 0 ? ['--opt-out', argv[optOutAt + 1]] : [],
    ].flat().filter(Boolean),
  )
  const unknown = argv.filter((arg) => !consumed.has(arg))
  if (unknown.length) {
    throw new Error(`unknown flag ${unknown.join(' ')}`)
  }
  return {
    play,
    all: argv.includes('--all'),
    json: argv.includes('--json'),
    skipStore: argv.includes('--no-store'),
    record: recordAt >= 0 ? { email: argv[recordAt + 1], play: argv[recordAt + 2] } : null,
    optOut: optOutAt >= 0 ? argv[optOutAt + 1] : null,
  }
}

const lastEventFor = ({ member }) => member.expires ?? member.invitedAt ?? null

export const buildReport = ({ members, ledger, now, play }) => {
  /**
   * Assign every member a cohort, then split each sellable play into leads and
   * excluded. Excluded people are kept and counted: a thin week has to read as
   * "everyone is in cooldown", never as "there is nobody to contact".
   */
  const assigned = members.map((member) => ({
    ...member,
    cohort: assignCohort({ member, now }),
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
      leads: rankLeads({ leads: withSuppression.filter((entry) => !entry.suppressed).map((entry) => entry.member) }),
      excluded: withSuppression
        .filter((entry) => entry.suppressed)
        .map((entry) => ({ email: entry.member.email, ...entry.suppressed })),
    }
  })
  return {
    plays,
    triage: assigned.filter(
      (member) => member.cohort === 'triage-billing' || member.cohort === 'uninvited',
    ),
  }
}

export const renderReport = ({ report }) => {
  /** Human readable report; the agent consumes --json instead. */
  const blocks = report.plays.map((entry) => {
    const leads = entry.leads
      .map((lead) => `          ${lead.email}  ${lead.cohort}  tier=${lead.tier ?? 'none'}  last=${(lead.lastEventAt ?? 'unknown').slice(0, 10)}`)
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
  const triage = report.triage.length
    ? `TRIAGE  ${report.triage.length} routed to member-triage: ${report.triage.map((m) => `${m.email} (${m.cohort})`).join(', ')}`
    : ''
  const total = report.plays.reduce((acc, entry) => acc + entry.contactable, 0)
  const footer = total ? '' : 'Nothing to send. Every cohort is empty or fully suppressed.'
  return [...blocks, triage, footer].filter(Boolean).join('\n')
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
  const report = buildReport({ members, ledger: readLedger({ dir }), now: Date.now(), play: args.play })
  process.stdout.write(
    args.json
      ? `${JSON.stringify({ ...report, sources }, null, 2)}\n`
      : `sources: ${Object.entries(sources).map(([k, v]) => `${k} ${v}`).join(', ')}\n\n${renderReport({ report })}\n`,
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
