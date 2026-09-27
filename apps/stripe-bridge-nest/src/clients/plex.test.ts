import { Logger } from '@nestjs/common'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type PlexFetch, PlexUnavailable, plexApi } from '@/clients/plex.js'

const SERVERS_XML = `<MediaContainer>
  <Server name="Meleys" machineIdentifier="m-1"/>
  <Server name="Vermithor" machineIdentifier="m-2"/>
</MediaContainer>`

const SHARED_M1 = `<MediaContainer machineIdentifier="m-1">
  <SharedServer username="harman" email="Harman@X.com" allLibraries="1" allowSync="1">
    <Section id="1" title="01. Movies" shared="1"/>
    <Section id="2" title="90. Private" shared="1"/>
  </SharedServer>
  <SharedServer username="other" email="other@x.com" allLibraries="0" allowSync="0">
    <Section id="1" title="01. Movies" shared="1"/>
  </SharedServer>
</MediaContainer>`

const SHARED_M2 = `<MediaContainer machineIdentifier="m-2">
  <SharedServer username="other" email="other@x.com" allLibraries="0" allowSync="0">
    <Section id="9" title="02. Anime" shared="1"/>
    <Section id="10" title="03. 4K Movies" shared="0"/>
  </SharedServer>
</MediaContainer>`

type Answer = Readonly<{ body?: string; status?: number }>

/**
 * A plex.tv that answers only the urls it is given, the `responses` mock the
 * Python suite registered. Every call is recorded; an unregistered url fails
 * the way `responses` refused one, as a connection error.
 */
const fakePlexTv = (routes: Readonly<Record<string, Answer>>) => {
  const calls: { url: string; headers: Readonly<Record<string, string>> }[] = []
  const fetch: PlexFetch = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const answer = routes[url]
    if (answer === undefined) {
      throw new TypeError(`Connection refused by fake plex.tv: ${url}`)
    }
    return new Response(answer.body ?? '', { status: answer.status ?? 200 })
  }
  return { fetch, calls }
}

const mockPlexTv = () =>
  fakePlexTv({
    'http://plex.test/api/servers': { body: SERVERS_XML },
    'http://plex.test/api/servers/m-1/shared_servers': { body: SHARED_M1 },
    'http://plex.test/api/servers/m-2/shared_servers': { body: SHARED_M2 },
  })

const client = (fetch: PlexFetch, token = 'tok') =>
  plexApi({ token, base: 'http://plex.test', fetch })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('plex.tv client', () => {
  it('owned servers parses names and ids', async () => {
    const { fetch, calls } = fakePlexTv({ 'http://plex.test/api/servers': { body: SERVERS_XML } })
    expect(await client(fetch).ownedServers()).toEqual([
      { name: 'Meleys', machine_id: 'm-1' },
      { name: 'Vermithor', machine_id: 'm-2' },
    ])
    expect(calls[0]?.headers).toEqual({ 'X-Plex-Token': 'tok' })
  })

  it('shared access matches email case-insensitively', async () => {
    const access = await client(mockPlexTv().fetch).sharedAccessForEmail('harman@x.com')
    expect(access).toEqual({
      Meleys: {
        all_libraries: true,
        allow_sync: true,
        libraries: ['01. Movies', '90. Private'],
      },
    })
  })

  it('shared access skips unshared sections', async () => {
    const access = await client(mockPlexTv().fetch).sharedAccessForEmail('other@x.com')
    expect(access.Vermithor?.libraries).toEqual(['02. Anime'])
    expect(access.Vermithor?.all_libraries).toBe(false)
    expect(access.Vermithor?.allow_sync).toBe(false)
    expect(access.Meleys?.libraries).toEqual(['01. Movies'])
  })

  it('shared access is empty for an unknown email', async () => {
    expect(await client(mockPlexTv().fetch).sharedAccessForEmail('ghost@x.com')).toEqual({})
  })

  it('shared access all groups every email in one pass', async () => {
    // A shared_servers document lists every account the server is shared with,
    // so the whole roster costs one call per owned server, not per member.
    const { fetch, calls } = mockPlexTv()
    const access = await client(fetch).sharedAccessAll()
    expect(new Set(Object.keys(access))).toEqual(new Set(['harman@x.com', 'other@x.com'])) // keys lowercased
    expect(new Set(Object.keys(access['other@x.com'] ?? {}))).toEqual(
      new Set(['Meleys', 'Vermithor']),
    )
    expect(access['harman@x.com']?.Meleys).toEqual({
      all_libraries: true,
      allow_sync: true,
      libraries: ['01. Movies', '90. Private'],
    })
    expect(access['other@x.com']?.Vermithor?.libraries).toEqual(['02. Anime']) // shared="0" dropped
    const sharedCalls = calls.filter((call) => call.url.includes('shared_servers'))
    expect(sharedCalls).toHaveLength(2) // one per owned server, regardless of member count
  })

  // --- live sections: the owner's view of each server's libraries -------------

  const SERVER_M1 = `<MediaContainer>
  <Server name="Meleys" machineIdentifier="m-1">
    <Section id="145283096" key="31" type="show" title="22. Formula 1"/>
    <Section id="137390246" key="8" type="movie" title="04. Movies"/>
  </Server>
</MediaContainer>`

  const SERVER_M2 = `<MediaContainer>
  <Server name="Vermithor" machineIdentifier="m-2">
    <Section id="145181324" key="14" type="show" title="01. TV Shows"/>
  </Server>
</MediaContainer>`

  it('live sections keys titles by server then section id', async () => {
    // The section id is what Wizarr stores as a library's external_id, so
    // this is the join the stale-cache check needs.
    const { fetch } = fakePlexTv({
      'http://plex.test/api/servers': { body: SERVERS_XML },
      'http://plex.test/api/servers/m-1': { body: SERVER_M1 },
      'http://plex.test/api/servers/m-2': { body: SERVER_M2 },
    })
    expect(await client(fetch).liveSections()).toEqual({
      Meleys: { '145283096': '22. Formula 1', '137390246': '04. Movies' },
      Vermithor: { '145181324': '01. TV Shows' },
    })
  })

  it('live sections or none swallows a plex.tv failure', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const { fetch } = fakePlexTv({ 'http://plex.test/api/servers': { status: 503 } })
    expect(await client(fetch).liveSectionsOrNone()).toBeNull()
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).toContain('plex.tv')
  })

  it('live sections or none is null without a token', async () => {
    // No token means no plex.tv at all; the caller trusts Wizarr's cache.
    const { fetch, calls } = mockPlexTv()
    const plex = client(fetch, '')
    expect(plex.hasToken()).toBe(false)
    expect(await plex.liveSectionsOrNone()).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('raises PlexUnavailable for an error status and a dead connection', async () => {
    // The admin route answers 502 on exactly this, where Python caught
    // requests.RequestException.
    const failing = fakePlexTv({ 'http://plex.test/api/servers': { status: 503 } })
    await expect(client(failing.fetch).sharedAccessAll()).rejects.toBeInstanceOf(PlexUnavailable)
    const dead = fakePlexTv({})
    await expect(client(dead.fetch).sharedAccessAll()).rejects.toBeInstanceOf(PlexUnavailable)
  })
})
