import { expect, test } from '@/test/vi'
import { createQueryClient } from '@/lib/queryClient'
import {
  memberKeys,
  MEMBERS_QUERY_KEY,
  patchMember,
  restoreMember,
  snapshotMember,
} from './memberQueries'
import type { Member } from './adminApi'

const member: Member = {
  email: 'a@x.com',
  member: 'a',
  tier: 'gold',
  downloads: true,
  expires: null,
  servers: [],
  libraries: {},
  entitled: {},
  subscribed: true,
  payment_state: null,
  invited_at: null,
  tag: null,
  customer_id: null,
  stripe_email: null,
}

test('rollback preserves another action on the same member and changes to other list rows', () => {
  const queryClient = createQueryClient()
  queryClient.setQueryData(memberKeys.member(member.email), member)
  queryClient.setQueryData(MEMBERS_QUERY_KEY, [member, { ...member, email: 'b@x.com' }])
  const snapshot = snapshotMember({ queryClient, email: member.email })
  patchMember({
    queryClient,
    email: member.email,
    patch: (row) => ({ ...row, downloads: false, tag: 'vip' }),
  })
  patchMember({ queryClient, email: 'b@x.com', patch: (row) => ({ ...row, tag: 'hvu' }) })
  restoreMember({
    queryClient,
    email: member.email,
    snapshot,
    restore: ({ row, previous }) => ({ ...row, downloads: previous.downloads }),
  })
  expect(queryClient.getQueryData(memberKeys.member(member.email))).toMatchObject({
    downloads: true,
    tag: 'vip',
  })
  expect(queryClient.getQueryData(MEMBERS_QUERY_KEY)).toMatchObject([
    { email: 'a@x.com', downloads: true, tag: 'vip' },
    { email: 'b@x.com', tag: 'hvu' },
  ])
})
