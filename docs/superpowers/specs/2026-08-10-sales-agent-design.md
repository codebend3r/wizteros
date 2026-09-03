# sales-agent design

Date: 2026-08-10

## Goal

Grow membership by finding people who already showed interest and never converted, then
handing the operator a ranked opportunity and a ready to send email. The agent proposes.
A human sends.

Two outcomes count as success, not one. A conversion is the obvious one. A reply
explaining why someone left is the other, and it is the only channel in the stack that
produces that information at all.

## Scope

In scope: three win back plays, a cohort script, a judgment runbook, a mandatory copy
compliance gate, and a Gmail draft handoff.

Out of scope, deliberately:

- **Tier upgrade nudges.** There is no usage signal wired into this repo. Tautulli holds
  it and nothing here reads it, so any upgrade pitch would be guesswork. Revisit only if
  a Tautulli read gets built.
- **Sending mail.** Nothing in this design sends. It drafts.
- **Writing to the bridge store.** Outreach history stays in a local ledger. Putting it
  in the member event log needs an endpoint, an admin UI surface, a migration, tests, and
  a NAS deploy. That is a feature build and belongs in its own project.
- **Any mutation of a member.** No tier changes, no invites, no expiry writes.

## Shape

```
.claude/agents/sales-agent.md              thin dispatcher, read only
.claude/skills/sales-agent/SKILL.md        the runbook, where judgment lives
.claude/skills/sales-agent/scripts/cohorts.mjs
~/.local/state/wizteros/sales-agent/       ledger plus saved drafts
```

Both an agent and a skill, for one reason each. The skill is the runbook and the script,
invocable directly when the operator wants one draft for one cohort. The agent runs that
runbook in its own context so three upstream reads worth of member data never lands in
the main session, and returns only the ranked pitch.

The agent is read only. Its tool list is `Read, Grep, Glob, Bash`, and Bash is limited to
running the cohort script and read only inspection. It never creates the Gmail draft
itself. That happens in the main session, after the operator has read the copy and
approved it, so a draft holding real member addresses can never exist before the words in
it have been seen.

### Why the ledger sits outside the repo

`~/.local/state/wizteros/sales-agent/`, overridable with `WZ_SALES_STATE`.

Not a gitignored directory inside the repo. Member email addresses never belong in the
working tree, where a `git add -A` can catch them, and `git clean -xdf` must not be able
to destroy the contact history. Outside the repo solves both.

Ledger shape, one record per lowercased email:

```json
{
  "alex@example.com": {
    "contacts": [{ "at": "2026-08-10", "play": "declined" }],
    "optedOut": false
  }
}
```

## The cohort script

`cohorts.mjs` reads three sources and joins them per person:

1. **Stripe** `GET /v1/subscriptions?status=all`, paginated, customer expanded inline.
   Distinguishes a deliberate cancel from a failed payment.
2. **Wizarr** `GET /api/users` for expiry, and `GET /api/invitations` so a member whose
   Plex email differs from their Stripe email is matched through their invite code rather
   than counted twice.
3. **The bridge store**, `bridge.db` tarred off the NAS over one shot SSH, read with
   `sqlite3 -readonly` into a temp copy deleted in a `finally`. Supplies `subscribed`,
   `invited_at`, `tier`, and the manual tag.

This is the same read layer `stripe-reconcile` uses, reimplemented in this skill rather
than shared. Self containment is the established pattern here: `member-triage` and
`stripe-reconcile` each carry their own Stripe and Wizarr readers. The cost is a third
copy. The benefit is that building this cannot regress the reconcile audit, and the shape
needed here is different anyway (per member cohort assignment joined to a contact ledger,
not pairs of disagreements). The fork point for extracting a shared library is a fourth
consumer.

Columns come from `PRAGMA table_info`, because `tier`, `invited_at`, and `subscribed`
were all added by migrations and an older production database legitimately lacks them.

### Cohort rules

Cohort assignment mirrors `deriveStatus` in `apps/admin-portal/src/lib/memberStatus.ts`
exactly, including `INVITE_GRACE_DAYS` from `lib/inviteRules.ts`. If the two ever
disagree the agent is telling the operator something the admin UI contradicts, which
destroys trust in both.

| Play        | Membership                                                          | Cooldown    |
| ----------- | ------------------------------------------------------------------- | ----------- |
| `declined`  | `subscribed=0`, `invited_at` present, past the 14 day grace         | 45 days     |
| `lapsed`    | `subscribed=1` with a past expiry, or a Stripe status of `canceled` | 60 days     |
| `uninvited` | known to the bridge, no confirmed payment, no invite stamp          | not pitched |

### Filters applied before anything reaches the operator

- **VIP is never contacted.** The `vip` tag excludes absolutely. The `hvu` tag is an
  administrative label and does not exclude.
- **Cooldown**, per the table above, measured from the last recorded contact.
- **Lifetime cap of three contacts** across all plays. Someone who has ignored three
  emails is not a lead.
- **Opt out is permanent.** One `optedOut` flag and that address is excluded from every
  future run, with no expiry.

### Billing problems are not sales leads

Two cohorts route to `member-triage` and the script refuses to draft for them:

- **Involuntary lapse.** A Stripe `past_due` or `unpaid` is a failed card. That member
  believes they are paying, and a win back pitch is the wrong response to a billing
  failure.
- **Uninvited.** Usually a missed webhook rather than a prospect. If Stripe shows them
  paying, this is a bug, not an opportunity.

Only a deliberate `canceled` is a genuine win back.

Routed does not mean dropped. Both groups are still counted, listed, and handed back as a
triage worklist with the reason each was diverted. `--play=uninvited` is therefore a valid
invocation that produces a list and no draft. Silently omitting them would hide real
broken members behind a sales report.

### Interface

```bash
node --env-file-if-exists=.env .claude/skills/sales-agent/scripts/cohorts.mjs [flags]
```

`--env-file-if-exists`, not `--env-file`. A clone with no `.env` dies as
`node: .env: not found` with exit 9 before the script's own guard can report the real
problem.

| Flag                                 | Meaning                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| `--play=declined\|lapsed\|uninvited` | Restrict to one play. Default is all three                |
| `--all`                              | Include suppressed people, each annotated with the reason |
| `--json`                             | Machine readable output for the agent                     |
| `--record <email> <play>`            | Append one contact to the ledger                          |
| `--opt-out <email>`                  | Set the permanent exclusion flag                          |

Exit codes: `0` whenever the script ran, whatever it found, and `2` when it is
misconfigured or an upstream was unreadable. Finding nobody contactable is exit `0`. A
quiet week is a normal result and must not read as a failed run, the same convention
`copy-compliance` uses.

Gathering never writes. `--record` and `--opt-out` are separate explicit invocations the
main session makes after the operator confirms, matching the read only gather contract in
`member-triage`.

Environment: `STRIPE_API_KEY`, `WIZARR_BASE_URL`, `WIZARR_API_KEY`, plus SSH key auth to
the NAS. `WZ_NAS_HOST` and `WZ_NAS_PATH` override the NAS target, the same names
`stripe-reconcile` uses.

## What the agent reports

One ranked pitch per play:

```
PLAY  Declined invite win-back
      9 contactable of 23 in cohort

WHY NOW   6 of the 9 declined during the July backfill window and have
          never been contacted since.

LEADS     alex@...  invited 2026-07-25, link expired unopened, bronze scoped
          sam@...   invited 2026-06-02, redeemed nothing

DRAFT     subject and body, in full

EXCLUDED  3 VIP, 7 inside cooldown, 4 routed to member-triage

CALL      Send it. The one reason not to: 4 of the 9 share a domain and may
          be one household that declined together.
```

Ranking is warmth first, then recency. Someone who paid before outranks someone who only
ever received a link, and a lapse from three weeks ago outranks one from a year ago.

Two requirements on the report:

- **Every fact in a lead line traces to a real field.** No inferred enthusiasm, no
  invented history. If a claim cannot be sourced to Stripe, Wizarr, or the store, it does
  not appear.
- **The excluded count must reconcile with the cohort size.** A thin week has to read as
  "everyone is in cooldown", never as "there is nobody to contact".

A run with nothing to send is a valid result. The agent never manufactures leads to fill
a report.

## The compliance gate

A win back email is the most exposed copy in the system. It is read by someone deciding
whether to pay, it can be tied to a specific charge, and unlike the landing page it
arrives unsolicited.

**Rules are read at draft time, never copied into this skill.** The runbook points at
`.claude/skills/copy-compliance/SKILL.md` and requires reading it on every run. An earlier
version of `wizteros-reviewer` hand copied its conventions and went stale within 48 hours.
One authority for framing, and it is the compliance skill.

**Outreach is a payment surface**, so the absolute rule applies. No content nouns, no
titles, no catalog, no libraries as content, nothing unlimited.

### The one stop pitch

Permitted as a cost argument. Banned as a content argument.

| Allowed                                             | Banned                                      |
| --------------------------------------------------- | ------------------------------------------- |
| "One contribution instead of several subscriptions" | "Everything you are paying elsewhere for"   |
| "One login for the whole household"                 | "Cancel your subscriptions, this covers it" |
| "A single monthly contribution toward hosting"      | Any named commercial service, ever          |

The test is the one the compliance skill already uses: does the sentence describe what the
money keeps running, or what the member gets to consume? Consolidating spend is about
money. Replacing a streaming service is about content, because a catalog is the only thing
being replaced. Naming a competitor makes that implication explicit and is banned outright.

### Mandatory elements in every draft

- The feedback question, leading. The door is open line comes second.
- The contribution disclaimer, mirroring `Footer.tsx`: a contribution toward hosting and
  infrastructure costs, not a purchase of content.
- A plain opt out instruction that writes `optedOut` to the ledger when honored.

### Hard stop

If `copy-compliance/SKILL.md` cannot be read, the agent refuses to draft and says so. No
draft is better than an unchecked one.

## Handoff

1. The agent returns the pitch and the draft.
2. The operator approves or edits the copy.
3. The main session creates a Gmail draft: operator in `To`, cohort in `BCC`, never `CC`.
   Created as a draft, never sent.
4. The operator reviews it in Gmail and sends it.
5. Only then does the main session call `--record`.

Capped at 25 recipients per draft so a large cohort goes out in batches rather than one
blast that trips spam filtering.

If the Gmail MCP is not connected in that session, the draft is written to
`~/.local/state/wizteros/sales-agent/drafts/` and the agent says the fallback was used.

Sent from the operator's Gmail, not the bridge SMTP. That address carries invite and
renewal mail, and marketing complaints against it would put transactional delivery at
risk.

## Invocation

On demand only. No hook, no schedule. It runs when asked, matching how `deploy-nas` is
used.

## Red flags

- Contacting a VIP.
- Pitching someone whose real problem is billing.
- A member address anywhere but BCC.
- Drafting without reading `copy-compliance`.
- Re-pitching inside a cooldown, or past the third lifetime contact.
- An opt out that fails to survive to a second run.
- A lead line asserting something no upstream field supports.
- A cohort count that does not reconcile with contactable plus excluded.
- Copy that names a streaming service, promises titles, or says unlimited.
- Treating a clean run as proof the framing is safe. The gate reads rules and applies
  judgment. It does not guarantee a sentence is compliant, and the operator reads every
  draft before it is sent.

## Testing

The script is a read only gatherer with no test harness precedent in the other skills, so
verification is manual and stated rather than automated:

- Run against the live stack with `--all` and confirm cohort assignment matches the status
  badges on `/manage` for a sample of members in each play.
- Confirm a VIP never appears in any cohort.
- Confirm `--record` then a second run suppresses the recorded address.
- Confirm `--opt-out` survives a `--all` run.
- Confirm exit `2` when `STRIPE_API_KEY` is unset, with no partial output.
