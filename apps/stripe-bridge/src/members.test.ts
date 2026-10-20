import { afterEach, describe, expect, it } from 'vitest'
import { identitySnapshot } from '@/members.js'
import { asBridge, fakeBridge, slowUsers } from '@/test/fakes.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'

afterEach(removeTempDirs)

describe('identitySnapshot', () => {
  it('the identity snapshot asks for invitations without waiting on users', async () => {
    const fake = fakeBridge({ dbPath: tempDbPath() })
    fake.store.init()
    const { users, release } = slowUsers()
    fake.wizarr.listUsers.mockReturnValue(users)

    const snapshot = identitySnapshot(asBridge(fake))

    expect(fake.wizarr.listInvitations).toHaveBeenCalledOnce()
    release()
    expect((await snapshot).users).toHaveLength(1)
  })
})
