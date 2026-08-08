import type { PlexServerAccess } from '@/lib/adminApi'

/**
 * How one library stands between what the tier grants and what Plex is doing.
 *
 * - `shared`: the tier grants it and plex.tv confirms the share — the normal case.
 * - `not-shared`: the tier grants it but plex.tv is not sharing it. A member
 *   mid-invite reads entirely like this; so does a share that was severed.
 * - `not-entitled`: plex.tv is sharing it but no tier grants it. Legacy access
 *   left over from before the tier rules, e.g. the retired servers.
 * - `unknown`: plex.tv could not be read, so sharing cannot be claimed either way.
 */
export type LibraryAccessState = 'shared' | 'not-shared' | 'not-entitled' | 'unknown'

export type LibraryAccess = {
  library: string
  state: LibraryAccessState
}

export type ServerAccess = {
  server: string
  /** Whether any tier rule grants anything on this server at all. */
  entitled: boolean
  libraries: LibraryAccess[]
  entitledCount: number
  /** How many libraries plex.tv actually shares here, entitled or not. */
  sharedCount: number
}

const LABELS: Record<LibraryAccessState, string> = {
  shared: 'shared',
  'not-shared': 'not shared',
  'not-entitled': 'not entitled',
  unknown: 'unknown',
}

/** The wording shown beside each library, so state never rides on colour alone. */
export const stateLabel = (state: LibraryAccessState): string => LABELS[state]

const resolveState = ({
  isEntitled,
  isShared,
}: {
  isEntitled: boolean
  isShared: boolean | null
}): LibraryAccessState => {
  if (isShared === null) {
    return 'unknown'
  }
  if (isEntitled) {
    return isShared ? 'shared' : 'not-shared'
  }
  return 'not-entitled'
}

/**
 * Merge the tier's entitlement with the live plex.tv share into one list per server.
 *
 * `entitled` is what the member's tier grants (the bridge derives it from the
 * tier rules); `sharing` is what plex.tv actually reports, or null when it
 * could not be read. Keeping the two apart until here is the point — the page
 * used to collapse them, so a member mid-invite and a member with real access
 * rendered identically.
 */
export const buildServerAccess = ({
  entitled,
  sharing,
}: {
  entitled: Record<string, string[]>
  sharing: Record<string, PlexServerAccess> | null
}): ServerAccess[] => {
  const servers = [...new Set([...Object.keys(entitled), ...Object.keys(sharing ?? {})])].sort(
    (a, b) => a.localeCompare(b),
  )
  return servers.map((server) => {
    const entitledNames = entitled[server] ?? []
    const entitledSet = new Set(entitledNames)
    const serverShare = sharing?.[server] ?? null
    const sharedNames = serverShare?.libraries ?? []
    // allLibraries means the share covers the whole server, so a library the
    // tier grants counts as shared even when plex did not enumerate it.
    const sharesEverything = !!serverShare?.all_libraries
    const sharedSet = new Set(sharedNames)

    const resolved = [...new Set([...entitledNames, ...sharedNames])]
      .sort((a, b) => a.localeCompare(b))
      .map((library) => {
        const isShared = sharing === null ? null : sharesEverything || sharedSet.has(library)
        return {
          library,
          isShared,
          state: resolveState({ isEntitled: entitledSet.has(library), isShared }),
        }
      })

    return {
      server,
      entitled: entitledNames.length > 0,
      libraries: resolved.map(({ library, state }) => ({ library, state })),
      entitledCount: entitledNames.length,
      sharedCount: resolved.filter(({ isShared }) => isShared).length,
    }
  })
}
