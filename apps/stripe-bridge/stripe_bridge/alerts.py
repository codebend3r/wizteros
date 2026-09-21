"""Every operational alert the bridge mails an admin, as a subject and a body.

One file so the whole operator-facing voice can be read, and audited for the
server-cost framing, in one pass instead of being found inline in a webhook
handler, a recovery path and two sweeps.

Nothing here sends anything: each builder returns the pair its caller hands to
mailer.send_alert_email. That keeps the send where the caller's own logging
and error handling already are, and keeps it patchable per module in tests.
"""

from datetime import datetime, timezone


def money(amount: object, currency: object) -> str:
    """Stripe's minor-unit integer as '8.00 CAD'; 'unknown amount' when absent."""
    if not isinstance(amount, int):
        return "unknown amount"
    return f"{amount / 100:.2f} {str(currency or '').upper()}".strip()


def describe_invoice(obj: dict) -> str:
    """One line of what Stripe knows about a failed invoice, for an alert body."""
    amount = money(obj.get("amount_due"), obj.get("currency"))
    attempts = obj.get("attempt_count") or 0
    retry = obj.get("next_payment_attempt")
    when = (datetime.fromtimestamp(retry, tz=timezone.utc).date().isoformat()
            if retry else "none scheduled; Stripe has given up on this invoice")
    return f"{amount}, attempt {attempts}, next retry {when} (invoice {obj.get('id')})"


def signup(*, email: str, tier: str, session: dict, invite_url: str) -> tuple[str, str]:
    """Tell the admin who just signed up, with the same link the member got."""
    return (
        f"{email} signed up for {tier}",
        f"{email} completed a {tier} checkout for "
        f"{money(session.get('amount_total'), session.get('currency'))}.\n\n"
        f"  session  {session.get('id')}\n"
        f"  customer {session.get('customer')}\n"
        f"  invite   {invite_url}\n\n"
        f"The invite link has been emailed to them; they hold no new access "
        f"until they open it.\n",
    )


def payment_failed(*, email: str, invoice: dict, access: str) -> tuple[str, str]:
    """Tell the admin about one declined attempt; each is a day closer to a cancel."""
    return (
        f"{email} missed a payment",
        f"Stripe could not charge {email}.\n\n"
        f"  {describe_invoice(invoice)}\n\n"
        f"{access}\n\n"
        f"Access is not changed by a failed charge. If the retries all fail, "
        f"Stripe cancels the subscription and the bridge disables them then.\n",
    )


def banned_checkout(*, email: str, tier: str, session_id: object,
                    customer_id: object) -> tuple[str, str]:
    """Tell the admin a banned address paid; the charge is theirs to refund."""
    return (
        f"banned member {email} checked out",
        f"{email} is banned but completed a {tier} checkout "
        f"(session {session_id}, customer {customer_id}).\n\n"
        f"No invite was issued and no access was granted. Refund or "
        f"cancel the subscription in Stripe.\n",
    )


def access_restored(*, email: str, tier: str) -> tuple[str, str]:
    """Tell the admin a payment landed on a member holding nothing, and what was done."""
    return (
        f"reissued access for {email}",
        f"{email} paid but held no Wizarr records, so the bridge issued a fresh "
        f"{tier} invite and emailed it.\n\n"
        f"They are locked out until they open that link. If they were paying under "
        f"a second Stripe customer or a different Plex address, reconcile the two "
        f"before the next renewal.\n",
    )


def dunning_sweep(found: list[tuple[str, str, str]]) -> tuple[str, str]:
    """One mail for every member the sweep newly found past due."""
    body = "\n".join(f"- {email}: subscription {status}. {line}" for email, status, line in found)
    return (
        f"{len(found)} member(s) missed a payment",
        f"Stripe has these members in dunning, and no payment_failed webhook ever "
        f"reached the bridge for them:\n\n{body}\n\n"
        f"Nothing was changed except the admin UI now reads them as Payment Failed. "
        f"Check the card on file with them before Stripe's last retry cancels the "
        f"subscription.\n",
    )


def vips_without_access(stranded: list[str]) -> tuple[str, str]:
    """Tell the admin which standing grants currently grant nothing."""
    body = "\n".join(f"- {email}" for email in stranded)
    return (
        f"{len(stranded)} VIP(s) hold no server access",
        f"These VIP members have no Wizarr record on any server:\n\n{body}\n\n"
        f"VIP access is meant to be permanent. Either they never redeemed "
        f"their invite, or something disabled them.\n",
    )


def tier_scopes(problems: dict) -> tuple[str, str]:
    """Tell the admin which tiers no longer resolve against the live libraries."""
    body = "\n".join(f"- {tier}: {reason}" for tier, reason in sorted(problems.items()))
    return (
        f"{len(problems)} invite scope problem(s)",
        f"Invites no longer line up with the live library list:\n\n{body}\n\n"
        f"Members cannot sign up cleanly until the names line up again.\n",
    )
