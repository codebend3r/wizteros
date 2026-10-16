---
name: security-audit
description: Use when the wizteros repo needs a security check, or before anything is pushed, merged or made public. Triggers include "security check", "security audit", "is anything leaking", "scan for personal info", "are there ips in the repo", "check for secrets", "did we commit an email", "make sure nothing private is in the repo", or a new doc, test fixture, script or env example that might carry a real address, host, email or key. Only applies to the wizteros repo, which is public.
---

# Security audit for wizteros

## Overview

This repo is **public**, and it describes a private home network and a real member list.
The audit answers one question: _does anything in what we publish identify a person or a
machine, or let someone in?_ It has two halves:

1. **A deterministic leak scan** (`scripts/scan.mjs`), the same answer every run.
2. **A judgement pass** over the things a regex cannot see: dependency advisories, auth,
   webhook handling, injection, container and workflow hardening.

The scan is read-only. Fixing is a separate step, and nothing here commits, pushes or
rewrites history: those need an explicit instruction (see Hard rules in `CLAUDE.md`).

## Running the scan

```bash
bun run security:scan                   # the working tree: tracked files plus untracked, un-ignored ones
bun run security:scan -- --history      # also every line any commit on any branch ever added
bun run security:scan -- --json         # machine-readable
bun run security:scan -- --all          # lift the 25-hits-per-rule cap
```

Exit `0` is clean, `1` is findings, `2` is a usage error. Run it before a push and after
any change that adds a doc, fixture, script or env example.

| Rule             | Catches                                                                                  | Fix                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `private-ip`     | RFC 1918, tailnet (100.64/10) and link-local addresses                                   | `.env` for code; `192.0.2.x` in tests; `<meleys-ip>` in docs                 |
| `tailnet-name`   | `*.ts.net` hosts                                                                         | `<node>.<tailnet>.ts.net` in docs; an env var in code                        |
| `email`          | any address outside `example.*` and the committed allowlist                              | `@example.com`; real ones stay in `.env` or the live store                   |
| `home-path`      | `/Users/<name>/`, `/home/<name>/`                                                        | `~/…`                                                                        |
| `secret`         | live Stripe keys, webhook secrets, JWTs, GitHub/Slack/AWS/Anthropic tokens, private keys | **Rotate first**, then remove. Deleting it from the tree does not un-leak it |
| `sensitive-file` | a tracked `.env`, `*.pem`, `*.key`, `*.db`, `id_*`, anything under `fleet-monitor-ssh/`  | `git rm --cached`, add to `.gitignore`, rotate what it held                  |
| `denylist`       | your own never-publish strings                                                           | see below                                                                    |

Secrets are printed masked (first six characters and a length), so a report never
re-leaks what it found.

### What the scan deliberately lets through

- Documentation ranges (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`), loopback, `0.0.0.0`,
  and version strings such as Plex's `1.43.4.10903`.
- `example.com`/`.org`/`.net`, `.example`, `.invalid`, `.test`, GitHub noreply addresses.
- The placeholder addresses in `scripts/allowlist.json` (`x.com`, `alice@gmail.com`, …).
  Add to it only when the address is invented. A real person's address never goes in the
  allowlist, because the allowlist is committed.
- Any line carrying `security-audit:ignore`, for the rare string that has to look like a
  leak. Use it sparingly and say why on the line above.

### Your own denylist

Names, domains and handles that must never appear are private by nature, so they cannot
live in a committed file. Put them in the gitignored `.security-audit-denylist` (one per
line, `#` comments) or in `SECURITY_AUDIT_DENYLIST` (comma separated). Matches are
case-insensitive substrings. First run on a fresh clone: create the file with the owner's
legal name, personal domains and the handles the repo should never carry.

## The audit, in order

1. **Scan the tree.** `bun run security:scan`. Fix every hit; do not allowlist a real one.
2. **Scan history.** `bun run security:scan -- --history`. Anything found here is already
   public. A secret means rotate it now. An address or hostname means the only cure is a
   history rewrite plus a force-push, which is outward-facing and irreversible for anyone
   who cloned: **report it and ask**, never do it unprompted.
3. **Dependencies.** `bun audit`. Report the count and the direct (non-transitive)
   packages. `bun audit fix` rewrites `bun.lock`, so run it only when asked.
4. **Code review for what regexes cannot see.** Read, do not run anything that touches the
   NAS, Stripe or Wizarr. Cover:
   - **Auth.** `libs/server-common/src/adminAuth.ts`: algorithm pinned, issuer and
     audience checked, expiry enforced, blank config fails closed, allowlist compared
     case-insensitively. Every admin and monitor route behind `SupabaseAdminGuard`.
   - **Webhook.** Signature verified against the raw body, replay protection, what each
     handler trusts (for example, whether `payment_status` is checked before granting).
   - **Injection.** Every SQLite value bound, never interpolated; any `spawn`/`exec` built
     from an argv array, not a shell string; no user-controlled URLs.
   - **Secrets in flight.** Nothing logged, echoed in an error body, or stored; `.env`
     excluded from every Docker context (`Dockerfile.dockerignore`); which containers get
     which env (a public-facing service should not hold the Stripe key).
   - **Containers and workflows.** Root users, published ports, unauthenticated Docker TCP,
     `pull_request_target`, `${{ github.event.* }}` inside `run:`, unpinned third-party
     actions, missing `permissions:`.
   - **Portal.** No `dangerouslySetInnerHTML`, no tokens in URLs, client gating treated as
     UX only, and any `VITE_*` value understood to be **inlined into the public bundle**.
5. **Report.** Group by severity (Critical, High, Medium, Low). For each: file and line,
   the concrete failing scenario, and the one- or two-line fix. Drop anything speculative
   after reading the surrounding code. Say what was checked and found sound.

Test-mode Stripe keys and placeholder values in `.env.example` are not findings; do not
warn about them.

## Where addresses live now

The fleet's hosts are not in the code. They come from the gitignored `.env`:

| Variable      | Holds                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------ |
| `FM_HOST_IPS` | one comma-separated list of five IPv4 addresses: meleys, vermithor, caraxes, syrax, vhagar |
| `FM_SSH_USER` | the ssh account on those hosts                                                             |
| `WZ_NAS_HOST` | optional `user@host` override for the NAS; otherwise built from the two above              |

`scripts/nas-host.sh [host]` turns those into an ssh target for the skills' scripts, and
the fleet monitor refuses to boot if `FM_HOST_IPS` is missing, the wrong length, or holds
anything that is not an IPv4 address. A new host, address or account means a new `.env`
value or a placeholder in a doc, never a literal in a tracked file.

## Adding a new check

Add a rule to `buildRules` in `scripts/scan.mjs` and a test to `scripts/scan.test.mjs`
(`node --test .claude/skills/security-audit/scripts/scan.test.mjs`). Build any leak-shaped
fixture at runtime (`['192','168','1','5'].join('.')`) so the test file does not trip its
own scanner.
