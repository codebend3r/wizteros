import { describe, expect, it } from 'vitest'
import { parseDf, parseGpuFreq, parseHwmon, parseInotify } from '@/probes/system.js'
import type { Sample } from '@/probes/types.js'

const byMetric = (samples: readonly Sample[]): Record<string, number> =>
  Object.fromEntries(samples.map((sample) => [sample.metric, sample.value]))

describe('parseDf', () => {
  it('reports bytes and percent', () => {
    // df -Pk output; -P forces one line per filesystem even for long device names
    const text =
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
      '/dev/mapper/cachedev_0 101815078912 99863519232 1951559680 99% /volume1\n'
    const got = byMetric(parseDf(text))

    expect(got['disk.volume1.total_bytes']).toBe(101815078912 * 1024)
    expect(got['disk.volume1.used_bytes']).toBe(99863519232 * 1024)
    expect(got['disk.volume1.available_bytes']).toBe(1951559680 * 1024)
    expect(got['disk.volume1.used_percent']).toBe(99)
  })

  it('handles the LVM and crypt device names', () => {
    // caraxes uses /dev/vg1/volume_1 and meleys uses /dev/mapper/cryptvol_1
    const text =
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
      '/dev/vg1/volume_1 28991029248 24696061952 3652116480 88% /volume1\n'
    const got = byMetric(parseDf(text))

    expect(got['disk.volume1.used_percent']).toBe(88)
  })

  it('skips rows with non-numeric usage', () => {
    // tmpfs and proc filesystems often report - for capacity/usage columns
    const text =
      'Filesystem 1024-blocks Used Available Capacity Mounted on\n' +
      '/dev/mapper/good_fs 1000000 500000 500000 50% /volume1\n' +
      'tmpfs 1000000 - - - /run\n' +
      '/dev/mapper/another_good 2000000 1000000 1000000 50% /volume2\n'
    const got = byMetric(parseDf(text))

    // Good rows parse, bad row with dashes is silently skipped
    expect(got['disk.volume1.used_percent']).toBe(50)
    expect(got['disk.volume2.used_percent']).toBe(50)
    expect(got).not.toHaveProperty(['disk.run.used_percent'])
  })
})

describe('parseHwmon', () => {
  it('reads millidegrees', () => {
    // the collector emits one "<chip> <label>=<millidegrees>" line per sensor
    const text = 'coretemp temp1_input=41000\ncoretemp temp2_input=39000\n'
    const got = byMetric(parseHwmon(text))

    expect(got['temp.coretemp.temp1']).toBe(41)
    expect(got['temp.coretemp.temp2']).toBe(39)
  })
})

describe('parseGpuFreq', () => {
  it('emits a ratio', () => {
    // vermithor and vhagar idle at 100 MHz against a 750 MHz ceiling
    const got = byMetric(parseGpuFreq('100\n750\n'))

    expect(got['gpu.freq_mhz']).toBe(100)
    expect(got['gpu.freq_max_mhz']).toBe(750)
    expect(got['gpu.freq_ratio']).toBe(100 / 750)
  })

  it('is absent on boxes without a render node', () => {
    // meleys, syrax and caraxes have no /dev/dri, so the script emits nothing
    expect(parseGpuFreq('')).toEqual([])
  })

  it('survives a zero ceiling', () => {
    expect(byMetric(parseGpuFreq('0\n0\n'))).not.toHaveProperty(['gpu.freq_ratio'])
  })

  it('returns nothing on non-numeric multi-token input', () => {
    // transient cat error with multiple tokens (e.g. cat: read error)
    expect(parseGpuFreq('cat: read error\n')).toEqual([])
    expect(parseGpuFreq('abc def\n')).toEqual([])
  })
})

describe('parseInotify', () => {
  it('reports ceilings and usage', () => {
    // both docker hosts sit at 262144 watches after the 2026-08-08 raise
    const text = 'max_user_watches=262144\nmax_user_instances=1024\ninstances_in_use=37\n'
    const got = byMetric(parseInotify(text))

    expect(got['inotify.max_user_watches']).toBe(262144)
    expect(got['inotify.max_user_instances']).toBe(1024)
    expect(got['inotify.instances_in_use']).toBe(37)
    expect(got['inotify.instances_used_ratio']).toBe(37 / 1024)
  })

  it('skips an unreadable value', () => {
    // cat failing leaves the key with an empty value, which must not become 0
    const got = byMetric(parseInotify('max_user_watches=\nmax_user_instances=1024\n'))

    expect(got).not.toHaveProperty(['inotify.max_user_watches'])
    expect(got['inotify.max_user_instances']).toBe(1024)
  })
})

describe('the system parsers', () => {
  it('are total on empty input', () => {
    expect(parseDf('')).toEqual([])
    expect(parseHwmon('')).toEqual([])
    expect(parseInotify('')).toEqual([])
  })
})
