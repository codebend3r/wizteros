import { z } from 'zod'

/** The monitor's verdict on one host, reached from that host's own readings:
    `unknown` is a host never collected, not a host that is fine. */
export const hostStatusSchema = z.enum(['ok', 'warn', 'unknown'])

export type HostStatus = z.output<typeof hostStatusSchema>
