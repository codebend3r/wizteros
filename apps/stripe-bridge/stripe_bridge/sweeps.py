"""The drift alarms the reconcile loop runs between webhooks.

Each check never raises, alerts once per new problem rather than every sweep,
and never touches a member's access: that stays with the webhook handlers.
They take the Wizarr client and the store path as arguments so the loop, the
tests, and any one-off script call them the same way.
"""

import logging

import stripe

from stripe_bridge import plex, store, tiers
from stripe_bridge.mailer import send_alert_email
from stripe_bridge.members import access_line

log = logging.getLogger("bridge")

# Last set of tier problems alerted on, so a standing breakage mails once
# rather than every sweep. A change in the problem set (or a recovery followed
# by a relapse) alerts again.
_last_tier_problems: dict = {}


# Last set of VIPs alerted on as holding no access, so a standing problem mails
# once rather than every sweep.
_last_vips_without_access: list = []

# When one customer holds several subscriptions (an old canceled one next to
# the live one), the one that is paying, or failing to, is the one that counts.
_SUB_STATUS_RANK = {"active": 2, "trialing": 2, "past_due": 1, "unpaid": 1}


def _stripe_status_by_customer() -> dict[str, str]:
    """Every customer's best subscription status, straight from Stripe."""
    best: dict[str, str] = {}
    for sub in stripe.Subscription.list(status="all", limit=100).auto_paging_iter():
        cus, status = sub["customer"], sub["status"]
        if _SUB_STATUS_RANK.get(status, 0) > _SUB_STATUS_RANK.get(best.get(cus, ""), 0):
            best[cus] = status
    return best


def _dunning_sweep_alert(found: list[tuple[str, str, str]]) -> None:
    """One mail for every member the sweep newly found past due."""
    body = "\n".join(f"- {email}: subscription {status}. {line}" for email, status, line in found)
    send_alert_email(
        f"{len(found)} member(s) missed a payment",
        f"Stripe has these members in dunning, and no payment_failed webhook ever "
        f"reached the bridge for them:\n\n{body}\n\n"
        f"Nothing was changed except the admin UI now reads them as Payment Failed. "
        f"Check the card on file with them before Stripe's last retry cancels the "
        f"subscription.\n",
    )


def check_payment_states(*, client, db_path: str) -> list:
    """Mirror Stripe's own dunning state onto the store; alert on what the webhooks missed.

    invoice.payment_failed only reaches the bridge when Stripe delivers it, and
    a member found past due by this sweep is one whose failure arrived by no
    other route: the event type was not enabled, the Funnel was down, the
    retries ran out. Access is never touched here; that stays the cancel
    handler's job. Alerts once per newly found member, because writing the
    flag is what stops the next sweep repeating it. Never raises: an
    unreachable Stripe is not a missed payment.
    """
    try:
        by_customer = _stripe_status_by_customer()
    except Exception:
        log.exception("payment state check: could not list subscriptions from Stripe")
        return []
    found = []
    for email, row in store.all_customer_rows(db_path).items():
        status = by_customer.get(row["customer_id"])
        if not row["subscribed"] or status not in store.PAYMENT_STATE_BY_STATUS:
            continue
        state = store.PAYMENT_STATE_BY_STATUS[status]
        if state == row["payment_state"]:
            continue
        store.set_payment_state(db_path, email, state)
        if state:
            log.warning("payment state check: %s is %s in Stripe; no webhook said so", email, status)
            store.record_event(db_path, email, "Payment failed",
                               f"Stripe reports the subscription {status}; found by the sweep, "
                               f"no webhook was received")
            found.append((email, status, access_line(client=client, db_path=db_path,
                                                   customer_id=row["customer_id"], email=email)))
        else:
            log.info("payment state check: %s is paying again", email)
            store.record_event(db_path, email, "Payment recovered",
                               "Stripe reports the subscription active again")
    if found:
        _dunning_sweep_alert(found)
    return [email for email, _status, _line in found]


def check_vip_access(*, client, db_path: str) -> list:
    """VIPs holding no Wizarr record at all; alert on the set changing.

    A VIP is a standing grant, so "no records" is never a normal resting state
    for one: it means an invite was issued and never redeemed, or something
    disabled them. Guards stop the causes the bridge knows about, and this is
    the net under the ones it does not (a manual disable, a Plex-side unshare,
    an invite that quietly expired). Never raises: it runs inside the reconcile
    loop, and an unreachable Wizarr is not a lockout.
    """
    global _last_vips_without_access
    tags = store.all_member_tags(db_path)
    vips = sorted(email for email, tag in tags.items() if tag == "vip")
    if not vips:
        _last_vips_without_access = []
        return []
    try:
        users = client.list_users()
    except Exception:
        log.exception("vip access check: could not read users from Wizarr")
        return []
    held = {(u.get("email") or "").lower() for u in users}
    stranded = [email for email in vips if email not in held]
    if not stranded:
        _last_vips_without_access = []
        return []
    log.error("vip access check: %d VIP(s) hold no records: %s", len(stranded), stranded)
    if stranded != _last_vips_without_access:
        _last_vips_without_access = stranded
        body = "\n".join(f"- {email}" for email in stranded)
        send_alert_email(
            f"{len(stranded)} VIP(s) hold no server access",
            f"These VIP members have no Wizarr record on any server:\n\n{body}\n\n"
            f"VIP access is meant to be permanent. Either they never redeemed "
            f"their invite, or something disabled them.\n",
        )
    return stranded


def check_tier_scopes(*, client) -> dict:
    """Verify every tier still resolves against the live library list; alert on drift.

    The tier rules match Plex library names, so a rename on the server silently
    empties a tier with no code change and no failing test — that is exactly how
    the youth tier died unnoticed. The same rename also leaves a stale name in
    Wizarr's own library cache until someone rescans it, and Plex rejects every
    invite carrying that name whole at redemption, so the cache is checked
    against plex.tv's live sections here too. Returns the problems found
    (empty when healthy). Never raises: it runs inside the reconcile loop, and
    neither a down Wizarr nor a down SMTP may take that loop out. A Wizarr or
    plex.tv that cannot be reached is reported as healthy — unreachable is not
    misconfigured, and the next sweep will try again.
    """
    global _last_tier_problems
    try:
        libraries = client.list_libraries()
    except Exception:
        log.exception("tier scope check: could not read libraries from Wizarr")
        return {}
    problems = {
        **tiers.tier_scope_problems(libraries=libraries),
        **tiers.library_cache_problems(libraries=libraries, live=plex.live_sections_or_none()),
    }
    if not problems:
        _last_tier_problems = {}
        return {}
    for tier, reason in problems.items():
        log.error("tier scope check: %s -> %s", tier, reason)
    if problems != _last_tier_problems:
        _last_tier_problems = problems
        body = "\n".join(f"- {tier}: {reason}" for tier, reason in sorted(problems.items()))
        send_alert_email(
            f"{len(problems)} invite scope problem(s)",
            f"Invites no longer line up with the live library list:\n\n{body}\n\n"
            f"Members cannot sign up cleanly until the names line up again.\n",
        )
    return problems
