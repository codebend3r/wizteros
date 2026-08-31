# Styled HTML body for the invite email. Email clients require inline styles,
# table-based layout, and no external assets, so everything is self-contained.
# Palette follows the Westeroz site: red #c23b3b accent, near-black #0b0d12 text.

_FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

_TEMPLATE = """\
<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:#f4f5f7;">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
      Set up your account &mdash; your invite expires in {expires_days} days.
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:#ffffff;border:1px solid #e2e4e9;border-radius:12px;">
            <tr>
              <td style="padding:40px 40px 32px;font-family:{font};">
                <p style="margin:0 0 28px;font-size:14px;font-weight:700;letter-spacing:6px;color:#0b0d12;">WESTEROZ</p>
                <h1 style="margin:0 0 12px;font-size:24px;font-weight:700;color:#0b0d12;">You&rsquo;re in.</h1>
                <p style="margin:0 0 12px;font-size:16px;line-height:1.6;color:#3f4653;">
                  Thanks for contributing to server costs. Your access is ready &mdash;
                  set up your account to get started.
                </p>
                <p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#3f4653;">
                  You&rsquo;ll sign in with a Plex account. If you don&rsquo;t have one yet,
                  create it with this same email address so your access stays linked to
                  your contribution.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
                  <tr>
                    <td bgcolor="#c23b3b" style="border-radius:8px;">
                      <a href="{invite_url}" style="display:inline-block;padding:13px 28px;font-family:{font};font-size:16px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">Set up your account</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;font-size:14px;line-height:1.6;color:#6b7280;">
                  This invite expires in {expires_days} days, so please complete signup soon.
                </p>
                <p style="margin:0;font-size:13px;line-height:1.6;color:#6b7280;">
                  Or paste this link into your browser:<br>
                  <a href="{invite_url}" style="color:#c23b3b;word-break:break-all;">{invite_url}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 40px;border-top:1px solid #e9ebef;font-family:{font};">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#9aa1ad;">
                  If you cancel your contribution, access will be removed at the end of
                  the current billing cycle.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""


def render_invite_email(*, invite_url: str, expires_days: int) -> str:
    """Render the HTML alternative of the invite email."""
    return _TEMPLATE.format(invite_url=invite_url, expires_days=expires_days, font=_FONT)
