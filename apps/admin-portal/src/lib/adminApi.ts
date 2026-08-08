import { supabase } from '@/lib/supabaseClient'

export type PaidTier = 'bronze' | 'silver' | 'gold' | 'youth'
export type Tier = PaidTier | 'unknown'
export type MemberTag = 'vip' | 'hvu'

export type Member = {
  member: string
  email: string
  tier: Tier
  downloads: boolean | null
  expires: string | null
  servers: string[]
  libraries: Record<string, string[]>
  /** What the member's tier grants, independent of what Plex is actually sharing. */
  entitled: Record<string, string[]>
  subscribed: boolean
  invited_at: string | null
  tag: MemberTag | null
  customer_id: string | null
}

export type PlexServerAccess = {
  all_libraries: boolean
  allow_sync: boolean
  libraries: string[]
}

export type PlexAccess = {
  email: string
  servers: Record<string, PlexServerAccess>
}

export type MemberNotes = {
  email: string
  notes: string
}

export type MemberEvent = {
  id: number
  at: string
  email: string
  action: string
  detail: string
}

export type InviteResult = {
  url: string
  code: string
  tier: string
  disabled: number
  emailed: boolean
}

export type ResetExpiryResult = {
  updated: number
  expires: string | null
}

export type ResetTierResult = {
  email: string
  tier: string
}

export type CancelSubscriptionResult = {
  email: string
  canceled: number
  cancel_at: string | null
}

export type SetTagResult = {
  email: string
  tag: MemberTag | null
}

export type SetDownloadsResult = {
  email: string
  downloads: boolean
}

export class AdminAuthError extends Error {}

const ADMIN_API_BASE: string = import.meta.env.VITE_ADMIN_API_BASE ?? ''

// The bridge authorizes admin calls off the Supabase session: send the
// user's access token as a bearer, refreshed from the client each request.
const authHeader = async (): Promise<Record<string, string>> => {
  if (!supabase) {
    return {}
  }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isLibrariesMap = (value: unknown): value is Record<string, string[]> =>
  isRecord(value) && Object.values(value).every(isStringArray)

const TIERS: ReadonlyArray<Tier> = ['bronze', 'silver', 'gold', 'youth', 'unknown']

const isTier = (value: unknown): value is Tier =>
  typeof value === 'string' && TIERS.some((tier) => tier === value)

const isMemberTag = (value: unknown): value is MemberTag => value === 'vip' || value === 'hvu'

// A bridge deployed before the libraries map, invited_at stamp, tag, or
// customer_id may still omit them; tolerate that and normalize with toMember
// so the page degrades to bare server names, a grace clock that never
// expires, an untagged member, and no Stripe link.
type MemberPayload = Omit<
  Member,
  'libraries' | 'entitled' | 'invited_at' | 'tag' | 'customer_id'
> & {
  libraries?: Record<string, string[]>
  entitled?: Record<string, string[]>
  invited_at?: string | null
  tag?: MemberTag | null
  customer_id?: string | null
}

// Kept as per-field checks rather than one boolean chain so a rejected payload
// can say which field failed. One malformed row from the bridge sinks the
// whole list, and "Unexpected members response" alone gives nothing to go on.
type MemberFieldCheck = {
  field: string
  valid: (value: Record<string, unknown>) => boolean
}

const MEMBER_FIELD_CHECKS: ReadonlyArray<MemberFieldCheck> = [
  { field: 'member', valid: (value) => typeof value.member === 'string' },
  { field: 'email', valid: (value) => typeof value.email === 'string' },
  { field: 'tier', valid: (value) => isTier(value.tier) },
  {
    field: 'downloads',
    valid: (value) => typeof value.downloads === 'boolean' || value.downloads === null,
  },
  {
    field: 'expires',
    valid: (value) => typeof value.expires === 'string' || value.expires === null,
  },
  { field: 'servers', valid: (value) => isStringArray(value.servers) },
  {
    field: 'libraries',
    valid: (value) => value.libraries === undefined || isLibrariesMap(value.libraries),
  },
  {
    field: 'entitled',
    valid: (value) => value.entitled === undefined || isLibrariesMap(value.entitled),
  },
  { field: 'subscribed', valid: (value) => typeof value.subscribed === 'boolean' },
  {
    field: 'invited_at',
    valid: (value) =>
      value.invited_at === undefined ||
      value.invited_at === null ||
      typeof value.invited_at === 'string',
  },
  {
    field: 'tag',
    valid: (value) => value.tag === undefined || value.tag === null || isMemberTag(value.tag),
  },
  {
    field: 'customer_id',
    valid: (value) =>
      value.customer_id === undefined ||
      value.customer_id === null ||
      typeof value.customer_id === 'string',
  },
]

const invalidMemberFields = (value: unknown): string[] =>
  isRecord(value)
    ? MEMBER_FIELD_CHECKS.filter(({ valid }) => !valid(value)).map(({ field }) => field)
    : ['(not an object)']

const isMemberPayload = (value: unknown): value is MemberPayload =>
  invalidMemberFields(value).length === 0

// Points at the first row the bridge got wrong so a single bad member is
// identifiable from the admin page without opening devtools.
const describeMembersMismatch = (data: unknown): string => {
  if (!Array.isArray(data)) {
    return `expected an array, got ${typeof data}`
  }
  const invalid = data
    .map((row: unknown, index) => ({ row, index, fields: invalidMemberFields(row) }))
    .filter(({ fields }) => fields.length > 0)
  const [first] = invalid
  if (!first) {
    return 'no offending row found'
  }
  const who =
    isRecord(first.row) && typeof first.row.email === 'string' && !!first.row.email
      ? first.row.email
      : `row ${first.index}`
  return `${invalid.length} of ${data.length} rows invalid; first is ${who} (bad fields: ${first.fields.join(', ')})`
}

const toMember = (payload: MemberPayload): Member => ({
  ...payload,
  libraries: payload.libraries ?? {},
  entitled: payload.entitled ?? {},
  invited_at: payload.invited_at ?? null,
  tag: payload.tag ?? null,
  customer_id: payload.customer_id ?? null,
})

const isPlexServerAccess = (value: unknown): value is PlexServerAccess =>
  isRecord(value) &&
  typeof value.all_libraries === 'boolean' &&
  typeof value.allow_sync === 'boolean' &&
  isStringArray(value.libraries)

const isPlexAccess = (value: unknown): value is PlexAccess =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  isRecord(value.servers) &&
  Object.values(value.servers).every(isPlexServerAccess)

const isMemberNotes = (value: unknown): value is MemberNotes =>
  isRecord(value) && typeof value.email === 'string' && typeof value.notes === 'string'

const isMemberEvent = (value: unknown): value is MemberEvent =>
  isRecord(value) &&
  typeof value.id === 'number' &&
  typeof value.at === 'string' &&
  typeof value.email === 'string' &&
  typeof value.action === 'string' &&
  typeof value.detail === 'string'

const isMemberEventArray = (value: unknown): value is MemberEvent[] =>
  Array.isArray(value) && value.every(isMemberEvent)

const isMemberPayloadArray = (value: unknown): value is MemberPayload[] =>
  Array.isArray(value) && value.every(isMemberPayload)

const isInviteResult = (value: unknown): value is InviteResult =>
  isRecord(value) &&
  typeof value.url === 'string' &&
  typeof value.code === 'string' &&
  typeof value.tier === 'string' &&
  typeof value.disabled === 'number' &&
  typeof value.emailed === 'boolean'

const isResetExpiryResult = (value: unknown): value is ResetExpiryResult =>
  isRecord(value) &&
  typeof value.updated === 'number' &&
  (typeof value.expires === 'string' || value.expires === null)

const isResetTierResult = (value: unknown): value is ResetTierResult =>
  isRecord(value) && typeof value.email === 'string' && typeof value.tier === 'string'

const isCancelSubscriptionResult = (value: unknown): value is CancelSubscriptionResult =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  typeof value.canceled === 'number' &&
  (typeof value.cancel_at === 'string' || value.cancel_at === null)

const isSetTagResult = (value: unknown): value is SetTagResult =>
  isRecord(value) &&
  typeof value.email === 'string' &&
  (value.tag === null || isMemberTag(value.tag))

const isSetDownloadsResult = (value: unknown): value is SetDownloadsResult =>
  isRecord(value) && typeof value.email === 'string' && typeof value.downloads === 'boolean'

type RequestArgs = {
  path: string
  method?: 'GET' | 'POST'
  body?: unknown
}

// The bridge reports failures as {"detail": "..."}; carrying a snippet of it
// into the thrown error is what distinguishes a dead upstream from a bad
// request once the page only shows the message.
const bodySnippet = async (response: Response): Promise<string> => {
  try {
    return (await response.text()).slice(0, 200)
  } catch {
    return ''
  }
}

const requestJson = async ({ path, method = 'GET', body }: RequestArgs): Promise<unknown> => {
  const response = await fetch(`${ADMIN_API_BASE}${path}`, {
    method,
    headers: {
      ...(await authHeader()),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 401) {
    throw new AdminAuthError('Not signed in')
  }
  if (!response.ok) {
    const detail = await bodySnippet(response)
    throw new Error(`Request failed (${response.status})${!!detail ? `: ${detail}` : ''}`)
  }
  // With VITE_ADMIN_API_BASE unset every call is relative, so the dev server
  // and Netlify both answer with index.html at 200. Name that instead of
  // letting it surface as an opaque JSON parse error.
  const contentType = response.headers?.get('content-type') ?? ''
  if (!!contentType && !contentType.includes('json')) {
    throw new Error(
      `Expected JSON from ${path} but got ${contentType}. Is VITE_ADMIN_API_BASE set?`,
    )
  }
  return response.json()
}

// The cause carries the only clue about a bridge-side failure (status, the
// bridge's own detail, or the offending row), so the pages render it rather
// than collapsing every load error into the same sentence.
export const loadErrorMessage = (cause: unknown): string =>
  cause instanceof Error && !!cause.message
    ? `Could not load members. ${cause.message}`
    : 'Could not load members.'

export const fetchMembers = async (): Promise<Member[]> => {
  const data = await requestJson({ path: '/admin/members' })
  if (!isMemberPayloadArray(data)) {
    throw new Error(`Unexpected members response: ${describeMembersMismatch(data)}`)
  }
  return data.map(toMember)
}

export const fetchMember = async ({ email }: { email: string }): Promise<Member | null> => {
  const response = await fetch(
    `${ADMIN_API_BASE}/admin/member?email=${encodeURIComponent(email)}`,
    {
      headers: await authHeader(),
    },
  )
  if (response.status === 401) {
    throw new AdminAuthError('Not signed in')
  }
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`)
  }
  const data: unknown = await response.json()
  if (!isMemberPayload(data)) {
    throw new Error('Unexpected member response')
  }
  return toMember(data)
}

export const fetchPlexAccess = async ({ email }: { email: string }): Promise<PlexAccess> => {
  const data = await requestJson({
    path: `/admin/plex-access?email=${encodeURIComponent(email)}`,
  })
  if (!isPlexAccess(data)) {
    throw new Error('Unexpected plex-access response')
  }
  return data
}

export const fetchMemberEvents = async ({ email }: { email: string }): Promise<MemberEvent[]> => {
  const data = await requestJson({
    path: `/admin/events?email=${encodeURIComponent(email)}`,
  })
  if (!isMemberEventArray(data)) {
    throw new Error('Unexpected events response')
  }
  return data
}

export const fetchMemberNotes = async ({ email }: { email: string }): Promise<MemberNotes> => {
  const data = await requestJson({
    path: `/admin/notes?email=${encodeURIComponent(email)}`,
  })
  if (!isMemberNotes(data)) {
    throw new Error('Unexpected notes response')
  }
  return data
}

export const saveMemberNotes = async ({
  email,
  notes,
}: {
  email: string
  notes: string
}): Promise<MemberNotes> => {
  const data = await requestJson({
    path: '/admin/notes',
    method: 'POST',
    body: { email, notes },
  })
  if (!isMemberNotes(data)) {
    throw new Error('Unexpected notes response')
  }
  return data
}

export const resetExpiry = async ({
  email,
  days = null,
  expiresAt = null,
}: {
  email: string
  days?: number | null
  expiresAt?: string | null
}): Promise<ResetExpiryResult> => {
  const data = await requestJson({
    path: '/admin/reset-expiry',
    method: 'POST',
    body: { email, days, expires_at: expiresAt },
  })
  if (!isResetExpiryResult(data)) {
    throw new Error('Unexpected reset-expiry response')
  }
  return data
}

export const resetTier = async ({
  email,
  tier,
}: {
  email: string
  tier: PaidTier
}): Promise<ResetTierResult> => {
  const data = await requestJson({
    path: '/admin/reset-tier',
    method: 'POST',
    body: { email, tier },
  })
  if (!isResetTierResult(data)) {
    throw new Error('Unexpected reset-tier response')
  }
  return data
}

export const cancelSubscription = async ({
  email,
}: {
  email: string
}): Promise<CancelSubscriptionResult> => {
  const data = await requestJson({
    path: '/admin/cancel-subscription',
    method: 'POST',
    body: { email },
  })
  if (!isCancelSubscriptionResult(data)) {
    throw new Error('Unexpected cancel-subscription response')
  }
  return data
}

export const setMemberTag = async ({
  email,
  tag,
}: {
  email: string
  tag: MemberTag | null
}): Promise<SetTagResult> => {
  const data = await requestJson({
    path: '/admin/set-tag',
    method: 'POST',
    body: { email, tag },
  })
  if (!isSetTagResult(data)) {
    throw new Error('Unexpected set-tag response')
  }
  return data
}

export const setMemberDownloads = async ({
  email,
  allow,
}: {
  email: string
  allow: boolean
}): Promise<SetDownloadsResult> => {
  const data = await requestJson({
    path: '/admin/set-downloads',
    method: 'POST',
    body: { email, allow },
  })
  if (!isSetDownloadsResult(data)) {
    throw new Error('Unexpected set-downloads response')
  }
  return data
}

export const reissueInvite = async ({
  email,
  tier,
}: {
  email: string
  tier: PaidTier
}): Promise<InviteResult> => {
  const data = await requestJson({
    path: '/admin/reissue-invite',
    method: 'POST',
    body: { email, tier },
  })
  if (!isInviteResult(data)) {
    throw new Error('Unexpected reissue-invite response')
  }
  return data
}
