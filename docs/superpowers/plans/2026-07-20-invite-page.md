# /invite Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only `/invite` page that invites a brand-new person — type an email, pick a tier, send the scoped invite.

**Architecture:** Frontend-only. A new React page reuses the existing `POST /admin/reissue-invite` endpoint (already correct for a never-before-seen email: nothing to disable, writes a pending row, emails the link). A client-side guard blocks emails that already belong to a member and points the admin to the `/user` re-invite flow. No bridge/Python changes.

**Tech Stack:** React 18 + TypeScript (strict), React Router, TanStack Query, SCSS modules, Vitest + Testing Library. Package manager: **bun** (`bunx`, `bun run`).

## Global Constraints

- **TypeScript:** `type` aliases only — never `interface` (lint: `typescript/consistent-type-definitions`). No `any`. No type casts. Prefer type guards.
- **Code style:** `Array.prototype` methods, never `for`/`for..of`. Double-bang (`!!v`) for booleans. Short-circuit `&&` (not ternary) for conditional React render where the else branch is null/undefined; guard numbers so `0` never renders. Optional chaining pairs with `??`. Single object param over positional params.
- **CSS:** SCSS modules per component. All colors/spacing/radius/fonts come from `styles/globals.scss` tokens (`--color-*`, `--space-*`, `--radius-*`, `--font-*`). Container-driven layout with grid/flex + `gap`; no margins for spacing; no bare `<div>` without a class.
- **Comments:** docstrings on functions only — never line-by-line, never on imports.
- **Commits:** subject starts with `WZ:`; concise bullet body. Commit after each task.
- **Payment/user-facing copy:** infrastructure/hosting framing; never reference content, libraries, or titles. (No such copy appears in this plan — tier summaries describe access scope, not content.)
- **Reused exports (do not redefine):** `reissueInvite`, `fetchMembers`, types `InviteResult`, `Member`, `PaidTier`, `AdminAuthError` from `@/lib/adminApi`; `PAID_TIERS`, `TIER_LABELS`, `TIER_DOWNLOADS`, `ACCESS_DAYS`, `INVITE_LINK_DAYS`, `isPaidTier` from `@/lib/inviteRules`; `MEMBERS_QUERY_KEY` from `@/pages/Manage/Manage`; components `AdminGate`/`useAdminAuth`, `AdminLayout`, `ConfirmActionModal`, `TierIcon`.

---

### Task 1: Route, page shell, and Manage entry link

Navigation scaffold: you can reach `/invite` (behind the password gate) from a link on `/manage`, and get back. No form yet.

**Files:**

- Create: `web/src/pages/Invite/Invite.tsx`
- Create: `web/src/pages/Invite/Invite.module.scss`
- Create: `web/src/pages/Invite/Invite.test.tsx`
- Modify: `web/src/AppRoutes.tsx`
- Modify: `web/src/pages/Manage/Manage.tsx`
- Modify: `web/src/pages/Manage/Manage.module.scss`
- Modify: `web/src/pages/Manage/Manage.test.tsx`

**Interfaces:**

- Consumes: `AdminGate`, `useAdminAuth`, `AdminLayout`, `MEMBERS_QUERY_KEY` (existing).
- Produces: default export `Invite` (a routed page component); route path `/invite`; a `/manage` link with accessible name `+ Invite someone` → `href="/invite"`. The SCSS module exposes classes `page`, `back`, `title` used by later tasks.

- [ ] **Step 1: Write the failing test** — `web/src/pages/Invite/Invite.test.tsx`

```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import Invite from '@/pages/Invite/Invite'

vi.mock('@/lib/adminApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/adminApi')>()),
  fetchMembers: vi.fn(),
  reissueInvite: vi.fn(),
}))

const { fetchMembers } = await import('@/lib/adminApi')

const renderInvite = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Invite />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  sessionStorage.setItem('westeroz-admin-password', 'secret')
  // The members query arrives in a later task; default it so cross-task runs stay quiet.
  vi.mocked(fetchMembers).mockResolvedValue([])
})

afterEach(() => {
  sessionStorage.clear()
  vi.restoreAllMocks()
})

test('requires the admin password gate', () => {
  sessionStorage.clear()
  renderInvite()
  expect(screen.getByLabelText('Password')).toBeInTheDocument()
})

test('shows the invite heading and back link after the gate', () => {
  renderInvite()
  expect(screen.getByRole('heading', { name: 'Invite someone' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '← All members' })).toHaveAttribute('href', '/manage')
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `bunx vitest run src/pages/Invite/Invite.test.tsx`
Expected: FAIL — cannot resolve `@/pages/Invite/Invite`.

- [ ] **Step 3: Create the SCSS module** — `web/src/pages/Invite/Invite.module.scss`

```scss
.page {
  display: grid;
  align-content: start;
  gap: var(--space-3);
  max-width: 48rem;
  width: 100%;
  margin-inline: auto;
  padding: var(--space-4) var(--space-3);
}

.back {
  color: var(--color-muted);
  font-size: var(--font-size-sm);
  text-decoration: none;
  justify-self: start;

  &:hover {
    color: var(--color-text);
  }
}

.title {
  font-family: var(--font-display);
  font-size: var(--font-size-xl);
  font-weight: 700;
}
```

- [ ] **Step 4: Create the page shell** — `web/src/pages/Invite/Invite.tsx`

```tsx
import { Link } from 'react-router-dom'
import AdminGate from '@/components/AdminGate/AdminGate'
import AdminLayout from '@/components/AdminLayout/AdminLayout'
import styles from '@/pages/Invite/Invite.module.scss'

const InviteInner = () => (
  <AdminLayout>
    <main className={styles.page}>
      <Link className={styles.back} to="/manage">
        ← All members
      </Link>
      <h1 className={styles.title}>Invite someone</h1>
    </main>
  </AdminLayout>
)

const Invite = () => (
  <AdminGate title="Westeroz — Invite">
    <InviteInner />
  </AdminGate>
)

export default Invite
```

- [ ] **Step 5: Register the route** — `web/src/AppRoutes.tsx`

Add the import (alphabetical among page imports) and the route:

```tsx
import { Route, Routes } from 'react-router-dom'
import App from '@/App'
import Invite from '@/pages/Invite/Invite'
import Manage from '@/pages/Manage/Manage'
import ResetUser from '@/pages/ResetUser/ResetUser'
import User from '@/pages/User/User'

const AppRoutes = () => (
  <Routes>
    <Route path="/" element={<App />} />
    <Route path="/invite" element={<Invite />} />
    <Route path="/manage" element={<Manage />} />
    <Route path="/reset-user" element={<ResetUser />} />
    <Route path="/user" element={<User />} />
  </Routes>
)

export default AppRoutes
```

- [ ] **Step 6: Run the Invite test — verify it passes**

Run: `bunx vitest run src/pages/Invite/Invite.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 7: Add the `/manage` entry link** — `web/src/pages/Manage/Manage.tsx`

Add `Link` to the react-router import at the top:

```tsx
import { Link } from 'react-router-dom'
```

Then insert the link directly under the `<h1>` in the returned JSX:

```tsx
        <h1 className={styles.title}>Members</h1>
        <Link className={styles.inviteLink} to="/invite">
          + Invite someone
        </Link>
```

- [ ] **Step 8: Style the link** — append to `web/src/pages/Manage/Manage.module.scss`

```scss
.inviteLink {
  justify-self: start;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: var(--font-size-sm);
  text-decoration: none;

  &:hover {
    border-color: var(--color-accent);
  }
}
```

- [ ] **Step 9: Add the Manage link test** — append to `web/src/pages/Manage/Manage.test.tsx`

```tsx
test('links to the invite page', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([member])
  renderManage()
  const link = await screen.findByRole('link', { name: '+ Invite someone' })
  expect(link).toHaveAttribute('href', '/invite')
})
```

- [ ] **Step 10: Run the Manage test + typecheck — verify pass**

Run: `bunx vitest run src/pages/Manage/Manage.test.tsx && bun run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 11: Commit**

```bash
git add web/src/pages/Invite web/src/AppRoutes.tsx web/src/pages/Manage
git commit -m "WZ: Add the /invite route, page shell, and Manage entry link

- New /invite page behind the admin gate with an All members back link
- Invite someone link on /manage pointing at the new route"
```

---

### Task 2: Invite form and send flow

The working form: email input, four tier cards, gating, confirm modal, the send mutation, the result notice with a **View member** link, form clear, and optimistic members-cache priming.

**Files:**

- Modify: `web/src/pages/Invite/Invite.tsx`
- Modify: `web/src/pages/Invite/Invite.module.scss`
- Modify: `web/src/pages/Invite/Invite.test.tsx`

**Interfaces:**

- Consumes: `reissueInvite({ email, tier, password }) -> Promise<InviteResult>`; `InviteResult = { url, code, tier, disabled, emailed }`; `Member`; `PaidTier`; `TIER_LABELS`, `TIER_DOWNLOADS`, `PAID_TIERS`, `ACCESS_DAYS`, `INVITE_LINK_DAYS`; `MEMBERS_QUERY_KEY`; `ConfirmActionModal`, `TierIcon`.
- Produces: the full send behavior. Local `type PendingSend = { email: string; tier: PaidTier }` (used by the mutation). Accessible names later tasks/tests rely on: email field label **"Email address"**; tier card buttons whose names contain the tier label (e.g. `Gold`); primary button **"Send invite"** (label **"Sending…"** while pending); confirm dialog named **"Confirm invite"** with its own **"Send invite"** button.

- [ ] **Step 1: Write the failing tests** — append to `web/src/pages/Invite/Invite.test.tsx`

Add `within` and `userEvent` to imports at the top of the file:

```tsx
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
```

Also widen the destructure of the mocked module (top of file, replacing the existing `const { fetchMembers } = ...`):

```tsx
const { fetchMembers, reissueInvite } = await import('@/lib/adminApi')
```

Append these tests:

```tsx
const gold: InviteResult = {
  url: 'https://x/j/abc',
  code: 'abc',
  tier: 'gold',
  disabled: 0,
  emailed: true,
}

test('send stays disabled until a valid email and a tier are chosen', async () => {
  renderInvite()
  // findByRole (async) so this passes both before and after the members-query
  // gate arrives — once loaded the label settles on "Send invite".
  const send = await screen.findByRole('button', { name: 'Send invite' })
  expect(send).toBeDisabled()
  await userEvent.type(screen.getByLabelText('Email address'), 'not-an-email')
  await userEvent.click(screen.getByRole('button', { name: /Gold/ }))
  expect(send).toBeDisabled()
  await userEvent.clear(screen.getByLabelText('Email address'))
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  expect(send).toBeEnabled()
})

test('sends an invite for the typed email and selected tier, then clears the form', async () => {
  vi.mocked(reissueInvite).mockResolvedValue(gold)
  renderInvite()
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  await userEvent.click(screen.getByRole('button', { name: /Gold/ }))
  await userEvent.click(await screen.findByRole('button', { name: 'Send invite' }))

  const dialog = screen.getByRole('dialog', { name: 'Confirm invite' })
  expect(dialog).toHaveTextContent('new@x.com')
  expect(dialog).toHaveTextContent('Gold')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Send invite' }))

  expect(reissueInvite).toHaveBeenCalledWith({
    email: 'new@x.com',
    tier: 'gold',
    password: 'secret',
  })
  expect(await screen.findByText(/Invite emailed/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'https://x/j/abc' })).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'View member' })).toHaveAttribute(
    'href',
    '/user?email=new%40x.com',
  )
  expect(screen.getByLabelText('Email address')).toHaveValue('')
  expect(screen.getByRole('button', { name: /Gold/ })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('a failed invite email shows the manual-send link', async () => {
  vi.mocked(reissueInvite).mockResolvedValue({ ...gold, emailed: false })
  renderInvite()
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  await userEvent.click(screen.getByRole('button', { name: /Silver/ }))
  await userEvent.click(await screen.findByRole('button', { name: 'Send invite' }))
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Send invite' }),
  )
  expect(await screen.findByText(/send this link manually/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'https://x/j/abc' })).toBeInTheDocument()
})

test('an auth error during send returns to the password gate', async () => {
  vi.mocked(reissueInvite).mockRejectedValue(new AdminAuthError('nope'))
  renderInvite()
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  await userEvent.click(screen.getByRole('button', { name: /Bronze/ }))
  await userEvent.click(await screen.findByRole('button', { name: 'Send invite' }))
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Send invite' }),
  )
  expect(await screen.findByLabelText('Password')).toBeInTheDocument()
})
```

Add `AdminAuthError` and `InviteResult` to the type import used by the test file (add near the top):

```tsx
import { AdminAuthError, type InviteResult } from '@/lib/adminApi'
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `bunx vitest run src/pages/Invite/Invite.test.tsx`
Expected: FAIL — no "Email address" field / no tier buttons yet.

- [ ] **Step 3: Replace the page implementation** — `web/src/pages/Invite/Invite.tsx` (full file)

```tsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import AdminGate, { useAdminAuth } from '@/components/AdminGate/AdminGate'
import AdminLayout from '@/components/AdminLayout/AdminLayout'
import ConfirmActionModal from '@/components/ConfirmActionModal/ConfirmActionModal'
import TierIcon from '@/components/TierIcon/TierIcon'
import {
  AdminAuthError,
  reissueInvite,
  type InviteResult,
  type Member,
  type PaidTier,
} from '@/lib/adminApi'
import {
  ACCESS_DAYS,
  INVITE_LINK_DAYS,
  PAID_TIERS,
  TIER_DOWNLOADS,
  TIER_LABELS,
} from '@/lib/inviteRules'
import { MEMBERS_QUERY_KEY } from '@/pages/Manage/Manage'
import styles from '@/pages/Invite/Invite.module.scss'

const EMAIL_RE = /^[^@\s]+@[^@\s]+$/

const TIER_SUMMARY: Record<PaidTier, string> = {
  bronze: 'Everything except 4K · no downloads',
  silver: 'Everything · no downloads',
  gold: 'Everything · downloads included',
  kids: 'Kid-safe libraries only · downloads included',
}

type PendingSend = {
  email: string
  tier: PaidTier
}

const InviteInner = () => {
  const { password, deauthenticate } = useAdminAuth()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [tier, setTier] = useState<PaidTier | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null)
  const [sentEmail, setSentEmail] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const trimmedEmail = email.trim()
  const emailValid = EMAIL_RE.test(trimmedEmail)

  const inviteMutation = useMutation({
    mutationFn: ({ email: to, tier: paid }: PendingSend) =>
      reissueInvite({ email: to, tier: paid, password }),
    onSuccess: (result, { email: to, tier: paid }) => {
      setInviteResult(result)
      setSentEmail(to)
      // Prime the members cache so the new invitee shows up as a pending
      // member on /manage and /user immediately — same shape the bridge's
      // _member_from_customer returns for a not-yet-joined subscriber.
      const pendingRow: Member = {
        member: to.split('@')[0] ?? to,
        email: to,
        tier: paid,
        downloads: TIER_DOWNLOADS[paid],
        expires: null,
        servers: [],
        libraries: {},
        subscribed: false,
        invited_at: new Date().toISOString(),
      }
      queryClient.setQueryData<Member[]>(MEMBERS_QUERY_KEY, (old) => {
        if (!old) {
          return old
        }
        const exists = old.some((row) => row.email.toLowerCase() === to.toLowerCase())
        return exists
          ? old.map((row) => (row.email.toLowerCase() === to.toLowerCase() ? pendingRow : row))
          : [...old, pendingRow]
      })
      setEmail('')
      setTier(null)
      setConfirming(false)
    },
    onError: (cause) => {
      setConfirming(false)
      if (cause instanceof AdminAuthError) {
        deauthenticate()
        return
      }
      setActionError('Could not create invite.')
    },
  })

  const handleSend = () => {
    setActionError(null)
    setInviteResult(null)
    if (!tier || !emailValid) {
      return
    }
    setConfirming(true)
  }

  return (
    <AdminLayout>
      <main className={styles.page}>
        <Link className={styles.back} to="/manage">
          ← All members
        </Link>
        <h1 className={styles.title}>Invite someone</h1>
        {!!actionError && <p className={styles.error}>{actionError}</p>}
        {!!inviteResult && !!sentEmail && (
          <p className={styles.resultNotice}>
            {inviteResult.emailed
              ? 'Invite emailed. Link: '
              : 'Email failed — send this link manually: '}
            <a href={inviteResult.url}>{inviteResult.url}</a>{' '}
            <Link className={styles.viewMember} to={`/user?email=${encodeURIComponent(sentEmail)}`}>
              View member
            </Link>
          </p>
        )}
        <div className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="invite-email">
              Email address
            </label>
            <input
              id="invite-email"
              className={styles.emailInput}
              type="email"
              placeholder="name@example.com"
              value={email}
              onChange={(event) => {
                setEmail(event.target.value)
                setActionError(null)
              }}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Tier</span>
            <div className={styles.tierGrid} role="group" aria-label="Tier">
              {PAID_TIERS.map((paid) => (
                <button
                  key={paid}
                  type="button"
                  className={`${styles.tierCard} ${tier === paid ? styles.tierCardSelected : ''}`}
                  aria-pressed={tier === paid}
                  onClick={() => setTier(paid)}
                >
                  <span className={styles.tierCardLabel}>
                    <TierIcon tier={paid} /> {TIER_LABELS[paid]}
                  </span>
                  <span className={styles.tierCardSummary}>{TIER_SUMMARY[paid]}</span>
                </button>
              ))}
            </div>
          </div>
          <button
            className={styles.send}
            type="button"
            onClick={handleSend}
            disabled={!emailValid || !tier || inviteMutation.isPending}
          >
            {inviteMutation.isPending ? 'Sending…' : 'Send invite'}
          </button>
        </div>
        {confirming && !!tier && (
          <ConfirmActionModal
            title="Confirm invite"
            confirmLabel="Send invite"
            busy={inviteMutation.isPending}
            busyLabel="Sending…"
            onConfirm={() => inviteMutation.mutate({ email: trimmedEmail, tier })}
            onCancel={() => setConfirming(false)}
          >
            <dl className={styles.confirmDetails}>
              <dt>Email</dt>
              <dd>{trimmedEmail}</dd>
              <dt>Tier</dt>
              <dd>
                <TierIcon tier={tier} /> {TIER_LABELS[tier]}
              </dd>
              <dt>Downloads</dt>
              <dd>{TIER_DOWNLOADS[tier] ? 'Included' : 'Not included'}</dd>
              <dt>Access</dt>
              <dd>{ACCESS_DAYS} days per billing cycle</dd>
              <dt>Link valid for</dt>
              <dd>{INVITE_LINK_DAYS} days</dd>
            </dl>
            <p className={styles.confirmNote}>
              A fresh {TIER_LABELS[tier]}-scoped invite link is generated and emailed to{' '}
              {trimmedEmail}. They join by opening the link and signing in with their Plex account.
            </p>
          </ConfirmActionModal>
        )}
      </main>
    </AdminLayout>
  )
}

const Invite = () => (
  <AdminGate title="Westeroz — Invite">
    <InviteInner />
  </AdminGate>
)

export default Invite
```

- [ ] **Step 4: Append the form styles** — `web/src/pages/Invite/Invite.module.scss`

```scss
.form {
  display: grid;
  gap: var(--space-3);
}

.field {
  display: grid;
  gap: var(--space-1);
}

.label {
  color: var(--color-muted);
  font-size: var(--font-size-xs);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.emailInput {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: var(--font-size-md);
  max-width: 24rem;

  &::placeholder {
    color: var(--color-muted);
  }
}

.tierGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  gap: var(--space-2);
}

.tierCard {
  display: grid;
  gap: var(--space-1);
  justify-items: start;
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;

  &:hover {
    border-color: var(--color-accent);
  }
}

.tierCardSelected {
  border-color: var(--color-accent);
  outline: 2px solid var(--color-accent);
}

.tierCardLabel {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: var(--font-size-md);
  font-weight: 700;
}

.tierCardSummary {
  color: var(--color-muted);
  font-size: var(--font-size-sm);
}

.send {
  justify-self: start;
  padding: var(--space-1) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-accent-text);
  font-family: var(--font-body);
  font-size: var(--font-size-md);
  font-weight: 700;
  cursor: pointer;

  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}

.resultNotice {
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  word-break: break-all;
}

.viewMember {
  color: var(--color-accent);
  white-space: nowrap;
}

.error {
  color: var(--color-kids);
}

.confirmDetails {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-1) var(--space-3);
  margin: 0;
}

.confirmNote {
  color: var(--color-muted);
  font-size: var(--font-size-sm);
}
```

- [ ] **Step 5: Run the tests — verify they pass**

Run: `bunx vitest run src/pages/Invite/Invite.test.tsx`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/Invite
git commit -m "WZ: Build the /invite form and send flow

- Email field plus four tier cards, nothing preselected
- Confirm modal, then reissue-invite send scoped to the tier
- Result notice with the link and a View member shortcut
- Clear the form and prime the members cache on success"
```

---

### Task 3: Duplicate-email guard

Block an email that already belongs to a member (link to the `/user` re-invite flow), and hold the Send button until the members list has loaded so the check can actually run.

**Files:**

- Modify: `web/src/pages/Invite/Invite.tsx`
- Modify: `web/src/pages/Invite/Invite.module.scss`
- Modify: `web/src/pages/Invite/Invite.test.tsx`

**Interfaces:**

- Consumes: `fetchMembers({ password }) -> Promise<Member[]>`; `MEMBERS_QUERY_KEY`; `isPaidTier`, `TIER_LABELS`; `Member`.
- Produces: guard behavior — a matched email shows a notice containing "already a member" and a **Go to member** link to `/user?email=<encoded>`, and does NOT call `reissueInvite`. While the members query is loading, the primary button reads **"Checking members…"** and is disabled.

- [ ] **Step 1: Write the failing tests** — append to `web/src/pages/Invite/Invite.test.tsx`

```tsx
const existing: Member = {
  member: 'cody',
  email: 'new@x.com',
  tier: 'gold',
  downloads: true,
  expires: null,
  servers: ['Vermithor'],
  libraries: {},
  subscribed: false,
  invited_at: null,
}

test('blocks an email that already belongs to a member', async () => {
  vi.mocked(fetchMembers).mockResolvedValue([existing])
  renderInvite()
  await userEvent.type(screen.getByLabelText('Email address'), 'new@x.com')
  await userEvent.click(screen.getByRole('button', { name: /Gold/ }))
  // Wait for the members list to load (button label flips from "Checking members…").
  await userEvent.click(await screen.findByRole('button', { name: 'Send invite' }))

  expect(reissueInvite).not.toHaveBeenCalled()
  expect(screen.getByText(/already a member/)).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Go to member' })).toHaveAttribute(
    'href',
    '/user?email=new%40x.com',
  )
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('send waits while the members list is still loading', () => {
  vi.mocked(fetchMembers).mockReturnValue(new Promise(() => {}))
  renderInvite()
  expect(screen.getByRole('button', { name: 'Checking members…' })).toBeDisabled()
})
```

Add `Member` to the test file's type import:

```tsx
import { AdminAuthError, type InviteResult, type Member } from '@/lib/adminApi'
```

- [ ] **Step 2: Run the tests — verify they fail**

Run: `bunx vitest run src/pages/Invite/Invite.test.tsx`
Expected: FAIL — no guard/notice; no "Checking members…" state.

- [ ] **Step 3: Add the members query and imports** — `web/src/pages/Invite/Invite.tsx`

Update the React and react-query imports, and the adminApi / inviteRules imports, at the top:

```tsx
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
```

```tsx
import {
  AdminAuthError,
  fetchMembers,
  reissueInvite,
  type InviteResult,
  type Member,
  type PaidTier,
} from '@/lib/adminApi'
import {
  ACCESS_DAYS,
  INVITE_LINK_DAYS,
  isPaidTier,
  PAID_TIERS,
  TIER_DOWNLOADS,
  TIER_LABELS,
} from '@/lib/inviteRules'
```

- [ ] **Step 4: Add the guard state, query, and effect** — inside `InviteInner`, add `blockedMember` beside the other `useState` calls:

```tsx
const [blockedMember, setBlockedMember] = useState<Member | null>(null)
```

Then add the query + auth effect right after the state declarations (before `inviteMutation`):

```tsx
const {
  data: members,
  error: loadError,
  isPending: membersPending,
} = useQuery({
  queryKey: MEMBERS_QUERY_KEY,
  queryFn: () => fetchMembers({ password }),
  staleTime: 5 * 60 * 1000,
})

useEffect(() => {
  if (loadError instanceof AdminAuthError) {
    deauthenticate()
  }
}, [loadError, deauthenticate])
```

- [ ] **Step 5: Add the guard to `handleSend`** — replace the existing `handleSend` with:

```tsx
const handleSend = () => {
  setActionError(null)
  setInviteResult(null)
  if (!tier || !emailValid) {
    return
  }
  // Guard runs only on a successfully loaded list; a failed members query
  // (non-auth) skips the check and lets the send through — the bridge treats
  // a duplicate as a safe re-invite anyway.
  const match = (members ?? []).find(
    (row) => row.email.toLowerCase() === trimmedEmail.toLowerCase(),
  )
  if (match) {
    setBlockedMember(match)
    return
  }
  setBlockedMember(null)
  setConfirming(true)
}
```

- [ ] **Step 6: Clear the block on edit + gate/label the button** — in the email `onChange`, add `setBlockedMember(null)`:

```tsx
              onChange={(event) => {
                setEmail(event.target.value)
                setActionError(null)
                setBlockedMember(null)
              }}
```

Update the Send button's `disabled` and label to account for the loading list:

```tsx
<button
  className={styles.send}
  type="button"
  onClick={handleSend}
  disabled={!emailValid || !tier || membersPending || inviteMutation.isPending}
>
  {membersPending ? 'Checking members…' : inviteMutation.isPending ? 'Sending…' : 'Send invite'}
</button>
```

- [ ] **Step 7: Render the block notice** — add directly after the `inviteResult` notice block (before `<div className={styles.form}>`):

```tsx
{
  !!blockedMember && (
    <p className={styles.blockedNotice}>
      {blockedMember.email} is already a member
      {isPaidTier(blockedMember.tier) && ` (${TIER_LABELS[blockedMember.tier]})`}. Use Re-invite
      instead.{' '}
      <Link
        className={styles.viewMember}
        to={`/user?email=${encodeURIComponent(blockedMember.email)}`}
      >
        Go to member
      </Link>
    </p>
  )
}
```

- [ ] **Step 8: Append the notice style** — `web/src/pages/Invite/Invite.module.scss`

```scss
.blockedNotice {
  padding: var(--space-2);
  border: 1px solid var(--color-kids);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}
```

- [ ] **Step 9: Run the full Invite suite — verify pass**

Run: `bunx vitest run src/pages/Invite/Invite.test.tsx`
Expected: PASS (all tests, Tasks 1–3).

- [ ] **Step 10: Typecheck + full test run**

Run: `bun run typecheck && bunx vitest run`
Expected: typecheck clean; entire suite green.

- [ ] **Step 11: Commit**

```bash
git add web/src/pages/Invite
git commit -m "WZ: Block invites to existing members on /invite

- Look the email up in the shared members list before sending
- A match shows a notice and links to the /user re-invite flow
- Hold Send as Checking members… until the list has loaded"
```

---

## Self-Review

**Spec coverage** (against `docs/superpowers/specs/2026-07-20-invite-page-design.md`):

- Frontend-only over `reissue-invite` → Tasks 2. ✅
- Route `/invite` behind `AdminGate` → Task 1. ✅
- `/manage` "Invite someone" entry + `/invite` back link → Task 1. ✅
- Email input with light `@`-validation → Task 2 (`EMAIL_RE`). ✅
- Four tier cards, nothing preselected, Send gated on email+tier → Task 2. ✅
- Tier card summaries (access scope, not content) → Task 2 (`TIER_SUMMARY`). ✅
- Confirm via `ConfirmActionModal` with new-invitee copy (no "disabled" language) → Task 2. ✅
- Duplicate guard: block + `/user` link → Task 3. ✅
- Guard readiness ("Checking members…") → Task 3. ✅
- After send: result notice (emailed / manual), **View member** link, clear form, prime members cache → Task 2. ✅
- Errors: `AdminAuthError` → deauthenticate; other → inline error → Tasks 2 & 3. ✅
- Tests for gating, send, email-failed, auth error, dupe block, loading, Manage link → Tasks 1–3. ✅
- No bridge changes → honored. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete content; no "add validation/error handling" hand-waves. ✅

**Type consistency:** `PendingSend = { email; tier }` defined and used identically in the mutation (Task 2) and unchanged in Task 3. `reissueInvite({ email, tier, password })`, `InviteResult` fields (`url/code/tier/disabled/emailed`), and the `Member` shape (`member/email/tier/downloads/expires/servers/libraries/subscribed/invited_at`) match `adminApi.ts` exactly. Accessible names are stable across tasks: "Email address", "Send invite"/"Sending…"/"Checking members…", dialog "Confirm invite", links "View member"/"Go to member". ✅

**Note on cross-task tests:** the members-query mock (`fetchMembers.mockResolvedValue([])`) is defaulted in `beforeEach` from Task 1 so the query the component grows in Task 3 stays quiet under the Task 1/2 tests too.
