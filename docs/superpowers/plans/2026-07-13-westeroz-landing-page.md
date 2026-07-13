# Westeroz Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a static Netlify landing page for "Westeroz" that funnels visitors to a single, configurable Stripe Payment Link.

**Architecture:** A single-page Vite + React + TypeScript app under `web/`, built to static files and served by Netlify. Three stacked sections (Hero, Support, Footer) driven by one typed config object whose Payment Link and member URL are env-swappable. No backend, no serverless functions, no calls into the home LAN.

**Tech Stack:** Vite, React 18, TypeScript, SCSS modules, Vitest + React Testing Library, Netlify.

## Global Constraints

Every task's requirements implicitly include these. Values are verbatim from the spec / `CLAUDE.md`.

- **Framing:** All user-facing copy uses infrastructure/hosting language. No reference to content, libraries, titles, or the underlying media platform anywhere on the page.
- **TypeScript:** Use type aliases only — never `interface`, including in `declare` blocks. Never `any`. Never cast types. Prefer type guards; use `unknown` if a type can't be inferred.
- **Code style:** Prefer a single configurable object parameter over positional params. Prefer `!!value` for boolean conversion. Prefer short-circuit (`&&`) over ternary when the else branch is null/undefined, with a guarded boolean (never a bare number). Optional chaining (`?.`) always paired with nullish coalescing (`??`). Prefer `Array.prototype` methods over `for` loops; never `for/in` or `for/of`.
- **CSS:** SCSS modules (`*.module.scss`) for component styles; `styles/globals.scss` only for design tokens and typographic primitives. Container-driven layout. CSS grid with `gap` for spacing (avoid margins); flex second choice. No bare divs (every element has a class). All colors/font-sizes/spacing/radius from tokens in `globals.scss`.
- **Commits:** One commit per logical change. Subject starts with `WZ:` followed by a short title. Favor concise bullet points in the body.
- **Project location:** The landing page lives in its own `web/` directory with its own `package.json`, isolated from the root bridge tooling.

---

### Task 1: Scaffold the `web/` project

**Files:**
- Create: `web/package.json`
- Create: `web/vite.config.ts`
- Create: `web/tsconfig.json`
- Create: `web/index.html`
- Create: `web/src/vite-env.d.ts`
- Create: `web/src/test-setup.ts`
- Create: `web/src/styles/globals.scss`
- Create: `web/src/main.tsx`
- Create: `web/src/App.tsx`
- Create: `web/.gitignore`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: a runnable Vite app with a passing Vitest suite. `App` is a default-exported React component. `globals.scss` exposes CSS custom-property tokens (`--color-*`, `--space-*`, `--radius-*`, `--font-size-*`, `--max-width`) on `:root`.

- [ ] **Step 1: Create `web/package.json`**

```json
{
  "name": "westeroz-web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.4.8",
    "@testing-library/react": "^16.0.1",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.0",
    "sass": "^1.78.0",
    "typescript": "^5.5.4",
    "vite": "^5.4.3",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 2: Create `web/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "vite.config.ts"]
}
```

- [ ] **Step 3: Create `web/vite.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.ts',
  },
})
```

- [ ] **Step 4: Create `web/src/vite-env.d.ts`**

Note: uses `const` declarations only — no `interface`, so it complies with the TS constraint. Does NOT augment `ImportMetaEnv` (that would require an interface); env access is handled with a local type alias in Task 3.

```ts
/// <reference types="vite/client" />

declare module '*.module.scss' {
  const classes: Record<string, string>
  export default classes
}
```

- [ ] **Step 5: Create `web/src/test-setup.ts`**

```ts
import '@testing-library/jest-dom'
```

- [ ] **Step 6: Create `web/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Westeroz — media server hosting</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Create `web/src/styles/globals.scss`**

```scss
:root {
  --color-bg: #0b0d12;
  --color-surface: #141821;
  --color-border: #232838;
  --color-text: #e7e9ee;
  --color-muted: #9aa3b2;
  --color-accent: #d64545;
  --color-accent-text: #ffffff;

  --space-1: 0.5rem;
  --space-2: 1rem;
  --space-3: 1.5rem;
  --space-4: 2rem;
  --space-6: 3rem;
  --space-8: 5rem;

  --radius-md: 12px;
  --radius-lg: 20px;

  --font-size-hero: clamp(2.5rem, 6vw, 4rem);
  --font-size-lg: 1.25rem;
  --font-size-md: 1rem;
  --font-size-sm: 0.875rem;

  --max-width: 64rem;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: var(--font-size-md);
  line-height: 1.5;
}
```

- [ ] **Step 8: Create `web/src/App.tsx` (placeholder — Task 7 composes the real page)**

```tsx
const App = () => <main>Westeroz</main>

export default App
```

- [ ] **Step 9: Create `web/src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/globals.scss'

const rootElement = document.getElementById('root')

if (!!rootElement) {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
```

- [ ] **Step 10: Create `web/.gitignore`**

```
node_modules
dist
```

- [ ] **Step 11: Write the smoke test `web/src/App.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react'
import App from './App'

test('renders the brand name', () => {
  render(<App />)
  expect(screen.getByText('Westeroz')).toBeInTheDocument()
})
```

- [ ] **Step 12: Install dependencies and run the test to verify it passes**

Run: `cd web && npm install && npm test`
Expected: `App.test.tsx` passes (1 passed).

- [ ] **Step 13: Verify the production build works**

Run: `cd web && npm run build`
Expected: `tsc` reports no errors and Vite writes `web/dist/` with `index.html` + assets.

- [ ] **Step 14: Commit**

```bash
git add web/package.json web/package-lock.json web/vite.config.ts web/tsconfig.json web/index.html web/.gitignore web/src
git commit -m "WZ: Scaffold Westeroz landing page (Vite + React + TS)"
```

---

### Task 2: Site config with env resolution

**Files:**
- Create: `web/src/site.config.ts`
- Test: `web/src/site.config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SupportItem = { title: string; detail: string }`
  - `type SiteConfig = { brandName: string; tagline: string; priceLabel: string; paymentLinkUrl: string; memberUrl: string | null; supportItems: ReadonlyArray<SupportItem> }`
  - `resolveConfig({ env }: { env: RawEnv }): SiteConfig` — pure function, testable without `import.meta`.
  - `siteConfig: SiteConfig` — the resolved singleton used by components.
  - Exported constant `DEFAULT_PAYMENT_LINK_URL` (the current Stripe test link).

- [ ] **Step 1: Write the failing test `web/src/site.config.test.ts`**

```ts
import { resolveConfig, DEFAULT_PAYMENT_LINK_URL } from './site.config'

test('falls back to the default payment link and null member url with empty env', () => {
  const config = resolveConfig({ env: {} })
  expect(config.paymentLinkUrl).toBe(DEFAULT_PAYMENT_LINK_URL)
  expect(config.memberUrl).toBeNull()
})

test('uses the payment link from env when set', () => {
  const config = resolveConfig({ env: { VITE_PAYMENT_LINK_URL: 'https://buy.stripe.com/live_abc' } })
  expect(config.paymentLinkUrl).toBe('https://buy.stripe.com/live_abc')
})

test('uses the member url from env when set', () => {
  const config = resolveConfig({ env: { VITE_MEMBER_URL: 'https://invite.example.com' } })
  expect(config.memberUrl).toBe('https://invite.example.com')
})

test('provides three support items', () => {
  const config = resolveConfig({ env: {} })
  expect(config.supportItems).toHaveLength(3)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/site.config.test.ts`
Expected: FAIL — cannot resolve `./site.config`.

- [ ] **Step 3: Create `web/src/site.config.ts`**

Note on `env`: `import.meta.env.VITE_*` is typed `any` via `vite/client`'s index signature. Assigning `import.meta.env` to a `RawEnv`-typed local narrows it to `string | undefined` fields without an explicit `any` or a cast, satisfying the constraints.

```ts
type SupportItem = {
  title: string
  detail: string
}

type SiteConfig = {
  brandName: string
  tagline: string
  priceLabel: string
  paymentLinkUrl: string
  memberUrl: string | null
  supportItems: ReadonlyArray<SupportItem>
}

type RawEnv = {
  VITE_PAYMENT_LINK_URL?: string
  VITE_MEMBER_URL?: string
}

export const DEFAULT_PAYMENT_LINK_URL =
  'https://buy.stripe.com/test_bJe6oG2Yte2m7l1f721Nu00'

const SUPPORT_ITEMS: ReadonlyArray<SupportItem> = [
  {
    title: 'Server hardware',
    detail: 'Always-on machines that host and stream the platform.',
  },
  {
    title: 'Storage & bandwidth',
    detail: 'Disks and network capacity that keep everything available.',
  },
  {
    title: 'Maintenance & uptime',
    detail: 'Updates, backups, and monitoring so it stays reliable.',
  },
]

export const resolveConfig = ({ env }: { env: RawEnv }): SiteConfig => ({
  brandName: 'Westeroz',
  tagline:
    'A community-run media server. Contribute to the cost of keeping it online.',
  priceLabel: '$X / month',
  paymentLinkUrl: env.VITE_PAYMENT_LINK_URL ?? DEFAULT_PAYMENT_LINK_URL,
  memberUrl: env.VITE_MEMBER_URL ?? null,
  supportItems: SUPPORT_ITEMS,
})

const env: RawEnv = import.meta.env

export const siteConfig = resolveConfig({ env })

export type { SiteConfig, SupportItem }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/site.config.test.ts`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add web/src/site.config.ts web/src/site.config.test.ts
git commit -m "WZ: Add env-swappable site config for landing page"
```

---

### Task 3: Hero component

**Files:**
- Create: `web/src/components/Hero/Hero.tsx`
- Create: `web/src/components/Hero/Hero.module.scss`
- Test: `web/src/components/Hero/Hero.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks (takes plain props).
- Produces: `Hero` (default export), props `type HeroProps = { brandName: string; tagline: string; priceLabel: string; paymentLinkUrl: string }`. Renders a "Contribute" link whose `href` is `paymentLinkUrl`.

- [ ] **Step 1: Write the failing test `web/src/components/Hero/Hero.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react'
import Hero from './Hero'

const props = {
  brandName: 'Westeroz',
  tagline: 'A community-run media server.',
  priceLabel: '$10 / month',
  paymentLinkUrl: 'https://buy.stripe.com/test_abc',
}

test('renders the brand, price, and a Contribute link to the payment url', () => {
  render(<Hero {...props} />)
  expect(screen.getByRole('heading', { name: 'Westeroz' })).toBeInTheDocument()
  expect(screen.getByText('$10 / month')).toBeInTheDocument()
  const cta = screen.getByRole('link', { name: 'Contribute' })
  expect(cta).toHaveAttribute('href', 'https://buy.stripe.com/test_abc')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/components/Hero/Hero.test.tsx`
Expected: FAIL — cannot resolve `./Hero`.

- [ ] **Step 3: Create `web/src/components/Hero/Hero.module.scss`**

```scss
.hero {
  display: grid;
  gap: var(--space-3);
  justify-items: center;
  text-align: center;
  padding: var(--space-8) var(--space-3);
}

.brand {
  font-size: var(--font-size-hero);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.tagline {
  font-size: var(--font-size-lg);
  color: var(--color-muted);
  max-width: 32rem;
}

.price {
  font-size: var(--font-size-lg);
  font-weight: 600;
}

.cta {
  display: inline-grid;
  align-items: center;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-accent-text);
  font-weight: 600;
  text-decoration: none;
}
```

- [ ] **Step 4: Create `web/src/components/Hero/Hero.tsx`**

```tsx
import styles from './Hero.module.scss'

type HeroProps = {
  brandName: string
  tagline: string
  priceLabel: string
  paymentLinkUrl: string
}

const Hero = ({ brandName, tagline, priceLabel, paymentLinkUrl }: HeroProps) => (
  <section className={styles.hero}>
    <h1 className={styles.brand}>{brandName}</h1>
    <p className={styles.tagline}>{tagline}</p>
    <p className={styles.price}>{priceLabel}</p>
    <a className={styles.cta} href={paymentLinkUrl}>
      Contribute
    </a>
  </section>
)

export default Hero
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web && npx vitest run src/components/Hero/Hero.test.tsx`
Expected: PASS (1 passed).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Hero
git commit -m "WZ: Add Hero section with Contribute CTA"
```

---

### Task 4: Support component

**Files:**
- Create: `web/src/components/Support/Support.tsx`
- Create: `web/src/components/Support/Support.module.scss`
- Test: `web/src/components/Support/Support.test.tsx`

**Interfaces:**
- Consumes: `SupportItem` from `web/src/site.config.ts`.
- Produces: `Support` (default export), props `type SupportProps = { items: ReadonlyArray<SupportItem> }`. Renders one `<article>` per item.

- [ ] **Step 1: Write the failing test `web/src/components/Support/Support.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react'
import Support from './Support'

const items = [
  { title: 'Server hardware', detail: 'Always-on machines.' },
  { title: 'Storage & bandwidth', detail: 'Disks and network capacity.' },
]

test('renders one heading per support item', () => {
  render(<Support items={items} />)
  expect(screen.getByRole('heading', { name: 'Server hardware' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Storage & bandwidth' })).toBeInTheDocument()
  expect(screen.getByText('Disks and network capacity.')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/components/Support/Support.test.tsx`
Expected: FAIL — cannot resolve `./Support`.

- [ ] **Step 3: Create `web/src/components/Support/Support.module.scss`**

```scss
.support {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  padding: var(--space-6) var(--space-3);
}

.item {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.itemTitle {
  font-size: var(--font-size-md);
  font-weight: 600;
}

.itemDetail {
  font-size: var(--font-size-sm);
  color: var(--color-muted);
}
```

- [ ] **Step 4: Create `web/src/components/Support/Support.tsx`**

```tsx
import type { SupportItem } from '../../site.config'
import styles from './Support.module.scss'

type SupportProps = {
  items: ReadonlyArray<SupportItem>
}

const Support = ({ items }: SupportProps) => (
  <section className={styles.support}>
    {items.map(({ title, detail }) => (
      <article key={title} className={styles.item}>
        <h2 className={styles.itemTitle}>{title}</h2>
        <p className={styles.itemDetail}>{detail}</p>
      </article>
    ))}
  </section>
)

export default Support
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web && npx vitest run src/components/Support/Support.test.tsx`
Expected: PASS (1 passed).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Support
git commit -m "WZ: Add Support section describing contribution costs"
```

---

### Task 5: Footer component

**Files:**
- Create: `web/src/components/Footer/Footer.tsx`
- Create: `web/src/components/Footer/Footer.module.scss`
- Test: `web/src/components/Footer/Footer.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `Footer` (default export), props `type FooterProps = { memberUrl: string | null }`. Renders the member link only when `memberUrl` is truthy; always renders the framing disclaimer.

- [ ] **Step 1: Write the failing test `web/src/components/Footer/Footer.test.tsx`**

```tsx
import { render, screen } from '@testing-library/react'
import Footer from './Footer'

test('shows the member link when a member url is provided', () => {
  render(<Footer memberUrl="https://invite.example.com" />)
  const link = screen.getByRole('link', { name: /access your account/i })
  expect(link).toHaveAttribute('href', 'https://invite.example.com')
})

test('hides the member link when member url is null', () => {
  render(<Footer memberUrl={null} />)
  expect(screen.queryByRole('link', { name: /access your account/i })).toBeNull()
})

test('always renders the framing disclaimer', () => {
  render(<Footer memberUrl={null} />)
  expect(screen.getByText(/not a purchase of content/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/components/Footer/Footer.test.tsx`
Expected: FAIL — cannot resolve `./Footer`.

- [ ] **Step 3: Create `web/src/components/Footer/Footer.module.scss`**

```scss
.footer {
  display: grid;
  gap: var(--space-2);
  justify-items: center;
  text-align: center;
  padding: var(--space-6) var(--space-3);
  border-top: 1px solid var(--color-border);
}

.member {
  color: var(--color-text);
  font-size: var(--font-size-md);
  font-weight: 600;
  text-decoration: none;
}

.disclaimer {
  color: var(--color-muted);
  font-size: var(--font-size-sm);
  max-width: 34rem;
}
```

- [ ] **Step 4: Create `web/src/components/Footer/Footer.tsx`**

```tsx
import styles from './Footer.module.scss'

const MEMBER_LINK_LABEL = 'Already contributing? Access your account →'
const DISCLAIMER =
  'A contribution toward hosting and infrastructure costs, not a purchase of content.'

type FooterProps = {
  memberUrl: string | null
}

const Footer = ({ memberUrl }: FooterProps) => (
  <footer className={styles.footer}>
    {!!memberUrl && (
      <a className={styles.member} href={memberUrl}>
        {MEMBER_LINK_LABEL}
      </a>
    )}
    <p className={styles.disclaimer}>{DISCLAIMER}</p>
  </footer>
)

export default Footer
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web && npx vitest run src/components/Footer/Footer.test.tsx`
Expected: PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Footer
git commit -m "WZ: Add Footer with conditional member link and framing disclaimer"
```

---

### Task 6: Compose the page in `App`

**Files:**
- Modify: `web/src/App.tsx`
- Create: `web/src/App.module.scss`
- Modify: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `siteConfig` from `web/src/site.config.ts`; `Hero`, `Support`, `Footer` components.
- Produces: the fully composed single-page `App`.

- [ ] **Step 1: Replace `web/src/App.test.tsx` with the integration test**

```tsx
import { render, screen } from '@testing-library/react'
import App from './App'
import { DEFAULT_PAYMENT_LINK_URL } from './site.config'

test('renders the brand heading', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'Westeroz' })).toBeInTheDocument()
})

test('Contribute CTA points at the resolved payment link', () => {
  render(<App />)
  expect(screen.getByRole('link', { name: 'Contribute' })).toHaveAttribute(
    'href',
    DEFAULT_PAYMENT_LINK_URL,
  )
})

test('renders the three support items', () => {
  render(<App />)
  expect(screen.getByRole('heading', { name: 'Server hardware' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Storage & bandwidth' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Maintenance & uptime' })).toBeInTheDocument()
})

test('hides the member link by default (no VITE_MEMBER_URL)', () => {
  render(<App />)
  expect(screen.queryByRole('link', { name: /access your account/i })).toBeNull()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/App.test.tsx`
Expected: FAIL — `App` still renders only the placeholder `Westeroz` text; support-item and CTA assertions fail.

- [ ] **Step 3: Create `web/src/App.module.scss`**

```scss
.page {
  display: grid;
  gap: var(--space-4);
  width: 100%;
  max-width: var(--max-width);
  margin-inline: auto;
  padding-inline: var(--space-2);
}
```

- [ ] **Step 4: Replace `web/src/App.tsx` with the composed page**

```tsx
import Hero from './components/Hero/Hero'
import Support from './components/Support/Support'
import Footer from './components/Footer/Footer'
import { siteConfig } from './site.config'
import styles from './App.module.scss'

const App = () => (
  <main className={styles.page}>
    <Hero
      brandName={siteConfig.brandName}
      tagline={siteConfig.tagline}
      priceLabel={siteConfig.priceLabel}
      paymentLinkUrl={siteConfig.paymentLinkUrl}
    />
    <Support items={siteConfig.supportItems} />
    <Footer memberUrl={siteConfig.memberUrl} />
  </main>
)

export default App
```

- [ ] **Step 5: Run the full test suite to verify it passes**

Run: `cd web && npm test`
Expected: all suites pass (App, Hero, Support, Footer, site.config).

- [ ] **Step 6: Verify the production build**

Run: `cd web && npm run build`
Expected: `tsc` clean, `web/dist/` written.

- [ ] **Step 7: Commit**

```bash
git add web/src/App.tsx web/src/App.module.scss web/src/App.test.tsx
git commit -m "WZ: Compose Westeroz landing page from Hero, Support, Footer"
```

---

### Task 7: Netlify deploy configuration + docs

**Files:**
- Create: `netlify.toml` (repo root)
- Create: `web/.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: the built `web/dist/` output.
- Produces: Netlify build config and operator documentation. No tests (config + docs only).

- [ ] **Step 1: Create `netlify.toml` at the repo root**

Note: with `base = "web"`, Netlify installs from `web/package.json` and resolves `publish` relative to `base` (so `publish = "dist"` → `web/dist`).

```toml
[build]
  base = "web"
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "20"
```

- [ ] **Step 2: Create `web/.env.example`**

```
# Stripe Payment Link the Contribute button points at.
# Defaults to the test link in site.config.ts when unset.
VITE_PAYMENT_LINK_URL=https://buy.stripe.com/test_bJe6oG2Yte2m7l1f721Nu00

# Wizarr member sign-in URL (invite.<domain>). Leave unset until the
# Cloudflare Tunnel is up — the member link stays hidden while empty.
# VITE_MEMBER_URL=https://invite.example.com
```

- [ ] **Step 3: Add a landing-page section to `README.md`**

Append this section to `README.md`:

```markdown
## Landing page (`web/`)

Static Vite + React landing page for `westeroz.netlify.app` that funnels
visitors to the Stripe Payment Link.

- Develop: `cd web && npm install && npm run dev`
- Test: `cd web && npm test`
- Build: `cd web && npm run build` (outputs `web/dist/`)

Deploy: Netlify builds from the repo using `netlify.toml` (base `web/`,
publish `web/dist`). Set `VITE_PAYMENT_LINK_URL` (and later `VITE_MEMBER_URL`)
in the Netlify UI to switch the test link for the live one — no code change.
```

- [ ] **Step 4: Verify the config is valid by building once more**

Run: `cd web && npm run build`
Expected: build succeeds, `web/dist/index.html` exists.

- [ ] **Step 5: Commit**

```bash
git add netlify.toml web/.env.example README.md
git commit -m "WZ: Add Netlify config and landing page docs"
```

---

## Notes for the operator (post-implementation)

These are follow-ups, not implementation steps:
1. Decide the monthly amount and set `priceLabel` in `web/src/site.config.ts`.
2. Create the Netlify site, connect the repo, and set the subdomain to `westeroz.netlify.app`.
3. When the live Stripe Payment Link exists, set `VITE_PAYMENT_LINK_URL` in the Netlify UI.
4. When Wizarr is publicly reachable via the tunnel, set `VITE_MEMBER_URL` to enable the member link.
