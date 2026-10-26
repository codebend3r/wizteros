import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { expectedServers } from './audit-invites.mjs'

const { libraries } = JSON.parse(
  readFileSync(
    new URL(
      '../../../../apps/stripe-bridge/src/test/fixtures/live-libraries.json',
      import.meta.url,
    ),
    'utf8',
  ),
)

test('the Node entrypoint fails before any requests when credentials are missing', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./audit-invites.mjs', import.meta.url))],
    {
      env: { ...process.env, WIZARR_BASE_URL: '', WIZARR_API_KEY: '' },
      encoding: 'utf8',
    },
  )
  assert.equal(result.status, 2)
  assert.match(result.stderr, /Missing WIZARR_BASE_URL \/ WIZARR_API_KEY/)
})

test('baseline audit rejects a missing or malformed library list', () => {
  ;[undefined, null, {}].forEach((invalid) => {
    assert.throws(
      () => expectedServers({ tier: 'gold', libraries: invalid }),
      /Wizarr did not return a libraries array/,
    )
  })
})

test('baseline audit expects each tier across its eligible fleet servers', () => {
  assert.deepEqual(expectedServers({ tier: 'bronze', libraries }), ['Meleys', 'Syrax', 'Vermithor'])
  assert.deepEqual(expectedServers({ tier: 'silver', libraries }), [
    'Meleys',
    'Syrax',
    'Vermithor',
    'Vhagar',
  ])
  assert.deepEqual(expectedServers({ tier: 'gold', libraries }), [
    'Meleys',
    'Syrax',
    'Vermithor',
    'Vhagar',
  ])
  assert.deepEqual(expectedServers({ tier: 'youth', libraries }), ['Meleys', 'Vermithor'])
})

test('baseline audit uses a title prefix, excludes Caraxes and disabled/private rows', () => {
  const rows = [
    { name: 'Movies in 4K', server_name: 'Syrax', enabled: true },
    { name: '01. 4K Movies', server_name: 'Vhagar', enabled: true },
    { name: 'Kid Shows', server_name: 'Caraxes', enabled: true },
    { name: '95. Private', server_name: 'Private', enabled: true },
    { name: 'Movies', server_name: 'Disabled', enabled: false },
    { name: 'Movies', server_name: null, enabled: true },
  ]
  assert.deepEqual(expectedServers({ tier: 'bronze', libraries: rows }), ['Syrax'])
  assert.deepEqual(expectedServers({ tier: 'gold', libraries: rows }), ['Syrax', 'Vhagar'])
  assert.deepEqual(expectedServers({ tier: 'youth', libraries: rows }), [])
})
