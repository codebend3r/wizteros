---
name: sales-agent
description: Use when looking for membership growth opportunities among people who already showed interest and did not convert. Triggers include "find sales opportunities", "who should we win back", "draft a win-back email", "anyone we can re-invite", "who declined and never came back", "grow membership", or a review of lapsed and declined members. Only applies to the wizteros repo.
---

# Sales agent for wizteros

## Overview

Finds people who already showed interest in the server and never converted, ranks them,
and drafts a compliance-checked win-back email for a human to read, edit, and send by
hand.

`cohorts.mjs` reads Stripe, Wizarr, and the bridge store, joins them per person, and
assigns one lifecycle cohort each: `vip`, `active`, `invited-pending`, `declined`,
`backfill`, `lapsed`, `uninvited`, or `triage-billing`. Three of those, `declined`,
`backfill`, and `lapsed`, are sellable plays. The rest are excluded, or routed to a
different runbook, or both.

Two outcomes count as success here, not one. A conversion is the obvious one. A reply
explaining why someone left is the other, and outreach is the only channel in this stack
that produces that information at all. A cold report that nobody opens produces neither.

**It drafts and never sends.** Nothing in this skill, the script, or the agent that runs
it has a way to send mail. Every send is a human pressing send in their own Gmail client,
after reading the draft. The only thing this skill writes on its own is the ledger, and
only after a human confirms a send actually happened (see Handoff).

**A run with nothing to send is a valid result.** If every cohort is empty or every
candidate is suppressed, say so plainly and stop. Never manufacture a lead, soften a
cooldown, or stretch a cohort boundary to produce something to report.

## Running it

```bash
node --env-file-if-exists=.env .claude/skills/sales-agent/scripts/cohorts.mjs [flags]
```

Run it from the repo root. Use `--env-file-if-exists=.env`, never `--env-file=.env`. This
repo's `.env` is gitignored, so a fresh clone or worktree has none, and Node's
`--env-file` treats a missing file as fatal: `node: .env: not found`, exit `9`, before a
line of the script runs. `--env-file-if-exists` loads the file when it is there and, when
it is not, prints a "not found. Continuing without it." notice to stderr and runs the
script anyway rather than dying, so the script's own config check is the thing that
reports a missing variable, not Node's flag parser.

A live report needs `STRIPE_API_KEY`, `WIZARR_BASE_URL`, and `WIZARR_API_KEY` (the same
three the bridge runs with), plus SSH key auth to the NAS for the bridge-store read. The
NAS target defaults to `crivas@192.168.50.2` and `/volume1/docker/stripe-bridge`,
overridable with `WZ_NAS_HOST` and `WZ_NAS_PATH`. The store read is a plain SSH redirect,
`ssh <host> "cat <path>/stripe-bridge-data/bridge.db" > <tmpfile>`, not a tar copy, into a
`mkdtemp` directory that is removed in a `finally` whether the read succeeds or not.

`--record` and `--opt-out` touch only the local ledger and need none of the above: they
run before the config check, so recording a contact or an opt-out works even with no
Stripe or Wizarr credentials at hand.

The ledger lives outside the repo at `~/.local/state/wizteros/sales-agent/outreach.json`,
overridable with `WZ_SALES_STATE`. It is never git-tracked and never gitignored inside the
repo either, on purpose: member email addresses must not be reachable by `git add -A` or
destroyable by `git clean -xdf`. If neither `WZ_SALES_STATE` nor `HOME` resolves, the run
stops with an error rather than resolving a relative path: relative would land the ledger
under whatever directory the script was run from, which is exactly the repo-tree outcome
the location is chosen to avoid.

| Flag                                           | Meaning                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--play=declined\|backfill\|lapsed\|uninvited` | Restrict to one play. No flag runs all three sellable plays: `lapsed`, `backfill`, `declined`. `uninvited` is a valid selection that produces no play block at all, only a triage listing: uninvited members are never pitched, so there is nothing to draft                       |
| `--json`                                       | Machine-readable output, `{ plays, bulkDates, triage, selfFiltered, sources }`, for the agent to parse                                                                                                                                                                             |
| `--no-store`                                   | Skip the NAS bridge-store read. The member list itself is built by iterating the store's rows, so this does not just drop a field, it drops every member: expect an empty report, not a degraded one. Useful only for checking that Stripe and Wizarr answer, never for a real run |
| `--record <email> <play>`                      | Append one contact to the ledger. `<play>` must be `declined`, `backfill`, or `lapsed`. Anything else, including `uninvited`, is rejected before any write happens: uninvited members are never pitched, so recording a contact against that play would itself be corrupt state    |
| `--opt-out <email>`                            | Set the permanent exclusion flag for an email. Missing the email argument is rejected the same way, before any write                                                                                                                                                               |

Both `--record` and `--opt-out` also reject a value that is itself flag shaped. `--opt-out
--json` is a missing argument, not an opt-out for someone named `--json`, and writing that
key would put a permanent suppression on a person who was never opted out while reporting
success.

Exit codes:

- **`0`** whenever the script completes a run, whatever it found. This covers a report
  with zero contactable leads in every play, a successful `--record`, a successful
  `--opt-out`, and a report where the bridge store came back unreadable (that shows up as
  `sources.store: "unavailable: <reason>"`, not as a nonzero exit). Finding nobody
  contactable is exit `0`. A quiet week is not a failure.
- **`2`** only when the run is misconfigured or an upstream it depends on could not be
  read: an unknown flag, an unknown play, a flag-shaped value where an email or a play
  belongs, an unresolvable ledger directory, a missing or empty `STRIPE_API_KEY` /
  `WIZARR_BASE_URL` / `WIZARR_API_KEY`, a failed Stripe or Wizarr request, or a ledger file
  that exists but fails to parse. That last one is deliberate: `readLedger` returns an
  empty ledger only when the file is genuinely absent (first run). If the file is present
  and corrupted it throws instead of silently starting over, because the ledger is the
  opt-out list, and silently forgetting it would mean re-emailing someone who already
  asked to stop. `writeLedger` writes to a temp file in the same directory and renames it
  into place, so a crash mid-write can never leave that half-written state behind.

The bridge-store read is the one exception: it fails soft. A bad SSH connection or a
missing `sqlite3` degrades that source to `unavailable` and the run still exits `0`, at
the cost of the member list being empty (see `--no-store` above). Always read the
`sources:` line before trusting an empty report: an empty report with `store unavailable`
means the read failed, not that the week was quiet.

## The plays

| Play        | Membership                                                                                                                           | Cooldown                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `declined`  | `subscribed=0`, an `invited_at` is present, past the 14-day invite grace, and `invited_at`'s calendar date is not a bulk invite date | 45 days                  |
| `backfill`  | Same as `declined`, except `invited_at`'s calendar date is a bulk invite date                                                        | 45 days                  |
| `lapsed`    | `subscribed=1` with a past `expires`, or a Stripe status of `canceled`                                                               | 60 days                  |
| `uninvited` | known to the bridge, no confirmed payment, no invite stamp                                                                           | not pitched, triage only |

### Bulk invite detection

A live run once listed 45 "declined" leads that had never actually declined anything:
they were existing members stamped `invited_at` during a one-time migration backfill, all
on the same day. A win-back email telling them they declined an invitation would have been
false. `bulkInviteDates` in `classify.mjs` catches this without hardcoding a date: any
calendar date (UTC) on which `BULK_INVITE_THRESHOLD` (10) or more _distinct_ members were
invited is a bulk stamp, counted by member, never by row, so one person with several store
rows cannot manufacture a bulk date on their own. Organic invites run at one or two a day,
comfortably below the threshold; a genuine day of ten or more organic signups would be
visible in the report and is a good problem, not a bug. A member whose invite date lands on
a bulk date gets `backfill` instead of `declined`; every other cohort boundary (VIP, billing
trouble, a Stripe cancel, the subscribed branch, the invite grace itself) is unaffected, a
bulk stamp only reinterprets what an already-expired, unredeemed invite means.

### Self address filter

The operator's own plus-addressed test accounts (`name+anything@domain`) are not members
and must never inflate a cohort count or receive a draft. `cohorts.mjs` resolves the
operator's address in this order: `WZ_SALES_SELF` (comma separated, for more than one
address), then `git config user.email`, then no filter at all if neither resolves. The
source in effect is always printed on the `sources:` line (as `self: <source> (<n>
filtered)` or `self: none (no filter)`), so the filter is never silent. A match compares
the local part before any `+`, lowercased, plus the domain, so `me@example.com` and
`me+gold@example.com` are the same address for filtering purposes but `me@otherdomain.com`
is not. Filtered addresses are counted in `report.selfFiltered`, never just dropped.

### How this relates to the admin UI

Cohort assignment **extends** `deriveStatus` in `apps/admin-portal/src/lib/memberStatus.ts`
rather than mirroring it, and it is scoped to `customer_map` rather than to everyone the
admin UI lists. It does share the 14-day grace constant, read from
`apps/admin-portal/src/lib/inviteRules.ts` and pinned by a test on both sides. That grace
decides which _status badge_ a pending invite shows; it is a different number from
`INVITE_EXPIRES_DAYS` (7, deployed), which is how long the invite link itself stays
redeemable.

Four disagreements with `/manage` are known and expected. Do not stop for any of these:

1. **`backfill`.** A sales-agent-only subdivision of whatever the admin UI shows for an
   expired, unredeemed invite, used purely to pick the right outreach angle. It never
   changes what badge the admin UI itself displays.
2. **Stripe state.** `deriveStatus` reads no Stripe status at all. This tool adds
   `triage-billing` (`past_due`, `unpaid`, `incomplete`, `incomplete_expired`) and reads a
   `canceled` subscription as `lapsed`. So a member with `subscribed=0`, an aged
   `invited_at`, and a Stripe cancel reads `Declined Invite` on `/manage` and `lapsed`
   here. Both are correct for their own purpose.
3. **Different populations.** `/manage` lists Wizarr users unioned with `customer_map`;
   this tool iterates `customer_map` only. Anyone holding a Wizarr record with no
   `customer_map` row (legacy shares, manual adds) shows as `Uninvited` on `/manage` and is
   invisible here: not a lead, not excluded, not triage, not self-filtered. A person on
   `/manage` who is absent from this report entirely is most likely this.
4. **Duplicate-email merges.** `mergeStoreRows` here is deterministic and ORs `subscribed`
   across every row for one email; the bridge's Python `store.all_customer_rows` is
   last-row-wins with no merge. So `/manage` can show `Declined Invite` where this tool
   computes `active`. The OR direction is the safe one: it is the difference between
   leaving a paying member alone and pitching them.

A disagreement **outside** that list is a bug worth stopping for: it means the report is
telling the operator something the admin UI contradicts for a reason nobody has accounted
for. A disagreement that matches one of the four is working as designed.

### Order of assignment

Order matters in cohort assignment, and it is checked in this sequence:

1. **VIP is never contacted.** The `vip` tag wins before anything else is even looked at,
   so a VIP with a canceled subscription and a past expiry still never reaches a play. The
   `hvu` tag is a separate administrative label and does not exclude.
2. **A billing failure routes to triage, not a play.** See the next section.
3. **A deliberate Stripe cancel reads as `lapsed`.** Checked before the invite-grace logic,
   because the `customer.subscription.deleted` webhook clears `subscribed`, and without
   this ordering a genuine cancel would misread as a declined invite instead.
4. Everything else falls out of `subscribed`, `expires`, and `invited_at`. Inside the
   invite branch, past the grace splits one more time: a bulk invite date reads as
   `backfill`, anything else reads as `declined` (see Bulk invite detection above).

Three filters apply on top of cohort assignment, in this order, before anyone reaches the
operator:

1. **Opt-out is permanent.** One flag, checked first, and it never expires.
2. **Lifetime cap of three contacts, across all plays.** Checked before the cooldown on
   purpose: an expired cooldown must not revive someone who has already ignored three
   emails, regardless of which plays those three contacts were under.
3. **Cooldown**, per the table above, counted from the most recent contact of _any_
   play. A `lapsed` contact three days ago still blocks a `declined` or `backfill` pitch
   today; no play can double up on one person by using its own clock.

Excluded people are never dropped from the count. Every person in a cohort is either a
lead or an excluded entry with a reason (`opted-out`, `lifetime-cap`, or `cooldown`), and
`contactable + excluded` always equals `cohortSize`.

## Billing problems are not sales leads

A Stripe status of `past_due`, `unpaid`, `incomplete`, or `incomplete_expired` reads as
`triage-billing`, checked before any sellable cohort. All four are failed-card states, not
a deliberate cancel: that member believes they are paying right now, and a win-back pitch
is the wrong response to a bounced card. Route them to `member-triage` instead.

`uninvited` (known to the bridge, no payment, no invite stamp) is usually a missed
webhook, not a cold prospect. If Stripe shows that person actually paying, this is a bug
in the checkout-to-invite path, not a growth opportunity. Route it to `member-triage` too.

Both groups are still counted and listed, in `report.triage`, with the reason each was
diverted. `--play=uninvited` is a valid invocation for exactly this: it lists uninvited
members for triage and produces no play block, because there is nothing to draft for them.
Silently omitting either group from the output would hide real broken members behind a
sales report.

Only a deliberate `canceled` status is a genuine win-back opportunity, and it lands in
`lapsed`, not here.

## The compliance gate

**Read `.claude/skills/copy-compliance/SKILL.md` in full, every single run, at the moment
you are about to draft.** Never work from memory of it, and never copy its rules, tables,
or banned-word lists into this file. An earlier version of the `wizteros-reviewer` agent
hand-copied its conventions once and was stale within 48 hours. There is exactly one
authority for what counts as compliant copy in this repo, and it is that skill, read live.

**If `copy-compliance/SKILL.md` cannot be read for any reason, refuse to draft and say
so.** No draft is better than an unchecked one. This is not a fallback-to-caution
situation; there is no lesser check to fall back to.

Outreach is a payment surface. A win-back email may be the most exposed copy this repo
produces: it is read by someone actively deciding whether to pay again, it can be tied to
a specific charge, and unlike the landing page it arrives unsolicited. The absolute rule
applies in full: no content nouns, no titles, no catalog language, nothing framed as
"unlimited".

The one place this gets subtle is the one-stop pitch, the argument that one contribution
here replaces several other subscriptions. It is permitted as a cost argument and banned
as a content argument:

| Allowed                                             | Banned                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------------------- |
| "One contribution instead of several subscriptions" | "Everything you're paying elsewhere for"                                  |
| "One login for the whole household"                 | "Cancel your subscriptions, this covers it"                               |
| "A single monthly contribution toward hosting"      | Any named commercial streaming service, ever, including "replace Netflix" |

Use `copy-compliance`'s own test: does the sentence describe what the money keeps
running, or what the member gets to consume? Consolidating spend across services is a
statement about money. Naming or implying a specific streaming service is a statement
about content, because the only thing that service actually provides, and the only thing
it could be "replacing", is a catalog. That is a content sale by another name, and it is
banned outright regardless of how the sentence is worded around it.

Every draft carries these mandatory elements, checked against `copy-compliance` at draft
time same as everything else:

- The feedback question, leading. What made them leave, or what would bring them back.
- The door-is-open line, second: they are welcome back whenever, no pressure.
- The contribution disclaimer, in the same register as `Footer.tsx`: a contribution
  toward hosting and infrastructure costs, not a purchase of content.
- A plain opt-out instruction. Honoring a reply that asks to stop means the main session
  running `--opt-out <email>` afterward, not just noting it.

## Drafting

The skeleton, in order:

1. **The feedback question.** Leads every draft. This is the outcome that matters when
   the person does not come back: find out why.
2. **The door-is-open line.** No pressure, no urgency language, just that access is
   available again whenever they want it.
3. **The pitch**, if there is one to make: what changed, or the one-stop cost argument
   above, always framed as a contribution and never as content.
4. **The contribution disclaimer**, verbatim in register with `Footer.tsx`.
5. **The opt-out instruction**, plain, in the last line.

### The `backfill` angle

A `backfill` member never declined an invitation. They were already members when a bulk
migration stamped `invited_at` on them. The draft must never say or imply they declined,
ignored, or turned down an invite. It leads with the same feedback question every other
play leads with, then explains how to keep access by contributing now: no framing of a
missed choice, no guilt, no urgency language.

**Check the bulk date before you write a deadline sentence. This is a rule, not a
footnote.** Detection is generic: any UTC date with ten or more distinct invited members
qualifies, so more than one migration, batch import, or genuinely busy signup day can put
members in this play. The report prints every detected date on its `BULK DATES` line, and
`--json` carries them in `report.bulkDates`. Match the member's `invitedAt` against them,
then:

- **Invite date is the 2026-07-25 migration.** Those members were asked to start
  contributing toward server costs by 2026-08-08, and that date has passed. The draft may
  say so, stating plainly that the deadline has passed. That is the only deadline claim
  permitted anywhere in this play.
- **Invite date is any other bulk date.** No deadline claim at all, in any wording. No
  date, no "the deadline has passed", no implied cutoff. The honest angle is that they
  were added in a bulk migration and never started contributing, and that access needs a
  contribution to continue.

Asserting a deadline that never applied to a member is a false statement to someone
deciding whether to pay. If the bulk date behind a member cannot be established, write no
deadline claim: the second bullet is always the safe form.

Everything under the compliance gate above applies to this play exactly as it does to
every other one; it is still a payment surface.

Every factual claim in a draft (when they were invited, what tier they were on, when they
lapsed) has to trace to a real field on that member: `invitedAt`, `expires`, `tier`,
`cohort`. Never invent enthusiasm, urgency, or history the upstream data does not support.
If a claim cannot be sourced to Stripe, Wizarr, or the bridge store, it does not appear in
the draft.

## Handoff

Nothing in this skill sends mail. The flow from a drafted email to an actual send is five
steps, and steps 3 and 5 are the only writes anywhere in this whole path:

1. The report and the draft come back to the operator, one draft per play.
2. The operator approves or edits the copy. This is the read-before-send gate: a Gmail
   draft holding real member addresses must never exist before a human has read the words
   in it.
3. The main session creates the Gmail draft: the operator's own address in `To`, the
   cohort in `BCC`, never `CC`. It is created as a draft only, never sent. Cap each draft
   at 25 recipients, so a large cohort goes out in batches instead of one blast that trips
   spam filtering.
4. The operator reviews it inside Gmail itself and sends it by hand.
5. Only after that send actually happens does the main session run `--record <email>
<play>` for each recipient (and `--opt-out <email>` for anyone whose reply asks to
   stop). Recording before a send actually goes out would start a cooldown clock for
   outreach that never happened.

If the Gmail MCP is not connected in that session, write the draft to
`~/.local/state/wizteros/sales-agent/drafts/` instead and say plainly that the fallback
was used, so nobody mistakes a saved file for a sent draft.

Mail goes out from the operator's own Gmail, never the bridge's SMTP. The bridge address
carries invite and renewal mail, which is transactional and needs to keep landing; routing
marketing mail through the same address risks a spam complaint taking transactional
delivery down with it.

## Reporting back

The script's own text output is one block per play (the play name, `contactable of
cohortSize`, the ranked lead lines, then `EXCLUDED` with every excluded email and its
reason), followed by a single `BULK DATES` line naming every detected bulk invite date
(present only when at least one was detected), a single `TRIAGE` line for the whole run
naming everyone routed to `member-triage` and why, a `SELF-FILTERED` line naming every
operator test address excluded (present only when at least one was filtered), then a
footer. None of those three repeats per play; each is computed once and appended once,
after every play's block. When assembling the report for the operator, add the narrative
layer on top of that structure per play: why now (what the data actually shows, not a
guess), the ranked leads, the draft in full, the excluded summary, and a one-line call
on whether to send.

The footer prints "Nothing to send" only when every play's contactable count is zero _and_
`TRIAGE` is empty, so it never appears above a triage list naming real people who still
need `member-triage`.

Plays are ordered by warmth, leads within a play by recency. The block order is `lapsed`,
then `backfill`, then `declined`: someone who paid before is warmer than someone who was
added in a bulk migration and never started contributing, who in turn is warmer than
someone who only ever received a link and never redeemed it. Inside one block, a recent
event outranks an old one. Both orders come out of the script; never re-order either by
hand to push a favorite lead to the top.

**`contactable` plus `excluded` must always equal `cohortSize`, for every play, every
run.** If it doesn't, something in the pipeline dropped a person, and that is a bug worth
stopping for, not a report worth sending.

Before reading an empty or thin report as "a quiet week", check the `sources:` line. A
bridge-store read that failed makes the member list empty by construction (see `--no-store`
above), and that looks identical to an actually quiet week unless the sources are checked
first.

**A run with nothing to send is a valid result.** State it plainly and stop. Never
manufacture a lead, stretch a cooldown, or loosen a cohort boundary to have something to
report.

## Red flags

- Contacting a VIP, under any framing.
- Pitching someone whose real problem is billing. Route to `member-triage` instead.
- A member's email address appearing anywhere but `BCC`.
- Drafting without reading `copy-compliance/SKILL.md` live, at draft time, in that run.
- Re-pitching someone inside their cooldown window, or past their third lifetime contact.
- An opt-out that fails to survive to a second run. If a second run ever re-contacts
  someone who opted out, the ledger read or write path is broken and nothing should be
  sent until that's fixed.
- A lead line asserting something no upstream field supports: invented history, invented
  enthusiasm, invented urgency.
- A `backfill` draft claiming a contribution deadline for a member whose invite date is not
  the 2026-07-25 migration. That is the one bulk date a deadline sentence is licensed for;
  every other one gets no deadline claim at all.
- A cohort where `contactable + excluded` does not equal `cohortSize`.
- Copy that names a commercial streaming service, promises specific titles, or says
  "unlimited" anything.
- Treating a clean `copy-compliance` run as proof the framing is safe. That skill surfaces
  candidates against a fixed word list and reports them for human judgment; it does not
  understand a sentence, and the operator still reads every draft before it goes anywhere.
- Manufacturing a lead, or stretching a cooldown or cohort boundary, to avoid reporting a
  quiet week. A run with nothing to send is a valid result.
- Recording a contact (`--record`) before the send it describes actually happened.
