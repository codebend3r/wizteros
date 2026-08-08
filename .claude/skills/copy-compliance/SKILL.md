---
name: copy-compliance
description: Use when wizteros user-facing copy has to be checked against the server-cost contribution framing, or when asked "audit the copy", "is this copy safe", "compliance check", "review the landing page copy", "does this wording cross the line". Also triggers on any change or PR touching the landing page, a tier card, a tier name or summary, checkout-adjacent wording, the invite or renewal email, or the member-facing footer. Only applies to the wizteros repo.
---

# Copy compliance for wizteros

## Overview

Every paid surface in this repo says the member is contributing to server costs. That is
not a marketing voice, it is the legal position. Plex's TOS prohibits selling access to a
server, and Stripe's TOS prohibits selling rights you do not own. Copy that promises
titles, libraries, or a catalog describes a content sale, and a content sale is the thing
neither TOS allows.

Nothing enforces this. There is no linter rule, no test, and no CI check that reads copy.
The whole guard is one line in CLAUDE.md and whoever happens to be paying attention. A
single innocent tweak to a tier card is enough to cross the line.

This skill surfaces candidates and nothing more. **The human judges every hit.** Fixes
are rewrites, made deliberately, as their own change.

## Running it

```bash
node .claude/skills/copy-compliance/scripts/extract-copy.mjs
node .claude/skills/copy-compliance/scripts/extract-copy.mjs --all
```

The script resolves the repo root from its own location, so it runs from any clone or
worktree (`WZ_REPO` overrides). It is read-only, has no dependencies, and always exits 0
when it runs, whatever it finds. Hits are candidates, not build failures.

| Flag | Meaning |
|---|---|
| (none) | Print only lines matching a risk term, grouped payment surfaces first |
| `--all` | Dump every extracted string, unfiltered. Use it when auditing new copy the term list has never seen |

If a configured path no longer resolves, the script prints an `INCOMPLETE RUN` warning
naming each missing entry and still exits 0. Treat that as a broken tool, not a clean
audit: fix the path lists at the top of the script before reading any result. This is the
one failure mode that matters, because a restructure silently turns the extractor into a
no-op that reports zero hits.

Each row reads `line  origin  [terms]  source`. `origin` is how the text was found:
`string` (a quoted literal), `text` (a JSX or HTML text node, or a Python triple-quoted
block), `comment` (a code comment, always exempt, shown so nothing is dropped silently).

## Surfaces where the rule is absolute

These are payment surfaces. A member reads them while deciding to pay, while paying, or
right after paying. No content nouns, no titles, no catalog language, at all.

| Surface | Path |
|---|---|
| Landing page composition | `apps/admin-portal/src/App.tsx` |
| Tier cards, tier names, summaries, feature rows, tagline, support items | `apps/admin-portal/src/site.config.ts` |
| Pricing section chrome | `apps/admin-portal/src/components/Pricing/Pricing.tsx` |
| Hero | `apps/admin-portal/src/components/Hero/Hero.tsx` |
| What the contribution funds | `apps/admin-portal/src/components/Support/Support.tsx` |
| Member links and the disclaimer | `apps/admin-portal/src/components/Footer/Footer.tsx` |
| Document title (search results, browser tab) | `apps/admin-portal/index.html` |
| Invite email, HTML body | `apps/stripe-bridge/stripe_bridge/email_template.py` |
| Invite email, subject and plain-text body | `apps/stripe-bridge/stripe_bridge/mailer.py` |

`App.tsx` and `Support.tsx` are surfaces without copy of their own: both render text
passed down from `site.config.ts`, so the extractor correctly reports no rows for them.
Audit their wording in `site.config.ts`, and read the components only to confirm they
have not started hard-coding strings.

Two payment surfaces the extractor cannot reach:

- **Stripe product names, product descriptions, and Payment Link page copy.** They live
  in the Stripe dashboard, reached from `VITE_PAYMENT_LINK_*_URL`. This is the copy
  Stripe's own compliance team reads, it is the most exposed text in the system, and not
  one character of it is in this repo. Check it by hand, every audit.
- **Wizarr's own onboarding screens**, which the invite link lands on. Configured in
  Wizarr on the NAS, not here.

## Surfaces that are exempt

Admin-only pages behind `AdminGate`, all under `apps/admin-portal/src/pages/`: `Manage`,
`User`, `Invite`, `Email`, `ResetUser`, `Login`, and the components only they render
(`MembersTable`, `SideMenu`, `AdminLayout`, `ConfirmInviteModal`, `ConfirmActionModal`,
`CopyEmailsButton`). One person signs in there. Nobody is being sold anything, so
`'Everything except 4K'` on the invite form is operator shorthand, not a promise.

Also exempt: code comments, tests, `docs/`, `README.md`, `CLAUDE.md`, commit messages,
and the operator alert emails in `mailer.py` (`send_alert_email`, addressed to the admin).

Exempt means "not a violation". It does not mean invisible: the extractor still prints
these, under a separate heading, so a genuinely bad line cannot hide behind an exemption.

## Safe framings versus risky ones

The test that decides it: **does this sentence describe what the money keeps running, or
what the member gets to consume?** The first is a hosting contribution. The second is a
content sale.

### Models, all real copy in this repo

| Copy | Why it works |
|---|---|
| `'A community-run media server. Contribute to the cost of keeping it online.'` (`site.config.ts:85`) | Names the thing being funded (a server), and the verb is contribute, not buy |
| `'A monthly contribution toward hosting, storage, and bandwidth.'` (`Pricing.tsx:17`) | Three infrastructure line items. Zero content nouns |
| `'A contribution toward hosting and infrastructure costs, not a purchase of content.'` (`Footer.tsx:6`) | The disclaimer. It says the quiet part out loud, which is exactly why it is safe |
| `'Server hardware'` / `'Storage & bandwidth'` / `'Maintenance & uptime'` (`site.config.ts:41-54`) | The support section is the framing in miniature. Copy this register |
| `'Thanks for contributing to server costs.'` (`email_template.py:23`, `mailer.py:54`) | First line a paying member reads, and it names costs, not content |
| `'If you cancel your contribution, access will be removed at the end of the current billing cycle.'` (`email_template.py:45`) | Access is a consequence of contributing, never the thing purchased |
| `'Already contributing? Access your account'` (`Footer.tsx:3`) | Identifies members by what they contribute, not what they watch |
| The `<title>` ending in `media server hosting` (`apps/admin-portal/index.html:7`) | The title tag is copy too, and it says hosting |

### Risky, with the rewrite that keeps the page reading well

| Risky | Problem | Rewrite |
|---|---|---|
| `'Request any show or movie'` | The worst line on the page. An unbounded promise to obtain specific titles, on a payment surface, next to a price | `'Request additions to the server'` |
| `'The full catalog in 4K.'` | "Catalog" is an inventory of content. It says the money buys a library | `'Full server access, 4K capable.'` |
| `'Access to all youth 1080p tv shows and movies'` | Names content types outright | `'Access to all youth-scoped 1080p shares'` |
| `'Access to all 4K youth movies'` | Same | `'Access to the youth-scoped 4K share'` |
| `'Access to all 1080p libraries'` / `'Access to all 4K libraries'` | "Libraries" is Plex's content noun. Milder than "movies", still content inventory | `'Access to all 1080p shares'` / `'Access to all 4K shares'` |
| `'Access to Lossless Music Library'` | Same, and it names a format tier of content | `'Access to the lossless audio share'` |
| `'A family plan curated for youth.'` | "Curated" claims editorial selection of content | `'A youth-scoped share for family households.'` |
| `'The essentials to get streaming.'` | Borderline. Sells the consumption, not the contribution | `'The entry-level contribution.'` |

Resolution words (`4K`, `1080p`) are the one judgment call worth stating: they are
acceptable **attached to server capability** ("4K capable", "4K shares"), because that
describes bandwidth and storage the contribution funds. They are not acceptable attached
to a content noun ("the full catalog in 4K", "4K movies"), because that prices content by
quality. The extractor flags them either way and lets the human split the two.

Two hits that look bad and are correct as written:

- `'not a purchase of content.'` (`Footer.tsx:6`) flags on `content`, in a negation. The
  disclaimer needs the word to deny the thing. Leave it alone.
- `'Always-on machines that host and stream the platform.'` (`site.config.ts:44`) flags
  on `stream`, used as a verb about the hardware. That is infrastructure language.

## Procedure

1. **Run the extractor.** Read the payment-surface block first. The admin block is
   context, not a worklist.
2. **Judge every hit against the surface it appears on.** Same word, different verdict:
   `library` on a tier card is a content promise, `library` in the admin members table is
   a count of Plex objects for one operator.
3. **Read the surrounding copy, not just the flagged line.** The term list catches known
   words. A sentence can promise content without using one of them, and only reading
   catches that. `--all` is for exactly this pass.
4. **Check Stripe by hand.** Product names and descriptions on the live Payment Links.
   The script cannot see them and never will.
5. **Rewrite in place.** Never delete a sentence to make a hit go away: the page still
   has to read well and the tier cards still have to line up (see below). A tier that
   loses a feature row looks worse than one with fixed wording.
6. **Re-run the extractor, then `bun run verify`.** Copy strings are asserted in tests.

## Rewriting without breaking the page

Three traps specific to `site.config.ts`, all of them silent:

- **`toChecklist` matches by exact string.** `included.includes(label)` decides the check
  or the cross. Rewriting a label in `FEATURE_LABELS` without rewriting the same string in
  every tier's `included` array flips that row to "Not included" with no error anywhere.
  Bronze, Silver, and Gold all carry their own copies.
- **The four cards align row by row.** `FEATURE_LABELS` and `YOUTH_FEATURE_LABELS` are
  index-aligned on purpose (the comment at `site.config.ts:64-65` says so). Removing a
  row from one list breaks the visual alignment of all four cards.
- **Tests hard-code the labels.** `apps/admin-portal/src/site.config.test.ts` asserts both
  label lists verbatim; `apps/stripe-bridge/tests/test_email_template.py:19` asserts
  `"server costs"` is in the invite HTML;
  `apps/stripe-bridge/tests/test_bridge.py:619` asserts the invite subject.
  Tests are exempt from the framing rule but they are not exempt from being updated.

## Current findings

Found by reading the surfaces while writing this skill. **Reported only. Not fixed.**
The framing decision on each is the repo owner's.

Violations, all on the landing page, all in `apps/admin-portal/src/site.config.ts`:

| Line(s) | Copy | Call |
|---|---|---|
| 61, 71, 102, 119, 137, 154 | `'Request any show or movie'` | Violation. Appears on all four tier cards. An unbounded promise of specific titles in exchange for a monthly payment |
| 112 | `'The full catalog in 4K.'` | Violation. Silver's summary sells a content catalog |
| 67, 151 | `'Access to all youth 1080p tv shows and movies'` | Violation. Names content types on a priced card |
| 68, 152 | `'Access to all 4K youth movies'` | Violation. Same |

Borderline, same file, worth a decision rather than a reflex:

| Line(s) | Copy | Call |
|---|---|---|
| 57, 58, 100, 116, 117, 133, 134 | `'Access to all 1080p libraries'`, `'Access to all 4K libraries'` | Borderline. "Libraries" names Plex objects rather than titles, but it reads as content inventory next to a price |
| 59, 69, 101, 118, 135 | `'Access to Lossless Music Library'` | Borderline, same shape, plus it prices an audio format |
| 147 | `'A family plan curated for youth.'` | Borderline. "Curated" implies editorial selection of content |
| 96 | `'The essentials to get streaming.'` | Borderline. Sells consumption, though it names no content |
| 129 | `'Everything the server offers.'` | Acceptable as written. "Everything" is scoped to the server, not to a catalog. Watch it if it ever gets more specific |

Clean, no action: the invite email (`email_template.py`, `mailer.py`) is entirely
contribution-framed and mentions nothing a member can watch. `Footer.tsx`,
`Pricing.tsx`, `Hero.tsx`, `Support.tsx`, and `apps/admin-portal/index.html` are clean.
Admin pages carry content nouns (`'Everything except 4K'`, library counts) and are exempt.

Not verified: Stripe product and Payment Link copy, and Wizarr's onboarding screens.
Neither is in this repo.

## Red flags

- **A tier name or summary drifting toward a content promise.** Tier copy is the highest
  risk text in the repo: it sits directly against a price. `'The full catalog in 4K.'` is
  what that drift looks like when it has already happened.
- **The invite email mentioning what a member can watch.** It is currently clean, and it
  is the one surface Stripe can tie to a specific charge. Any content noun added here is
  a serious problem.
- **"Unlimited" anything on a payment surface.** Unlimited access, unlimited streaming,
  unlimited requests. It is a promise about content volume, and it is unbounded.
- **A new feature row added to the tier cards.** Every existing row already leans toward
  content language. New ones inherit that gravity.
- **Copy pasted from a commercial streaming service**, or written in that voice. Their
  legal position is that they own distribution rights. This one does not.
- **A hit being "fixed" by deleting the line.** That is a broken card, not a compliant
  one. Rewrite it.
- **Treating a clean extractor run as a pass.** It reads a fixed word list against the
  static strings in this repo. It does not read Stripe, it does not read Wizarr, and it
  does not understand a sentence.
