const DAY = 86_400_000

export const INVITE_GRACE_DAYS = 14
export const BULK_INVITE_THRESHOLD = 10

const BILLING_PROBLEM = new Set(['past_due', 'unpaid', 'incomplete', 'incomplete_expired'])

export const WARMTH = { lapsed: 3, backfill: 2, declined: 1 }

const parseTime = (value) => {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? null : parsed
}

const inviteDateOf = (invitedAtMs) => new Date(invitedAtMs).toISOString().slice(0, 10)

export const bulkInviteDates = ({ members }) => {
  /**
   * Detect bulk invite stamps: any calendar date (UTC) on which
   * BULK_INVITE_THRESHOLD or more distinct members were invited. Organic
   * invites run at one or two a day, so an order-of-magnitude jump on a
   * single date is a migration backfill, not real interest, and members
   * invited on that date must not read as having declined anything.
   *
   * Distinct members are counted, never rows: the store can legitimately
   * hold several rows for one person, and counting rows would let one
   * duplicated member manufacture a bulk date on their own.
   */
  const emailsByDate = members.reduce((acc, member) => {
    const invitedAt = parseTime(member.invitedAt)
    if (invitedAt === null || !member.email) {
      return acc
    }
    const date = inviteDateOf(invitedAt)
    const existing = acc[date] ?? new Set()
    return { ...acc, [date]: new Set([...existing, member.email.toLowerCase()]) }
  }, {})
  return new Set(
    Object.entries(emailsByDate)
      .filter(([, emails]) => emails.size >= BULK_INVITE_THRESHOLD)
      .map(([date]) => date),
  )
}

export const assignCohort = ({ member, now, bulkDates = new Set() }) => {
  /**
   * Assign one lifecycle cohort, extending deriveStatus in the admin UI rather
   * than mirroring it: deriveStatus reads no Stripe status at all, so
   * triage-billing and the canceled-reads-as-lapsed branch below have no
   * counterpart there. SKILL.md lists the known divergences in full.
   *
   * Order carries the logic. A VIP is excluded before anything else. A billing
   * failure is checked before every sellable cohort, because a member whose
   * card bounced believes they are paying and must reach triage rather than a
   * pitch. A Stripe cancel is checked before the invite rules because the
   * subscription.deleted webhook clears `subscribed`, which would otherwise
   * make a genuine cancel read as a declined invite.
   *
   * bulkDates only matters at the very last step, once a member is already
   * past the invite grace: a bulk stamp reinterprets what an expired,
   * unredeemed invite means, nothing more. It never overrides VIP, billing
   * trouble, a Stripe cancel, the subscribed branch, or the grace window
   * itself, and it defaults to an empty set so an omitted argument preserves
   * this function's previous behaviour exactly.
   */
  if (member.tag === 'vip') {
    return 'vip'
  }
  if (member.stripeStatus && BILLING_PROBLEM.has(member.stripeStatus)) {
    return 'triage-billing'
  }
  if (member.stripeStatus === 'canceled') {
    return 'lapsed'
  }
  const expires = parseTime(member.expires)
  if (member.subscribed) {
    return expires !== null && expires < now ? 'lapsed' : 'active'
  }
  const invitedAt = parseTime(member.invitedAt)
  if (invitedAt === null) {
    return 'uninvited'
  }
  if (now - invitedAt <= INVITE_GRACE_DAYS * DAY) {
    return 'invited-pending'
  }
  return bulkDates.has(inviteDateOf(invitedAt)) ? 'backfill' : 'declined'
}

export const rankLeads = ({ leads }) =>
  /**
   * Recency, most recent first. Warmth is not a factor here: this only ever
   * receives one play's leads, so every entry already shares a cohort. Warmth
   * orders the play blocks themselves instead, from WARMTH, in cohorts.mjs.
   */
  [...leads].sort((a, b) => (parseTime(b.lastEventAt) ?? 0) - (parseTime(a.lastEventAt) ?? 0))
