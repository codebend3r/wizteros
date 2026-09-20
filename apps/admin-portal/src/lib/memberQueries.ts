import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { fetchMembers, type Member } from '@/lib/adminApi'

// The members call is a ~15s Wizarr fan-out, so every page that wants the list
// shares one key and one staleness window rather than paying for it again.
export const MEMBERS_QUERY_KEY = ['members'] as const

const MEMBERS_STALE_MS = 5 * 60 * 1000

// The per-member keys the member page reads. Spelled once so a cache patch and
// the query that owns the entry can never drift apart.
export const memberKeys = {
  member: (email: string) => ['member', email] as const,
  plexAccess: (email: string) => ['plex-access', email] as const,
  notes: (email: string) => ['member-notes', email] as const,
  events: (email: string) => ['member-events', email] as const,
}

/** The shared members list query, identical wherever it is read. */
export const membersQueryOptions = () =>
  queryOptions({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: () => fetchMembers(),
    staleTime: MEMBERS_STALE_MS,
  })

type PatchMemberArgs = {
  queryClient: QueryClient
  email: string
  patch: (row: Member) => Member
  /**
   * Appended to the list when no row matches, for an address that has only
   * just become a member. Left out, an unmatched list is untouched.
   */
  insert?: Member
}

/**
 * Apply one change to both places a member is cached: their own detail entry
 * and their row in the members list. Addresses are compared case-insensitively
 * because the bridge, Stripe, and the admin's typing disagree about casing.
 */
export const patchMember = ({ queryClient, email, patch, insert }: PatchMemberArgs): void => {
  const key = email.toLowerCase()
  queryClient.setQueryData<Member | null>(memberKeys.member(email), (old) =>
    old ? patch(old) : old,
  )
  queryClient.setQueryData<Member[]>(MEMBERS_QUERY_KEY, (old) => {
    if (!old) {
      return old
    }
    if (!old.some((row) => row.email.toLowerCase() === key)) {
      return insert ? [...old, insert] : old
    }
    return old.map((row) => (row.email.toLowerCase() === key ? patch(row) : row))
  })
}

export type MemberSnapshot = {
  member: Member | null | undefined
  members: Member[] | undefined
}

/** Both cached shapes as they stand, for an optimistic patch to roll back to. */
export const snapshotMember = ({
  queryClient,
  email,
}: {
  queryClient: QueryClient
  email: string
}): MemberSnapshot => ({
  member: queryClient.getQueryData<Member | null>(memberKeys.member(email)),
  members: queryClient.getQueryData<Member[]>(MEMBERS_QUERY_KEY),
})

/** Put a snapshot back after the write it was taken for failed. */
export const restoreMember = ({
  queryClient,
  email,
  snapshot,
}: {
  queryClient: QueryClient
  email: string
  snapshot: MemberSnapshot
}): void => {
  queryClient.setQueryData(memberKeys.member(email), snapshot.member)
  queryClient.setQueryData(MEMBERS_QUERY_KEY, snapshot.members)
}
