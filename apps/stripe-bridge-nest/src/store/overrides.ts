import { asRow, asRows, fields, flag, type Row } from '@wizteros/server-common'
import { isMemberTag, type MemberTag } from '@/standing.js'
import type { Units } from '@/store/units.js'

// The admin's per-member overrides: notes, a tag, a downloads toggle, and the
// link from a paying address to the Plex account it pays for. Each is one
// table keyed by a lowercased address with one value column, so all four are
// the same small store.

/**
 * One address-keyed table: read one value, write or clear one, read them all.
 * `encode` turns a value into what the column holds and `decode` reads it
 * back, answering null for a stored value it does not recognise, which then
 * reads as absent. The key is always stored lowercased.
 */
const addressKeyed = <T>({
  units,
  table,
  key,
  column,
  encode,
  decode,
}: {
  units: Units
  table: string
  key: string
  column: string
  encode: (value: T) => string | number
  decode: (row: Row) => T | null
}) => ({
  get: ({ address }: { address: string }): T | null => {
    const row = units.read((connection) =>
      asRow(
        connection
          .prepare(`SELECT ${column} FROM ${table} WHERE ${key} = ?`)
          .get(address.toLowerCase()),
      ),
    )
    return row ? decode(row) : null
  },

  /** Upsert the value, or delete the row when it is null. */
  set: ({ address, value }: { address: string; value: T | null }): void => {
    units.write((connection) =>
      value === null
        ? connection.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(address.toLowerCase())
        : connection
            .prepare(
              `INSERT INTO ${table} (${key}, ${column}) VALUES (?, ?) ` +
                `ON CONFLICT(${key}) DO UPDATE SET ${column} = excluded.${column}`,
            )
            .run(address.toLowerCase(), encode(value)),
    )
  },

  all: (): ReadonlyMap<string, T> =>
    new Map(
      units
        .read((connection) =>
          asRows(connection.prepare(`SELECT ${key}, ${column} FROM ${table}`).all()),
        )
        .flatMap((row) => {
          const value = decode(row)
          return value === null ? [] : [[fields(row).text(key), value] as const]
        }),
    ),
})

const same = (text: string): string => text

export const overrideStore = (units: Units) => {
  const notes = addressKeyed({
    units,
    table: 'member_notes',
    key: 'email',
    column: 'notes',
    encode: same,
    decode: (row) => fields(row).text('notes'),
  })
  const tags = addressKeyed({
    units,
    table: 'member_tags',
    key: 'email',
    column: 'tag',
    encode: (tag: MemberTag) => tag,
    decode: (row) => {
      const tag = fields(row).text('tag')
      return isMemberTag(tag) ? tag : null
    },
  })
  const downloads = addressKeyed({
    units,
    table: 'member_downloads',
    key: 'email',
    column: 'allow',
    encode: flag,
    decode: (row) => !!fields(row).number('allow'),
  })
  const links = addressKeyed({
    units,
    table: 'member_links',
    key: 'stripe_email',
    column: 'plex_email',
    encode: (plexEmail: string) => plexEmail.toLowerCase(),
    decode: (row) => fields(row).text('plex_email'),
  })

  return {
    /** The admin's free-form notes for an email; empty string when none saved. */
    getMemberNotes: ({ email }: { email: string }): string => notes.get({ address: email }) ?? '',

    /** Save (overwrite) the admin's notes for an email. */
    setMemberNotes: ({ email, notes: text }: { email: string; notes: string }): void =>
      notes.set({ address: email, value: text }),

    /** The member's manual designation, or null when untagged. */
    getMemberTag: ({ email }: { email: string }): MemberTag | null => tags.get({ address: email }),

    /** Save the manual designation for an email; null clears it. */
    setMemberTag: ({ email, tag }: { email: string; tag: MemberTag | null }): void =>
      tags.set({ address: email, value: tag }),

    /** Map lowercased email -> manual tag for every tagged member. */
    allMemberTags: (): ReadonlyMap<string, MemberTag> => tags.all(),

    /** The downloads override for an email; null when the tier default applies. */
    getMemberDownloads: ({ email }: { email: string }): boolean | null =>
      downloads.get({ address: email }),

    /** Save the admin's downloads override for an email. */
    setMemberDownloads: ({ email, allow }: { email: string; allow: boolean }): void =>
      downloads.set({ address: email, value: allow }),

    /** Map lowercased email -> downloads override for every overridden member. */
    allMemberDownloads: (): ReadonlyMap<string, boolean> => downloads.all(),

    /** The Plex address this Stripe address pays for, or null when unlinked. */
    getMemberLink: ({ stripeEmail }: { stripeEmail: string }): string | null =>
      links.get({ address: stripeEmail }),

    /**
     * Record that `stripeEmail` bills for the person watching as `plexEmail`.
     *
     * A null `plexEmail` clears the link, which puts the Stripe address back on
     * the members list as its own row. Both are stored lowercased, the same key
     * the customer map and the Wizarr user join use.
     */
    setMemberLink: ({
      stripeEmail,
      plexEmail,
    }: {
      stripeEmail: string
      plexEmail: string | null
    }): void => links.set({ address: stripeEmail, value: plexEmail }),

    /** Map lowercased Stripe address -> the Plex address it pays for. */
    allMemberLinks: (): ReadonlyMap<string, string> => links.all(),
  }
}
