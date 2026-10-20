import { request as httpsRequest } from 'node:https'
import { text } from 'node:stream/consumers'
import { getSystemErrorName } from 'node:util'

/**
 * One GET, judged: the decoded JSON of a 2xx answer, or the reason there is
 * none. `reason` names the transport failure (`timeout`, `refused`, `dns`,
 * `transport_error`), the status of an answer outside 2xx (`http_404`), or
 * `bad_json` for a 2xx nothing could parse. Every caller used to re-decode a
 * raw body, and each wrote its own `bad_json` branch to do it.
 */
export type HttpResult =
  | Readonly<{ ok: true; payload: unknown }>
  | Readonly<{ ok: false; reason: string }>

/** What one GET answered before it is judged: the status and the decoded body. */
export type HttpAnswer = Readonly<{
  status: number
  body: string
}>

/**
 * One GET on the wire. `getJson` takes one so a test can stand in for the
 * server; the default is `send`. It rejects on any failure, and `getJson`
 * turns the rejection into a reason.
 */
export type Send = (
  call: Readonly<{
    url: string
    headers: Readonly<Record<string, string>>
    verify: boolean
    signal: AbortSignal
  }>,
) => Promise<HttpAnswer>

// fetch follows redirects unless told otherwise, and httpx does not: a 3xx is
// an answer to judge like any other status, not a second request to make.
const viaFetch: Send = async ({ url, headers, signal }) => {
  const response = await fetch(url, { headers, signal, redirect: 'manual' })
  return { status: response.status, body: await response.text() }
}

// fetch can only switch verification off through an undici Agent passed as its
// dispatcher, and the `undici` package is not a dependency here (Node bundles
// its own copy but does not export it). node:https takes the switch directly,
// and fails with the same error codes, so the unverified GET goes through it.
const viaUnverifiedHttps: Send = ({ url, headers, signal }) =>
  new Promise((resolve, reject) => {
    httpsRequest(url, { headers, signal, rejectUnauthorized: false }, (response) => {
      text(response).then((body) => resolve({ status: response.statusCode ?? 0, body }), reject)
    })
      .on('error', reject)
      .end()
  })

/** The production GET: fetch, unless verification is off for an https url. */
export const send: Send = (call) =>
  call.verify || new URL(call.url).protocol !== 'https:' ? viaFetch(call) : viaUnverifiedHttps(call)

// The error and everything beneath it. fetch wraps the socket's error in a
// TypeError as its cause, and a host with several addresses fails with an
// AggregateError holding one error per address; the code that names the
// failure is on the innermost ones.
const failures = (error: unknown): readonly unknown[] => [
  error,
  ...(error instanceof AggregateError ? error.errors.flatMap(failures) : []),
  ...(error instanceof Error && error.cause !== undefined ? failures(error.cause) : []),
]

const field = ({ error, name }: { error: unknown; name: string }): unknown =>
  error instanceof Error && name in error ? Reflect.get(error, name) : undefined

// httpx's ConnectTimeout and ReadTimeout. The deadline itself is caught before
// this is asked; these are the socket's and undici's own timeouts.
const TIMEOUT_CODES: ReadonlySet<unknown> = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

// The verdicts of a TLS handshake that did not complete: OpenSSL's certificate
// codes and Node's own. httpx raises these as a ConnectError, like a refusal.
const TLS_FAILURE = /^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_)/

const isTimeout = (error: unknown): boolean =>
  field({ error, name: 'name' }) === 'TimeoutError' ||
  TIMEOUT_CODES.has(field({ error, name: 'code' }))

// httpx's ConnectError: anything that failed before a connection existed,
// which is a lookup, a connect, or a handshake.
const isConnectFailure = (error: unknown): boolean => {
  const syscall = field({ error, name: 'syscall' })
  const code = field({ error, name: 'code' })
  return (
    syscall === 'connect' ||
    syscall === 'getaddrinfo' ||
    (typeof code === 'string' && TLS_FAILURE.test(code))
  )
}

// The two texts the Python matched are the Linux and the macOS wording of one
// resolver answer, EAI_NONAME: the name does not exist. Node reports that and
// EAI_NODATA under the same ENOTFOUND code, so the resolver's own number is
// what tells them apart.
const isUnknownName = (error: unknown): boolean => {
  const errno = field({ error, name: 'errno' })
  return (
    field({ error, name: 'syscall' }) === 'getaddrinfo' &&
    typeof errno === 'number' &&
    getSystemErrorName(errno) === 'EAI_NONAME'
  )
}

/**
 * Name why a request failed. A refused socket-proxy connection and a genuine
 * DNS miss must never look identical to the incident machine.
 */
const classify = (error: unknown): string => {
  const causes = failures(error)
  if (causes.some(isTimeout)) {
    return 'timeout'
  }
  const connect = causes.filter(isConnectFailure)
  if (connect.length === 0) {
    return 'transport_error'
  }
  return connect.some(isUnknownName) ? 'dns' : 'refused'
}

const failure = (reason: string): HttpResult => ({ ok: false, reason })

// `json.loads` on an answer that arrived, answering rather than raising.
const judge = ({ status, body }: HttpAnswer): HttpResult => {
  if (status < 200 || status >= 300) {
    return failure(`http_${status}`)
  }
  try {
    return { ok: true, payload: JSON.parse(body) }
  } catch {
    return failure('bad_json')
  }
}

/**
 * GET a URL as JSON, never raising on the server's account. A dead endpoint
 * degrades that target only.
 *
 * `verify` is off only for the two Plex servers that insist on https: they
 * present Plex's *.plex.direct wildcard certificate on a LAN ip, which no
 * verifier can accept, and the owner token is what authorizes the request on
 * either transport. Everything else keeps the default.
 *
 * The timeout covers the whole request, headers to last byte. httpx applied
 * its timeout to each phase (connect, then every read) instead, and a server
 * that keeps trickling bytes never trips a per-read timeout: vermithor
 * answered one listing page's headers at once and then took fifty-nine
 * minutes over its body (2026-09-18).
 *
 * `signal` is the caller giving up (a shutdown). It reaches the wire, so the
 * socket closes rather than running on to the deadline, and it is the one
 * rejection: an AbortError, whichever of the request and the abort settled
 * first, because a request the abort cut short fails with a reason of its own
 * and reporting that would count the shutdown against the server.
 */
export const getJson = async ({
  url,
  timeout = 8.0,
  headers = null,
  verify = true,
  signal = null,
  get = send,
}: {
  url: string
  timeout?: number
  headers?: Readonly<Record<string, string>> | null
  verify?: boolean
  signal?: AbortSignal | null
  get?: Send
}): Promise<HttpResult> => {
  const deadline = AbortSignal.timeout(timeout * 1000)
  const attempt = async (): Promise<HttpResult> => {
    try {
      return judge(
        await get({
          url,
          headers: headers ?? {},
          verify,
          signal: signal === null ? deadline : AbortSignal.any([deadline, signal]),
        }),
      )
    } catch (error) {
      // once the deadline has passed, whatever the request died of was the
      // deadline: node:https reports a body cut short as a reset, not a timeout
      return failure(deadline.aborted ? 'timeout' : classify(error))
    }
  }
  const result = await attempt()
  if (signal !== null && signal.aborted) {
    throw new DOMException('This operation was aborted', 'AbortError')
  }
  return result
}
