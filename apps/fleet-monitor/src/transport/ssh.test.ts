import { spawn as spawnProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirs, tempDbPath } from '@/test/support.js'
import { buildArgv, classify, run, runLocal } from '@/transport/ssh.js'

// A fresh control directory per test, inside a temp dir that afterEach
// removes, instead of the fixed /tmp paths the Python tests left behind.
const controlDir = (): string => join(dirname(tempDbPath()), 'fm')

afterEach(removeTempDirs)

describe('buildArgv', () => {
  it('multiplexes and silences warnings', () => {
    const argv = buildArgv({
      host: '192.168.50.3',
      user: 'crivas',
      controlDir: '/tmp/fm',
      timeout: 15,
    })
    const joined = argv.join(' ')

    // LogLevel=ERROR is load bearing: current OpenSSH prints a post-quantum
    // key exchange warning on every connection to these DSM boxes
    expect(argv).toContain('-oLogLevel=ERROR')
    expect(argv).toContain('-oControlMaster=auto')
    expect(argv).toContain('-oControlPersist=300')
    expect(argv).toContain('-oBatchMode=yes')
    expect(argv).toContain('-oConnectTimeout=15')
    expect(joined).toContain('/tmp/fm/')
    expect(argv.slice(-2)).toEqual(['crivas@192.168.50.3', 'bash -s'])
  })

  it('never prompts', () => {
    // a prompt would hang the collector forever rather than fail the tick
    const argv = buildArgv({ host: 'h', user: 'u', controlDir: '/tmp/fm', timeout: 5 })
    expect(argv).toContain('-oBatchMode=yes')
  })
})

describe('classify', () => {
  it('names the reason', () => {
    expect(classify({ returncode: 255, stderr: 'Connection timed out' })).toBe('timeout')
    expect(classify({ returncode: 255, stderr: 'Permission denied (publickey).' })).toBe('auth')
    expect(classify({ returncode: 255, stderr: 'Connection refused' })).toBe('refused')
    expect(classify({ returncode: 255, stderr: 'No route to host' })).toBe('unreachable')
    expect(classify({ returncode: 255, stderr: 'something else entirely' })).toBe('ssh_error')
    expect(classify({ returncode: 1, stderr: '' })).toBe('command_failed')
  })
})

describe('run', () => {
  it('returns a typed failure for an unroutable host', async () => {
    // 192.0.2.1 is TEST-NET-1 and never answers. The Python test dialled it
    // for real; here a local shell answers the way ssh does when the connect
    // times out (the message on stderr, exit status 255), so the test needs
    // neither the network nor an ssh binary.
    const spawn = vi.fn((_command: string, _args: readonly string[]) =>
      spawnProcess('bash', [
        '-c',
        'echo "ssh: connect to host 192.0.2.1 port 22: Operation timed out" >&2; exit 255',
      ]),
    )

    const result = await run({
      host: '192.0.2.1',
      body: 'echo hi',
      user: 'tester',
      controlDir: controlDir(),
      timeout: 2,
      spawn,
    })

    expect(result.ok).toBe(false)
    expect(result.stdout).toBe('')
    expect(['timeout', 'unreachable', 'refused', 'ssh_error']).toContain(result.reason)
    expect(spawn).toHaveBeenCalledWith(
      'ssh',
      expect.arrayContaining(['-oConnectTimeout=2', 'tester@192.0.2.1', 'bash -s']),
    )
  })

  it('succeeds against a localhost shell', async () => {
    // exercises the happy path without needing the LAN: the transport shells
    // out, so a local bash proves the plumbing
    const result = await runLocal({ body: "echo '###hi'\necho body" })

    expect(result.ok).toBe(true)
    expect(result.stdout).toContain('###hi')
    expect(result.reason).toBe('')
  })

  it('returns a typed failure when ssh cannot be spawned', async () => {
    // spawns a binary that does not exist, so the spawn-time guard is proven
    // against the operating system's own ENOENT rather than a mock (the Python
    // test hid ssh from PATH to the same end)
    const result = await run({
      host: '192.0.2.1',
      body: 'echo hi',
      user: 'tester',
      controlDir: controlDir(),
      timeout: 1,
      spawn: (_command, args) =>
        spawnProcess('/nonexistent-empty-dir-for-fleet-monitor-tests/ssh', args),
    })

    expect(result.ok).toBe(false)
    expect(result.stdout).toBe('')
    expect(result.reason).toBe('spawn_error')
  })

  it('kills a capture that outlives its budget', async () => {
    // no Python counterpart: the Python test of an unroutable host could land
    // here by chance, depending on the network. A process that never answers
    // is killed at timeout times CAPTURE_FACTOR and reported as a timeout.
    const result = await run({
      host: '192.0.2.1',
      body: 'echo hi',
      user: 'tester',
      controlDir: controlDir(),
      timeout: 0.1,
      spawn: () => spawnProcess('sleep', ['30']),
    })

    expect(result).toEqual({ ok: false, stdout: '', reason: 'timeout' })
  })
})
