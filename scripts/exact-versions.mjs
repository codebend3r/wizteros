// Every dependency in every tracked package.json names one exact version, never
// a range, so an install resolves the same bytes on every machine and in CI.
// A shared version lives once in a root catalog, a sibling package is linked
// with workspace:*, and nothing else is allowed.
//
//   node scripts/exact-versions.mjs   fail on any ranged version, listing each one
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'overrides',
  'resolutions',
]

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

/** True for an exact version, a catalog reference, or a sibling workspace link. */
export const isExact = (spec) =>
  EXACT.test(spec) || /^catalog:[\w-]*$/.test(spec) || spec === 'workspace:*'

/** Every `{name, spec}` in one dependency map, nested override objects included. */
const entries = (map, prefix = '') =>
  Object.entries(map ?? {}).flatMap(([name, spec]) =>
    typeof spec === 'string'
      ? [{ name: `${prefix}${name}`, spec }]
      : entries(spec, `${prefix}${name} > `),
  )

/** Each ranged version in one parsed manifest, as `field: name spec`. */
export const rangedVersions = (manifest) => {
  const workspaces = Array.isArray(manifest.workspaces) ? {} : (manifest.workspaces ?? {})
  const maps = [
    ...DEPENDENCY_FIELDS.map((field) => [field, manifest[field]]),
    ['workspaces.catalog', workspaces.catalog],
    ...Object.entries(workspaces.catalogs ?? {}).map(([name, map]) => [
      `workspaces.catalogs.${name}`,
      map,
    ]),
  ]
  return maps.flatMap(([field, map]) =>
    entries(map)
      .filter(({ spec }) => !isExact(spec))
      .map(({ name, spec }) => `${field}: ${name} ${spec}`),
  )
}

const main = () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const manifests = execFileSync('git', ['ls-files', '*package.json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => path !== '')
  const findings = manifests.flatMap((path) =>
    rangedVersions(JSON.parse(readFileSync(join(repoRoot, path), 'utf8'))).map(
      (finding) => `  ${path}  ${finding}`,
    ),
  )
  if (findings.length > 0) {
    console.error('ranged versions found; pin each to an exact version:')
    findings.forEach((finding) => console.error(finding))
    process.exit(1)
  }
  console.log(`all ${manifests.length} manifests pin exact versions`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
