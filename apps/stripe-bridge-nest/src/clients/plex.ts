import { Logger } from '@nestjs/common'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { mapInOrder } from '@/sequence.js'
import type { LiveSections, PlexAccess, PlexApi, PlexShare, PlexShares } from '@/types.js'

// The owner's view of plex.tv: which servers the account owns, what each one's
// libraries are live, and who each server is shared with. Read-only; nothing
// here changes a share.

const log = new Logger('bridge')

/** Seconds a plex.tv request may take, headers to last byte. */
const TIMEOUT = 15

/** The one GET this client makes, narrowed so a test can answer it with XML. */
export type PlexFetch = (
  url: string,
  init: Readonly<{ headers: Readonly<Record<string, string>>; signal: AbortSignal }>,
) => Promise<Response>

/**
 * plex.tv could not be asked or would not answer: a network error, a timeout,
 * or an error status. It stands where the Python caught
 * `requests.RequestException`, so the admin route that reads shares answers
 * 502 on exactly these and nothing else.
 */
export class PlexUnavailable extends Error {
  override readonly name = 'PlexUnavailable'
}

/** One owned server: its name and the machineIdentifier its documents are keyed by. */
export type OwnedServer = Readonly<{ name: string | null; machine_id: string }>

/** One parsed element: its tag, its attributes, and its child elements in document order. */
type XmlElement = Readonly<{
  tag: string
  attributes: Readonly<Record<string, string>>
  children: readonly XmlElement[]
}>

// preserveOrder keeps siblings in document order, which ElementTree's iter()
// walks in; the default grouping by tag name would reorder mixed siblings.
// htmlEntities decodes numeric character references (&#39;), which
// ElementTree does and fast-xml-parser otherwise leaves as text.
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  htmlEntities: true,
})

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A node's attributes as strings; preserveOrder files them under ':@'. */
const attributesOf = (
  node: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> => {
  const raw = node[':@']
  return isRecord(raw)
    ? Object.fromEntries(
        Object.entries(raw).flatMap(([key, value]) =>
          typeof value === 'string' ? [[key, value]] : [],
        ),
      )
    : {}
}

/** The elements among preserveOrder nodes, skipping text and the attribute slot. */
const elementsOf = (nodes: unknown): readonly XmlElement[] =>
  Array.isArray(nodes)
    ? nodes.filter(isRecord).flatMap((node) =>
        Object.entries(node)
          .filter(([key, value]) => key !== ':@' && key !== '#text' && Array.isArray(value))
          .map(([tag, children]) => ({
            tag,
            attributes: attributesOf(node),
            children: elementsOf(children),
          })),
      )
    : []

/**
 * Parse a plex.tv document to its root element. Malformed XML throws, as
 * ElementTree.fromstring did; fast-xml-parser alone would parse it leniently.
 */
const parseXml = (text: string): XmlElement => {
  const verdict = XMLValidator.validate(text)
  if (verdict !== true) {
    throw new Error(`plex.tv answered malformed XML: ${verdict.err.msg}`)
  }
  const [root] = elementsOf(parser.parse(text))
  if (root === undefined) {
    throw new Error('plex.tv answered a document with no root element')
  }
  return root
}

/**
 * Every element tagged `tag` at or below `element`, depth-first in document
 * order: ElementTree's `Element.iter(tag)`, which includes the element itself.
 */
const iter = ({ element, tag }: { element: XmlElement; tag: string }): readonly XmlElement[] => [
  ...(element.tag === tag ? [element] : []),
  ...element.children.flatMap((child) => iter({ element: child, tag })),
]

/** An attribute's value, or null when absent: ElementTree's `Element.get`. */
const attr = ({ element, name }: { element: XmlElement; name: string }): string | null =>
  element.attributes[name] ?? null

const codePoints = (text: string): readonly number[] =>
  Array.from(text, (character) => character.codePointAt(0) ?? 0)

/**
 * Order two strings by code point, as Python's sorted() does. JavaScript's
 * default sort compares UTF-16 code units, which puts astral characters
 * before U+E000..U+FFFF.
 */
const byCodePoint = (a: string, b: string): number => {
  const left = codePoints(a)
  const right = codePoints(b)
  const index = left.findIndex((point, i) => point !== right[i])
  if (index === -1) {
    return left.length - right.length
  }
  const other = right[index]
  return other === undefined ? 1 : (left[index] ?? 0) - other
}

// requests' HTTPError text, so the logged warning reads the same.
const httpErrorText = ({ response, url }: { response: Response; url: string }): string =>
  `${response.status} ${response.status < 500 ? 'Client' : 'Server'} Error: ${response.statusText} for url: ${url}`

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * A plex.tv client for the owner `token`. The Python read PLEX_TOKEN and
 * PLEX_TV_BASE at import; here both are handed in, with `fetch` so a test can
 * answer with XML instead of the network.
 */
export const plexApi = ({
  token,
  base,
  fetch = globalThis.fetch,
}: {
  token: string
  base: string
  fetch?: PlexFetch
}): PlexApi & {
  ownedServers: () => Promise<OwnedServer[]>
  liveSections: () => Promise<LiveSections>
} => {
  /**
   * Fetch a plex.tv XML document with the owner token. Throws PlexUnavailable
   * on a network failure, a timeout, or a 4xx/5xx (requests'
   * raise_for_status), and a plain Error on malformed XML.
   */
  const getXml = async (path: string): Promise<XmlElement> => {
    const url = `${base}${path}`
    const text = await (async (): Promise<string> => {
      try {
        const response = await fetch(url, {
          headers: { 'X-Plex-Token': token },
          signal: AbortSignal.timeout(TIMEOUT * 1000),
        })
        if (response.status >= 400) {
          throw new PlexUnavailable(httpErrorText({ response, url }))
        }
        return await response.text()
      } catch (error) {
        throw error instanceof PlexUnavailable
          ? error
          : new PlexUnavailable(messageOf(error), { cause: error })
      }
    })()
    return parseXml(text)
  }

  /** The account's Plex servers from plex.tv (name + machineIdentifier). */
  const ownedServers = async (): Promise<OwnedServer[]> =>
    iter({ element: await getXml('/api/servers'), tag: 'Server' }).flatMap((server) => {
      const machineId = attr({ element: server, name: 'machineIdentifier' })
      return machineId
        ? [{ name: attr({ element: server, name: 'name' }), machine_id: machineId }]
        : []
    })

  /**
   * Every owned server's library sections from plex.tv, keyed by server name.
   *
   * Each server maps section id to the section's live title. The id is the
   * value Wizarr stores as a library's external_id, and the title is what
   * plexapi resolves an invite's library names against at redemption, so
   * this is the view a stale Wizarr cache has to be checked against.
   *
   * A server with no name is keyed "null", where Python keyed it None and
   * the JSON wire then spelled it the same way.
   */
  const liveSections = async (): Promise<LiveSections> => {
    const servers = await ownedServers()
    const documents = await mapInOrder({
      items: servers,
      run: async (server) => ({
        name: String(server.name),
        root: await getXml(`/api/servers/${server.machine_id}`),
      }),
    })
    return Object.fromEntries(
      documents.map(({ name, root }) => [
        name,
        Object.fromEntries(
          iter({ element: root, tag: 'Section' }).flatMap((section) => {
            const id = attr({ element: section, name: 'id' })
            return id ? [[id, attr({ element: section, name: 'title' }) || '']] : []
          }),
        ),
      ]),
    )
  }

  /**
   * liveSections(), or null when there is no token or plex.tv cannot answer.
   *
   * Null means "nothing to check against", never "no libraries": callers keep
   * trusting Wizarr's cache rather than blocking a checkout on a third party.
   */
  const liveSectionsOrNone = async (): Promise<LiveSections | null> => {
    if (!token) {
      return null
    }
    try {
      return await liveSections()
    } catch (error) {
      log.warn(
        `plex.tv live sections unavailable; trusting wizarr's library cache: ${messageOf(error)}`,
      )
      return null
    }
  }

  /**
   * Every shared account's plex.tv access, keyed by lowercased email then server.
   *
   * Ground truth straight from plex.tv's shared_servers, independent of
   * Wizarr and of the bridge's tier rules, so it also covers legacy shares
   * that never went through an invite. A shared_servers document lists every
   * account a server is shared with, so the whole roster costs one call per
   * owned server; looking up a single email is no cheaper.
   */
  const sharedAccessAll = async (): Promise<PlexAccess> => {
    const servers = await ownedServers()
    const documents = await mapInOrder({
      items: servers,
      run: async (server) => ({
        name: String(server.name),
        root: await getXml(`/api/servers/${server.machine_id}/shared_servers`),
      }),
    })
    const grants = documents.flatMap(({ name, root }) =>
      iter({ element: root, tag: 'SharedServer' }).flatMap((shared) => {
        const email = (attr({ element: shared, name: 'email' }) || '').trim().toLowerCase()
        if (!email) {
          return []
        }
        const share: PlexShare = {
          all_libraries: attr({ element: shared, name: 'allLibraries' }) === '1',
          allow_sync: attr({ element: shared, name: 'allowSync' }) === '1',
          libraries: iter({ element: shared, tag: 'Section' })
            .filter((section) => attr({ element: section, name: 'shared' }) === '1')
            .map((section) => attr({ element: section, name: 'title' }) || '')
            .toSorted(byCodePoint),
        }
        return [{ email, server: name, share }]
      }),
    )
    // Grouped the way setdefault() built it: emails and servers keep the
    // position they were first seen at, and a repeat takes the later value,
    // which Object.fromEntries does for duplicate keys.
    const emails = [...new Set(grants.map((grant) => grant.email))]
    return Object.fromEntries(
      emails.map((email) => [
        email,
        Object.fromEntries(
          grants
            .filter((grant) => grant.email === email)
            .map((grant) => [grant.server, grant.share]),
        ),
      ]),
    )
  }

  /**
   * The actual plex.tv share one email holds, per owned server.
   *
   * Empty when the email is not shared anywhere.
   */
  const sharedAccessForEmail = async (email: string): Promise<PlexShares> =>
    (await sharedAccessAll())[email.trim().toLowerCase()] ?? {}

  return {
    hasToken: () => !!token,
    ownedServers,
    liveSections,
    liveSectionsOrNone,
    sharedAccessAll,
    sharedAccessForEmail,
  }
}
