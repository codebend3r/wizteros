"""Who a Stripe customer is in Wizarr, resolved live.

Shared by the webhook handlers and the sweeps, which is why it takes the
Wizarr client and the store path as arguments instead of reading the bridge's
module globals.
"""

import logging

from stripe_bridge import store

log = logging.getLogger("bridge")


def resolve_user_ids(client, store_path: str, customer_id: str | None,
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
        held = bool(resolve_user_ids(client, db_path, customer_id, email))
    except Exception:
        log.exception("could not read Wizarr records for %s", email)
        return "Whether they hold server access could not be checked (Wizarr unreachable)."
    if held:
        return ("They still hold server access for the period already paid; it lapses "
                "at their expiry if the retries keep failing.")
    return ("They hold NO server access on any server right now: either their invite "
            "was never redeemed or their records already lapsed.")
