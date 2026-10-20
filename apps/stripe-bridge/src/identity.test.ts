import { describe, expect, it } from 'vitest'
import { everyRecord, type IdentitySnapshot, identityFor } from '@/identity.js'
import type { WizarrInvitation, WizarrUser } from '@/types.js'

const USERS: readonly WizarrUser[] = [
  { id: 1, username: 'pat', email: 'Pat@x.com', server: 'Meleys' },
  { id: 2, username: 'pat', email: 'pat@x.com', server: 'Vhagar' },
  { id: 7, username: 'nora', email: 'watches@x.com', server: 'Meleys' },
  { id: 8, username: 'nora', email: 'watches@x.com', server: 'Syrax' },
  { id: 281, username: 'local', email: null, server: 'Meleys' },
]

const snapshot = ({
  users = USERS,
  invitations = [],
  links = new Map(),
  invites = new Map(),
}: {
  users?: readonly WizarrUser[]
  invitations?: readonly WizarrInvitation[]
  links?: ReadonlyMap<string, string>
  invites?: ReadonlyMap<string, string>
} = {}): IdentitySnapshot => ({ users, invitations, links, invites })

const ids = (records: readonly WizarrUser[]): number[] => records.map((record) => record.id)

describe('identityFor', () => {
  it("finds a member's records by their own address, ignoring case", () => {
    const identity = identityFor({ snapshot: snapshot(), email: 'PAT@x.com', inviteCode: null })
    expect(ids(identity.records)).toEqual([1, 2])
    expect(identity.addresses).toEqual(new Set(['pat@x.com']))
    expect(identity.via).toBe('email')
  })

  it("prefers the member's own address over a link and an invite", () => {
    const identity = identityFor({
      snapshot: snapshot({
        links: new Map([['pat@x.com', 'watches@x.com']]),
        invitations: [{ id: 1, code: 'abc', used_by: '<User 281>' }],
      }),
      email: 'pat@x.com',
      inviteCode: 'abc',
    })
    expect(ids(identity.records)).toEqual([1, 2])
  })

  it('uses a linked address before the invite code', () => {
    // A stated identity beats an inferred one, and beats an invite nobody used.
    const identity = identityFor({
      snapshot: snapshot({
        links: new Map([['pays@x.com', 'watches@x.com']]),
        invitations: [{ id: 1, code: 'abc', used_by: '<User 281>' }],
      }),
      email: 'pays@x.com',
      inviteCode: 'abc',
    })
    expect(ids(identity.records)).toEqual([7, 8])
    expect(identity.via).toBe('link')
  })

  it('falls back to the account that redeemed the invite, on every server', () => {
    const identity = identityFor({
      snapshot: snapshot({ invitations: [{ id: 1, code: 'abc', used_by: '<User 7>' }] }),
      email: 'pays@x.com',
      inviteCode: 'abc',
    })
    expect(ids(identity.records)).toEqual([7, 8])
    expect(identity.addresses).toEqual(new Set(['pays@x.com', 'watches@x.com']))
    expect(identity.via).toBe('invite')
  })

  it('resolves a redeemer named by username', () => {
    const identity = identityFor({
      snapshot: snapshot({ invitations: [{ id: 1, code: 'abc', used_by: 'Nora' }] }),
      email: null,
      inviteCode: 'abc',
    })
    expect(ids(identity.records)).toEqual([7, 8])
  })

  it('keeps the one record of a redeemer with no email', () => {
    const identity = identityFor({
      snapshot: snapshot({ invitations: [{ id: 1, code: 'abc', used_by: '<User 281>' }] }),
      email: null,
      inviteCode: 'abc',
    })
    expect(ids(identity.records)).toEqual([281])
    expect(identity.addresses).toEqual(new Set())
  })

  it('tolerates a padded repr', () => {
    // The JS mirrors (sales-agent, member-triage, stripe-reconcile) accept the
    // repr with surrounding whitespace; the bridge is the enforcement path and
    // must classify the same strings the same way.
    const identity = identityFor({
      snapshot: snapshot({ invitations: [{ id: 1, code: 'abc', used_by: ' <User 7> ' }] }),
      email: null,
      inviteCode: 'abc',
    })
    expect(ids(identity.records)).toEqual([7, 8])
  })

  it('finds nothing for an unredeemed invite, or a redeemer no longer on the server', () => {
    const unredeemed = snapshot({ invitations: [{ id: 1, code: 'abc', used_by: null }] })
    const gone = snapshot({ invitations: [{ id: 1, code: 'abc', used_by: '<User 999>' }] })
    expect(identityFor({ snapshot: unredeemed, email: 'new@x.com', inviteCode: 'abc' })).toEqual({
      addresses: new Set(['new@x.com']),
      records: [],
      via: 'none',
    })
    expect(identityFor({ snapshot: gone, email: null, inviteCode: 'abc' }).records).toEqual([])
  })

  it('only follows the invite when there is a code to follow', () => {
    const identity = identityFor({
      snapshot: snapshot({ invitations: [{ id: 1, code: 'abc', used_by: '<User 7>' }] }),
      email: 'new@x.com',
      inviteCode: null,
    })
    expect(identity.records).toEqual([])
  })

  it('collects both halves of a link from either side', () => {
    const links = new Map([
      ['pays@x.com', 'watches@x.com'],
      ['old@x.com', 'watches@x.com'],
      ['else@x.com', 'other@x.com'],
    ])
    const person = new Set(['pays@x.com', 'old@x.com', 'watches@x.com'])
    const fromPayer = identityFor({
      snapshot: snapshot({ links }),
      email: 'pays@x.com',
      inviteCode: null,
    })
    const fromPlex = identityFor({
      snapshot: snapshot({ links }),
      email: 'watches@x.com',
      inviteCode: null,
    })
    expect(fromPayer.addresses).toEqual(person)
    expect(fromPlex.addresses).toEqual(person)
  })

  it("follows the redeemer's own links into the person", () => {
    const identity = identityFor({
      snapshot: snapshot({
        links: new Map([['card@x.com', 'watches@x.com']]),
        invitations: [{ id: 1, code: 'abc', used_by: '<User 8>' }],
      }),
      email: 'pays@x.com',
      inviteCode: 'abc',
    })
    expect(identity.addresses).toEqual(new Set(['pays@x.com', 'watches@x.com', 'card@x.com']))
  })

  it('joins a payer to the Plex account that redeemed their invite, from either side', () => {
    // An admin tags the member list's row, which is the Plex account; Stripe
    // bills the payer. Without this the two never read as one person.
    const linked = snapshot({
      invitations: [{ id: 1, code: 'abc', used_by: '<User 7>' }],
      invites: new Map([['pays@x.com', 'abc']]),
    })
    const person = new Set(['pays@x.com', 'watches@x.com'])
    expect(
      identityFor({ snapshot: linked, email: 'pays@x.com', inviteCode: null }).addresses,
    ).toEqual(person)
    expect(
      identityFor({ snapshot: linked, email: 'watches@x.com', inviteCode: null }).addresses,
    ).toEqual(person)
  })

  it('lets a stated link outrank the one a redemption implies', () => {
    const identity = identityFor({
      snapshot: snapshot({
        links: new Map([['pays@x.com', 'pat@x.com']]),
        invitations: [{ id: 1, code: 'abc', used_by: '<User 7>' }],
        invites: new Map([['pays@x.com', 'abc']]),
      }),
      email: 'pays@x.com',
      inviteCode: null,
    })
    expect(identity.addresses).toEqual(new Set(['pays@x.com', 'pat@x.com']))
  })

  it('implies nothing from an unredeemed invite or one redeemed under the same address', () => {
    const identity = identityFor({
      snapshot: snapshot({
        invitations: [
          { id: 1, code: 'new', used_by: null },
          { id: 2, code: 'own', used_by: '<User 1>' },
        ],
        invites: new Map([
          ['new@x.com', 'new'],
          ['pat@x.com', 'own'],
        ]),
      }),
      email: 'pat@x.com',
      inviteCode: null,
    })
    expect(identity.addresses).toEqual(new Set(['pat@x.com']))
  })
})

describe('everyRecord', () => {
  it("collects the person's records under every address, without repeats", () => {
    const linked = snapshot({ links: new Map([['pat@x.com', 'watches@x.com']]) })
    const identity = identityFor({ snapshot: linked, email: 'pat@x.com', inviteCode: null })
    expect(identity.records.map((record) => record.id)).toEqual([1, 2])
    expect(everyRecord({ snapshot: linked, identity }).map((record) => record.id)).toEqual([
      1, 2, 7, 8,
    ])
  })

  it('keeps an email-less redeemer the identity was found by', () => {
    const linked = snapshot({ invitations: [{ id: 1, code: 'abc', used_by: '<User 281>' }] })
    const identity = identityFor({ snapshot: linked, email: null, inviteCode: 'abc' })
    expect(everyRecord({ snapshot: linked, identity }).map((record) => record.id)).toEqual([281])
  })
})
