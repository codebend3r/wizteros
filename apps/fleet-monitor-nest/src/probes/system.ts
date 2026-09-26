import { number, ratio } from '@/probes/parse.js'
import { lines, splitOnce, words } from '@/probes/proc.js'
import type { Sample } from '@/probes/types.js'

const BLOCK_BYTES = 1024

// df -Pk column order after the filesystem name.
const TOTAL = 1
const USED = 2
const AVAILABLE = 3
const CAPACITY = 4
const MOUNT = 5

/**
 * Volume usage from `df -Pk <mount>`.
 *
 * -P is required: without it df wraps long device names onto a second line,
 * and the fleet runs three different naming schemes (/dev/mapper/cachedev_0,
 * /dev/mapper/cryptvol_1, /dev/vg1/volume_1).
 */
export const parseDf = (text: string): readonly Sample[] =>
  lines(text)
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map(words)
    .flatMap((fields): readonly Sample[] => {
      if (fields.length <= MOUNT) {
        return []
      }
      const total = number(fields[TOTAL])
      const used = number(fields[USED])
      const available = number(fields[AVAILABLE])
      const capacity = number(fields[CAPACITY].replace(/%+$/, ''))
      if (total === null || used === null || available === null || capacity === null) {
        return []
      }
      const name = fields[MOUNT].replace(/^\/+/, '').replaceAll('/', '_') || 'root'
      return [
        { metric: `disk.${name}.total_bytes`, value: total * BLOCK_BYTES, kind: 'gauge' },
        { metric: `disk.${name}.used_bytes`, value: used * BLOCK_BYTES, kind: 'gauge' },
        { metric: `disk.${name}.available_bytes`, value: available * BLOCK_BYTES, kind: 'gauge' },
        { metric: `disk.${name}.used_percent`, value: capacity, kind: 'gauge' },
      ]
    })

/**
 * Chip temperatures from lines shaped `<chip> <label>_input=<millidegrees>`.
 *
 * The collector flattens the hwmon tree into that shape because the sysfs
 * layout differs across the fleet; only vermithor exposes a coretemp chip at
 * hwmon0.
 */
export const parseHwmon = (text: string): readonly Sample[] =>
  lines(text)
    .filter((line) => line.includes('='))
    .map(words)
    .flatMap((fields): readonly Sample[] => {
      if (fields.length < 2) {
        return []
      }
      // str.partition("="): a sensor word with no `=` is all key and no value
      const [key, raw = ''] = splitOnce({ text: fields[1], separator: '=' })
      const millidegrees = number(raw)
      const label = key.endsWith('_input') ? key.slice(0, -'_input'.length) : key
      return millidegrees === null
        ? []
        : [{ metric: `temp.${fields[0]}.${label}`, value: millidegrees / 1000, kind: 'gauge' }]
    })

/**
 * Inotify ceilings and instance usage from `key=value` lines.
 *
 * Tracked because meleys exhausted its watch limit once already (raised from
 * 8192 to 262144 on 2026-08-08). Running a second media server against the
 * same libraries doubles the demand on the same ceiling, so the headroom is
 * worth watching rather than rediscovering the hard way.
 */
export const parseInotify = (text: string): readonly Sample[] => {
  // a Map keeps a repeated key where it first appeared with the value it last
  // had, as the Python dict comprehension did
  const values: ReadonlyMap<string, number> = new Map(
    lines(text)
      .filter((line) => line.includes('='))
      .flatMap((line): readonly (readonly [string, number])[] => {
        const [key, raw = ''] = splitOnce({ text: line, separator: '=' })
        const value = number(raw.trim())
        return value === null ? [] : [[key, value]]
      }),
  )
  return [
    ...[...values].map(([key, value]): Sample => ({
      metric: `inotify.${key}`,
      value,
      kind: 'gauge',
    })),
    ...ratio({
      metric: 'inotify.instances_used_ratio',
      value: values.get('instances_in_use') ?? null,
      ceiling: values.get('max_user_instances') ?? 0,
    }),
  ]
}

/**
 * Intel i915 frequency from gt_act_freq_mhz and gt_max_freq_mhz.
 *
 * This is a load proxy, not a utilization percentage. DSM ships no
 * intel_gpu_top and does not expose the i915 perf interface, so a true busy
 * percentage is not obtainable.
 *
 * Only vermithor and vhagar have a render node at all. Verified 2026-08-11:
 * meleys has no /dev/dri, an empty /sys/class/drm, and no amdgpu or radeon
 * module loaded, because Synology does not enable the Vega iGPU on the
 * R1600. That is a permanent property of the box, not a missing driver, so
 * anything transcoding on meleys is doing it in software on 2 physical cores.
 */
export const parseGpuFreq = (text: string): readonly Sample[] => {
  const fields = words(text)
  if (fields.length < 2) {
    return []
  }
  const current = number(fields[0])
  const ceiling = number(fields[1])
  if (current === null || ceiling === null) {
    return []
  }
  return [
    { metric: 'gpu.freq_mhz', value: current, kind: 'gauge' },
    { metric: 'gpu.freq_max_mhz', value: ceiling, kind: 'gauge' },
    ...ratio({ metric: 'gpu.freq_ratio', value: current, ceiling }),
  ]
}
