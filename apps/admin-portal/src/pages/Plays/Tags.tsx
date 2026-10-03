import type { NeverPlayedKind, PlayKind } from '@/lib/playsApi'
import { seriesClass } from '@/pages/Fleet/seriesPalette'
import { KIND_LABEL, NEVER_KIND_LABEL } from '@/pages/Plays/playsCopy'
import { serverName } from '@/pages/Plays/playsFormat'
import styles from '@/pages/Plays/DataTable.module.scss'

type Kind = PlayKind | NeverPlayedKind

const LABEL: Readonly<Record<Kind, string>> = { ...KIND_LABEL, ...NEVER_KIND_LABEL }

const TONE: Readonly<Record<Kind, string>> = {
  movie: styles.movie,
  episode: styles.tv,
  show: styles.tv,
  track: styles.audio,
  album: styles.audio,
}

type ServerTagProps = {
  readonly host: string
  /** Every Plex host in config order, the order the chart colours them by:
      a host's position here is the colour its bars wear above. */
  readonly hosts: readonly string[]
}

/** One server as a pill in its chart colour, named as a proper noun. The
    name says which server, so the colour is never the only cue. */
export const ServerTag = ({ host, hosts }: ServerTagProps) => (
  <span className={`${styles.pill} ${styles.server} ${seriesClass(hosts.indexOf(host))}`}>
    <span className={styles.dot} aria-hidden="true" />
    {serverName(host)}
  </span>
)

type ServerTagsProps = {
  readonly servers: readonly string[]
  readonly hosts: readonly string[]
}

/** Every server a row was played on, a pill each, or a dash for none. */
export const ServerTags = ({ servers, hosts }: ServerTagsProps) =>
  servers.length === 0 ? (
    '--'
  ) : (
    <span className={styles.tags}>
      {servers.map((host) => (
        <ServerTag key={host} host={host} hosts={hosts} />
      ))}
    </span>
  )

/** A play's or a shelf item's type as a pill: movies violet, TV and shows
    cyan, audio and albums silver, each with its name inside. */
export const KindTag = ({ kind }: { readonly kind: Kind }) => (
  <span className={`${styles.pill} ${styles.kind} ${TONE[kind]}`}>{LABEL[kind]}</span>
)
