// The release version lives in every package.json of the workspace: the root's
// and each package its `workspaces` globs match. scripts/release.sh moves them
// in lockstep and CI's version-parity job checks they agree, both through this
// list, so a new app or lib joins the release without an edit anywhere else.
//
//   node scripts/version-markers.mjs                  print each manifest path, root first
//   node scripts/version-markers.mjs --check [X.Y.Z]  fail unless they all read one version
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Parse one manifest, by its path from the repo root. */
const readManifest = (path) => JSON.parse(readFileSync(join(repoRoot, path), 'utf8'))

/** The package directories one `workspaces` entry names: `apps/*` expands, a plain path stays. */
const expandWorkspace = (pattern) => {
  if (!pattern.endsWith('/*')) {
    return [pattern]
  }
  const parent = pattern.slice(0, -2)
  return readdirSync(join(repoRoot, parent), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`)
    .sort()
}

/** Every manifest that carries the release version, the root's first. */
const markers = () => [
  'package.json',
  ...(readManifest('package.json').workspaces ?? [])
    .flatMap(expandWorkspace)
    .map((dir) => `${dir}/package.json`)
    .filter((path) => existsSync(join(repoRoot, path))),
]

/** Exit 1 unless every marker has a version and they all agree, on `expected` when given. */
const check = (expected) => {
  const rows = markers().map((path) => ({ path, version: readManifest(path).version ?? '' }))
  const target = expected ?? rows[0].version
  const drifted = rows.filter(({ version }) => version === '' || version !== target)
  if (target === '' || drifted.length > 0) {
    console.error(`version markers disagree${expected ? `, expected ${expected}` : ''}:`)
    rows.forEach(({ path, version }) =>
      console.error(`  ${path.padEnd(36)} ${version === '' ? '(no version)' : version}`),
    )
    process.exit(1)
  }
  console.log(`all ${rows.length} version markers read ${target}`)
}

const [mode, expected] = process.argv.slice(2)

if (mode === '--check') {
  check(expected)
} else if (mode === undefined) {
  console.log(markers().join('\n'))
} else {
  console.error('usage: version-markers.mjs [--check [X.Y.Z]]')
  process.exit(1)
}
