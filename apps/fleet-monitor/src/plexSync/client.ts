// How a pass reaches one Plex server: the transport it sends on, the client
// that carries its token and assembles each url, the decoded answer, and the
// pager every listing shares.

import type { Host } from '@/config.js'
import * as plex from '@/probes/plex.js'
import { getJson, type Send, send } from '@/transport/http.js'

// Wide, on purpose. The first live round timed out at twenty seconds on the
// two slowest boxes while they were also serving streams; the same requests
// answered in a second once they were idle. A dead server fails the connect
// long before this, so the width only ever costs a busy one its patience.
export const TIMEOUT = 90.0

/**
 * One Plex answer, decoded, or the reason there is none. `reason` names the
 * transport failure the way the docker endpoint's checks do, plus `bad_json`
 * for a 200 nothing could parse or that carried a bare JSON `null`.
 */
export type Fetched =
  | Readonly<{ ok: true; payload: unknown }>
  | Readonly<{ ok: false; reason: string }>

/**
 * Whether the server said something the caller can act on.
 *
 * A 404 is the server saying what was asked for does not exist any more,
 * which is an answer: the enrichment stubs those keys and moves on. Anything
 * else that failed is the server not answering, which is not the same fact
 * and ends the pass. Stated once because both enrichment paths have to draw
 * the line in the same place.
 */
export const answeredOrGone = (fetched: Fetched): boolean =>
  fetched.ok || fetched.reason === 'http_404'

/** What an answer described, or nothing for a key the server has forgotten. */
export const payloadOf = (fetched: Fetched): unknown => (fetched.ok ? fetched.payload : null)

/**
 * How a pass reaches Plex: the wire it sends on, the budget each request
 * gets, and the signal that abandons a request in flight. Production passes
 * nothing and gets `send`, TIMEOUT and no signal; a test stands in for the
 * server at the wire and narrows the budget (the Python tests patched
 * `http.get_json` and `TIMEOUT` on the module, which an ESM export does not
 * allow), and `runForever` hands its shutdown signal down.
 */
export type Transport = Readonly<{
  send: Send
  timeout: number
  signal: AbortSignal | null
}>

export const transport = ({
  send: wire = send,
  timeout = TIMEOUT,
  signal = null,
}: {
  send?: Send
  timeout?: number
  signal?: AbortSignal | null
} = {}): Transport => ({ send: wire, timeout, signal })

const secure = (host: Host): boolean => host.plex_url.startsWith('https://')

// Python's quote_plus with `safe=">:,"`: letters, digits and `_.-~` stay, a
// space becomes `+`, and `>`, `:` and `,` stay literal. encodeURIComponent
// also leaves `!'()*` alone, which quote_plus escapes, so those are escaped
// back.
const quotePlus = (text: string): string =>
  encodeURIComponent(text)
    .replace(/[!'()*]/g, (mark) => `%${mark.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+')
    .replace(/%(3E|3A|2C)/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

/** Python's `urlencode(params, safe=">:,")`, in the order the params were given. */
const urlencode = (params: Readonly<Record<string, string>>): string =>
  Object.entries(params)
    .map(([key, value]) => `${quotePlus(key)}=${quotePlus(value)}`)
    .join('&')

/** One GET a pass asks of its server: the path, its query, and the page wanted. */
export type PlexRequest = Readonly<{
  path: string
  params?: Readonly<Record<string, string>>
  start?: number
  size?: number
}>

/**
 * One Plex server as a pass sees it: the host it is, and a GET that already
 * carries the token and the transport. Built once per host per pass, so
 * nothing below has to hand the four of them along.
 */
export type PlexClient = Readonly<{
  host: Host
  get: (request: PlexRequest) => Promise<Fetched>
}>

/**
 * The client for one server. Its `get` fetches one Plex path as JSON, never
 * failing on the server's account, within the transport's budget.
 *
 * Paging travels in the two container headers, the way every Plex client
 * sends it. The query keeps `>` and `:` literal because `viewedAt>=` and
 * `viewedAt:asc` are how the server spells its own filters.
 *
 * Verification is off for the two servers that insist on https: they present
 * Plex's wildcard certificate on a LAN address, which no verifier accepts,
 * and the token is what authorizes the request on either transport.
 *
 * The whole request gets the budget, headers to last byte, so a server that
 * keeps trickling bytes cannot hold a five-server loop for an hour.
 *
 * A 200 carrying a bare JSON `null` is a failure named `bad_json`: there is
 * nothing in it to store, and reading it as an answer let a pass report
 * success having committed nothing.
 *
 * The one rejection is the transport's signal aborting, which is a shutdown
 * rather than the server failing: `getJson` surfaces it as an AbortError,
 * which `logRaised` passes through, so a round torn down mid-request records
 * no failed check against a server that did nothing wrong. Python's task
 * cancellation did the same.
 */
export const plexClient = ({
  host,
  token,
  via = transport(),
}: {
  host: Host
  token: string
  via?: Transport
}): PlexClient => ({
  host,
  get: async ({ path, params = {}, start, size }) => {
    const query = urlencode(params)
    const result = await getJson({
      url: `${host.plex_url}${path}${query ? `?${query}` : ''}`,
      timeout: via.timeout,
      headers: {
        'X-Plex-Token': token,
        Accept: 'application/json',
        ...(start === undefined ? {} : { 'X-Plex-Container-Start': String(start) }),
        ...(size === undefined ? {} : { 'X-Plex-Container-Size': String(size) }),
      },
      verify: !secure(host),
      signal: via.signal,
      get: via.send,
    })
    return result.ok && result.payload === null ? { ok: false, reason: 'bad_json' } : result
  },
})
/**
 * Page one Plex listing from `start` to its end, handing each page to `keep`
 * before asking for the next. Returns the failure reason, or empty when the
 * last page landed.
 *
 * Each page is kept, and so committed, before the next is asked for, which is
 * what lets a pass that dies midway resume from the last page that landed.
 */
export const pageAll = async ({
  client,
  request,
  pageSize,
  keep,
  start = 0,
}: {
  client: PlexClient
  request: Omit<PlexRequest, 'start' | 'size'>
  pageSize: number
  keep: (payload: unknown) => void
  start?: number
}): Promise<string> => {
  const fetched = await client.get({ ...request, start, size: pageSize })
  if (!fetched.ok) {
    return fetched.reason
  }
  keep(fetched.payload)
  const info = plex.pageInfo(fetched.payload)
  if (info === null || info.size === 0 || start + info.size >= info.total_size) {
    return ''
  }
  return pageAll({ client, request, pageSize, keep, start: start + info.size })
}
