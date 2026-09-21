"""The environment the bridge runs on, read once and shared.

Every module that needs the Wizarr location, the invite windows or the store
path imports them from here instead of reading os.environ again, so the
webhook handler, the admin router and the invite pipeline cannot disagree
about what the deployment is configured as. That disagreement was real: the
admin router read the same six variables with empty-string defaults while the
entrypoint read them strictly, so a deploy missing WIZARR_API_KEY refused to
start the webhook and served admin routes that 500ed one request at a time.

Reads are lenient here and the entrypoint calls require() for the variables it
cannot run without, which keeps the fail-fast in the one process that has to
have them without stopping a test or a script from importing a module.
"""

import os

from stripe_bridge.wizarr import WizarrClient

WIZARR_BASE_URL = os.environ.get("WIZARR_BASE_URL", "").rstrip("/")
WIZARR_API_KEY = os.environ.get("WIZARR_API_KEY", "")

# How long an issued invite link stays redeemable, and how long the access a
# payment buys lasts once it is redeemed. Both are counted in days.
INVITE_DAYS = int(os.environ.get("INVITE_EXPIRES_DAYS", "14"))
ACCESS_DURATION = os.environ.get("ACCESS_DURATION", "35")

# The public origin members' invite links are built on, and the SQLite file
# holding the customer map, tags, links and event log.
PUBLIC_INVITE_BASE = os.environ.get("PUBLIC_INVITE_BASE", "").rstrip("/")
MAP_DB_PATH = os.environ.get("MAP_DB_PATH", "/data/bridge.db")

client = WizarrClient(WIZARR_BASE_URL, WIZARR_API_KEY)


def require(*names: str) -> None:
    """Raise KeyError naming every variable in `names` that the environment lacks.

    Called by the entrypoint at import so a misconfigured container dies on
    boot, naming all of what is missing at once, rather than accepting webhooks
    it cannot act on.
    """
    missing = [name for name in names if name not in os.environ]
    if missing:
        raise KeyError(f"missing required environment: {', '.join(missing)}")
