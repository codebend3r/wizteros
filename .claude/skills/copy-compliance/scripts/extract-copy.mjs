#!/usr/bin/env node
/**
 * extract-copy.mjs
 *
 * Pulls user-facing copy out of the wizteros surfaces and flags any line that
 * carries content-promise language. Read-only: it never writes, never edits,
 * never calls the network. Node built-ins only, no dependencies.
 *
 * Usage (from anywhere):
 *   node .claude/skills/copy-compliance/scripts/extract-copy.mjs
 *   node .claude/skills/copy-compliance/scripts/extract-copy.mjs --all
 *
 * Honest about what it is: this is regex-level extraction, not an AST parse.
 * It is deliberately over-inclusive, because a false positive costs one second
 * of reading and a silent miss costs a TOS violation. Known blind spots, all
 * of which a human has to cover by reading:
 *
 *   - Copy assembled at runtime (concatenated fragments, values from env, text
 *     that arrives from the bridge API) is invisible here.
 *   - The risk-term list is fixed. Novel phrasing that promises content without
 *     using a listed word will not match. Adding terms is cheap, do it.
 *   - Multi-line template literals in TS are read line by line, so a risk term
 *     split across a line break will not match.
 *   - HTML and JSX attribute text is only seen when it is also a quoted string
 *     literal, which covers TSX but not raw attributes in index.html.
 *   - THE BIGGEST GAP: Stripe product names, product descriptions, and Payment
 *     Link page copy live in the Stripe dashboard, not in this repo. They are
 *     the most exposed copy in the whole system and this script cannot see a
 *     single character of them. Check them by hand.
 *
 * Exit code is 0 whether or not anything is flagged. Hits are candidates for a
 * human to judge, not build failures. Only a real error exits 1.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// scripts/ -> copy-compliance/ -> skills/ -> .claude/ -> repo root, so the
// script works from any clone or worktree. WZ_REPO overrides it.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = process.env.WZ_REPO ?? resolve(SCRIPT_DIR, '..', '..', '..', '..')

// Directories walked in full. Test files are skipped: assertions quote copy,
// they do not ship it.
const SCAN_DIRS = ['apps/admin-portal/src/pages', 'apps/admin-portal/src/components']

// Files scanned individually. site.config.ts is not under pages/ or components/
// but holds every tier name, price, summary, and feature label, so leaving it
// out would make this whole script decorative.
const SCAN_FILES = [
  'apps/admin-portal/index.html',
  'apps/admin-portal/src/App.tsx',
  'apps/admin-portal/src/site.config.ts',
  // Not under pages/ or components/, but it derives the annual cadence label
  // and the savings line that the tier card prints next to a price.
  'apps/admin-portal/src/lib/billing.ts',
  'apps/stripe-bridge/stripe_bridge/email_template.py',
  'apps/stripe-bridge/stripe_bridge/mailer.py',
]

// Where the framing rule is absolute. Everything else scanned is admin-only,
// reported separately so a hit there reads as low priority, not as a pass.
const PAYMENT_SURFACES = [
  'apps/admin-portal/index.html',
  'apps/admin-portal/src/App.tsx',
  'apps/admin-portal/src/site.config.ts',
  'apps/admin-portal/src/lib/billing.ts',
  'apps/admin-portal/src/components/Hero/',
  'apps/admin-portal/src/components/Pricing/',
  // Renders inside Pricing, so its copy sits directly against a price.
  'apps/admin-portal/src/components/BillingToggle/',
  'apps/admin-portal/src/components/Support/',
  'apps/admin-portal/src/components/Footer/',
  'apps/stripe-bridge/stripe_bridge/email_template.py',
  'apps/stripe-bridge/stripe_bridge/mailer.py',
]

const SCANNED_EXTENSIONS = ['.tsx', '.ts', '.html', '.py']

// Single words that describe what a member gets to consume rather than what
// they are paying to keep running. Grouped only to make the list easy to grow.
const RISK_WORDS = [
  // content nouns
  'movie',
  'movies',
  'show',
  'shows',
  'series',
  'title',
  'titles',
  'episode',
  'episodes',
  'film',
  'films',
  'library',
  'libraries',
  'catalog',
  'catalogue',
  'content',
  // consumption verbs
  'watch',
  'watching',
  'stream',
  'streaming',
  'binge',
  // quality claims, which are claims about the content itself
  '4K',
  'HD',
  'UHD',
  '1080p',
  '2160p',
  // scope promises
  'unlimited',
  'everything',
  'curated',
]

// Phrases that claim a relationship with somebody else's product. The label
// reported is the text that actually matched.
const RISK_PHRASES = [
  /\byour\s+(?:plex|netflix|hulu|disney\+?|hbo|max|prime\s+video)\b/gi,
  /\b(?:plex|netflix|hulu|disney\+?|hbo|max)\s+(?:subscription|membership|plan|account|access)\b/gi,
  /\bsubscri(?:be|ption)\s+to\s+plex\b/gi,
]

const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const WORD_MATCHERS = RISK_WORDS.map((word) => ({
  label: word,
  pattern: new RegExp(`\\b${escapeForRegex(word)}\\b`, 'i'),
}))

/** Every risk term found in one piece of extracted text, in list order, deduped. */
const findTerms = (text) => {
  const words = WORD_MATCHERS.filter(({ pattern }) => pattern.test(text)).map(({ label }) => label)
  const phrases = RISK_PHRASES.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[0].replace(/\s+/g, ' ').trim()),
  )
  return [...new Set([...words, ...phrases])]
}

const isPaymentSurface = (relativePath) =>
  PAYMENT_SURFACES.some((surface) =>
    surface.endsWith('/') ? relativePath.startsWith(surface) : relativePath === surface,
  )

const walk = (absoluteDir) =>
  readdirSync(absoluteDir, { withFileTypes: true }).flatMap((entry) => {
    const child = join(absoluteDir, entry.name)
    if (entry.isDirectory()) {
      return walk(child)
    }
    return entry.isFile() ? [child] : []
  })

const isScannable = (path) =>
  SCANNED_EXTENSIONS.some((extension) => path.endsWith(extension)) &&
  !path.includes('.test.') &&
  !path.endsWith('.d.ts')

/** Offset to 1-based line number, via the offsets every line starts at. */
const makeLineLookup = (source) => {
  const starts = source.split('\n').reduce(
    (accumulator, line) => ({
      offsets: [...accumulator.offsets, accumulator.next],
      next: accumulator.next + line.length + 1,
    }),
    { offsets: [], next: 0 },
  )
  return (offset) => starts.offsets.filter((start) => start <= offset).length
}

/**
 * Text nodes in JSX and HTML: the run between a tag's closing `>` and the next
 * `<`. Requiring a real tag right before the run keeps arrow functions (`=>`)
 * and comparisons (`a > b`) from swallowing half the file as prose. The `<` is
 * matched by lookahead so it stays available as the next tag's opening.
 *
 * Only run on .tsx and .html. A generic like `ReadonlyArray<TierFeature>` reads
 * as a tag, so on a plain .ts file this pass reports object keys as prose. No
 * copy is lost by skipping it there: a .ts file has no text nodes, every string
 * it renders is a quoted literal that the literal pass already reads.
 */
const TAG_TEXT_RE = /<[A-Za-z/][^<>]*>([^<>]*)(?=<)/g

const extractTagText = (source, lineOf) =>
  [...source.matchAll(TAG_TEXT_RE)].flatMap((match) => {
    const chunk = match[1]
    const chunkStart = match.index + match[0].length - chunk.length
    return chunk.split('\n').reduce(
      (accumulator, rawLine) => {
        // Drop `{expression}` containers so `Choose {name}` reads as "Choose".
        const text = rawLine.replace(/\{[^{}]*\}/g, ' ').trim()
        const entry = /[A-Za-z]/.test(text)
          ? [{ line: lineOf(accumulator.offset), origin: 'text', text }]
          : []
        return {
          offset: accumulator.offset + rawLine.length + 1,
          entries: [...accumulator.entries, ...entry],
        }
      },
      { offset: chunkStart, entries: [] },
    ).entries
  })

// One line's worth of quoted literals. Newlines are excluded from every arm so
// an apostrophe inside prose ("the member's status") cannot open a match that
// runs away across the file.
const STRING_RE = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\\n]|\\.)*)`/g

const isImportLine = (line) => /^\s*(?:import|export)\b.*\bfrom\b/.test(line) || /^\s*import\s/.test(line)

const extractStringLiterals = (lines) =>
  lines.flatMap((rawLine, index) => {
    if (isImportLine(rawLine)) {
      return []
    }
    return [...rawLine.matchAll(STRING_RE)]
      .map((match) => (match[1] ?? match[2] ?? match[3] ?? '').trim())
      .filter((text) => /[A-Za-z]/.test(text))
      .map((text) => ({ line: index + 1, origin: 'string', text }))
  })

const TS_COMMENT_RE = /^\s*(?:\/\/|\*|\/\*)/
const PY_COMMENT_RE = /^\s*#/

const extractComments = (lines, pattern) =>
  lines.flatMap((rawLine, index) =>
    pattern.test(rawLine) ? [{ line: index + 1, origin: 'comment', text: rawLine.trim() }] : [],
  )

/**
 * Python: every line inside a triple-quoted block counts as copy, which is how
 * both the HTML invite template and the plain-text alternative get read. The
 * toggle is per triple-quote occurrence, so a one-line `"""doc"""` cancels out.
 * Markup is stripped so what is reported is the prose a member reads. Attribute
 * values survive anyway, the quoted-literal pass reads them off the same line.
 */
const extractPythonText = (lines) =>
  lines.reduce(
    (accumulator, rawLine, index) => {
      const markers = (rawLine.match(/"""|'''/g) ?? []).length
      const insideAfter = markers % 2 === 1 ? !accumulator.inside : accumulator.inside
      const counts = accumulator.inside || markers > 0
      const text = rawLine
        .replace(/[frbuFRBU]{0,2}(?:"""|''')/g, ' ')
        .replace(/<[^<>]*>/g, ' ')
        .trim()
      const entry =
        counts && /[A-Za-z]/.test(text) ? [{ line: index + 1, origin: 'text', text }] : []
      return { inside: insideAfter, entries: [...accumulator.entries, ...entry] }
    },
    { inside: false, entries: [] },
  ).entries

const extractFile = ({ relativePath, source }) => {
  const lines = source.split('\n')
  const lineOf = makeLineLookup(source)
  if (relativePath.endsWith('.py')) {
    return [
      ...extractPythonText(lines),
      ...extractStringLiterals(lines),
      ...extractComments(lines, PY_COMMENT_RE),
    ]
  }
  if (relativePath.endsWith('.html')) {
    return extractTagText(source, lineOf)
  }
  const tagText = relativePath.endsWith('.tsx') ? extractTagText(source, lineOf) : []
  return [...tagText, ...extractStringLiterals(lines), ...extractComments(lines, TS_COMMENT_RE)]
}

/** Collapse to one record per source line, so a line is reported exactly once. */
const byLine = ({ entries, lines }) => {
  const grouped = entries.reduce((accumulator, entry) => {
    const existing = accumulator.get(entry.line)
    return new Map(accumulator).set(entry.line, {
      line: entry.line,
      // A line seen as prose and as a literal keeps the more specific origin.
      origin: existing && existing.origin !== 'comment' ? existing.origin : entry.origin,
      texts: [...(existing?.texts ?? []), entry.text],
      source: (lines[entry.line - 1] ?? '').trim(),
    })
  }, new Map())
  return [...grouped.values()].sort((a, b) => a.line - b.line)
}

const exists = (relativePath) => {
  try {
    statSync(join(REPO_ROOT, relativePath))
    return true
  } catch {
    return false
  }
}

/**
 * Configured paths that no longer resolve. A restructure that moves a surface
 * turns this script into a no-op that still exits 0, which reads as a clean
 * audit: the single worst way for it to fail. Every configured entry is checked
 * so staleness is reported loudly instead of being scanned over. Payment-surface
 * prefixes are checked too, because a stale prefix there is subtler and worse:
 * the file still gets scanned, but it lands under the "exempt" heading.
 */
const findMissingSurfaces = () =>
  [
    ...SCAN_DIRS.map((path) => ({ path, kind: 'SCAN_DIRS' })),
    ...SCAN_FILES.map((path) => ({ path, kind: 'SCAN_FILES' })),
    ...PAYMENT_SURFACES.map((path) => ({ path, kind: 'PAYMENT_SURFACES' })),
  ].filter(({ path }) => !exists(path.endsWith('/') ? path.slice(0, -1) : path))

const collect = () => {
  const fromDirs = SCAN_DIRS.filter(exists).flatMap((relativeDir) =>
    walk(join(REPO_ROOT, relativeDir)).map((path) => path.slice(REPO_ROOT.length + 1)),
  )
  const fromFiles = SCAN_FILES.filter(
    (relativePath) => exists(relativePath) && statSync(join(REPO_ROOT, relativePath)).isFile(),
  )
  return [...new Set([...fromDirs, ...fromFiles])].filter(isScannable).sort()
}

const readFileRecords = (relativePaths) =>
  relativePaths.map((relativePath) => {
    const source = readFileSync(join(REPO_ROOT, relativePath), 'utf8')
    const lines = source.split('\n')
    return {
      relativePath,
      payment: isPaymentSurface(relativePath),
      records: byLine({ entries: extractFile({ relativePath, source }), lines }),
    }
  })

const pad = (value, width) => String(value).padStart(width, ' ')

const printGroup = ({ heading, files, render }) => {
  const populated = files.filter((file) => file.rows.length > 0)
  if (!populated.length) {
    return
  }
  console.log(`\n${heading}`)
  console.log('='.repeat(heading.length))
  populated.forEach((file) => {
    console.log(`\n${file.relativePath}`)
    file.rows.forEach((row) => console.log(render(row)))
  })
}

const main = () => {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      [
        'extract-copy.mjs: extract user-facing wizteros copy and flag content-promise language.',
        '',
        '  (no flags)  print only the lines matching a risk term',
        '  --all       print every extracted string, unfiltered',
        '  --help      this text',
        '',
        `Repo root: ${REPO_ROOT} (override with WZ_REPO)`,
      ].join('\n'),
    )
    return
  }
  const showAll = args.includes('--all')
  const unknown = args.filter((arg) => !['--all', '--help', '-h'].includes(arg))
  if (unknown.length) {
    console.error(`Unknown argument: ${unknown.join(', ')}. Try --help.`)
    process.exitCode = 1
    return
  }

  const missing = findMissingSurfaces()
  if (missing.length) {
    console.error(
      [
        '',
        `WARNING: ${missing.length} configured path${missing.length === 1 ? ' does' : 's do'} not exist under ${REPO_ROOT}.`,
        'This run is INCOMPLETE. Do not read its result as a clean audit.',
        ...missing.map(({ path, kind }) => `  ${kind}: ${path}`),
        'Fix the path lists at the top of this script, then re-run.',
        '',
      ].join('\n'),
    )
  }

  const files = readFileRecords(collect())
  const withRows = files.map((file) => ({
    ...file,
    rows: showAll
      ? file.records.map((record) => ({ ...record, terms: [] }))
      : file.records
          .map((record) => ({ ...record, terms: findTerms(record.texts.join(' ')) }))
          .filter((record) => record.terms.length > 0),
  }))

  const render = (row) =>
    showAll
      ? `  ${pad(row.line, 4)}  ${row.origin.padEnd(7)}  ${row.texts.join(' | ')}`
      : `  ${pad(row.line, 4)}  ${row.origin.padEnd(7)}  [${row.terms.join(', ')}]  ${row.source}`

  console.log(
    showAll
      ? 'Every extracted string. Nothing here is a verdict.'
      : 'Candidates only. Judge each one against the surface it appears on.',
  )

  printGroup({
    heading: 'PAYMENT SURFACES (the rule is absolute here)',
    files: withRows.filter((file) => file.payment),
    render,
  })
  printGroup({
    heading: 'ADMIN AND INTERNAL SURFACES (exempt, shown for context)',
    files: withRows.filter((file) => !file.payment),
    render,
  })

  const total = withRows.reduce((sum, file) => sum + file.rows.length, 0)
  const onPayment = withRows
    .filter((file) => file.payment)
    .reduce((sum, file) => sum + file.rows.length, 0)
  console.log(
    `\n${total} line${total === 1 ? '' : 's'} across ${withRows.filter((file) => file.rows.length).length} file${
      withRows.filter((file) => file.rows.length).length === 1 ? '' : 's'
    }, ${onPayment} on payment surfaces.`,
  )
  if (!showAll) {
    console.log('Stripe product and Payment Link copy lives in the Stripe dashboard. Not scanned.')
  }
  if (missing.length) {
    console.log(
      `INCOMPLETE RUN: ${missing.length} configured path${missing.length === 1 ? '' : 's'} missing (see the warning above).`,
    )
  }
}

main()
