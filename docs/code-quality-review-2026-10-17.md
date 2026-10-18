# Code quality review and stacked-PR plan

Reviewed at `a8f31cf` (v0.4.3, `main`) on 2026-10-17. Line numbers are as of that commit and will drift as the stacks land; re-grep before acting on one.

Six reviewers each read one area in full: stripe-bridge, fleet-monitor (plays, plexSync, api), fleet-monitor (collector, probes, core), the portal's `lib/` and `stores/`, the portal's `pages/` and `components/`, and server-common with the tooling and skill scripts. The review was read-only. Implementation progress is tracked in section 6.

**Verification key.** Items marked ✓ were re-checked against the code by the coordinator. Unmarked items come from a single reviewer's reading and should be confirmed before the PR that fixes them.

**Verdict:** not approved. Module by module the code is careful. The weakness is between modules: the same few concepts (the wire contract, tier rules, identity, HTTP handling, loops, configs) are written out three to five times, and the copies have started to disagree.

## 1. Defects

Fix these before any refactor.

| #   | Defect                                                                                                                                                                                                                                                                    | Where                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Ban and VIP tags are written under the Plex email but read under the Stripe payer email. When the two differ, a VIP still gets expiry stamped and is disabled on cancel, and a banned member passes `isBanned` on renewal. ✓                                              | set: `roster.ts:328`, `useMemberActions.ts:170`; read: `webhook/handlers.ts:264,349,454` |
| 2   | The landing page breaks the copy rules. The Hero ticker lists "4K and 1080p movies", "Anime shows", "Kids TV shows"; the tagline says "a huge library of movies and TV… Request any show or movie", which the `copy-compliance` skill calls the worst line on the page. ✓ | `components/Hero/Hero.tsx:14-29`, `site.config.ts:110-111`                               |
| 3   | The re-invite confirmation says existing records are disabled. The bridge keeps them. ✓                                                                                                                                                                                   | `ConfirmInviteModal.tsx:21` vs `admin/actions.ts:414-421`                                |
| 4   | A fleet 401 throws a plain `Error`, so a lapsed session on /fleet, /plays or the incidents part of /income never signs the user out. ✓                                                                                                                                    | `lib/fleetApi.ts:300-314` vs `lib/queryClient.ts:17`                                     |
| 5   | The Member guard never checks `payment_state` or `stripe_email`, which drive status and income, and treats five always-sent fields as optional. ✓                                                                                                                         | `lib/adminApi.ts:170-210`                                                                |
| 6   | The polling `fleet-metric` query is missing from the persistence deny-list, so it is restored stale and re-serialised into sessionStorage on every poll. ✓                                                                                                                | `lib/queryPersistence.ts:4`, `Fleet.tsx:77`                                              |
| 7   | Reissue with an unknown tier silently mints a Bronze invite (`tier: z.string()` then `normalizeTier`). `resetTier` answers 400 for the same input. ✓                                                                                                                      | `admin/bodies.ts:26`, `admin/actions.ts:440`                                             |
| 8   | `invoice.payment_failed` with no customer throws before reaching the warn branch written for it, so Stripe keeps redelivering. ✓                                                                                                                                          | `webhook/handlers.ts:69,393-396`                                                         |
| 9   | CI never runs lint, typecheck, test or build on direct pushes to main. `83ca417` and `1da1acb` landed that way. ✓                                                                                                                                                         | `.github/workflows/pull-request-checks.yml:3`                                            |
| 10  | Every NAS deploy via the skill ships the local `apps/stripe-bridge/data/bridge.db` (member emails). The skill's exclude list has also drifted from `scripts/deploy-nas.sh` (no `fleet-monitor-data`, `fleet-monitor-ssh`). ✓                                              | `.claude/skills/deploy-nas/scripts/deploy-nas.sh:149`                                    |
| 11  | The bridge build compiles `src/test/**` into `dist`, which the Dockerfile copies into the production image. Nx's `production` input excludes those files, so the build cache key misses them. ✓                                                                           | `apps/stripe-bridge/tsconfig.build.json:10` vs fleet-monitor's                           |
| 12  | `deploy-nas.sh` reports a tier alarm whenever Wizarr is merely unreachable. `stack-health.sh` already tells the two apart. ✓                                                                                                                                              | `deploy-nas.sh:245` vs `stack-health.sh:340`, `sweeps.ts:147,160`                        |
| 13  | Income runs two state machines that disagree: a member seen only through "Payment received" who then cancels gets churn but never counted income. Not verified; needs a failing test first.                                                                               | `lib/income.ts:260` vs `:370`                                                            |

Secondary, reported but not verified:

- `ConfirmActionModal` never moves, traps or restores focus. `TierMenuButton` uses `role="menu"` with no arrow keys. Five error messages lack `role="alert"`. `PagedTable` renders two identical `nav aria-label="Pages"`.
- Nothing clears the persisted query cache on sign-out (`authStore.ts:35`), so member data stays in sessionStorage.
- "99.94%", "refreshed 40s ago" and "Last maintenance 3 days ago" are hardcoded (`StatusBoard.tsx`, `Hero.tsx`) while the monitor has real uptime data.
- `getMember` and `fetchUpstream` await three independent reads in series, starting with the ~15s users call. `eachInOrder` justifies ordering for writes only.

## 2. Structural moves

Each of these deletes a category of complexity rather than rearranging it. Sizes are the reviewers' estimates.

- **J1. One wire contract** (~1,100-1,300 lines). Portal types and guards restate each other (~500 lines in `playsApi.ts`, ~185 in `adminApi.ts`, ~77 in `fleetApi.ts`), then both servers copy the guards by hand: `fleet-monitor/src/test/wire.ts` (639 lines) and `stripe-bridge/src/test/adminHarness.ts:15-235`. Move to a pure-TS `libs/wire` with one schema per response, plus a `MemberAction` union so income stops regex-parsing event prose (`income.ts:166,260-338`). Both servers already pin `zod` 4.6.5.
- **J2. One identity resolver in the bridge.** The email, linked address, invite chain is implemented 3+ times with different subsets (`members.ts:23`, `reconcile.ts:15`, `handlers.ts:172-211`, the admin paths), and a new signup calls the ~15s `/api/users` twice. Fetch `{users, invitations, links}` once and use a pure `identityFor({snapshot, email}) → {addresses, records}`, with standing read as the strongest tag across the set. Closes defect 1; deletes `unstampedRecords`, `fromInvite`, the two `findUserIdsBy*` port methods and the duplicate rescoping in `resetExistingRecords` and `reissueInvite`.
- **J3. One portal HTTP client.** `authHeader` and `requestJson` are written twice with different 401, content-type and error-body rules (`adminApi.ts:124,330`, `fleetApi.ts:287,300`). `lib/http.ts` `createClient({base})` with `read`/`write`, one 401 path, one `{"detail"}` parser. ~280 lines.
- **J4. fleet-monitor maintains rollup tables nothing reads.** `rollups.read` has no production caller ✓; `rollup_5m` (90 days) and `rollup_1h` (2 years) are write-only, alongside the worker thread, `joinCompactions`, the 60s stop grace and the exit-133 handling. History is capped at 7 days because it reads raw samples (`fleetController.ts:22`). Either wire rollups into `series.history` for longer windows or delete compaction and keep `prune`. Also drop the `coverage` table (`store.ts:35,355`, `fleet.ts:194-220`; subsumed by the per-target observed run, since the clamp always picks `run.since`) and the never-read `samples.kind` column (~25 `kind:` literals in the probes).
- **J5. Schema and compaction out of `collector.ts`.** `appModule.ts:5` ✓ imports `initDb` from the collector, so the API and every 15-minute compaction worker load ssh, every probe and plexSync. Table setup is aggregated twice with different subsets (`collector.ts:501`, `plexSync.ts:859`) and a third time in tests. `schema.ts` with one `initDb`, plus `compaction.ts`.
- **J6. `plexSync.ts` (1,007 lines).** `getJson` already bounds the whole request (`http.ts:151`) ✓, yet `plexSync.fetch` races it against a second deadline (`:273-300`) ✓, which exists only because the test fake ignores signals. `getJson` returns `{ok, status, body, reason}` that every caller re-decodes (three `bad_json` branches, two different `GetJson` types at `collector.ts:37` and `plexSync.ts:153`). Moves:
  - `getJson({…, signal}) → {ok:true; payload} | {ok:false; reason}`; fakes drop to the `Send` level.
  - One `plexClient({host, token, via})` per host, replacing eight functions that hand-thread `host, path, token, via, now`.
  - A discriminated `Fetched` instead of `reason: ''` meaning success (a JSON `null` body currently reports success and commits nothing).
  - One pager (`pageHistory` and `pageSection` share a verbatim end-of-pages test).
  - Split into `plexSync/{client,history,inventory,index}.ts`.
  - `tasks.ts` gets one `every({seconds, signal, round})` and the single `isAbort` (three copies today ✓, two hand-written fixed-cadence loops).
- **J7. `plays/views.ts` (868 lines).** Three history row types, three mappers and two copies of count+page are one row with fields dropped (`:109,141,173`, `:643,692,848`). `baseTable` grew two one-caller knobs; `table` copies the whole ledger with its LAG window into a second temp table to read one title's name (`views.ts:798`).
- **J8. Portal pages.** A layout route with `<Outlet/>` replaces nine copies of `XInner` + `AdminGate` + `<AdminLayout><main className={styles.page}>` and ~20 lines of `.page`/`.title` SCSS each (`AdminGate` is a pure pass-through; titles have drifted). `components/DataTable<T>({columns})` replaces `WatchHistory`, `ViewerHistory` and `TitleHistory` (one table) and five other hand-written tables, using `IncomeTable`'s `COLUMNS` as the model. One `PressedGroup` replaces four copies (Manage, EventTimeline, PlaysFilters, `RangePicker`).
- **J9. Delete two pages.** `pages/Design` (603 TSX + 721 SCSS) hand-copies tokens (missing `--space-0`, `--radius-sm`, payment-failed, the series tokens) and states rules that are no longer true ("every mutation confirms first"). `pages/ResetUser` is still routed at `/reset-user` ✓ but linked from nowhere, bypasses React Query, has an unlabelled input and stale copy.
- **J10. Tier is defined in five places in the portal** (`adminApi.ts:4`, `inviteRules.ts:5-37`, `site.config.ts` with prices as `'$8'` strings parsed back at `income.ts:71`, Invite's `TIER_SUMMARY`; two exported types both named `Tier`) **and passed as a bare string in the bridge store** (`CustomerRow.tier: string`). One `lib/tiers.ts` table; in the bridge, type writes as `Tier` and confine `normalizeTier` to Stripe metadata.
- **J11. Tooling.** PR workflow on push to main (defect 9). Deploy ships `git archive HEAD | ssh … tar -x`: the skill already refuses unless main is clean and in sync, so this deletes both exclude lists, the SMB branch and `scripts/deploy-nas.sh` (defect 10). Shared `tsconfig.server.json` and `.oxlintrc.server.json` registered in the currently empty `sharedGlobals` (defect 11); each project's `.oxlintrc` also disables `no-non-null-assertion` for tests though no test uses one. One parameterised server Dockerfile (the fleet image is never built in CI). `fastApiCompat(app)` in server-common replacing four identical calls in both `app.ts` files. Export `stackOf` (three copies), `parseInteger` (three) and `isRow` (copied seven times as `isObject`/`isRecord`) from server-common.
- **J12. Skill scripts reimplement the bridge.** Four scripts read the live `bridge.db` three different ways, one with a raw `cat` of a live file (the torn-copy risk `backup.sh` warns about). `nasHost()` is copied four times, Stripe pagination three, a Wizarr GET helper six. Two `PAYING` copies duplicate `subscriptionStatus.ts`. Add a strictly read-only `dist/opsCli.js` to the bridge image and `.claude/skills/_shared/ops.mjs`. Separately, `monitor-ci` cannot run in this repo (it requires Nx Cloud) yet CLAUDE.md recommends it.

## 3. Leave alone

`sequence.ts`; the `standing.ts`, `subscriptionStatus.ts` and `TIER_RULES` tables; the `Bridge` port with its fakes; the webhook queue with mark-after-success; the read/write lock reasoning in `withSqlite`; fleet-monitor's pure probe parsers, one-session-per-observation writes, incident hysteresis and `pythonMath.ts`; the portal's `ChartScale` / `components/Chart` layer, `playsParams.ts`, `ViewTabs` and `readMonitor`'s shape (extend, don't replace); `version-markers.mjs`; the allowlist dockerignores.

## 4. Stacked-PR plan

About 38 PRs in seven short stacks. One 38-deep stack would force a restack of everything above on any change near the bottom. Stacks that do not touch the same files run in parallel.

```
main
├─ 0  guardrails ─► A  live defects ─► release 0.4.4 + deploy:nas
│                   (everything below roots at main once A has merged)
├─ B  bridge identity ─────────────► e2e-runner, release, deploy:nas
├─ C  one wire contract: C1–C4 ─┬─► C5–C8 (after B merges)
│                               └─► F  portal pages
├─ D  fleet-monitor core ──────────► nas-state-backup before D6, deploy:nas
└─ E  server tooling + skills: E1–E3 ─► E4 (after B merges)
```

### Rules for every PR

- Each PR is a behaviour change or a pure refactor, never both. A refactor PR passes the existing tests unchanged (tests may move, not change). `api.test.ts` and the bridge's `adminHarness` prove the API responses are byte-identical.
- Each PR's base is the branch below it. CI's `pull_request` trigger has no branch filter, so stacked PRs get checks.
- Merge bottom-up only. The repo squash-merges and auto-deletes branches; GitHub retargets the next PR to `main`, but its branch still carries the pre-squash commits. Restack with `git rebase --onto origin/main <merged-branch-old-tip> <top-branch> --update-refs`, then `--force-with-lease`. Every restack is a force push, so ask each time unless pushes are approved once per stack.
- Titles and commits start `WZ:` (CLAUDE.md). Use the `commiter` and `pr-creator` skills. Releases go through `scripts/release.sh` / `version-bumper`, never by hand-editing a version.

### Stack 0: guardrails (merge first)

| PR  | Change                                                                                                                                                                                              | Kind     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 0.1 | Run PR checks on pushes to main too; move version parity into that workflow; key concurrency on `github.ref` (`head_ref` is empty on a push).                                                       | infra    |
| 0.2 | Bridge build excludes `src/test`. Shared `tsconfig.server.json` and `.oxlintrc.server.json` in `sharedGlobals`. Drop the per-project test override of `no-non-null-assertion` (no test uses one).   | infra    |
| 0.3 | `server-common` exports `stackOf`, `isRecord`, `parseInteger`, replacing ~13 copies. Note: server-common consumers use its built `dist`, so apps depend on `^build`, and the lib imports `./` only. | refactor |

### Stack A: live defects, then release 0.4.4 and `deploy:nas`

A1–A4 are combined into one behaviour-fix PR at the owner's request. Release 0.4.4 and production deployment remain follow-ups after merge.

| PR  | Change                                                                                                                                                                                | Kind |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| A1  | Landing copy: Hero ticker, tagline, hardcoded telemetry; plus the re-invite modal copy. Run `copy-compliance`.                                                                        | fix  |
| A2  | Portal: fleet 401 signs out; Member guard checks `payment_state`/`stripe_email` and drops the legacy optionals; persistence opt-in (fixes `fleet-metric`); cache cleared on sign-out. | fix  |
| A3  | Bridge: reissue with an unknown tier answers 400; `payment_failed` with no customer warns instead of throwing.                                                                        | fix  |
| A4  | Deploy ships `git archive HEAD`; delete `scripts/deploy-nas.sh`; the bridge logs a stable marker on a real tier alarm and all three scripts grep for it.                              | fix  |

### Stack B: bridge identity, then e2e-runner, release, `deploy:nas`

| PR  | Change                                                                                                                           | Kind     |
| --- | -------------------------------------------------------------------------------------------------------------------------------- | -------- |
| B1  | Pure `identityFor({snapshot, email})` plus tests; nothing calls it yet.                                                          | refactor |
| B2  | Members, reconcile and the checkout reset use it. Drop `findUserIdsBy*` from the port. A new signup makes one `/api/users` call. | refactor |
| B3  | Defect 1: `strongestTag` across a person's addresses for webhooks, sweep, ban and cancel; Stripe lookups cover every address.    | fix      |
| B4  | One `rescopeRecords`; checkout goes through `issueInvite({sessionId})`; one `payerEmail`.                                        | refactor |
| B5  | `Tier` typed through the store; members built in one pass; independent reads in parallel.                                        | refactor |

### Stack C: one wire contract

| PR  | Change                                                                                                                                                | Kind     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| C1  | Scaffold `libs/wire`: Nx project, lockstep version marker, Dockerfile and dockerignore entries. One trivial schema to prove Netlify and Docker build. | infra    |
| C2  | `lib/http.ts` `createClient`; adminApi and fleetApi use it.                                                                                           | refactor |
| C3  | Fleet responses move into wire; delete the portal's fleet guards, the `HostSummary` layer and the fleet half of `test/wire.ts`.                       | refactor |
| C4  | Plays responses move into wire; delete playsApi's guards and the rest of `test/wire.ts`; move toolbar wording out of the API module.                  | refactor |
| C5  | Admin responses move into wire; delete adminApi's guards and the `adminHarness` copies (after B).                                                     | refactor |
| C6  | `MemberAction` union: the bridge writes events through it; income's switch becomes exhaustive (after B).                                              | refactor |
| C7  | One `lib/tiers.ts` table (prices as numbers) and one `lib/format.ts`.                                                                                 | refactor |
| C8  | Income as one chronological walk. Starts with a failing test for defect 13; if it does not reproduce, this is a refactor only.                        | fix?     |

### Stack D: fleet-monitor

| PR  | Change                                                                                                                                                        | Kind     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| D1  | `schema.ts` and `compaction.ts` out of the collector.                                                                                                         | refactor |
| D2  | `tasks.ts` owns `isAbort` and `every()`; both loops use them.                                                                                                 | refactor |
| D3  | Transport owns its contract: `getJson` returns a union and takes a signal; `SshResult` a union; fakes at the `Send` level; delete plexSync's second deadline. | refactor |
| D4  | plexSync: one `plexClient` per host, discriminated `Fetched`, one pager. Tiny behaviour change: a JSON `null` body now fails.                                 | refactor |
| D5  | Split into `plexSync/{client,history,inventory,index}.ts`.                                                                                                    | move     |
| D6  | The rollup decision (J4); drop `coverage` and `samples.kind`. Migrates the live `fleet.db`: run `nas-state-backup` first.                                     | schema   |
| D7  | `views.ts`: one history row type, `pagedPlays`, `baseTable` without its one-caller knobs, then split.                                                         | refactor |

### Stack E: tooling and skills

| PR  | Change                                                                                                                            | Kind     |
| --- | --------------------------------------------------------------------------------------------------------------------------------- | -------- |
| E1  | `fastApiCompat(app)`, trimmed lib exports, shared fixtures from `server-common/testing`; delete the duplicate monitor auth tests. | refactor |
| E2  | One parameterised server Dockerfile; CI smoke-builds both images.                                                                 | infra    |
| E3  | `.claude/skills/_shared/ops.mjs` (`nasHost`, `ssh`, `stripeList`, `wizarrGet`).                                                   | refactor |
| E4  | Read-only bridge `opsCli`; three skill scripts stop reading `bridge.db` themselves (after B).                                     | refactor |
| E5  | Remove or rewrite `monitor-ci`; update CLAUDE.md's mention.                                                                       | cleanup  |

### Stack F: portal pages (on top of C4)

| PR  | Change                                                                                                | Kind     |
| --- | ----------------------------------------------------------------------------------------------------- | -------- |
| F1  | Delete `ResetUser` and `Design`, or shrink Design.                                                    | delete   |
| F2  | Layout route plus `AdminPage`; delete `AdminGate` and the nine page shells.                           | refactor |
| F3  | `components/DataTable<T>` plus `PLAY_COLUMNS`; migrate the three history tables, then the other five. | refactor |
| F4  | `PressedGroup`, shared `Alert`, heading `level` on `Section`; delete `RangePicker`.                   | refactor |
| F5  | `useReissueInvite`, one mutation style, one outcome state (after C5).                                 | refactor |
| F6  | Accessibility: native `<dialog>`, `TierMenuButton`, `role=alert`/`status`, the duplicate pager nav.   | fix      |

## 5. Open decisions

1. **B3:** should a tag on any of a person's addresses apply to all of them? Recommended: yes.
2. **A3:** resolved in Stack A: unknown tiers on reissue answer 400, matching reset-tier.
3. **A1:** proposed landing wording in the Stack A PR: “Community powered. Member funded.” Final wording is reviewable there.
4. **D6:** wire the rollups into history, or delete compaction and keep only pruning?
5. **F1:** delete Design, or shrink it to render the real components?
6. **C1:** `zod/mini` in the portal bundle, or a small hand-written combinator? Recommended: zod, since both servers already pin it.

## 6. Progress

Update this table as PRs open and merge.

Stack 0 implementation notes:

- Shared server configs are hashed by Nx and the TypeScript config is included in both Docker build contexts.
- The two wire-test record guards retain their array-accepting behaviour until Stack C; all equivalent server record guards use `isRecord`.
- The portal had two test non-null assertions, contrary to the review's note. Explicit element checks replace them; all projects now enforce the rule in tests.
- Validation: uncached workspace verification, workflow lint (`actionlint`), version parity, both Docker builds and production import smoke tests. The bridge image contains no `dist/test` directory.

Stack A implementation notes:

- A1: hosting-contribution headline, ticker and tagline; unavailable public telemetry is labelled rather than fabricated, and cost allocations are explicitly illustrative. Re-invite copy describes preserved access and the uncovered-server exception.
- A2: monitor 401s use the shared auth-error path; both member endpoints require all current fields. Only successful `members` queries opt in to persistence, old blobs are invalidated, and sign-out clears memory and storage while blocking delayed writes.
- A3: regression tests cover unknown-tier 400s before upstream calls, acknowledgment of failed-payment invoices without a customer/email, and retries for real Stripe lookup failures.
- A4: one deploy entrypoint ships `git archive HEAD`; fake-SSH tests exercise the real script without touching a NAS, including ignored local data, preserved live state, preflight, dry-run and alarm classification. Deploy, stack-health and member-triage match `[TIER_SCOPE_ALARM]`.
- Copy-compliance extractor reviewed (including the public StatusBoard). Remaining payment-surface candidates describe server capabilities or the explicit non-purchase disclaimer. Live Stripe Payment Links and Wizarr onboarding were not audited.
- Validation: `bun run verify --skip-nx-cache` passed across all four workspace projects, including tooling tests, version parity and the security scan. Copy extractor ran in filtered and `--all` modes; both shell scripts passed `bash -n` and ShellCheck.
- No release or production deployment performed.

| Stack | State                                               | PRs |
| ----- | --------------------------------------------------- | --- |
| 0     | merged                                              | #70 |
| A     | A1–A4 implemented on `stack-a-live-defects`; one PR |     |
| B     | not started                                         |     |
| C     | not started                                         |     |
| D     | not started                                         |     |
| E     | not started                                         |     |
| F     | not started                                         |     |
