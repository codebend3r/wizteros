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
`lapsed`, `uninvited`, or `triage-billing`. Two of those, `declined` and `lapsed`, are
sellable plays. The rest are excluded, or routed to a different runbook, or both.

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
destroyable by `git clean -xdf`.

| Flag | Meaning |
|---|---|
| `--play=declined\|lapsed\|uninvited` | Restrict to one play. No flag runs both sellable plays, `declined` and `lapsed`. `uninvited` is a valid selection that produces no play block at all, only a triage listing: uninvited members are never pitched, so there is nothing to draft |
| `--json` | Machine-readable output, `{ plays, triage, sources }`, for the agent to parse |
| `--no-store` | Skip the NAS bridge-store read. The member list itself is built by iterating the store's rows, so this does not just drop a field, it drops every member: expect an empty report, not a degraded one. Useful only for checking that Stripe and Wizarr answer, never for a real run |
| `--record <email> <play>` | Append one contact to the ledger. `<play>` must be `declined` or `lapsed`. Anything else, including `uninvited`, is rejected before any write happens: uninvited members are never pitched, so recording a contact against that play would itself be corrupt state |
| `--opt-out <email>` | Set the permanent exclusion flag for an email. Missing the email argument is rejected the same way, before any write |
| `--all` | Currently a functional no-op. It is parsed and accepted, but nothing in `buildReport` or `renderReport` reads it. Excluded people are already listed in every run whether or not `--all` is passed. Do not rely on it to change output, and do not describe it to the operator as a filter toggle: as written, it isn't one |

Exit codes:

- **`0`** whenever the script completes a run, whatever it found. This covers a report
  with zero contactable leads in every play, a successful `--record`, a successful
  `--opt-out`, and a report where the bridge store came back unreadable (that shows up as
  `sources.store: "unavailable: <reason>"`, not as a nonzero exit). Finding nobody
  contactable is exit `0`. A quiet week is not a failure.
- **`2`** only when the run is misconfigured or an upstream it depends on could not be
  read: an unknown flag or an unknown play, a missing or empty `STRIPE_API_KEY` /
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

| Play | Membership | Cooldown |
|---|---|---|
| `declined` | `subscribed=0`, an `invited_at` is present, and it is past the 14-day invite grace | 45 days |
| `lapsed` | `subscribed=1` with a past `expires`, or a Stripe status of `canceled` | 60 days |
| `uninvited` | known to the bridge, no confirmed payment, no invite stamp | not pitched, triage only |

Cohort assignment mirrors `deriveStatus` in `apps/admin-portal/src/lib/memberStatus.ts`,
including its 14-day grace constant. That grace decides which *status badge* a pending
invite shows; it is a different number from `INVITE_EXPIRES_DAYS` (7, deployed), which is
how long the invite link itself stays redeemable. If this cohort logic and the admin UI's
badges ever disagree for the same member, that is a bug worth stopping for: it means the
report is telling the operator something the admin UI contradicts.

Order matters in cohort assignment, and it is checked in this sequence:

1. **VIP is never contacted.** The `vip` tag wins before anything else is even looked at,
   so a VIP with a canceled subscription and a past expiry still never reaches a play. The
   `hvu` tag is a separate administrative label and does not exclude.
2. **A billing failure routes to triage, not a play.** See the next section.
3. **A deliberate Stripe cancel reads as `lapsed`.** Checked before the invite-grace logic,
   because the `customer.subscription.deleted` webhook clears `subscribed`, and without
   this ordering a genuine cancel would misread as a declined invite instead.
4. Everything else falls out of `subscribed`, `expires`, and `invited_at`.

Three filters apply on top of cohort assignment, in this order, before anyone reaches the
operator:

1. **Opt-out is permanent.** One flag, checked first, and it never expires.
2. **Lifetime cap of three contacts, across all plays.** Checked before the cooldown on
   purpose: an expired cooldown must not revive someone who has already ignored three
   emails, regardless of which plays those three contacts were under.
3. **Cooldown**, per the table above, counted from the most recent contact of *either*
   play. A `lapsed` contact three days ago still blocks a `declined` pitch today; the two
   plays cannot double up on one person by using different clocks.

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

| Allowed | Banned |
|---|---|
| "One contribution instead of several subscriptions" | "Everything you're paying elsewhere for" |
| "One login for the whole household" | "Cancel your subscriptions, this covers it" |
| "A single monthly contribution toward hosting" | Any named commercial streaming service, ever, including "replace Netflix" |

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
reason), followed by a single `TRIAGE` line for the whole run naming everyone routed to
`member-triage` and why, followed by a footer. The `TRIAGE` line is not repeated per
play; it is computed once and appended once, after every play's block. When assembling
the report for the operator, add the narrative layer on top of that structure per play:
why now (what the data actually shows, not a guess), the ranked leads, the draft in
full, the excluded summary, and a one-line call on whether to send.

**The footer talks about sellable cohorts only, never about triage.** It prints
"Nothing to send" whenever every play's contactable count is zero, which is a real and
correct statement about `declined` and `lapsed`, but it says nothing about whether
`TRIAGE` is empty. Run `--play=uninvited` (or any run where every play is empty but
triage is not) and the output prints the `TRIAGE` line naming real people who need
`member-triage`, immediately followed by "Nothing to send. Every cohort is empty or
fully suppressed." Read literally, that footer is about the plays above it, not about
the whole run. When assembling the report for the operator, never let "Nothing to send"
read as "there is nothing to do here": if `TRIAGE` names anyone, say so as work that
still needs doing, regardless of what the footer says underneath it.

Ranking within a play is warmth first, then recency. `lapsed` outranks `declined` (someone
who paid before is warmer than someone who only ever received a link and never redeemed
it), and within the same warmth, a recent event outranks an old one. Never re-order this
by hand to push a favorite lead to the top.

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
- A cohort where `contactable + excluded` does not equal `cohortSize`.
- Copy that names a commercial streaming service, promises specific titles, or says
  "unlimited" anything.
- Treating a clean `copy-compliance` run as proof the framing is safe. That skill surfaces
  candidates against a fixed word list and reports them for human judgment; it does not
  understand a sentence, and the operator still reads every draft before it goes anywhere.
- Manufacturing a lead, or stretching a cooldown or cohort boundary, to avoid reporting a
  quiet week. A run with nothing to send is a valid result.
- Recording a contact (`--record`) before the send it describes actually happened.
