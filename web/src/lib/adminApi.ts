export type PaidTier = 'bronze' | 'silver' | 'gold' | 'kids'
export type Tier = PaidTier | 'unknown'

export type Member = {
  member: string
  email: string
  tier: Tier
  downloads: boolean | null
  expires: string | null
  servers: string[]
  subscribed: boolean
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

const TIERS: ReadonlyArray<Tier> = ['bronze', 'silver', 'gold', 'kids', 'unknown']

const isTier = (value: unknown): value is Tier =>
  typeof value === 'string' && TIERS.some((tier) => tier === value)

const isMember = (value: unknown): value is Member =>
  isRecord(value) &&
  typeof value.member === 'string' &&
  typeof value.email === 'string' &&
  isTier(value.tier) &&
  (typeof value.downloads === 'boolean' || value.downloads === null) &&
  (typeof value.expires === 'string' || value.expires === null) &&
  isStringArray(value.servers) &&
  typeof value.subscribed === 'boolean'

const isMemberArray = (value: unknown): value is Member[] =>
  Array.isArray(value) && value.every(isMember)

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
  if (!isMemberArray(data)) {
    throw new Error('Unexpected members response')
  }
  return data
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
  if (!isMember(data)) {
    throw new Error('Unexpected member response')
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
