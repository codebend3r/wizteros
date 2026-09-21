"""The drift alarms the reconcile loop runs between webhooks.

Each check never raises, alerts once per new problem rather than every sweep,
and never touches a member's access: that stays with the webhook handlers.
They take the Wizarr client and the store path as arguments so the loop, the
tests, and any one-off script call them the same way.
"""

import logging

from stripe_bridge import alerts, plex, store, tiers
from stripe_bridge.mailer import send_alert_email
from stripe_bridge.members import access_line, stripe_status_by_customer

log = logging.getLogger("bridge")


class _ChangeAlert:
    """Mails once per distinct problem set, not once per sweep.

    A standing breakage is alerted on the sweep that finds it and then stays
    quiet; a change in the set, or a recovery followed by a relapse, alerts
    again. The remembered set lives for the life of the process, so a restart
    re-alerts on whatever is still broken.
    """

    def __init__(self) -> None:
        """Start with nothing outstanding, so the first problem set always mails."""
        self._last: object = None

    def clear(self) -> None:
        """Forget the outstanding set: the same problem returning mails again."""
        self._last = None

    def fire(self, current: object, *, subject: str, body: str) -> None:
        """Mail subject/body unless this exact set is the one already alerted on."""
        if current != self._last:
            self._last = current
            send_alert_email(subject, body)


_tier_scope_alert = _ChangeAlert()
_vip_access_alert = _ChangeAlert()


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
        by_customer = stripe_status_by_customer()
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
        send_alert_email(*alerts.dunning_sweep(found))
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
    tags = store.all_member_tags(db_path)
    vips = sorted(email for email, tag in tags.items() if tag == "vip")
    if not vips:
        _vip_access_alert.clear()
        return []
    try:
        users = client.list_users()
    except Exception:
        log.exception("vip access check: could not read users from Wizarr")
        return []
    held = {(u.get("email") or "").lower() for u in users}
    stranded = [email for email in vips if email not in held]
    if not stranded:
        _vip_access_alert.clear()
        return []
    log.error("vip access check: %d VIP(s) hold no records: %s", len(stranded), stranded)
    subject, body = alerts.vips_without_access(stranded)
    _vip_access_alert.fire(stranded, subject=subject, body=body)
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
        _tier_scope_alert.clear()
        return {}
    for tier, reason in problems.items():
        log.error("tier scope check: %s -> %s", tier, reason)
    subject, body = alerts.tier_scopes(problems)
    _tier_scope_alert.fire(problems, subject=subject, body=body)
    return problems
