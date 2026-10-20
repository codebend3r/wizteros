// The inventory pass: every movie, show and artist section paged to its end,
// so never-played has something to diff against, and the folder exclusion
// rule applied to the section listing.

import { Logger } from '@nestjs/common'
import { type Host, plexExcludedPaths } from '@/config.js'
import { session } from '@/db.js'
import * as plays from '@/plays/index.js'
import * as plex from '@/probes/plex.js'
import {
  pageAll,
  type PlexClient,
  plexClient,
  type Transport,
  transport,
} from '@/plexSync/client.js'

const log = new Logger('fleet.plex')

export const LIBRARY_PAGE = 1000

/**
 * True when `path` is the excluded folder or something inside it.
 *
 * Compared on whole segments, so /volume1/Caraxes/tmp never matches a sibling
 * called tmp-restore, and case-insensitively, because the servers spell the
 * same share both ways and the mount is case-preserving either way.
 */
const under = ({ path, folder }: { path: string; folder: string }): boolean => {
  const inside = path.replace(/\/+$/, '').toLowerCase()
  const outer = folder.replace(/\/+$/, '').toLowerCase()
  return inside === outer || inside.startsWith(`${outer}/`)
}

/**
 * The section ids whose every folder sits under an excluded one.
 *
 * Every, not any: a library pointed at both a scratch folder and a real one
 * is a library the page still has to count, and dropping it whole because one
 * of its paths matched would lose plays nobody asked to lose. A section with
 * no folder at all is never excluded, since there is no path to judge.
 */
export const excludedSections = ({
  sections,
  folders,
}: {
  sections: readonly plex.Section[]
  folders: readonly string[]
}): ReadonlySet<string> =>
  new Set(
    sections
      .filter(
        (section) =>
          section.locations.length > 0 &&
          section.locations.every((path) => folders.some((folder) => under({ path, folder }))),
      )
      .map((section) => section.section_id),
  )

/**
 * Every leaf item of one section, a page per session, all stamped with this
 * run. Returns the failure reason, or empty when the last page landed.
 */
const pageSection = ({
  client,
  path,
  section,
  now,
  pageSize,
}: {
  client: PlexClient
  path: string
  section: plex.Section
  now: Date
  pageSize: number
}): Promise<string> =>
  pageAll({
    client,
    request: {
      path: `/library/sections/${section.section_id}/all`,
      params: { type: String(plex.LEAF_TYPE[section.kind]), includeGuids: '0' },
    },
    pageSize,
    keep: (payload) => {
      // the listing does not name its own section on each row
      const items = plex.parseItems({ payload, sectionId: section.section_id })
      session({
        path,
        work: (connection) =>
          plays.upsertItems({ connection, host: client.host.name, items, seenAt: now }),
      })
    },
  })

/**
 * One host's inventory pass. True when every section paged to its end.
 *
 * Items are retired only after a complete run. A section that failed on page
 * three left its remaining items unseen this run, and retiring them would
 * make a third of a library look deleted because a request timed out.
 *
 * This is also where the exclusion rule is applied, because this is the one
 * pass that reads the section listing and so the one that can tell which
 * library sits in an excluded folder. Excluded sections are marked, their
 * plays and items deleted, and their listings never paged, so the history
 * pass that runs before the next inventory already knows to drop them.
 */
export const syncLibrary = async ({
  host,
  path,
  now,
  token,
  pageSize = LIBRARY_PAGE,
  via = transport(),
}: {
  host: Host
  path: string
  now: Date
  token: string
  pageSize?: number
  via?: Transport
}): Promise<boolean> => {
  if (!host.plex_url || !token) {
    return false
  }
  const client = plexClient({ host, token, via })
  const sections = await client.get({ path: '/library/sections' })
  if (!sections.ok) {
    session({
      path,
      work: (connection) =>
        plays.markLibrary({
          connection,
          host: host.name,
          at: now,
          ok: false,
          error: sections.reason,
        }),
    })
    log.warn(`inventory for ${host.name} failed: ${sections.reason}`)
    return false
  }
  const parsed = plex.parseSections(sections.payload)
  const excluded = excludedSections({ sections: parsed, folders: plexExcludedPaths() })
  const purged = session({
    path,
    work: (connection) => {
      plays.upsertSections({ connection, host: host.name, sections: parsed, excludedIds: excluded })
      return plays.purgeSections({ connection, host: host.name, sectionIds: excluded })
    },
  })
  if (purged.plays || purged.items) {
    log.log(
      `inventory for ${host.name} purged ${purged.plays} plays and ${purged.items} items ` +
        'from excluded libraries',
    )
  }

  // One section after another, and every one of them even after a failure;
  // the failure kept is the last one, as the Python loop overwrote it.
  const failure = await parsed.reduce<Promise<string>>(async (previous, section) => {
    const earlier = await previous
    if (excluded.has(section.section_id)) {
      return earlier
    }
    const reason = await pageSection({ client, path, section, now, pageSize })
    if (reason) {
      log.warn(`inventory for ${host.name} stopped in '${section.title}': ${reason}`)
      return reason
    }
    return earlier
  }, Promise.resolve(''))
  const complete = !failure
  session({
    path,
    work: (connection) => {
      if (complete) {
        const retired = plays.retireUnseenItems({ connection, host: host.name, seenBefore: now })
        if (retired) {
          log.log(`inventory for ${host.name} retired ${retired} items`)
        }
      }
      plays.markLibrary({
        connection,
        host: host.name,
        at: now,
        ok: complete,
        error: failure || null,
      })
    },
  })
  return complete
}
