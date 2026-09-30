import type { Sample } from '@/probes/types.js'

/** One container as GET /containers/json describes it. */
export type ContainerState = Readonly<{
  name: string
  running: boolean
  health: string
}>

// A decoded JSON object, as opposed to an array or a scalar: the one shape
// whose fields can be read.
const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const health = (status: string): string => {
  if (status.includes('(healthy)')) {
    return 'healthy'
  }
  if (status.includes('(unhealthy)')) {
    return 'unhealthy'
  }
  return 'none'
}

/**
 * Container state from GET /containers/json?all=1.
 *
 * A malformed entry is skipped rather than raised on: one bad row must not
 * cost the whole host's container view.
 *
 * An entry whose first name is empty is skipped too. It would yield metrics
 * shaped `container..up`, which the web's container pattern cannot match, and
 * an incident against `container:<host>/`: an invisible container carrying an
 * invisible incident.
 */
export const parseContainers = (payload: readonly unknown[]): readonly ContainerState[] =>
  payload.filter(isObject).flatMap((entry): readonly ContainerState[] => {
    const names = entry.Names
    const first: unknown = Array.isArray(names) ? names[0] : undefined
    const name = typeof first === 'string' ? first.replace(/^\/+/, '') : ''
    if (name === '') {
      return []
    }
    const status = entry.Status
    return [
      {
        name,
        running: entry.State === 'running',
        health: health(typeof status === 'string' ? status : ''),
      },
    ]
  })

/**
 * Up, health, and has_healthcheck gauges, one triple per container.
 *
 * `healthy` means a healthcheck ran and passed, nothing weaker. Most
 * containers on this fleet declare no healthcheck at all, and folding that
 * into `healthy` would assert a check passed that was never run; dropping the
 * sample instead would read as failing one. So the third gauge carries
 * whether there is a check to believe, and the UI says plain "Up" when there
 * is not.
 *
 * No restart count: GET /containers/json never returns RestartCount, only
 * `docker inspect` does, so a gauge built from this endpoint would read as a
 * constant zero forever, indistinguishable from a container nothing has ever
 * had to restart.
 */
export const toSamples = (states: readonly ContainerState[]): readonly Sample[] =>
  states.flatMap((state): readonly Sample[] => [
    {
      metric: `container.${state.name}.up`,
      value: state.running ? 1 : 0,
      kind: 'gauge',
    },
    {
      metric: `container.${state.name}.healthy`,
      value: state.health === 'healthy' && state.running ? 1 : 0,
      kind: 'gauge',
    },
    {
      metric: `container.${state.name}.has_healthcheck`,
      value: state.health === 'none' ? 0 : 1,
      kind: 'gauge',
    },
  ])

/**
 * One container as a reader sees it, rebuilt from the stored gauges.
 *
 * `healthy` is only meaningful when `has_healthcheck` is true. Most
 * containers on this fleet declare no healthcheck, and that is neither a pass
 * nor a failure.
 */
export type ContainerView = Readonly<{
  name: string
  up: boolean
  healthy: boolean
  has_healthcheck: boolean
}>

// The three gauges `toSamples` writes per container, and the only place their
// names are taken apart again. Flattening to `container.<name>.<field>` is what
// a time series needs; a reader needs the objects back. Both halves live here
// so the naming cannot drift from the parsing: the SPA used to re-derive this
// with a regex of its own, a wire away from the code that chose the names.
const FIELDS = ['up', 'healthy', 'has_healthcheck'] as const

const PREFIX = 'container.'

/** Rebuild the container list from one host's latest gauges, name-sorted. */
export const fromSamples = (
  metrics: Readonly<Record<string, number>>,
): readonly ContainerView[] => {
  const names = new Set(
    Object.keys(metrics).flatMap((metric) =>
      FIELDS.filter((field) => metric.startsWith(PREFIX) && metric.endsWith(`.${field}`)).map(
        (field) => {
          // removeprefix, then removesuffix: the suffix is only cut when the
          // remainder still ends with it
          const rest = metric.slice(PREFIX.length)
          const suffix = `.${field}`
          return rest.endsWith(suffix) ? rest.slice(0, -suffix.length) : rest
        },
      ),
    ),
  )
  return [...names].toSorted().map((name): ContainerView => ({
    name,
    up: metrics[`container.${name}.up`] === 1,
    healthy: metrics[`container.${name}.healthy`] === 1,
    has_healthcheck: metrics[`container.${name}.has_healthcheck`] === 1,
  }))
}
