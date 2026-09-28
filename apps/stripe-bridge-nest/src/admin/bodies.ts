import { z } from 'zod'

// The admin routes' query and body schemas, typed the way the portal sends
// them (apps/admin-portal/src/lib/adminApi.ts). A body that fails its schema
// is a 422 in FastAPI's `{detail: [...]}` shape through fastApiValidationPipe,
// and fields a schema does not name are ignored.

/** A field that may be left out or sent as null, and reads as null either way. */
const nullable = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => value ?? null)

export const EmailQuery = z.object({ email: z.string() })

export const OptionalEmailQuery = z.object({ email: z.string().optional() })

export const NotesBody = z.object({ email: z.string(), notes: z.string() })

export const ResetExpiryBody = z.object({
  email: z.string(),
  days: nullable(z.int()),
  expires_at: nullable(z.string()),
})

export const ResetTierBody = z.object({ email: z.string(), tier: z.string() })

export const ReissueInviteBody = z.object({ email: z.string(), tier: z.string() })

export const EmailBody = z.object({ email: z.string() })

export const SetTagBody = z.object({ email: z.string(), tag: nullable(z.string()) })

export const SetDownloadsBody = z.object({ email: z.string(), allow: z.boolean() })

export const LinkAddressBody = z.object({
  stripe_email: z.string(),
  plex_email: nullable(z.string()),
})
