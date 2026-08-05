# Sidemenu for admin routes: design

Date: 2026-07-23
Status: Approved

## Goal

Add a sidemenu listing all app routes to the web app, visible only when logged in
(i.e., past the `AdminGate` password gate).

## Decisions

- **Placement:** rendered inside `AdminLayout`, so it appears on `/manage`, `/invite`,
  `/email`, `/reset-user`, and `/user` once authenticated. The public landing page (`/`)
  is untouched.
- **Style:** persistent left sidebar on desktop; below ~48rem it hides and a hamburger
  button toggles it as an overlay drawer.
- **Routes listed:** Home `/`, Members `/manage`, Invite `/invite`, Email `/email`.
  Dropped after review: the bare `/user` link (without an `?email=` param the page
  only shows "No email provided.", member detail stays reachable from the Members
  table) and `/reset-user` (removed from the menu on request; the route itself
  remains directly reachable).

## Components

### `src/components/SideMenu/SideMenu.tsx` (+ `.module.scss`)

- Exports `menuRoutes`: array of `{ label, path }` for the six routes above.
- Renders `<nav aria-label="Sections">` containing a list of react-router `NavLink`s.
- Active route styled via `NavLink`'s active class (accent color + surface background).
- The Home link uses `end` so it is only active on `/` exactly.
- Owns the mobile drawer state: a local `useState` open flag, hamburger toggle button,
  drawer closes on link click. No global state (zustand unnecessary for one local flag).

### `AdminLayout` changes

- Middle row becomes a two-column grid: fixed ~14rem sidebar + `1fr` content,
  spaced with `gap`, tokens from `styles/globals.scss`.
- Header and footer continue to span full width.
- Public API (`children` prop) unchanged, so page components need no edits.

## Error handling

None required: purely presentational, no data fetching.

## Testing

- `SideMenu.test.tsx`: renders all six links; marks the current route active;
  hamburger toggles the drawer; drawer closes on link click.
- `AdminLayout.test.tsx`: asserts the sidemenu renders inside the layout.
- Existing page tests pass unchanged (layout API is stable).
