import { isRecord } from '@/lib/guards'
import { supabase } from '@/lib/supabaseClient'

/**
 * The session lapsed, or this account is not on the server's allowlist. Its
 * own class because the query client ends the session on it wherever it
 * lands, rather than every page repeating the check.
 */
export class AdminAuthError extends Error {}

/**
 * The server has no record under that key. Its own class because a 404 is an
 * answer for some callers ("no such member") and a failure for the rest.
 */
export class NotFoundError extends Error {}

type Guard<T> = (value: unknown) => value is T

type Expect<T> = {
  readonly path: string
  readonly is: Guard<T>
  /** The response's name in the sentence a refused body throws. */
  readonly what: string
  /** Says what was wrong with a refused body, when the guard alone cannot. */
  readonly explain?: (data: unknown) => string
}

export type Client = {
  readonly read: <T>(expect: Expect<T>) => Promise<T>
  readonly write: <T>(expect: Expect<T> & { readonly body: unknown }) => Promise<T>
}

// Both servers authorize off the Supabase session: send the signed-in admin's
// access token as a bearer, read from the client per request so a refreshed
// session is picked up without a reload.
const authHeader = async (): Promise<Record<string, string>> => {
  if (!supabase) {
    return {}
  }
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : {}
}

const textOf = async (response: Response): Promise<string> => {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const DETAIL_LIMIT = 200

/**
 * What a failed response said about itself.
 *
 * Both servers answer a failure as FastAPI did, `{"detail": "..."}`, and
 * carrying that sentence into the thrown error is what tells a dead upstream
 * from a bad request once the page only shows the message. A detail that is
 * not a sentence (a 422's list of field errors) or a body that is not JSON at
 * all is carried as a snippet of the raw text instead.
 */
const detailOf = async (response: Response): Promise<string> => {
  const text = await textOf(response)
  const parsed = parseJson(text)
  const detail = isRecord(parsed) ? parsed.detail : null
  return (typeof detail === 'string' ? detail : text).slice(0, DETAIL_LIMIT)
}

/**
 * One server's HTTP client: the bearer, the 401, the error body and the JSON
 * check, written once for the bridge and the fleet monitor alike.
 *
 * `base` is empty when its variable is unset, which makes every call relative,
 * and then the dev server and Netlify both answer with this SPA's index.html
 * at 200 (/fleet is one of its own routes, too). `baseVariable` names that
 * instead of letting it surface as an opaque JSON parse error.
 */
export const createClient = ({
  base,
  baseVariable,
  name,
}: {
  base: string
  baseVariable: string
  /** The server as a sentence names it: "the bridge", "the fleet monitor". */
  name: string
}): Client => {
  const send = async ({ path, init }: { path: string; init: RequestInit }): Promise<unknown> => {
    const response = await fetch(`${base}${path}`, init)
    // The pages render behind AdminGate, so reaching here signed out means the
    // session lapsed mid-visit or this build points at a server that does not
    // allowlist the account; neither is what "Request failed (401)" says.
    if (response.status === 401) {
      throw new AdminAuthError(`Not signed in, or this account is not allowed to read ${name}.`)
    }
    if (!response.ok) {
      const detail = await detailOf(response)
      const message = `Request failed (${response.status})${!!detail ? `: ${detail}` : ''}`
      throw response.status === 404 ? new NotFoundError(message) : new Error(message)
    }
    const contentType = response.headers?.get('content-type') ?? ''
    if (!!contentType && !contentType.includes('json')) {
      throw new Error(`Expected JSON from ${path} but got ${contentType}. Is ${baseVariable} set?`)
    }
    return await response.json()
  }

  const vouch = <T>({ data, is, what, explain }: Expect<T> & { data: unknown }): T => {
    if (!is(data)) {
      throw new Error(`Unexpected ${what} from ${name}${explain ? `: ${explain(data)}` : ''}`)
    }
    return data
  }

  return {
    read: async (expect) =>
      vouch({
        ...expect,
        data: await send({ path: expect.path, init: { headers: await authHeader() } }),
      }),
    write: async ({ body, ...expect }) =>
      vouch({
        ...expect,
        data: await send({
          path: expect.path,
          init: {
            method: 'POST',
            headers: { ...(await authHeader()), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        }),
      }),
  }
}
