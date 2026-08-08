"""One-time backfill: mark the 44 non-VIP members Invited with a 14-day expiry.

For each listed member this stamps invited_at = now in the bridge (so they read
"Invited") and sets a real Wizarr access expiry 14 days out (so Wizarr removes
their access if they don't sign up). It does NOT set the payment flag — their
status stays "Invited" until a real Stripe payment flips it to "Subscribed
Monthly".

Idempotent and safe to re-run. Two members are skipped untouched:
  - anyone tagged `vip` (VIP access is never time-boxed), and
  - anyone already carrying a confirmed payment (`subscribed`).

Deploy the payment-flag bridge changes FIRST — otherwise the old logic would
read these members as "Subscribed Monthly" the moment they get an expiry.

Config comes from the bridge's own env (MAP_DB_PATH, WIZARR_BASE_URL,
WIZARR_API_KEY). Run it from a checkout on the NAS with those vars pointed at
production (the bridge modules and `requests` must be importable), e.g.:

    MAP_DB_PATH=/volume1/docker/wizteros/stripe-bridge-data/bridge.db \\
    WIZARR_BASE_URL=http://localhost:5690 WIZARR_API_KEY=... \\
    python scripts/backfill_invited_expiry.py --dry-run

Drop --dry-run to apply. Always run --dry-run first and read the summary.
"""

import argparse
import logging
import os
import sys
from datetime import datetime, timedelta, timezone

# The bridge modules sit one directory up in a checkout (and flat in /app inside
# the image); make both layouts importable.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from stripe_bridge import store
from stripe_bridge.wizarr import WizarrClient

log = logging.getLogger("bridge.backfill")

EXPIRY_DAYS = int(os.environ.get("BACKFILL_EXPIRY_DAYS", "14"))
MAP_DB_PATH = os.environ.get("MAP_DB_PATH", "/data/bridge.db")
WIZARR_BASE_URL = os.environ.get("WIZARR_BASE_URL", "").rstrip("/")
WIZARR_API_KEY = os.environ.get("WIZARR_API_KEY", "")

# The 44 non-VIP members (the full Wizarr roster minus the 5 VIP emails).
# Auditable — remove any address here to leave that member untouched.
EMAILS = [
    "amolsharma@me.com",
    "andrewmasonmac@gmail.com",
    "andrew.a.donald@gmail.com",
    "oe.andy0102@gmail.com",
    "artirawal2009@gmail.com",
    "ayosalawu@gmail.com",
    "codebenderinc@gmail.com",
    "chrismanocchio@gmail.com",
    "christopherlukestewart@gmail.com",
    "cuallijulius@gmail.com",
    "danny.p.79@icloud.com",
    "davejmcg@gmail.com",
    "harpreetmand@gmail.com",
    "harmancheema07@gmail.com",
    "higorsalesart@gmail.com",
    "jamal.tobias@gmail.com",
    "jean.abousaab@gmail.com",
    "jeffreceno@hotmail.com",
    "jimmyvo768@gmail.com",
    "jroberts0985@gmail.com",
    "karensjahn@gmail.com",
    "kensuong@gmail.com",
    "kkalawi@gmail.com",
    "lauramjbowers@gmail.com",
    "809lenny@gmail.com",
    "luxman.thevathasan@gmail.com",
    "m.mcphaden@live.ca",
    "macklewis16@gmail.com",
    "mattbk.cb@gmail.com",
    "stefuraknataliia@gmail.com",
    "nicklhw@gmail.com",
    "pollux527@hotmail.com",
    "contactprerit@gmail.com",
    "ramiandari@gmail.com",
    "rita.duchak@icloud.com",
    "rodrigobocaiuva@gmail.com",
    "rorosha13@gmail.com",
    "ryan.duchak@gmail.com",
    "schopra86@live.com",
    "canexan@gmail.com",
    "jbloco26@gmail.com",
    "gmacgregor@gmail.com",
    "Toronto0442@gmail.com",
    "william@wcarroll.com",
]


def run(dry_run: bool) -> None:
    """Stamp each eligible member Invited and set their 14-day Wizarr expiry."""
    client = WizarrClient(WIZARR_BASE_URL, WIZARR_API_KEY)
    tags = store.all_member_tags(MAP_DB_PATH)
    rows = store.all_customer_rows(MAP_DB_PATH)
    expires = (datetime.now(timezone.utc) + timedelta(days=EXPIRY_DAYS)).isoformat()

    stamped, skipped = 0, 0
    for email in EMAILS:
        key = email.lower()
        if tags.get(key) == "vip":
            log.info("skip %s — VIP (never time-boxed)", email)
            skipped += 1
            continue
        if rows.get(key, {}).get("subscribed"):
            log.info("skip %s — already subscribed (confirmed payment)", email)
            skipped += 1
            continue

        uids = client.find_user_ids_by_email(email)
        log.info("%s%s — stamp Invited, expire %d Wizarr record(s) at %s",
                 "[dry-run] " if dry_run else "", email, len(uids), expires[:10])
        if dry_run:
            stamped += 1
            continue

        store.stamp_invited(MAP_DB_PATH, email)
        for uid in uids:
            client.set_expiry(uid, expires)
        store.record_event(MAP_DB_PATH, email, "Invited",
                           f"manual — access ends {expires[:10]}")
        stamped += 1

    log.info("%sdone: %d stamped, %d skipped, %d total",
             "[dry-run] " if dry_run else "", stamped, skipped, len(EMAILS))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="log what would change without writing")
    args = parser.parse_args()

    if not WIZARR_BASE_URL or not WIZARR_API_KEY:
        sys.exit("WIZARR_BASE_URL and WIZARR_API_KEY must be set")
    run(args.dry_run)


if __name__ == "__main__":
    main()
