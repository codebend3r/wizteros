import { type RequestListener, type Server, createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { getJson, type HttpResult } from '@/transport/http.js'

// A local port nothing listens on: bound, read back, then released. The
// Python tests used port 1, but fetch refuses to dial port 1 at all (it is on
// the Fetch standard's list of blocked ports), which would test that refusal
// rather than a dead endpoint.
const deadPort = async (): Promise<number> => {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (address === null || typeof address === 'string') {
    throw new Error('no port was bound')
  }
  return address.port
}

// The reason of a failed result, or empty for an answered one.
const reasonOf = (result: HttpResult): string => (result.ok ? '' : result.reason)

const servers: Server[] = []

// A local HTTP server answering every request with `handler`, closed (with
// any connection it still holds) after the test.
const serve = async (handler: RequestListener): Promise<string> => {
  const server = createHttpServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('no port was bound')
  }
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

describe('getJson', () => {
  it('returns a typed failure for a dead port', async () => {
    // a port on localhost that refuses; the collector must degrade, not raise
    const port = await deadPort()
    const result = await getJson({ url: `http://127.0.0.1:${port}/containers/json`, timeout: 2 })

    expect(result.ok).toBe(false)
    expect(['refused', 'timeout', 'transport_error']).toContain(reasonOf(result))
  })

  it('reports a bad url as a typed failure', async () => {
    const result = await getJson({ url: 'http://nonexistent.invalid/x', timeout: 2 })

    expect(result.ok).toBe(false)
    expect(['dns', 'timeout', 'transport_error']).toContain(reasonOf(result))
  })

  it('accepts a verify switch for self-signed servers', async () => {
    // two Plex servers present the *.plex.direct wildcard on a LAN ip, which
    // cannot verify; the switch has to exist, and it must not change the
    // never-raises contract
    const port = await deadPort()
    const result = await getJson({
      url: `https://127.0.0.1:${port}/identity`,
      timeout: 2,
      verify: false,
    })

    expect(result.ok).toBe(false)
    expect(['refused', 'timeout', 'transport_error']).toContain(reasonOf(result))
  })

  // The tests below have no Python counterpart. The Python suite only ever
  // reached get_json's failure branch; these pin the answered branch and the
  // two places where fetch and httpx differ by default.

  it('hands back the decoded body of a 2xx answer', async () => {
    const url = await serve((_request, response) => response.writeHead(200).end('[]'))

    expect(await getJson({ url: `${url}/containers/json` })).toEqual({ ok: true, payload: [] })
  })

  it('names a 2xx nothing could parse bad_json', async () => {
    const url = await serve((_request, response) => response.writeHead(200).end('<html>nope'))

    expect(await getJson({ url })).toEqual({ ok: false, reason: 'bad_json' })
  })

  it('judges a non-2xx answer by its status', async () => {
    const url = await serve((_request, response) => response.writeHead(503).end('down'))

    expect(await getJson({ url })).toEqual({ ok: false, reason: 'http_503' })
  })

  it('does not follow a redirect', async () => {
    // httpx answers a 3xx as it is; fetch would follow it unless told not to
    const url = await serve((_request, response) =>
      response.writeHead(302, { Location: '/elsewhere' }).end(),
    )

    expect(await getJson({ url })).toEqual({ ok: false, reason: 'http_302' })
  })

  it('times out a body that never finishes', async () => {
    // the deadline covers the whole request: headers arriving on time do not
    // buy the body unlimited time
    const url = await serve((_request, response) => {
      response.writeHead(200)
      response.write('[')
    })

    expect(await getJson({ url, timeout: 0.2 })).toEqual({ ok: false, reason: 'timeout' })
  })

  it('rejects as an abort once the caller gives up, not as a failure', async () => {
    // a shutdown is not the server failing, so it must not come back as a
    // reason that would be recorded against it
    const url = await serve(() => undefined)
    const controller = new AbortController()

    const pending = getJson({ url, timeout: 60, signal: controller.signal })
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
