import { describe, expect, it } from 'vitest'
import {
  type ContainerState,
  type ContainerView,
  fromSamples,
  parseContainers,
  toSamples,
} from '@/probes/docker.js'

const payload = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  Names: ['/sonarr'],
  State: 'running',
  Status: 'Up 11 days',
  Labels: {},
  ...overrides,
})

const byMetric = (states: readonly ContainerState[]): Record<string, number> =>
  Object.fromEntries(toSamples(states).map((sample) => [sample.metric, sample.value]))

describe('parseContainers', () => {
  it('strips the leading slash', () => {
    const states = parseContainers([payload()])

    expect(states[0].name).toBe('sonarr')
    expect(states[0].running).toBe(true)
  })

  it('reads health from the status string', () => {
    expect(parseContainers([payload({ Status: 'Up 8 days (healthy)' })])[0].health).toBe('healthy')
    expect(parseContainers([payload({ Status: 'Up 2 minutes (unhealthy)' })])[0].health).toBe(
      'unhealthy',
    )
    expect(parseContainers([payload({ Status: 'Up 11 days' })])[0].health).toBe('none')
  })

  it('marks a stopped container down', () => {
    const states = parseContainers([payload({ State: 'exited', Status: 'Exited (0) 3 hours ago' })])

    expect(states[0].running).toBe(false)
    expect(states[0].health).toBe('none')
  })

  it('handles a missing names field', () => {
    // a malformed payload must not kill the tick
    expect(parseContainers([{ State: 'running' }])).toEqual([])
  })

  it('is empty on an empty payload', () => {
    expect(parseContainers([])).toEqual([])
  })

  it('skips an empty first name', () => {
    // an empty name yields metrics shaped `container..up`, which the web's
    // container pattern cannot match, and an incident against `container:host/`:
    // an invisible container carrying an invisible incident
    expect(parseContainers([payload({ Names: [''] })])).toEqual([])
    expect(parseContainers([payload({ Names: ['/'] })])).toEqual([])
  })
})

describe('toSamples', () => {
  it('emits up and healthy gauges', () => {
    const states = parseContainers([
      payload({ Names: ['/sonarr'], Status: 'Up 8 days (healthy)' }),
      payload({ Names: ['/radarr'], State: 'exited', Status: 'Exited (0) 3 hours ago' }),
    ])
    const got = byMetric(states)

    expect(got['container.sonarr.up']).toBe(1)
    expect(got['container.radarr.up']).toBe(0)
    expect(got['container.sonarr.healthy']).toBe(1)
  })

  it('separates a failing healthcheck from an absent one', () => {
    // "no healthcheck configured" is not "healthcheck passed": claiming the
    // latter asserts a check ran that never did. The third gauge is what lets
    // the UI say plain "Up" instead of guessing either way.
    const states = parseContainers([
      payload({ Names: ['/passing'], Status: 'Up 8 days (healthy)' }),
      payload({ Names: ['/failing'], Status: 'Up 2 minutes (unhealthy)' }),
      payload({ Names: ['/unchecked'], Status: 'Up 11 days' }),
    ])
    const got = byMetric(states)

    expect(got['container.passing.healthy']).toBe(1)
    expect(got['container.passing.has_healthcheck']).toBe(1)
    expect(got['container.failing.healthy']).toBe(0)
    expect(got['container.failing.has_healthcheck']).toBe(1)
    expect(got['container.unchecked.healthy']).toBe(0)
    expect(got['container.unchecked.has_healthcheck']).toBe(0)
  })

  it('never emits a restart count sample', () => {
    // GET /containers/json never returns RestartCount, so a sample built from
    // it would read as a constant zero forever, indistinguishable from a
    // genuinely healthy container. Never re-add this without an inspect-based
    // source for the field.
    const metrics = toSamples(parseContainers([payload()])).map((sample) => sample.metric)

    expect(metrics.some((metric) => metric.endsWith('.restart_count'))).toBe(false)
  })
})

describe('fromSamples', () => {
  it('round-trips the samples back into containers', () => {
    // The gauge names and the code that takes them apart live in one module,
    // so this is the pin that keeps them symmetric. The SPA used to re-derive
    // this with a regex of its own, a wire away from the names it was matching.
    const states: readonly ContainerState[] = [
      { name: 'plex', running: true, health: 'healthy' },
      { name: 'radarr', running: false, health: 'none' },
      { name: 'sonarr', running: true, health: 'none' },
    ]

    expect(fromSamples(byMetric(states))).toEqual([
      { name: 'plex', up: true, healthy: true, has_healthcheck: true },
      { name: 'radarr', up: false, healthy: false, has_healthcheck: false },
      { name: 'sonarr', up: true, healthy: false, has_healthcheck: false },
    ] satisfies readonly ContainerView[])
  })

  it('ignores metrics that are not containers', () => {
    expect(fromSamples({ 'load.1m': 0.4, 'mem.total_bytes': 1 })).toEqual([])
  })

  it('names a container with dots in its name', () => {
    const metrics = {
      'container.web.api.up': 1,
      'container.web.api.healthy': 0,
      'container.web.api.has_healthcheck': 0,
    }

    expect(fromSamples(metrics)).toEqual([
      { name: 'web.api', up: true, healthy: false, has_healthcheck: false },
    ] satisfies readonly ContainerView[])
  })
})
