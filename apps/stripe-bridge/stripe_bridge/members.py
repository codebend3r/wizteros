"""Who a Stripe customer is in Wizarr, resolved live.

Shared by the webhook handlers and the sweeps, which is why it takes the
Wizarr client and the store path as arguments instead of reading the bridge's
module globals.
"""

import logging

import stripe

from stripe_bridge import store

log = logging.getLogger("bridge")


def resolve_user_ids(*, client, store_path: str, customer_id: str | None,
                     email: str | None) -> list[int]:
    """All Wizarr record ids for a member (one per server), resolved live.

    Prefer email, then the address an admin linked this one to, then the
    stored invite code (the Stripe email may differ from the Plex account
    email). The linked address comes second on purpose: it is a stated fact
    about who this customer is, while the invite code only infers it from a
    redemption. It is also the only thing that answers for a member who
    re-subscribed under a re-typed address without ever redeeming the invite
    that checkout issued: their renewal would otherwise find nothing to
    extend and mint yet another invite they have no reason to click.
    """
    ids = client.find_user_ids_by_email(email) if email else []
    if not ids and email:
        linked = store.get_member_link(store_path, email)
        if linked:
            ids = client.find_user_ids_by_email(linked)
            if ids:
                log.info("resolved %s through its linked address %s", email, linked)
    if not ids and customer_id:
        m = store.get_mapping(store_path, customer_id)
        if m and m["invite_code"]:
            ids = client.find_user_ids_by_invite(m["invite_code"])
    return ids


def access_line(*, client, db_path: str, customer_id: str | None, email: str) -> str:
    """One sentence on whether the member can watch right now, for an alert body."""
    try:
        held = bool(resolve_user_ids(client=client, store_path=db_path,
                                     customer_id=customer_id, email=email))
    except Exception:
        log.exception("could not read Wizarr records for %s", email)
        return "Whether they hold server access could not be checked (Wizarr unreachable)."
    if held:
        return ("They still hold server access for the period already paid; it lapses "
                "at their expiry if the retries keep failing.")
    return ("They hold NO server access on any server right now: either their invite "
            "was never redeemed or their records already lapsed.")


# A subscription Stripe is still charging for, or trying to.
LIVE_STATUSES = frozenset({"active", "trialing"})

# When one customer holds several subscriptions (an old canceled one next to
# the live one), the one that is paying, or failing to, is the one that counts.
_SUB_STATUS_RANK = {"active": 2, "trialing": 2, "past_due": 1, "unpaid": 1}


def stripe_status_by_customer() -> dict[str, str]:
    """Every customer's best subscription status, straight from Stripe."""
    best: dict[str, str] = {}
    for sub in stripe.Subscription.list(status="all", limit=100).auto_paging_iter():
        cus, status = sub["customer"], sub["status"]
        if _SUB_STATUS_RANK.get(status, 0) > _SUB_STATUS_RANK.get(best.get(cus, ""), 0):
            best[cus] = status
    return best


def live_sibling_customer(*, db_path: str, email: str, dead_customer: str) -> str | None:
    """Another Stripe customer at the same address that Stripe still says is paying.

    A member who re-checks out from scratch instead of fixing their card ends
    up as two customers under one email: the old one dying in dunning, the new
    one paying. `subscribed` is per email, so the store cannot tell the two
    apart; Stripe can. One Stripe call, and only when a sibling row exists.
    """
    siblings = [c for c in store.customer_ids_for_email(db_path, email) if c != dead_customer]
    if not siblings:
        return None
    status = stripe_status_by_customer()
    return next((c for c in siblings if status.get(c) in LIVE_STATUSES), None)
