import { describe, expect, it } from 'vitest'
import { MEM_KEYS, lines } from '@/probes/proc.js'
import { SLOW_SCRIPT, VITALS_SCRIPT, splitSections } from '@/probes/script.js'
import { fixtureText } from '@/test/support.js'

describe('splitSections', () => {
  it('keys the sections by sentinel', () => {
    const text = '###stat\ncpu 1 2 3\n###meminfo\nMemTotal: 4 kB\n'
    expect(splitSections(text)).toEqual({
      stat: 'cpu 1 2 3\n',
      meminfo: 'MemTotal: 4 kB\n',
    })
  })

  it('ignores the preamble before the first sentinel', () => {
    // a login banner or an ssh warning that slipped past LogLevel=ERROR
    const text = 'warning: something\n###stat\ncpu 1 2 3\n'
    expect(splitSections(text)).toEqual({ stat: 'cpu 1 2 3\n' })
  })

  it('keeps an empty section empty', () => {
    // a host with no render node emits the gpu sentinel with nothing under it,
    // which must read as "collected, nothing there", not as a missing section
    const text = '###stat\ncpu 1 2 3\n###gpu\n###loadavg\n0.1 0.2 0.3 1/2 3\n'
    const sections = splitSections(text)

    expect(sections.gpu).toBe('')
    expect('gpu' in sections).toBe(true)
  })

  it('is empty on empty input', () => {
    expect(splitSections('')).toEqual({})
  })

  it('anchors the sentinel to the start of a line', () => {
    // Sentinels mid-line in a body must not be treated as section boundaries.
    // This guards against Docker container names or other values containing ###.
    const text = '###stat\nvalue###middle\nmore data\n###meminfo\nMemTotal: 1 kB\n'
    const sections = splitSections(text)

    expect(sections.stat).toBe('value###middle\nmore data\n')
    expect(sections.meminfo).toBe('MemTotal: 1 kB\n')
    expect(Object.keys(sections)).toHaveLength(2)
  })
})

describe('the scripts', () => {
  it('covers every vitals source in the vitals script', () => {
    expect(VITALS_SCRIPT).toContain('###stat')
    expect(VITALS_SCRIPT).toContain('/proc/stat')
    expect(VITALS_SCRIPT).toContain('###meminfo')
    expect(VITALS_SCRIPT).toContain('###netdev')
    expect(VITALS_SCRIPT).toContain('###loadavg')
    expect(VITALS_SCRIPT).toContain('###uptime')
  })

  it('tolerates a missing render node in the vitals script', () => {
    // the gpu read must not fail the script on the three boxes without /dev/dri
    expect(VITALS_SCRIPT).toContain('gt_act_freq_mhz')
    expect(VITALS_SCRIPT).toContain('2>/dev/null')
  })

  it('covers disk and temperature in the slow script', () => {
    expect(SLOW_SCRIPT).toContain('###df')
    expect(SLOW_SCRIPT).toContain('df -Pk')
    expect(SLOW_SCRIPT).toContain('###hwmon')
  })

  it('reads inotify headroom in the slow script', () => {
    // meleys ran out of inotify watches once already; a second media server
    // scanning the same libraries doubles the demand, so track the ceiling
    expect(SLOW_SCRIPT).toContain('###inotify')
    expect(SLOW_SCRIPT).toContain('max_user_watches')
    expect(SLOW_SCRIPT).toContain('max_user_instances')
  })

  it('does not use set -e in either script', () => {
    // a missing optional source must not abort the remaining sections
    expect(VITALS_SCRIPT).not.toContain('set -e')
    expect(SLOW_SCRIPT).not.toContain('set -e')
  })

  it('captures every meminfo key the parser reads in the vitals script', () => {
    // Derive the head count from VITALS_SCRIPT and apply it to a real kernel's
    // /proc/meminfo, captured from caraxes. A synthetic meminfo would encode
    // the very assumption under test (its own key ordering), so only a real
    // one is evidence that `head -n N` reaches SwapTotal and SwapFree.
    const match = /head -n (\d+) \/proc\/meminfo/.exec(VITALS_SCRIPT)
    expect(match, 'meminfo head command not found in VITALS_SCRIPT').not.toBeNull()
    const headCount = Number(match?.[1] ?? 0)

    const realMeminfo = lines(fixtureText('caraxes_proc_meminfo.txt'))
    expect(realMeminfo.length, 'fixture is shorter than the head count').toBeGreaterThanOrEqual(
      headCount,
    )
    const capturedMeminfo = realMeminfo.slice(0, headCount).join('\n')

    // All keys from MEM_KEYS must be present in the captured lines
    Array.from(MEM_KEYS.keys()).forEach((key) => {
      expect(
        capturedMeminfo,
        `'${key}' from MEM_KEYS not reachable within head -n ${headCount} in VITALS_SCRIPT`,
      ).toContain(key)
    })
  })
})
