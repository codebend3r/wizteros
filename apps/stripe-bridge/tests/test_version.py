import os
import re

# Provide required env before importing the module (mirrors test_bridge).
os.environ.update({
    "STRIPE_API_KEY": "sk_test_x", "STRIPE_WEBHOOK_SECRET": "whsec_x",
    "WIZARR_BASE_URL": "http://wizarr.test", "WIZARR_API_KEY": "k",
    "INVITE_EXPIRES_DAYS": "14", "ACCESS_DURATION": "35",
    "SMTP_HOST": "smtp.test", "SMTP_PORT": "587", "SMTP_USER": "u",
    "SMTP_PASS": "p", "FROM_ADDR": "server@test", "PUBLIC_INVITE_BASE": "http://inv.test",
    "MAP_DB_PATH": "/tmp/does-not-matter.db",
})

from stripe_bridge import __version__
from stripe_bridge.stripe_wizarr_bridge import app, version


def _routes_for(path):
    """Every registered route matching an exact path, as (methods, dependency count)."""
    return [
        (r.methods, len(r.dependencies))
        for r in app.routes
        if getattr(r, "path", None) == path
    ]


def test_version_is_semver():
    """release.sh rewrites this string with sed; a malformed value breaks the bump."""
    assert re.fullmatch(r"\d+\.\d+\.\d+", __version__)


def test_version_handler_reports_package_version():
    assert version() == {"version": __version__}


def test_version_endpoint_is_dual_pathed():
    """Funnel strips the /stripe prefix, so both paths must answer (as for /webhook)."""
    assert any("GET" in methods for methods, _ in _routes_for("/version"))
    assert any("GET" in methods for methods, _ in _routes_for("/stripe/version"))


def test_version_endpoint_needs_no_auth():
    """The deploy check runs before anyone holds an admin token."""
    for path in ("/version", "/stripe/version"):
        assert _routes_for(path), f"{path} not registered"
        assert all(count == 0 for _, count in _routes_for(path)), \
            f"{path} gained a dependency; it must stay unauthenticated"
