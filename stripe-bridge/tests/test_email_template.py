from email_template import render_invite_email


def test_render_contains_invite_url_and_expiry():
    html = render_invite_email(invite_url="http://inv.test/j/abc", expires_days=7)
    assert 'href="http://inv.test/j/abc"' in html
    assert "http://inv.test/j/abc" in html
    assert "7 days" in html


def test_render_carries_brand_and_cta():
    html = render_invite_email(invite_url="http://inv.test/j/abc", expires_days=7)
    assert "WESTEROZ" in html
    assert "Set up your account" in html


def test_render_keeps_infrastructure_framing_copy():
    html = render_invite_email(invite_url="http://inv.test/j/abc", expires_days=7)
    assert "server costs" in html
    assert "access will be removed" in html


def test_render_uses_inline_styles_only():
    # Gmail strips <style> blocks in some contexts; everything must be inline.
    html = render_invite_email(invite_url="http://inv.test/j/abc", expires_days=7)
    assert "<style" not in html
    assert 'src="http' not in html  # no external assets


def test_render_interpolates_expiry_days():
    html = render_invite_email(invite_url="http://inv.test/j/abc", expires_days=14)
    assert "14 days" in html
    assert "7 days" not in html
