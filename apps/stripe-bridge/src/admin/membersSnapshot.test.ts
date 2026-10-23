import { afterEach, describe, expect, it } from 'vitest'
import { fetchUpstream } from '@/admin/membersSnapshot.js'
import { asBridge, fakeBridge, slowUsers } from '@/test/fakes.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'

afterEach(removeTempDirs)

describe('independent Wizarr reads', () => {
  it('the members sweep does not queue the fast reads behind the users list', async () => {
    const fake = fakeBridge({ dbPath: tempDbPath() })
    fake.store.init()
    const { users, release } = slowUsers()
    fake.wizarr.listUsers.mockReturnValue(users)

    const upstream = fetchUpstream(asBridge(fake))

    expect(fake.wizarr.listLibraries).toHaveBeenCalledOnce()
    expect(fake.wizarr.listInvitations).toHaveBeenCalledOnce()
    release()
    expect((await upstream).users).toEqual([{ id: 1, email: 'a@x.com' }])
  })
})
