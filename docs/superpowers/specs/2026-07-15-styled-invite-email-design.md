# Styled invite email: design

Date: 2026-07-15
Status: approved

## Problem

The invite email the stripe-bridge sends after a successful checkout is plain
text: a bare paragraph and a raw URL. It reads as unfinished and does not match
the Westeroz brand.

## Decision

Send a `multipart/alternative` message: keep the existing plain-text body as
the fallback part, add a styled HTML part. The chosen visual direction (from
the three mocked options) is the **light card**: white card with a subtle
border on a light gray backdrop, red CTA button, safest rendering across
email clients while still using the site's accent color.

## Components

- `stripe-bridge/email_template.py` (new), `render_invite_email(...)` returns
  the HTML body. Pure string templating, no new dependencies. Keeps the markup
  blob out of the webhook logic and unit-testable.
- `stripe-bridge/stripe_wizarr_bridge.py`: `send_invite_email()` adds the
  HTML alternative via `msg.add_alternative(..., subtype="html")` and updates
  the subject to "Your Westeroz access link".

## HTML constraints and layout

Email clients require inline styles, table-based layout, and no external
assets. The layout, top to bottom, inside a 600px-max white card
(`#ffffff`, 1px `#e2e4e9` border, 12px radius) on a `#f4f5f7` backdrop:

1. Hidden preheader: "Set up your account, your invite expires in N days."
2. "WESTEROZ" letterspaced text wordmark, `#0b0d12` (text, not an image).
3. Heading "You're in." + copy thanking them for contributing to server costs
   (infrastructure framing per repo conventions; no content references).
4. Bulletproof red `#c23b3b` button "Set up your account" (padded `td` with
   `bgcolor` so Outlook renders it), white label.
5. Muted gray expiry line and the raw invite URL as a copy-paste fallback.
6. Footer, divided by a hairline border: cancellation note in small muted text.

## Testing

- Unit tests for `render_invite_email` (URL, expiry, button label, no
  `<style>` blocks).
- Bridge test asserts the message is `multipart/alternative`, both parts carry
  the invite URL, and SMTP behavior is unchanged.
- Manual check: render sample HTML and send one real email to the operator.

## Out of scope

- Hosted images / logo assets.
- Emails for renewal or cancellation events (none are sent today).
