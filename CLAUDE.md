# Claude context for wizteros

This file is loaded automatically when Claude Code runs inside this repo. It captures the working context that doesn't belong in the README.

## What this project is

A self-hosted stack that gates Plex access behind a recurring Stripe "server-cost contribution":

- **Wizarr** — invite-based onboarding for Plex users
- **Tautulli** — usage analytics
- **stripe-bridge** (`stripe-bridge/`) — small FastAPI service that converts Stripe webhooks (`checkout.session.completed`, `customer.subscription.deleted`) into Wizarr API calls

The contribution framing is deliberate (Plex TOS prohibits selling access, Stripe TOS prohibits selling rights you don't own). When suggesting copy, product descriptions, or UX text, lean toward infrastructure/hosting language. Never reference content, libraries, or titles in user-facing payment surfaces.

## React

- Never use default exports if it can be avoided, prefer named exports
- Always import all React methods, constants, and types from `react`, e.g. `import { useState } from 'react'`
- Prefer using latest features in React when possible
- Prefer using the `use` hook pattern for state management
- Prefer using zustand always for global state management

## Typescript

- Always use type aliases. Never use TypeScript interfaces anywhere, including `declare global` augmentations
- Use type guards wherever possible.
- Never use `any` types; prefer type narrowing or type guards
- Never under any circumstance cast types and never double cast: `as any as string`
- If type can't be inferred and type narrowing is not an option, use `unknown` types

## CSS

- Use SCSS modules (`*.module.scss`) for component styles
- Only use global stylesheets (`styles/globals.scss`) for design tokens and true typographic primitives
- Use a container driven approach, meaning the container will define the width and height and the children will be positioned within it, this means if/when the children are moved to different containers they may be laid out differently depending on what the container specifies
- Prefer using CSS display grid for layout with the gap property for spacing between grid items; avoid using margins for spacing
- Second preferred display value is flex
- Avoid using plain divs; meaing divs with no class or id defined
- Always use token values from `styles/globals.scss` when defining font sizes, colors, and other design tokens like padding, margin, gap, and border radius

## Code style

- Always prefer immutable data structures and operations
- Prefer `reduce` over `for` loops when possible. Never use `for/in` or `for/of` loops; reach for `Array.prototype` methods (`map`, `filter`, `reduce`, `flatMap`, etc.) when the value is an array.
- Prefer double-bang (`!!value`) for boolean conversion.
- Prefer short-circuit (`&&`) over a ternary when the else branch is `null` or `undefined`, especially in React rendering. Do: `{isActive && <Badge />}`. Don't: `{isActive ? <Badge /> : null}`. Guard the condition so it is a real boolean (`!!count && ...`), never a bare number that could render `0`.
- Prefer optional chaining (`?.`). When optional chaining is used, ALWAYS pair it with nullish coalescing (`??`) to supply a fallback.
- Prefer a single configurable object parameter over multiple positional parameters so argument order doesn't matter. Don't: `doSomething(foo, bar, hello)`. Do: `doSomething({ foo, bar, hello })`.

## Accessibility

- Use best practices for accessibility
- Use semantic HTML elements (`button`, `nav`, `main`, `header`, `ul`/`li`, `label`) before reaching for a generic element with a role; a native `button` beats a `div` with `onClick`
- Every interactive element must be reachable and operable by keyboard alone; preserve a logical tab order and never remove focus outlines without providing an equally visible `:focus-visible` style
- Associate every form control with a `label` (via `htmlFor`/`id` or wrapping); use `aria-describedby` for hints and error text
- Provide accessible names for icon-only controls with `aria-label`; mark purely decorative icons/images `aria-hidden="true"` and give meaningful images real `alt` text (empty `alt=""` when decorative)
- Add ARIA only to fill gaps native semantics can't; never override a native role, and prefer no ARIA over wrong ARIA
- Announce dynamic changes (toasts, async status, form errors) with an appropriate `aria-live` region or `role="alert"`
- Manage focus for modals, drawers, and menus: move focus in on open, trap it while open, restore it to the trigger on close, and close on `Escape`
- Meet WCAG AA contrast (4.5:1 body text, 3:1 large text and UI/graphical elements); verify against `styles/globals.scss` color tokens
- Respect `prefers-reduced-motion` and gate non-essential animation/transitions behind it
- Never convey meaning by color alone; pair it with text, an icon, or another cue
- Use relative units (`rem`) so the UI scales with user font-size settings, and keep layouts usable at 200% zoom
- Set a correct `lang` on the document and keep a single, ordered heading hierarchy (one `h1`, no skipped levels)

## Commits

- Create a commit after every logical change, batch if they are related.
- Subject must start with `WZ:` followed by a short title (e.g., `WZ: a short title`).
- Favor bullet points in the body. Keep it concise and easy to read.
