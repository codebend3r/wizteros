// Environment parsing shared by every server. Each app keeps its own list of
// variable names; what lives here is only how a raw value is read, so the
// bridge and the monitor cannot drift on what a blank entry or a trailing
// slash means.

type Env = Readonly<Record<string, string | undefined>>

/**
 * Throw naming every variable in `names` that `env` lacks.
 *
 * Called at boot so a misconfigured container dies naming all of what is
 * missing at once, rather than accepting requests it cannot act on. Only an
 * absent variable counts as missing: set-but-empty is a deliberate value.
 */
export const requireEnv = ({
  names,
  env = process.env,
}: {
  names: readonly string[]
  env?: Env
}): void => {
  const missing = names.filter((name) => env[name] === undefined)
  if (missing.length > 0) {
    throw new Error(`missing required environment: ${missing.join(', ')}`)
  }
}

/** Split a comma-separated value into its trimmed, non-empty entries. */
export const parseList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

/** A comma-separated email allowlist, lowercased so comparisons ignore case. */
export const parseEmailAllowlist = (raw: string | undefined): ReadonlySet<string> =>
  new Set(parseList(raw).map((email) => email.toLowerCase()))

/** A base url with every trailing slash removed, or empty when unset. */
export const trimTrailingSlashes = (raw: string | undefined): string =>
  (raw ?? '').replace(/\/+$/, '')
