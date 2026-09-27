import { isoformat } from '@wizteros/server-common'
import { afterEach, describe, expect, it } from 'vitest'
import { BASELINE_TIERS, rotateBaselineInvites } from '@/baseline.js'
import { asBridge, type FakeBridge, fakeBridge } from '@/test/fakes.js'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import { resolveTierAccess, tierDownloads } from '@/tiers.js'
import type { Bridge, WizarrInvitation, WizarrLibrary } from '@/types.js'

const NOW = new Date(Date.UTC(2026, 7, 11, 3, 0))
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** NOW moved by `ms` milliseconds. */
const at = (ms: number): Date => new Date(NOW.getTime() + ms)

// Enough of Meleys to resolve every tier: the youth allowlist in full, plus a
// non-4K library bronze/silver/gold pick up and a 4K one bronze must exclude.
const LIBRARIES: readonly WizarrLibrary[] = [
  { id: 1, name: '01. Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 2, name: '02. 4K Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 3, name: '03. Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 4, name: '04. 4K Family Movies', server_id: 2, server_name: 'Meleys', enabled: true },
  { id: 14, name: '14. Kid Shows', server_id: 2, server_name: 'Meleys', enabled: true },
]

/** The arguments one createInvite call carried. */
type Created = Readonly<{
  code: string
  serverIds: readonly number[]
  expiresInDays: number
  duration: string
  unlimited: boolean
  libraryIds: readonly number[]
  allowDownloads: boolean
}>

/** What the Wizarr stand-in holds; tests rewrite `invitations` to simulate drift. */
type WizarrState = {
  libraries: readonly WizarrLibrary[]
  invitations: readonly WizarrInvitation[]
  created: readonly Created[]
  deleted: readonly number[]
  nextId: number
}

type Setup = Readonly<{ fake: FakeBridge; bridge: Bridge; client: WizarrState }>

/**
 * A fresh store and a Wizarr stand-in that records invites in memory.
 *
 * Starts with the given library list and any pre-existing invitations.
 */
const setup = ({
  libraries = LIBRARIES,
  invitations = [],
}: {
  libraries?: readonly WizarrLibrary[]
  invitations?: readonly WizarrInvitation[]
} = {}): Setup => {
  const fake = fakeBridge({ dbPath: tempDbPath() })
  fake.store.init()
  const client: WizarrState = { libraries, invitations, created: [], deleted: [], nextId: 100 }
  fake.wizarr.listLibraries.mockImplementation(async () => [...client.libraries])
  fake.wizarr.listInvitations.mockImplementation(async () => [...client.invitations])
  fake.wizarr.createInvite.mockImplementation(async (invite) => {
    client.nextId += 1
    const code = `CODE${client.nextId}`
    client.created = [
      ...client.created,
      {
        code,
        serverIds: [...invite.serverIds],
        expiresInDays: invite.expiresInDays,
        duration: invite.duration,
        unlimited: invite.unlimited ?? false,
        libraryIds: [...(invite.libraryIds ?? [])],
        allowDownloads: invite.allowDownloads ?? false,
      },
    ]
    client.invitations = [
      ...client.invitations,
      {
        id: client.nextId,
        code,
        unlimited: invite.unlimited ?? false,
        server_names: ['Meleys'],
        used_by: null,
        expires: isoformat(at(invite.expiresInDays * DAY_MS)),
      },
    ]
    return { code, url: `/j/${code}` }
  })
  fake.wizarr.deleteInvitation.mockImplementation(async (invitationId) => {
    client.deleted = [...client.deleted, invitationId]
    client.invitations = client.invitations.filter((inv) => inv.id !== invitationId)
  })
  return { fake, bridge: asBridge(fake), client }
}

describe('baseline invites', () => {
  afterEach(() => {
    removeTempDirs()
  })

  it('rotation mints one invite per tier', async () => {
    const { bridge } = setup()
    const result = await rotateBaselineInvites({ bridge, now: NOW })
    expect(result.minted.map((m) => m.tier).toSorted()).toEqual([...BASELINE_TIERS].toSorted())
    expect(BASELINE_TIERS).toHaveLength(4)
    expect(result.skipped).toEqual([])
  })

  it('minted invites are unlimited and carry an expiry', async () => {
    const { bridge, client } = setup()
    await rotateBaselineInvites({ bridge, now: NOW })
    expect(client.created.every((c) => c.unlimited)).toBe(true)
    expect(
      client.created.every((c) => c.expiresInDays === bridge.settings.baselineExpiresDays),
    ).toBe(true)
    expect(bridge.store.allBaselineInvites().every((row) => !!row.expires_at)).toBe(true)
  })

  it('minted scope matches the tier rules', async () => {
    const { bridge, client } = setup()
    await rotateBaselineInvites({ bridge, now: NOW })
    expect(client.created).toHaveLength(BASELINE_TIERS.length)
    BASELINE_TIERS.forEach((tier, i) => {
      const created = client.created[i]
      const access = resolveTierAccess({ tier, libraries: LIBRARIES })
      expect(created?.libraryIds).toEqual(access.library_ids)
      expect(created?.serverIds).toEqual(access.server_ids)
      expect(created?.allowDownloads).toBe(tierDownloads(tier))
    })
  })

  it('never deletes an invite it did not mint', async () => {
    const memberInvite: WizarrInvitation = {
      id: 9,
      code: 'MEMBER1',
      unlimited: false,
      server_names: ['Meleys'],
      used_by: null,
      expires: isoformat(at(-30 * DAY_MS)),
    }
    const { bridge, client } = setup({ invitations: [memberInvite] })
    await rotateBaselineInvites({ bridge, now: NOW })
    expect(client.deleted).not.toContain(9)
  })

  it('never deletes a baseline that is still live', async () => {
    const { bridge, client } = setup()
    await rotateBaselineInvites({ bridge, now: NOW })
    const mintedIds = client.invitations.map((inv) => inv.id)
    // One hour later nothing has expired yet, so the previous generation stands.
    await rotateBaselineInvites({ bridge, now: at(HOUR_MS) })
    expect(client.deleted).toEqual([])
    const stillHeld = new Set(client.invitations.map((inv) => inv.id))
    expect(mintedIds.every((id) => stillHeld.has(id))).toBe(true)
  })

  it('reaps the previous generation once it expires', async () => {
    const { bridge, client } = setup()
    await rotateBaselineInvites({ bridge, now: NOW })
    const first = new Set(client.invitations.map((inv) => inv.id))
    const later = at(bridge.settings.baselineExpiresDays * DAY_MS + HOUR_MS)
    await rotateBaselineInvites({ bridge, now: later })
    expect(new Set(client.deleted)).toEqual(first)
    expect(bridge.store.allBaselineInvites()).toHaveLength(BASELINE_TIERS.length)
  })

  it('broken tier is skipped and keeps its existing invite', async () => {
    // Drop the youth allowlist libraries so that tier resolves to nothing.
    const thin = LIBRARIES.filter((lib) => ['01. Movies', '02. 4K Movies'].includes(lib.name ?? ''))
    const { bridge } = setup({ libraries: thin })
    const result = await rotateBaselineInvites({ bridge, now: NOW })
    expect(result.skipped).toContain('youth')
    expect(result.minted.map((m) => m.tier)).not.toContain('youth')
  })
})
