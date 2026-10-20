// The operational plumbing the skill scripts share: where the NAS is, how to
// run one command on it, and the two upstream reads every audit makes (a
// Stripe list walked to the end, a Wizarr GET). Each script used to carry its
// own copy of these, and the copies had started to differ.
//
// Everything here only reads. Nothing takes a request body or a method other
// than GET, and a failed request reports its status alone: an error body can
// echo the request back, and an API key must never reach stdout or a trace.
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** scripts/nas-host.sh, which builds a host's ssh target from the repo's .env. */
export const NAS_HOST_SCRIPT = fileURLToPath(
  new URL('../../../scripts/nas-host.sh', import.meta.url),
)

/**
 * Non-interactive and quick to give up: a script must fail rather than hang on
 * a password prompt or a host that is down.
 */
export const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']

/** The NAS ssh target: WZ_NAS_HOST, else what scripts/nas-host.sh builds from the repo's .env. */
export const nasHost = ({ env = process.env, run = execFileSync } = {}) =>
  env.WZ_NAS_HOST || run(NAS_HOST_SCRIPT, ['meleys'], { encoding: 'utf8', env }).trim()

/**
 * Run one command on the NAS and resolve to its stdout.
 *
 * One-shot ssh only. The command is a single argv element, so it never passes
 * through a local shell (and a bare local `cd` never hits a zoxide alias); the
 * remote login shell still parses it, so quote anything that is not a literal.
 */
export const ssh = async ({
  command,
  host = nasHost(),
  maxBuffer = 16 * 1024 * 1024,
  run = execFileAsync,
}) => {
  const { stdout } = await run('ssh', [...SSH_OPTIONS, host, command], { maxBuffer })
  return stdout
}

/** A failed GET, carrying the status so a caller can tell a 404 from an outage. */
const failed = ({ label, status }) =>
  Object.assign(new Error(`${label} responded ${status}`), { status })

/**
 * One Stripe GET, parsed. `path` is relative to /v1 (`customers`,
 * `subscriptions`); `params` is anything URLSearchParams takes, so repeated
 * keys such as `expand[]` go in as pairs.
 */
export const stripeGet = async ({ key, path, params = [], fetch = globalThis.fetch }) => {
  const route = path.replace(/^\/+/, '')
  const query = new URLSearchParams(params).toString()
  const res = await fetch(`https://api.stripe.com/v1/${route}${query ? `?${query}` : ''}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) {
    throw failed({ label: `Stripe GET /v1/${route}`, status: res.status })
  }
  return res.json()
}

/**
 * Every object a Stripe list endpoint holds. Stripe caps a page at 100, so this
 * walks `has_more` with `starting_after` until a page says it is the last, or
 * comes back empty.
 */
export const stripeList = async ({ key, path, params = [], fetch = globalThis.fetch }) => {
  const pairs = [...new URLSearchParams(params)].filter(([name]) => name !== 'limit')
  const collect = async ({ acc, startingAfter }) => {
    const page = await stripeGet({
      key,
      path,
      fetch,
      params: [
        ...pairs,
        ['limit', '100'],
        ...(startingAfter ? [['starting_after', startingAfter]] : []),
      ],
    })
    const data = page.data ?? []
    const rows = [...acc, ...data]
    return page.has_more && data.length
      ? collect({ acc: rows, startingAfter: data.at(-1).id })
      : rows
  }
  return collect({ acc: [], startingAfter: null })
}

/**
 * One Wizarr API GET, parsed. /api/users reconciles with every Plex server on
 * each call and routinely takes ~15s, so the default ceiling is generous.
 */
export const wizarrGet = async ({
  base,
  key,
  path,
  timeoutMs = 60_000,
  fetch = globalThis.fetch,
}) => {
  const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
    headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    throw failed({ label: `Wizarr GET ${path}`, status: res.status })
  }
  return res.json()
}
