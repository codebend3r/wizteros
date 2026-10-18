import { expect, test } from '@/test/vi'
import { reissueInviteNote } from '@/components/ConfirmInviteModal/ConfirmInviteModal'

test('reissue explains preserved access and the uncovered-server exception', () => {
  const note = reissueInviteNote({ tier: 'gold' })
  expect(note).toContain('Gold-scoped')
  expect(note).toContain('kept until')
  expect(note).toContain('does not cover a current server')
})
