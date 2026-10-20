import type { HttpAnswer, Send } from '@/transport/http.js'

// Stand-ins for the wire `getJson` sends on, so a test drives the real
// judging (status, JSON decode, deadline, abort) rather than a canned result.

/** A wire that answers every GET with one status and body. */
export const answering =
  (answer: HttpAnswer): Send =>
  async () =>
    answer

/** The error a socket reports for a refused connect, which `getJson` names `refused`. */
export const refusal = (): Error =>
  Object.assign(new Error('connect ECONNREFUSED'), { syscall: 'connect', code: 'ECONNREFUSED' })

/** A wire whose every connect is refused. */
export const refusing: Send = async () => {
  throw refusal()
}
