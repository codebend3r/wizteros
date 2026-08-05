import { expect, test } from '@/test/vi'
import type { PlexServerAccess } from '@/lib/adminApi'
import { buildServerAccess, stateLabel } from '@/lib/libraryAccess'

const share = (overrides: Partial<PlexServerAccess>): PlexServerAccess => ({
  all_libraries: false,
  allow_sync: false,
  libraries: [],
  ...overrides,
})

const statesFor = (servers: ReturnType<typeof buildServerAccess>, server: string) =>
  Object.fromEntries(
    (servers.find((entry) => entry.server === server)?.libraries ?? []).map((library) => [
      library.library,
      library.state,
    ]),
  )

test('a library both entitled and shared reads as shared', () => {
  const servers = buildServerAccess({
    entitled: { Meleys: ['01. Movies'] },
    sharing: { Meleys: share({ libraries: ['01. Movies'] }) },
  })
  expect(statesFor(servers, 'Meleys')).toEqual({ '01. Movies': 'shared' })
})

test('a library the tier grants but plex is not sharing reads as not-shared', () => {
  const servers = buildServerAccess({
    entitled: { Meleys: ['01. Movies', '03. Family Movies'] },
    sharing: { Meleys: share({ libraries: ['01. Movies'] }) },
  })
  expect(statesFor(servers, 'Meleys')).toEqual({
    '01. Movies': 'shared',
    '03. Family Movies': 'not-shared',
  })
})

test('a library shared beyond the tier reads as not-entitled', () => {
  const servers = buildServerAccess({
    entitled: { Meleys: ['01. Movies'] },
    sharing: { Meleys: share({ libraries: ['01. Movies', '09. Basketball'] }) },
  })
  expect(statesFor(servers, 'Meleys')).toEqual({
    '01. Movies': 'shared',
    '09. Basketball': 'not-entitled',
  })
})

test('a whole server shared but entitled to nothing is flagged not entitled', () => {
  // Every legacy member still shares the retired servers; this is what makes
  // that visible per member instead of buried in a library list.
  const servers = buildServerAccess({
    entitled: { Meleys: ['01. Movies'] },
    sharing: {
      Meleys: share({ libraries: ['01. Movies'] }),
      Vermithor: share({ libraries: ['01. TV Shows (switch to Meleys)'] }),
    },
  })
  const vermithor = servers.find((entry) => entry.server === 'Vermithor')
  expect(vermithor?.entitled).toBe(false)
  expect(vermithor?.libraries.every((library) => library.state === 'not-entitled')).toBe(true)
  expect(servers.find((entry) => entry.server === 'Meleys')?.entitled).toBe(true)
})

test('all_libraries means every library on that server counts as shared', () => {
  const servers = buildServerAccess({
    entitled: { Meleys: ['01. Movies', '03. Family Movies'] },
    sharing: { Meleys: share({ all_libraries: true, libraries: ['01. Movies'] }) },
  })
  expect(statesFor(servers, 'Meleys')).toEqual({
    '01. Movies': 'shared',
    '03. Family Movies': 'shared',
  })
})

test('an entitled server plex has no record of reads as not-shared', () => {
  const servers = buildServerAccess({
    entitled: { Meleys: ['01. Movies'] },
    sharing: {},
  })
  expect(statesFor(servers, 'Meleys')).toEqual({ '01. Movies': 'not-shared' })
})

test('unreadable plex.tv leaves every state unknown rather than guessing', () => {
  // sharing: null means the lookup failed or there is no token — claiming
  // "not shared" there would read as revoked access that is really just unknown.
  const servers = buildServerAccess({
    entitled: { Meleys: ['01. Movies', '03. Family Movies'] },
    sharing: null,
  })
  expect(statesFor(servers, 'Meleys')).toEqual({
    '01. Movies': 'unknown',
    '03. Family Movies': 'unknown',
  })
})

test('servers and libraries come back sorted', () => {
  const servers = buildServerAccess({
    entitled: { Meleys: ['03. Family Movies', '01. Movies'] },
    sharing: { Vermithor: share({ libraries: ['02. Anime', '01. TV'] }) },
  })
  expect(servers.map((entry) => entry.server)).toEqual(['Meleys', 'Vermithor'])
  expect(servers[0]?.libraries.map((library) => library.library)).toEqual([
    '01. Movies',
    '03. Family Movies',
  ])
})

test('counts summarise each server without recounting in the view', () => {
  const servers = buildServerAccess({
    entitled: { Meleys: ['01. Movies', '03. Family Movies'] },
    sharing: { Meleys: share({ libraries: ['01. Movies', '09. Basketball'] }) },
  })
  const meleys = servers.find((entry) => entry.server === 'Meleys')
  expect(meleys?.entitledCount).toBe(2)
  expect(meleys?.sharedCount).toBe(2)
  expect(meleys?.libraries).toHaveLength(3)
})

test('an empty entitlement and no share yields nothing to render', () => {
  expect(buildServerAccess({ entitled: {}, sharing: {} })).toEqual([])
})

test('every state has a label so meaning never rides on colour alone', () => {
  expect(stateLabel('shared')).toBe('shared')
  expect(stateLabel('not-shared')).toBe('not shared')
  expect(stateLabel('not-entitled')).toBe('not entitled')
  expect(stateLabel('unknown')).toBe('unknown')
})
