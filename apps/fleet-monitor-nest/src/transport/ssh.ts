import { type ChildProcessWithoutNullStreams, spawn as spawnProcess } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { constants } from 'node:os'
import { text } from 'node:stream/consumers'
import { setTimeout as sleep } from 'node:timers/promises'

// Matched against stderr in order, first hit wins. The needles are disjoint
// except for "timed out", which is deliberately the loose form: it also covers
// ssh's "Operation timed out", so listing that separately would be unreachable.
const REASONS: readonly (readonly [string, string])[] = [
  ['timed out', 'timeout'],
  ['Permission denied', 'auth'],
  ['Host key verification failed', 'auth'],
  ['Connection refused', 'refused'],
  ['No route to host', 'unreachable'],
  ['Network is unreachable', 'unreachable'],
]

// A whole capture gets this multiple of the connect timeout before the process
// is killed: connecting is only the first half of the budget, and the script
// still has to run and stream back. Named so callers that have to reason about
// how long a round can take can derive it rather than guess.
export const CAPTURE_FACTOR = 2

export type SshResult = Readonly<{
  ok: boolean
  stdout: string
  reason: string
}>

/**
 * Start one process with every stdio stream piped. `run` and `runLocal` take
 * one so a test can stand a local process in for ssh; the default is the real
 * `spawn`.
 */
export type Spawn = (command: string, args: readonly string[]) => ChildProcessWithoutNullStreams

const spawnPiped: Spawn = (command, args) => spawnProcess(command, args)

/**
 * Name why a run failed. A wrong key and a powered-off NAS must never look
 * identical in the incident log.
 */
export const classify = ({
  returncode,
  stderr,
}: {
  returncode: number
  stderr: string
}): string => {
  if (returncode === 0) {
    return ''
  }
  if (returncode !== 255) {
    return 'command_failed'
  }
  return REASONS.find(([needle]) => stderr.includes(needle))?.[1] ?? 'ssh_error'
}

/**
 * Argv for one multiplexed, non-interactive run.
 *
 * ControlMaster plus ControlPersist means the TCP handshake and key exchange
 * happen once per five minutes rather than once per tick. BatchMode is what
 * keeps a missing key a fast failure instead of a hung prompt.
 */
export const buildArgv = ({
  host,
  user,
  controlDir,
  timeout,
}: {
  host: string
  user: string
  controlDir: string
  timeout: number
}): readonly string[] => [
  'ssh',
  '-oLogLevel=ERROR',
  '-oBatchMode=yes',
  '-oStrictHostKeyChecking=accept-new',
  '-oControlMaster=auto',
  `-oControlPath=${controlDir}/%r@%h:%p`,
  '-oControlPersist=300',
  `-oConnectTimeout=${timeout}`,
  `${user}@${host}`,
  'bash -s',
]

const failure = (reason: string): SshResult => ({ ok: false, stdout: '', reason })

// A spawn that fails for a reason of the system's (no such binary, no
// permission, out of file descriptors) is a system error, with a syscall on
// it; anything else is a bug in the caller and is left to raise.
const isSystemError = (error: unknown): boolean => error instanceof Error && 'syscall' in error

// What Python reported as the returncode: the exit status, or the negated
// signal number when a signal ended the process.
const returncode = ({
  code,
  signal,
}: {
  code: number | null
  signal: NodeJS.Signals | null
}): number => code ?? (signal === null ? 0 : -constants.signals[signal])

const closed = (child: ChildProcessWithoutNullStreams): Promise<number> =>
  new Promise((resolve) => {
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) =>
      resolve(returncode({ code, signal })),
    )
  })

const exited = (child: ChildProcessWithoutNullStreams): Promise<void> =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => {
        child.once('exit', () => resolve())
      })

// The work's result, or null when the deadline passed first. The timer is
// cancelled as soon as the work settles, so a finished capture does not hold
// the event loop open for the rest of its budget.
const within = async <T>({
  work,
  seconds,
}: {
  work: Promise<T>
  seconds: number
}): Promise<T | null> => {
  const cancel = new AbortController()
  const expired = sleep(seconds * 1000, null, { signal: cancel.signal }).catch(() => null)
  try {
    return await Promise.race([work, expired])
  } finally {
    cancel.abort()
  }
}

const start = ({
  spawn,
  argv,
}: {
  spawn: Spawn
  argv: readonly string[]
}): ChildProcessWithoutNullStreams | null => {
  const [command, ...args] = argv
  try {
    const child = spawn(command, args)
    // the failure of an asynchronous spawn still arrives as an 'error' event,
    // which would crash the process with no listener
    child.on('error', () => undefined)
    // pid is only ever undefined for a process that never started
    return child.pid === undefined ? null : child
  } catch (error) {
    if (isSystemError(error)) {
      return null
    }
    throw error
  }
}

const capture = async ({
  argv,
  body,
  timeout,
  spawn,
}: {
  argv: readonly string[]
  body: string
  timeout: number
  spawn: Spawn
}): Promise<SshResult> => {
  const child = start({ spawn, argv })
  if (child === null) {
    // the binary itself could not be spawned: missing from PATH, no
    // permission, or the OS is out of file descriptors. Never let this cross
    // the boundary as a raw stack trace.
    return failure('spawn_error')
  }

  // a process that exits before reading its script closes the pipe under the
  // write; Python's communicate() swallows that broken pipe, and so does this
  child.stdin.on('error', () => undefined)
  child.stdin.end(body)

  const captured = await within({
    work: Promise.all([text(child.stdout), text(child.stderr), closed(child)]),
    seconds: timeout * CAPTURE_FACTOR,
  })
  if (captured === null) {
    child.kill('SIGKILL')
    await exited(child)
    return failure('timeout')
  }

  const [stdout, stderr, code] = captured
  const reason = classify({ returncode: code, stderr })
  return { ok: !reason, stdout: reason ? '' : stdout, reason }
}

/** Run a script on a host over a multiplexed connection. */
export const run = async ({
  host,
  body,
  user,
  controlDir = '/tmp/fm',
  timeout = 15,
  spawn = spawnPiped,
}: {
  host: string
  body: string
  user: string
  controlDir?: string
  timeout?: number
  spawn?: Spawn
}): Promise<SshResult> => {
  await mkdir(controlDir, { recursive: true, mode: 0o700 })
  const argv = buildArgv({ host, user, controlDir, timeout })
  return capture({ argv, body, timeout, spawn })
}

/**
 * Run a script through a local bash. Used by tests to exercise the capture
 * path without needing the LAN.
 */
export const runLocal = ({
  body,
  timeout = 15,
  spawn = spawnPiped,
}: {
  body: string
  timeout?: number
  spawn?: Spawn
}): Promise<SshResult> => capture({ argv: ['bash', '-s'], body, timeout, spawn })
