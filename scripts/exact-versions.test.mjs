import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isExact, rangedVersions } from './exact-versions.mjs'

test('an exact version, a catalog reference and a workspace link pass', () => {
  ;[
    '24.0.5',
    '7.0.0-dev.20260707.2',
    '1.2.3+build.4',
    'catalog:',
    'catalog:server',
    'workspace:*',
  ].forEach((spec) => assert.equal(isExact(spec), true, spec))
})

test('every kind of range fails', () => {
  ;[
    '^24.0.5',
    '~1.2.3',
    '>=1.0.0',
    '1.x',
    '1.2',
    '*',
    'latest',
    '1.0.0 || 2.0.0',
    'workspace:^',
  ].forEach((spec) => assert.equal(isExact(spec), false, spec))
})

test('ranges are reported from dependency fields and both kinds of catalog', () => {
  const manifest = {
    devDependencies: { nx: '^24.0.5', oxlint: 'catalog:' },
    peerDependencies: { '@nestjs/common': '12.4.0' },
    overrides: { parent: { child: '~1.0.0' } },
    workspaces: {
      packages: ['apps/*'],
      catalog: { zod: '^4.6.7' },
      catalogs: { server: { typescript: '6.0.3', '@types/node': '24.x' } },
    },
  }
  assert.deepEqual(rangedVersions(manifest), [
    'devDependencies: nx ^24.0.5',
    'overrides: parent > child ~1.0.0',
    'workspaces.catalog: zod ^4.6.7',
    'workspaces.catalogs.server: @types/node 24.x',
  ])
})

test('a bare workspaces list has no catalogs to check', () => {
  assert.deepEqual(
    rangedVersions({ workspaces: ['apps/*'], dependencies: { react: '19.3.1' } }),
    [],
  )
})
