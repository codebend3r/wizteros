const DAY = 86_400_000

export const INVITE_GRACE_DAYS = 14

const BILLING_PROBLEM = new Set(['past_due', 'unpaid', 'incomplete', 'incomplete_expired'])
const WARMTH = { lapsed: 2, declined: 1 }

const parseTime = (value) => {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? null : parsed
}

export const assignCohort = ({ member, now }) => {
  /**
   * Assign one lifecycle cohort, mirroring deriveStatus in the admin UI.
   *
   * Order carries the logic. A VIP is excluded before anything else. A billing
   * failure is checked before every sellable cohort, because a member whose
   * card bounced believes they are paying and must reach triage rather than a
   * pitch. A Stripe cancel is checked before the invite rules because the
   * subscription.deleted webhook clears `subscribed`, which would otherwise
   * make a genuine cancel read as a declined invite.
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
  return now - invitedAt > INVITE_GRACE_DAYS * DAY ? 'declined' : 'invited-pending'
}

export const rankLeads = ({ leads }) =>
  /**
   * Warmth first, then recency. Someone who has paid before outranks someone
   * who only ever received a link, and a recent lapse outranks an old one.
   */
  [...leads].sort((a, b) => {
    const warmth = (WARMTH[b.cohort] ?? 0) - (WARMTH[a.cohort] ?? 0)
    return warmth !== 0
      ? warmth
      : (parseTime(b.lastEventAt) ?? 0) - (parseTime(a.lastEventAt) ?? 0)
  })
