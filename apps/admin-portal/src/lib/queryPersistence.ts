// Query keys whose value is a live reading of the fleet, not a slow lookup
// worth caching across a reload. The play history aggregates are history and
// restore fine; the sync status is the one reading there that says "now".
const LIVE_KEYS = new Set(['fleet', 'fleet-incidents', 'plays-sync'])

/** Whether a query key holds a live reading that must never be restored from
 * storage.
 *
 * The persister exists for the ~15s members call. The fleet page inherited it
 * silently, and a restored fleet repaints a half-hour-old collector heartbeat,
 * a frozen `stale: false` and week-old host metrics as if they were the
 * present, with nothing on the page saying so. On a page whose entire thesis
 * is that history must never be shown as the present, that inverts the thesis.
 */
export const isLiveQueryKey = (queryKey: readonly unknown[]): boolean =>
  LIVE_KEYS.has(String(queryKey[0]))
