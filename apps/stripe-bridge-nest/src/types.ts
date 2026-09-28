import type { BridgeStore } from '@/store/openStore.js'

// The shapes the bridge's modules hand each other, and what it talks to, as
// ports: its own SQLite store and the four outside services. Records keep
// snake_case field names: most of them are read off, or written onto, a JSON
// wire that the portal and Wizarr already agree on.
//
// Every module that reads the store or talks to Wizarr, Stripe, plex.tv or SMTP
// takes the port it needs from a Bridge rather than importing a client, which
// is what lets a test hand in a fake.

// --- Wizarr --------------------------------------------------------------------

/**
 * One library row from Wizarr's /api/libraries. Only `id` and `server_id` are
 * always read; the rest may be missing, and a missing value fails closed
 * wherever it is judged.
 */
export type WizarrLibrary = Readonly<{
  id: number
  name?: string | null
  server_id: number
  server_name?: string | null
  enabled?: boolean
  /** The Plex section id Wizarr cached the library under. */
  external_id?: string | number | null
}>

/** One user record from /api/users: a person on one server. */
export type WizarrUser = Readonly<{
  id: number
  username?: string | null
  email?: string | null
  server?: string | null
  expires?: string | null
}>

/**
 * One invitation from /api/invitations. `used_by` is whatever Wizarr
 * serialized, usually the repr "<User 281>", so it stays unknown until read.
 */
export type WizarrInvitation = Readonly<{
  id: number
  code?: string | null
  used_by?: unknown
  server_names?: readonly string[] | null
  expires?: string | null
  unlimited?: boolean | null
}>

export type CreatedInvite = Readonly<{ code: string; url: string }>

export type WizarrApi = Readonly<{
  /** All libraries Wizarr knows. */
  listLibraries: () => Promise<WizarrLibrary[]>
  /** Create an invite; `libraryIds` null leaves scoping to Wizarr's defaults. */
  createInvite: (invite: {
    serverIds: readonly number[]
    expiresInDays: number
    duration: string
    unlimited?: boolean
    libraryIds?: readonly number[] | null
    allowDownloads?: boolean
  }) => Promise<CreatedInvite>
  /** Every invitation, used and unused alike. */
  listInvitations: () => Promise<WizarrInvitation[]>
  /** Delete one invitation by its numeric id, not its code. */
  deleteInvitation: (invitationId: number) => Promise<void>
  /** Every user record (one per person per server). */
  listUsers: () => Promise<WizarrUser[]>
  /** All records for an email, compared case-insensitively. */
  findUsersByEmail: (email: string) => Promise<WizarrUser[]>
  /** All record ids for an email. */
  findUserIdsByEmail: (email: string) => Promise<number[]>
  /** All record ids for the Plex account that redeemed an invite code. */
  findUserIdsByInvite: (code: string) => Promise<number[]>
  /** Set a record's expiry to an absolute ISO datetime, or null to clear it. */
  setExpiry: (update: { userId: number; expires: string | null }) => Promise<void>
  /** Disable (not delete) a record so its access stops. */
  disableUser: (userId: number) => Promise<void>
}>

// --- plex.tv -------------------------------------------------------------------

/** Server name -> section id -> the section's live title. */
export type LiveSections = Readonly<Record<string, Readonly<Record<string, string>>>>

/** What one account is actually shared on one server. */
export type PlexShare = Readonly<{
  all_libraries: boolean
  allow_sync: boolean
  libraries: readonly string[]
}>

/** Server name -> the share an account holds there. */
export type PlexShares = Readonly<Record<string, PlexShare>>

/** Lowercased email -> server name -> share. */
export type PlexAccess = Readonly<Record<string, PlexShares>>

export type PlexApi = Readonly<{
  /** Whether an owner token is configured; without one plex.tv is never asked. */
  hasToken: () => boolean
  /** live_sections(), or null when there is no token or plex.tv cannot answer. */
  liveSectionsOrNone: () => Promise<LiveSections | null>
  /** Every shared account's access. Throws PlexUnavailable when plex.tv fails. */
  sharedAccessAll: () => Promise<PlexAccess>
  /** One email's share per server; empty when shared nowhere. */
  sharedAccessForEmail: (email: string) => Promise<PlexShares>
}>

// --- Stripe --------------------------------------------------------------------

/** The subscription fields the bridge reads. */
export type StripeSubscription = Readonly<{
  id: string
  customer: string
  status: string
  cancel_at_period_end: boolean
  /** Epoch seconds, or null when no cancellation is scheduled. */
  cancel_at: number | null
}>

export type StripeApi = Readonly<{
  /** The email on a customer record; null when they have none on file. */
  customerEmail: (customerId: string) => Promise<string | null>
  /** The first customer Stripe's search finds for an email, or null. */
  searchCustomerId: (email: string) => Promise<string | null>
  /** Every customer id Stripe lists for an email (up to 100). */
  customerIdsForEmail: (email: string) => Promise<string[]>
  /** Every subscription a customer holds, all pages. */
  subscriptionsFor: (customerId: string) => Promise<StripeSubscription[]>
  /** Flag a subscription to cancel at period end; returns it as updated. */
  cancelAtPeriodEnd: (subscriptionId: string) => Promise<StripeSubscription>
  /** Every subscription on the account in any status, all pages. */
  allSubscriptions: () => Promise<StripeSubscription[]>
}>

// --- SMTP ----------------------------------------------------------------------

export type Alert = Readonly<{ subject: string; body: string }>

export type Mailer = Readonly<{
  /** Mail a member their invite link. Throws, so a webhook is retried. */
  sendInvite: (invite: { to: string; inviteUrl: string }) => Promise<void>
  /** Mail the operators an alert. Never throws. */
  sendAlert: (alert: Alert) => Promise<void>
}>

// --- the bridge ------------------------------------------------------------------

export type Settings = Readonly<{
  /** Origin invite links are built on: `${publicInviteBase}/j/${code}`. */
  publicInviteBase: string
  /** Days of access a payment buys, as the text Wizarr is sent. */
  accessDuration: string
  /** Days an issued invite stays redeemable. */
  inviteDays: number
  /** Days a baseline invite stays redeemable. */
  baselineExpiresDays: number
}>

/** Everything a handler, route or sweep needs, handed in rather than imported. */
export type Bridge = Readonly<{
  store: BridgeStore
  wizarr: WizarrApi
  stripe: StripeApi
  plex: PlexApi
  mailer: Mailer
  settings: Settings
}>

// --- the store -------------------------------------------------------------------

/**
 * What the bridge knows about one paying address, keyed by lowercased email.
 *
 * `customer_id` is the real Stripe id (cus_...) or null: admin-issued
 * placeholder rows are keyed "admin:<email>" and must never leak as a
 * customer id. `subscribed` is the confirmed-payment flag behind "Subscribed
 * Monthly"; `payment_state` is "past_due" while Stripe has a failed charge
 * outstanding and null otherwise.
 */
export type CustomerRow = Readonly<{
  customer_id: string | null
  invite_code: string | null
  tier: string | null
  invited_at: string | null
  subscribed: boolean
  payment_state: string | null
}>

/** One entry of a member's action history. */
export type EventRow = Readonly<{
  id: number
  at: string
  email: string
  action: string
  detail: string
}>

// --- tiers -----------------------------------------------------------------------

/** An invite's scope for a tier, resolved from the live library list. */
export type TierScope = Readonly<{
  library_ids: readonly number[]
  server_ids: readonly number[]
  server_names: readonly string[]
  allow_downloads: boolean
}>

// --- the members list -------------------------------------------------------------

/**
 * One row of the members list: a person, not a Wizarr record.
 *
 * `servers` and `libraries` are what they hold right now; `entitled` is what
 * their tier grants. `stripe_email` is set only when they pay under a
 * different address than their Plex account uses, and `tag` is stamped on by
 * the admin overrides rather than assembled with the rest.
 */
export type Member = Readonly<{
  member: string
  email: string
  tier: string
  downloads: boolean | null
  expires: string | null
  servers: readonly string[]
  libraries: Readonly<Record<string, readonly string[]>>
  entitled: Readonly<Record<string, readonly string[]>>
  subscribed: boolean
  payment_state: string | null
  invited_at: string | null
  customer_id: string | null
  stripe_email: string | null
  tag?: string | null
}>
