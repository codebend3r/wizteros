import { Logger } from '@nestjs/common'
import type {
  CreatedInvite,
  WizarrApi,
  WizarrInvitation,
  WizarrLibrary,
  WizarrUser,
} from '@/types.js'

const log = new Logger('bridge.wizarr')

// Per-user writes reconcile with the Plex server the record lives on, so they
// are as slow as /api/users itself. A 10s ceiling used to time out mid-loop and
// leave a checkout half-applied while the write still landed server-side.
export const USER_WRITE_TIMEOUT = 45

// /api/users is slow (Wizarr reconciles with each Plex server per call),
// routinely ~15s, so allow generous headroom.
const USERS_TIMEOUT = 45

// Every other call answers quickly.
const DEFAULT_TIMEOUT = 10

// Wizarr does not take an arbitrary expiry. Its API routes expires_in_days
// through a fixed lookup ({1: "day", 7: "week", 30: "month"} in
// app/blueprints/api/api_routes.py) and falls back to "never" for anything
// else. So an unhonored number does not shorten the invite, it removes the
// expiry altogether, and the link stays redeemable for good.
export const EXPIRY_DAYS_HONORED: readonly number[] = [1, 7, 30]

const LONGEST_HONORED = Math.max(...EXPIRY_DAYS_HONORED)

/**
 * The shortest expiry Wizarr honors that is still no shorter than `days`.
 *
 * Snapping up rather than down: a window that is too short can kill a paying
 * member's invite before they ever redeem it, whereas one that is too long
 * only delays the backstop. Past the largest honored value there is no finite
 * choice left, so that one is used instead of decaying into "never".
 */
export const honoredExpiryDays = (days: number): number =>
  EXPIRY_DAYS_HONORED.find((honored) => honored >= days) ?? LONGEST_HONORED

// Wizarr marshals an invitation's used_by as fields.String over a User
// relationship with no __str__, so the live API returns the repr "<User 281>"
// rather than a name. The number is the redeeming record's id. The username
// path stays for a Wizarr that one day serializes a real username.
const USED_BY_REPR = /^\s*<User (\d+)>\s*$/

/**
 * The user record that redeemed `invitation`, or null when nothing resolves.
 *
 * Resolves either shape Wizarr can put in used_by: the "<User N>" repr, whose
 * number is the record id, or a plain username. Returns null for an
 * unredeemed invitation and for a redeemer who is no longer on the server,
 * so a dead id is never handed back to a caller that writes with it.
 */
export const redeemerRecord = ({
  invitation,
  users,
}: {
  invitation: WizarrInvitation
  users: readonly WizarrUser[]
}): WizarrUser | null => {
  const usedBy = invitation.used_by
  if (typeof usedBy !== 'string' || usedBy === '') {
    return null
  }
  const match = USED_BY_REPR.exec(usedBy)
  if (match !== null) {
    const recordId = Number(match[1])
    return users.find((user) => user.id === recordId) ?? null
  }
  return users.find((user) => (user.username ?? '').toLowerCase() === usedBy.toLowerCase()) ?? null
}

/**
 * The lowercased email of the record that redeemed `invitation`.
 *
 * Null when the invitation is unredeemed, when the redeeming record is gone,
 * or when that record carries no email of its own (a local Plex account).
 */
export const redeemerEmail = ({
  invitation,
  users,
}: {
  invitation: WizarrInvitation
  users: readonly WizarrUser[]
}): string | null => (redeemerRecord({ invitation, users })?.email ?? '').toLowerCase() || null

/** The part of fetch the client uses, so a test can hand in a fake. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** A deadline signal for a timeout in seconds; a test can record the seconds. */
export type TimeoutSignal = (seconds: number) => AbortSignal

const abortAfter: TimeoutSignal = (seconds) => AbortSignal.timeout(seconds * 1000)

// --- narrowing the JSON Wizarr answers with -----------------------------------

type JsonObject = Readonly<Record<string, unknown>>

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringOrNull = (value: unknown): value is string | null =>
  typeof value === 'string' || value === null

const isBooleanOrNull = (value: unknown): value is boolean | null =>
  typeof value === 'boolean' || value === null

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/** The array under `key` of a JSON object body; empty when there is none. */
const listUnder = ({ body, key }: { body: unknown; key: string }): readonly unknown[] => {
  const value = isObject(body) ? body[key] : undefined
  return Array.isArray(value) ? value : []
}

/** The object rows of a list, the only rows whose fields can be read. */
const objectRows = (rows: readonly unknown[]): readonly JsonObject[] => rows.filter(isObject)

const toLibrary = (row: JsonObject): readonly WizarrLibrary[] => {
  const { id, server_id: serverId } = row
  if (typeof id !== 'number' || typeof serverId !== 'number') {
    return []
  }
  const externalId = row.external_id
  return [
    {
      id,
      server_id: serverId,
      ...(isStringOrNull(row.name) ? { name: row.name } : {}),
      ...(isStringOrNull(row.server_name) ? { server_name: row.server_name } : {}),
      ...(typeof row.enabled === 'boolean' ? { enabled: row.enabled } : {}),
      ...(typeof externalId === 'string' || typeof externalId === 'number' || externalId === null
        ? { external_id: externalId }
        : {}),
    },
  ]
}

const toUser = (row: JsonObject): readonly WizarrUser[] => {
  const { id } = row
  if (typeof id !== 'number') {
    return []
  }
  return [
    {
      id,
      ...(isStringOrNull(row.username) ? { username: row.username } : {}),
      ...(isStringOrNull(row.email) ? { email: row.email } : {}),
      ...(isStringOrNull(row.server) ? { server: row.server } : {}),
      ...(isStringOrNull(row.expires) ? { expires: row.expires } : {}),
    },
  ]
}

const toInvitation = (row: JsonObject): readonly WizarrInvitation[] => {
  const { id } = row
  if (typeof id !== 'number') {
    return []
  }
  const serverNames = row.server_names
  return [
    {
      id,
      ...(isStringOrNull(row.code) ? { code: row.code } : {}),
      ...('used_by' in row ? { used_by: row.used_by } : {}),
      ...(isStringArray(serverNames) || serverNames === null ? { server_names: serverNames } : {}),
      ...(isStringOrNull(row.expires) ? { expires: row.expires } : {}),
      ...(isBooleanOrNull(row.unlimited) ? { unlimited: row.unlimited } : {}),
    },
  ]
}

const toCreatedInvite = (body: unknown): CreatedInvite => {
  const invitation = isObject(body) ? body.invitation : undefined
  if (!isObject(invitation)) {
    throw new Error('wizarr answered a created invite with no invitation')
  }
  const { code, url } = invitation
  if (typeof code !== 'string' || typeof url !== 'string') {
    throw new Error('wizarr answered a created invite with no code or url')
  }
  return { code, url }
}

/**
 * Thin wrapper around the Wizarr REST API used by the bridge.
 *
 * `fetch` and `timeoutSignal` are injectable so a test never reaches the
 * network and can see which deadline each call was given.
 */
export const wizarrClient = ({
  baseUrl,
  apiKey,
  fetch = globalThis.fetch,
  timeoutSignal = abortAfter,
}: {
  baseUrl: string
  apiKey: string
  fetch?: Fetch
  timeoutSignal?: TimeoutSignal
}): WizarrApi => {
  // stripped so building a path never yields "//"
  const base = baseUrl.replace(/\/+$/, '')

  // auth and content-type headers every API call needs
  const headers = (): Record<string, string> => ({
    'X-API-Key': apiKey,
    'Content-Type': 'application/json',
  })

  /** One call; throws on any non-2xx answer. */
  const call = async ({
    method,
    path,
    timeout,
    json,
    params,
  }: {
    method: string
    path: string
    timeout: number
    json?: unknown
    params?: Readonly<Record<string, string>>
  }): Promise<Response> => {
    const query = params === undefined ? '' : new URLSearchParams(params).toString()
    const url = `${base}${path}${query === '' ? '' : `?${query}`}`
    const response = await fetch(url, {
      method,
      headers: headers(),
      signal: timeoutSignal(timeout),
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    })
    if (!response.ok) {
      throw new Error(`wizarr answered ${response.status} to ${method} ${url}`)
    }
    return response
  }

  /** GET a path and parse its JSON body. */
  const getJson = async ({
    path,
    timeout,
    params,
  }: {
    path: string
    timeout: number
    params?: Readonly<Record<string, string>>
  }): Promise<unknown> => {
    const response = await call({ method: 'GET', path, timeout, params })
    const body: unknown = await response.json()
    return body
  }

  /** Every invitation Wizarr holds, used and unused alike. */
  const invitations = async (): Promise<WizarrInvitation[]> =>
    objectRows(
      listUnder({
        body: await getJson({ path: '/api/invitations', timeout: DEFAULT_TIMEOUT }),
        key: 'invitations',
      }),
    ).flatMap(toInvitation)

  /** Query /api/users with the given filters and return the user list. */
  const users = async (params: Readonly<Record<string, string>>): Promise<WizarrUser[]> =>
    objectRows(
      listUnder({
        body: await getJson({ path: '/api/users', timeout: USERS_TIMEOUT, params }),
        key: 'users',
      }),
    ).flatMap(toUser)

  /** All user records for an email (one record per server). */
  const findUsersByEmail = async (email: string): Promise<WizarrUser[]> =>
    (await users({ email })).filter(
      (user) => (user.email ?? '').toLowerCase() === email.toLowerCase(),
    )

  return {
    /** All libraries Wizarr knows (id, name, server_id, server_name, enabled). */
    listLibraries: async () =>
      objectRows(
        listUnder({
          body: await getJson({ path: '/api/libraries', timeout: DEFAULT_TIMEOUT }),
          key: 'libraries',
        }),
      ).flatMap(toLibrary),

    /**
     * Create an invite for the given servers; return just its code and url.
     *
     * libraryIds null leaves scoping to Wizarr's defaults; a list scopes the
     * invite to exactly those libraries.
     *
     * expiresInDays is snapped to a value Wizarr honors before it is sent,
     * because the API turns every other number into an invite that never
     * expires rather than rejecting it.
     */
    createInvite: async ({
      serverIds,
      expiresInDays,
      duration,
      unlimited = false,
      libraryIds = null,
      allowDownloads = false,
    }) => {
      const expires = honoredExpiryDays(expiresInDays)
      if (expires !== expiresInDays) {
        log.warn(
          `wizarr honors an expiry of ${EXPIRY_DAYS_HONORED.join(', ')} days only, so ` +
            `${Math.trunc(expiresInDays)} was snapped up to ${expires}; ` +
            'the invite expires rather than living forever',
        )
      }
      const payload = {
        server_ids: [...serverIds],
        expires_in_days: expires,
        duration,
        unlimited,
        allow_downloads: allowDownloads,
        ...(libraryIds === null ? {} : { library_ids: [...libraryIds] }),
      }
      const response = await call({
        method: 'POST',
        path: '/api/invitations',
        timeout: DEFAULT_TIMEOUT,
        json: payload,
      })
      const body: unknown = await response.json()
      return toCreatedInvite(body)
    },

    /**
     * Every invitation Wizarr holds, used and unused alike.
     *
     * Callers must read scope from server_names, never specific_libraries:
     * the serializer reports specific_libraries as [] even for a correctly
     * scoped invite, so it cannot tell a scoped invite from an unscoped one.
     */
    listInvitations: invitations,

    /** Delete one invitation by its numeric id (not its code). */
    deleteInvitation: async (invitationId) => {
      await call({
        method: 'DELETE',
        path: `/api/invitations/${invitationId}`,
        timeout: DEFAULT_TIMEOUT,
      })
    },

    /** Every user record Wizarr knows (one per person per server). */
    listUsers: () => users({}),

    findUsersByEmail,

    /** All record ids for an email (one record per server). */
    findUserIdsByEmail: async (email) => (await findUsersByEmail(email)).map((user) => user.id),

    /**
     * All record ids for the Plex account that redeemed the invite.
     *
     * Fallback for when the Stripe email differs from the Plex account email.
     */
    findUserIdsByInvite: async (code) => {
      const invitation = (await invitations()).find((row) => row.code === code)
      if (!invitation?.used_by) {
        return []
      }
      const everyone = await users({})
      const record = redeemerRecord({ invitation, users: everyone })
      if (record === null) {
        return []
      }
      const email = (record.email ?? '').toLowerCase()
      // A record with no email cannot fan out to its sibling servers; the one
      // record that redeemed the invite is still the right thing to act on.
      if (email === '') {
        return [record.id]
      }
      return everyone
        .filter((user) => (user.email ?? '').toLowerCase() === email)
        .map((user) => user.id)
    },

    /**
     * Set a record's expiry to an absolute ISO datetime, or null to clear it.
     *
     * Wizarr validates the body against its schema (expires: date-time
     * string), so a literal null is rejected with a 400; clearing to
     * unlimited must omit the key entirely.
     */
    setExpiry: async ({ userId, expires }) => {
      await call({
        method: 'PUT',
        path: `/api/users/${userId}/update-expiry`,
        timeout: USER_WRITE_TIMEOUT,
        json: expires === null ? {} : { expires },
      })
    },

    /** Disable (not delete) a user record so its access stops. */
    disableUser: async (userId) => {
      await call({
        method: 'POST',
        path: `/api/users/${userId}/disable`,
        timeout: USER_WRITE_TIMEOUT,
      })
    },
  }
}
