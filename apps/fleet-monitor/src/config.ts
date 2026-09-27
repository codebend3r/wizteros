import {
  type AdminAuthConfig,
  parseEmailAllowlist,
  parseList,
  trimTrailingSlashes,
} from '@wizteros/server-common'
import { CAPTURE_FACTOR } from '@/transport/ssh.js'

/** The port the compose healthcheck and the Funnel's /monitor path both reach. */
export const PORT = 8010

export const VITALS_INTERVAL = 30
export const SLOW_INTERVAL = 900

// ssh connect budgets for the two tiers. transport/ssh gives a whole capture
// CAPTURE_FACTOR times the connect timeout before it kills the process, so the
// wall-clock ceiling of one probe is the product, not the timeout itself.
export const VITALS_TIMEOUT = 15
export const SLOW_TIMEOUT = 30

// The longest one collection round can legitimately take. Both tiers fan every
// host out concurrently, so fleet size does not enter into it; a slow round is
// the two tiers in series, each bounded by its own capture ceiling. Anything
// that measures the distance between rounds has to allow for this, because a
// round's own duration lands inside that distance.
//
// The factor is imported from the transport that spends it rather than restated
// here, so the two cannot drift apart.
export const MAX_ROUND_SECONDS = (VITALS_TIMEOUT + SLOW_TIMEOUT) * CAPTURE_FACTOR

// The two play-history cadences. History is Plex's own ledger of completed
// views, cheap to re-read (500 rows in a tenth of a second), so five minutes
// keeps the page within a coffee of the present. The inventory pages every
// section of every server, tens of thousands of episodes and tracks on meleys
// alone, so it runs six-hourly: a title added this morning shows up under
// never-played by the afternoon, and the servers are not asked to list their
// whole libraries a dozen times a day for that.
export const PLEX_HISTORY_INTERVAL = 300
export const PLEX_LIBRARY_INTERVAL = 6 * 3600

const DEFAULT_PLEX_LOOKBACK_DAYS = 365

// Library folders the play page is not about. Caraxes keeps a scratch tree of
// tutorials, home videos, documents and assignments under /volume1/Caraxes/tmp
// that Plex indexes as four movie libraries; their plays and their items are
// neither shared nor interesting, and they crowd the page's own numbers.
//
// A path, not a library name, because a library is renamed far more easily
// than it is moved, and the rule is about the folder.
const DEFAULT_PLEX_EXCLUDED_PATHS: readonly string[] = ['/volume1/Caraxes/tmp']

export type Host = Readonly<{
  name: string
  ip: string
  has_gpu: boolean
  docker_url: string
  // Empty means "no Plex here", the same contract docker_url follows.
  plex_url: string
}>

/** A host, frozen, with `plex_url` defaulting to empty like the Python dataclass. */
export const host = ({
  name,
  ip,
  has_gpu,
  docker_url,
  plex_url = '',
}: {
  name: string
  ip: string
  has_gpu: boolean
  docker_url: string
  plex_url?: string
}): Host => Object.freeze({ name, ip, has_gpu, docker_url, plex_url })

// Measured 2026-08-10, GPU absence re-verified 2026-08-11.
//
// has_gpu is a permanent property, not a pending driver fix. Only vermithor
// (Celeron J3455) and vhagar (Celeron J4125) expose a render node. meleys has
// no /dev/dri, an empty /sys/class/drm and no amdgpu module because Synology
// does not enable the R1600's Vega iGPU; syrax is an Atom C3538 with no iGPU;
// caraxes is ARMv8 with 1.6 GB.
//
// Core count is deliberately not a field here. /proc/stat already reports one
// row per cpu on every tick, so the collector observes it; declaring it as well
// would be a second copy to keep in step, and the fleet is not uniform (the
// R1600 is 2 physical cores presenting 4 threads).
//
// docker_url is set where Docker exists: vermithor, meleys, and vhagar since
// 2026-08-11. caraxes is aarch64 and Container Manager is x86-only there.
// The container list under each is discovered per tick, so a new stack member
// needs no change here; only a host gaining Docker does.
//
// Measured 2026-08-15: all three refuse on :2375. vermithor runs Docker on a
// local unix socket, which this url cannot address, and meleys and vhagar need
// a socket proxy that is not deployed yet. So every docker fetch fails on every
// tick until all three have a reachable TCP endpoint. That failure is recorded
// against the docker: target only; the containers behind it are never
// observed, so no container result is recorded either way. See collector.
//
// plex_url: Plex Media Server runs natively on all five (measured 2026-09-18,
// all on 1.43.4). vermithor and vhagar require secure connections and close a
// plain-http socket without a response, so they are addressed over https;
// the certificate they present is Plex's *.plex.direct wildcard, which cannot
// verify against a LAN ip, so plex sync connects to an https url with
// verification off. The owner token still authorizes every request.
export const HOSTS: readonly Host[] = Object.freeze([
  host({
    name: 'meleys',
    ip: '192.168.50.2',
    has_gpu: false,
    docker_url: 'http://192.168.50.2:2375',
    plex_url: 'http://192.168.50.2:32400',
  }),
  host({
    name: 'vermithor',
    ip: '192.168.50.3',
    has_gpu: true,
    docker_url: 'http://192.168.50.3:2375',
    plex_url: 'https://192.168.50.3:32400',
  }),
  host({
    name: 'caraxes',
    ip: '192.168.50.4',
    has_gpu: false,
    docker_url: '',
    plex_url: 'http://192.168.50.4:32400',
  }),
  host({
    name: 'syrax',
    ip: '192.168.50.5',
    has_gpu: false,
    docker_url: '',
    plex_url: 'http://192.168.50.5:32400',
  }),
  host({
    name: 'vhagar',
    ip: '192.168.50.6',
    has_gpu: true,
    docker_url: 'http://192.168.50.6:2375',
    plex_url: 'https://192.168.50.6:32400',
  }),
])

/**
 * The fleet's Plex hosts in config order, which is the order every by-host
 * list keeps: the portal binds one colour per position, the same binding the
 * fleet page uses.
 */
export const plexHosts = (hosts: readonly Host[] = HOSTS): readonly Host[] =>
  hosts.filter((candidate) => !!candidate.plex_url)

/** Where the SQLite file lives. /data is the container's mounted volume. */
export const dbPath = (): string => process.env.FM_DB_PATH ?? '/data/fleet.db'

/** The unprivileged account that holds the shared key on all five boxes. */
export const sshUser = (): string => process.env.FM_SSH_USER ?? 'crivas'

/**
 * The Supabase project and admins behind every gated route, from the
 * monitor's FM_-prefixed variables. Read when the guard asks rather than
 * captured at import; a container's environment is fixed at start, so an
 * edited .env still needs the container recreated.
 */
export const adminAuthConfig = (): AdminAuthConfig => ({
  supabaseUrl: trimTrailingSlashes(process.env.FM_SUPABASE_URL),
  allowedEmails: parseEmailAllowlist(process.env.FM_ADMIN_ALLOWED_EMAILS),
})

/**
 * The Plex owner token, or empty when none is configured.
 *
 * The monitor prefixes its own config FM_, but the bridge already keeps this
 * exact token as PLEX_TOKEN in the .env every compose service reads, so the
 * fallback means the play-history collector works with no new variable. An
 * empty answer is "not configured": plex sync idles on it rather than sending
 * unauthenticated requests that every server would refuse.
 */
export const plexToken = (): string => process.env.FM_PLEX_TOKEN || process.env.PLEX_TOKEN || ''

/**
 * How far back the first history backfill reaches, in days.
 *
 * Bounds only the initial pull; nothing stored is ever pruned by it. A value
 * that is not a positive integer falls back to a year rather than turning a
 * typo into a zero-day backfill or a crash at container start.
 */
export const plexLookbackDays = (): number => {
  const raw = (process.env.FM_PLEX_LOOKBACK_DAYS ?? '').trim()
  const days = /^[+-]?\d+$/.test(raw) ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_PLEX_LOOKBACK_DAYS
}

/**
 * Library folders whose plays and items the ledger never keeps.
 *
 * A comma-separated FM_PLEX_EXCLUDED_PATHS replaces the default list, and an
 * empty one switches the rule off entirely: an operator who wants everything
 * counted says so with an empty value rather than by editing this file.
 */
export const plexExcludedPaths = (): readonly string[] => {
  const raw = process.env.FM_PLEX_EXCLUDED_PATHS
  return raw === undefined ? DEFAULT_PLEX_EXCLUDED_PATHS : parseList(raw)
}
