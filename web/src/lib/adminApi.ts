export type PaidTier = 'bronze' | 'silver' | 'gold' | 'kids'
export type Tier = PaidTier | 'unknown'

export type Member = {
  member: string
  email: string
  tier: Tier
  downloads: boolean | null
  expires: string | null
  servers: string[]
  libraries: Record<string, string[]>
  subscribed: boolean
}

export type MemberNotes = {
  email: string
  notes: string
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

export class AdminAuthError extends Error {}

const ADMIN_API_BASE: string = import.meta.env.VITE_ADMIN_API_BASE ?? ''

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

const isLibrariesMap = (value: unknown): value is Record<string, string[]> =>
  isRecord(value) && Object.values(value).every(isStringArray)

const TIERS: ReadonlyArray<Tier> = ['bronze', 'silver', 'gold', 'kids', 'unknown']

const isTier = (value: unknown): value is Tier =>
  typeof value === 'string' && TIERS.some((tier) => tier === value)

// A bridge deployed before the libraries map may still omit it; tolerate
// that and normalize with toMember so the page degrades to bare server names.
type MemberPayload = Omit<Member, 'libraries'> & { libraries?: Record<string, string[]> }

const isMemberPayload = (value: unknown): value is MemberPayload =>
  isRecord(value) &&
  typeof value.member === 'string' &&
  typeof value.email === 'string' &&
  isTier(value.tier) &&
  (typeof value.downloads === 'boolean' || value.downloads === null) &&
  (typeof value.expires === 'string' || value.expires === null) &&
  isStringArray(value.servers) &&
  (value.libraries === undefined || isLibrariesMap(value.libraries)) &&
  typeof value.subscribed === 'boolean'

const toMember = (payload: MemberPayload): Member => ({
  ...payload,
  libraries: payload.libraries ?? {},
})

const isMemberNotes = (value: unknown): value is MemberNotes =>
  isRecord(value) && typeof value.email === 'string' && typeof value.notes === 'string'

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

type RequestArgs = {
  path: string
  password: string
  method?: 'GET' | 'POST'
  body?: unknown
}

const requestJson = async ({
  path,
  password,
  method = 'GET',
  body,
}: RequestArgs): Promise<unknown> => {
  const response = await fetch(`${ADMIN_API_BASE}${path}`, {
    method,
    headers: {
      'X-Admin-Password': password,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 401) {
    throw new AdminAuthError('Wrong password')
  }
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`)
  }
  return response.json()
}

export const fetchMembers = async ({ password }: { password: string }): Promise<Member[]> => {
  const data = await requestJson({ path: '/admin/members', password })
  if (!isMemberPayloadArray(data)) {
    throw new Error('Unexpected members response')
  }
  return data.map(toMember)
}

export const fetchMember = async ({
  email,
  password,
}: {
  email: string
  password: string
}): Promise<Member | null> => {
  const response = await fetch(
    `${ADMIN_API_BASE}/admin/member?email=${encodeURIComponent(email)}`,
    {
      headers: { 'X-Admin-Password': password },
    },
  )
  if (response.status === 401) {
    throw new AdminAuthError('Wrong password')
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

export const fetchMemberNotes = async ({
  email,
  password,
}: {
  email: string
  password: string
}): Promise<MemberNotes> => {
  const data = await requestJson({
    path: `/admin/notes?email=${encodeURIComponent(email)}`,
    password,
  })
  if (!isMemberNotes(data)) {
    throw new Error('Unexpected notes response')
  }
  return data
}

export const saveMemberNotes = async ({
  email,
  notes,
  password,
}: {
  email: string
  notes: string
  password: string
}): Promise<MemberNotes> => {
  const data = await requestJson({
    path: '/admin/notes',
    password,
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
  days,
  password,
}: {
  email: string
  days: number | null
  password: string
}): Promise<ResetExpiryResult> => {
  const data = await requestJson({
    path: '/admin/reset-expiry',
    password,
    method: 'POST',
    body: { email, days },
  })
  if (!isResetExpiryResult(data)) {
    throw new Error('Unexpected reset-expiry response')
  }
  return data
}

export const reissueInvite = async ({
  email,
  tier,
  password,
}: {
  email: string
  tier: PaidTier
  password: string
}): Promise<InviteResult> => {
  const data = await requestJson({
    path: '/admin/reissue-invite',
    password,
    method: 'POST',
    body: { email, tier },
  })
  if (!isInviteResult(data)) {
    throw new Error('Unexpected reissue-invite response')
  }
  return data
}
