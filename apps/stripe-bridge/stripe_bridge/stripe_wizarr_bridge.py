import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

import stripe
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware

from stripe_bridge import (
    __version__,
    admin,
    alerts,
    baseline,
    config,
    invites,
    store,
    sweeps,
    tiers,
)
from stripe_bridge import plex as plex
from stripe_bridge.config import (
    ACCESS_DURATION,
    MAP_DB_PATH,
    PUBLIC_INVITE_BASE,
    client,
)
from stripe_bridge.mailer import send_alert_email, send_invite_email
from stripe_bridge.members import access_line, live_sibling_customer, resolve_user_ids

config.require("STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET", "WIZARR_BASE_URL",
               "WIZARR_API_KEY", "PUBLIC_INVITE_BASE")

STRIPE_API_KEY = os.environ["STRIPE_API_KEY"]
STRIPE_WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]

RECONCILE_INTERVAL_SECONDS = int(os.environ.get("RECONCILE_INTERVAL_SECONDS", "3600"))
MEMBERS_SNAPSHOT_INTERVAL_SECONDS = int(
    os.environ.get("MEMBERS_SNAPSHOT_INTERVAL_SECONDS", "300"))
# Wall-clock hour the baseline invites rotate at, in the container's local time.
BASELINE_ROTATE_HOUR = int(os.environ.get("BASELINE_ROTATE_HOUR", "3"))

stripe.api_key = STRIPE_API_KEY
log = logging.getLogger("bridge")
logging.basicConfig(level=logging.INFO)


def _signup_alert(*, email: str, tier: str, session: dict, code: str) -> None:
    """Tell the admin who just signed up, with the same link the member got."""
    send_alert_email(*alerts.signup(email=email, tier=tier, session=session,
                                    invite_url=f"{PUBLIC_INVITE_BASE}/j/{code}"))


def _payment_failed_alert(*, email: str, invoice: dict) -> None:
    """Tell the admin about one declined attempt; each is a day closer to a cancel."""
    send_alert_email(*alerts.payment_failed(
        email=email, invoice=invoice,
        access=access_line(client=client, db_path=MAP_DB_PATH,
                           customer_id=invoice.get("customer"), email=email)))


def reconcile_pending_expiries() -> int:
    """Stamp the paid expiry on records that joined without one; returns records stamped.

    Wizarr does not translate an invite's duration into record expiry, so a
    brand-new member redeems into records with no expiry at all — and no
    webhook fires at redemption to correct it. Sweep every subscribed, non-VIP
    member and stamp invited_at + ACCESS_DURATION (the signup date anchors the
    window) on any of their records still unlimited. Records that already
    carry an expiry are never touched. When the signup anchor is old enough
    that the window has already closed, the expiry is re-anchored at the sweep
    rather than stamped in the past: a background job must never revoke a
    paying member's access, and must never leave it unbounded either.

    A member whose Plex email differs from the Stripe email (common for
    brand-new members, who create the Plex account at redemption) matches no
    record by email; their records are found through the invite they redeemed
    instead. The fallback only runs when the email matches nothing at all, so
    already-stamped members cost no extra Wizarr calls.
    """
    customers = store.all_customer_rows(MAP_DB_PATH)
    tags = store.all_member_tags(MAP_DB_PATH)
    links = store.all_member_links(MAP_DB_PATH)
    pending = {
        email: row for email, row in customers.items()
        if row["subscribed"] and row["invited_at"] and tags.get(email) not in ("vip", "banned")
    }
    if not pending:
        return 0
    users = client.list_users()
    now = datetime.now(timezone.utc)
    stamped = 0
    for email, row in pending.items():
        matched = [u for u in users if (u.get("email") or "").lower() == email]
        if not matched and links.get(email):
            # They pay under this address and watch under another. The invite
            # fallback below cannot reach them: a member who re-subscribed
            # while already holding access never redeems the new invite.
            matched = [u for u in users if (u.get("email") or "").lower() == links[email]]
        if matched:
            records = [u for u in matched if not u.get("expires")]
        else:
            ids = (set(client.find_user_ids_by_invite(row["invite_code"]))
                   if row["invite_code"] else set())
            records = [u for u in users if u["id"] in ids and not u.get("expires")]
        if not records:
            continue
        window = timedelta(days=int(ACCESS_DURATION))
        anchored = datetime.fromisoformat(row["invited_at"]) + window
        # A signup older than the access window computes a past date on every
        # sweep. Stamping it would let a background job revoke a paying
        # member's access; skipping it, which is what used to happen, left
        # them with no expiry at all and so no time-box whatsoever. Re-anchor
        # at the sweep instead: the same window any payment grants, and their
        # next renewal re-stamps it from the payment date.
        lapsed = anchored <= now
        expiry = now + window if lapsed else anchored
        for u in records:
            client.set_expiry(u["id"], expiry.isoformat())
        stamped += len(records)
        log.info("reconcile: stamped expiry %s on %d record(s) for %s%s",
                 expiry.isoformat(), len(records), email,
                 " (signup window had lapsed)" if lapsed else "")
        store.record_event(
            MAP_DB_PATH, email, "Expiry stamped",
            (f"signup window had already lapsed; re-anchored to {expiry.isoformat()[:10]}"
             if lapsed else
             f"joined with no expiry, set to {expiry.isoformat()[:10]}"))
    return stamped


async def _reconcile_loop() -> None:
    """Run the alarms and the expiry sweep now, then every interval.

    The checks run first and independently of each other: they are the drift
    alarms, so each must still fire on a sweep where another pass throws.
    """
    while True:
        try:
            await asyncio.to_thread(sweeps.check_tier_scopes, client=client)
        except Exception:
            log.exception("tier scope check failed")
        try:
            await asyncio.to_thread(sweeps.check_vip_access, client=client, db_path=MAP_DB_PATH)
        except Exception:
            log.exception("vip access check failed")
        try:
            await asyncio.to_thread(sweeps.check_payment_states, client=client,
                                    db_path=MAP_DB_PATH)
        except Exception:
            log.exception("payment state check failed")
        try:
            await asyncio.to_thread(reconcile_pending_expiries)
        except Exception:
            log.exception("expiry reconcile sweep failed")
        await asyncio.sleep(RECONCILE_INTERVAL_SECONDS)


async def _snapshot_loop() -> None:
    """Warm the members snapshot at boot and keep it fresh thereafter.

    A failed refresh (Wizarr or plex.tv down) logs and retries next interval;
    /admin/members keeps serving the previous snapshot in the meantime.
    """
    while True:
        try:
            await asyncio.to_thread(admin.members_snapshot.refresh)
        except Exception:
            log.exception("members snapshot refresh failed")
        await asyncio.sleep(MEMBERS_SNAPSHOT_INTERVAL_SECONDS)


def _seconds_until_hour(hour: int, *, now: datetime | None = None) -> float:
    """Seconds from now until the next local occurrence of the given hour.

    Sleeping to a wall-clock target rather than on a fixed interval keeps the
    rotation pinned to the same time every day instead of drifting forward by
    however long each run took, and re-anchors it after a restart.
    """
    now = now or datetime.now()
    target = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def _baseline_loop() -> None:
    """Rotate the per-tier baseline invites once a day at BASELINE_ROTATE_HOUR.

    Deliberately does not rotate at boot: a restart loop would otherwise mint a
    fresh set of invites every time the container came up.
    """
    while True:
        await asyncio.sleep(_seconds_until_hour(BASELINE_ROTATE_HOUR))
        try:
            result = await asyncio.to_thread(
                baseline.rotate_baseline_invites, client=client, db_path=MAP_DB_PATH)
            log.info("baseline rotation: minted %d, skipped %s, reaped %d",
                     len(result["minted"]), result["skipped"] or "none",
                     len(result["reaped"]))
        except Exception:
            log.exception("baseline rotation failed")


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """Open the store, then keep the reconcile, snapshot and rotation loops running.

    The schema is created here rather than at import so that importing this
    module (a test, a script, a CLI) never has to be able to write the
    configured database file; the process that serves requests always can.
    """
    store.init_db(MAP_DB_PATH)
    tasks = [asyncio.create_task(_reconcile_loop()), asyncio.create_task(_snapshot_loop()),
             asyncio.create_task(_baseline_loop())]
    yield
    for task in tasks:
        task.cancel()


app = FastAPI(lifespan=_lifespan)

ADMIN_ALLOWED_ORIGINS = [
    o.strip() for o in os.environ.get("ADMIN_ALLOWED_ORIGINS", "").split(",") if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ADMIN_ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)
# Bare paths serve Funnel-proxied calls (the /stripe prefix is stripped by
# Funnel); the /stripe-prefixed copy serves direct/local calls, mirroring the
# dual /webhook + /stripe/webhook handlers below.
app.include_router(admin.router)
app.include_router(admin.router, prefix="/stripe")


# Unauthenticated on purpose: the release string is not a secret, and the
# deploy check has to work before anyone holds an admin token. Dual-pathed for
# the same Funnel reason as the webhook handlers below.
@app.get("/stripe/version")
@app.get("/version")
def version():
    """Release version of the running bridge, so a deploy can be verified from outside."""
    return {"version": __version__}


def customer_email(customer_id: str) -> str | None:
    """Email on the Stripe customer record, or None if they have none on file."""
    # retrieve() returns a StripeObject (no dict .get); read the field directly.
    return getattr(stripe.Customer.retrieve(customer_id), "email", None)


def access_expiry_iso() -> str:
    """Absolute expiry for a paid record: the update time plus ACCESS_DURATION."""
    return (datetime.now(timezone.utc) + timedelta(days=int(ACCESS_DURATION))).isoformat()


def linked_addresses(store_path: str, email: str) -> set[str]:
    """Every address belonging to the same person as `email`, lowercased.

    Links point payer -> Plex account, so the person is identified by the Plex
    address: either this address pays for someone (follow the link) or it is
    the account itself. Both directions matter, since a cancellation can land
    on either half of the pair.
    """
    links = store.all_member_links(store_path)
    lowered = email.lower()
    owner = links.get(lowered, lowered)
    return {owner} | {payer for payer, plex in links.items() if plex == owner}


def still_subscribed_elsewhere(store_path: str, email: str) -> str | None:
    """Another address of the same person still carrying a live subscription.

    A member can hold two Stripe customers, and only one of them dying is the
    normal way that ends. Records resolve by email, so the dead customer's
    address is the same one the live member watches under: disabling on its
    cancellation revokes access somebody is currently paying for.
    """
    rows = store.all_customer_rows(store_path)
    others = sorted(linked_addresses(store_path, email) - {email.lower()})
    return next((a for a in others if a in rows and rows[a]["subscribed"]), None)


def resolve_tier_scope(tier: str, *, context: str) -> dict:
    """The tier's live library scope, or raise so the delivery is retried.

    An empty scope means the tier's library names no longer match anything on
    the server (a rename, a disabled library). Issuing the invite anyway would
    hand the member an invite that grants nothing, so the handler raises and
    leaves the Stripe event unmarked for redelivery. The log line is what says
    a webhook was abandoned on purpose, which is why it lives here rather than
    in invites, whose other callers do not retry.
    """
    try:
        return invites.live_scope(client=client, tier=tier, context=context)
    except invites.TierScopeEmpty:
        log.error("no libraries resolved for %s tier %s; aborting for retry", tier, context)
        raise


def restore_access(*, email: str, customer_id: str | None, tier: str | None) -> bool:
    """Re-invite a paid-up member who holds no Wizarr records; True when one was sent.

    A payment landing on a member with nothing to extend is the shape of the
    worst failure this bridge has: they are paid, they are locked out, and the
    only trace used to be one WARNING line nobody reads. Their records can be
    gone because a lapsed window expired them out while an earlier invoice sat
    unpaid, or because the payment arrived on a second Stripe customer whose
    email never had records of its own. Either way the remedy is the same one
    an admin would press by hand (issue a tier-scoped invite and mail it), so
    the bridge does it itself and tells the operator it happened.
    """
    resolved = tiers.normalize_tier(tier)
    access = resolve_tier_scope(resolved, context=f"access recovery for {email}")
    code = invites.mint(client=client, tier=resolved, scope=access)["code"]
    if customer_id:
        store.upsert_pending(MAP_DB_PATH, customer_id, email, code, tier=resolved)
    else:
        store.upsert_pending_by_email(MAP_DB_PATH, email, code, tier=resolved)
    send_invite_email(email, f"{PUBLIC_INVITE_BASE}/j/{code}")
    log.error("payment for %s found no records; reissued %s invite %s", email, resolved, code)
    store.record_event(MAP_DB_PATH, email, "Access restored",
                       f"paid with no active records; {resolved} invite reissued")
    send_alert_email(*alerts.access_restored(email=email, tier=resolved))
    return True


def sync_payment_state(*, email: str | None, status: str) -> None:
    """Mirror a Stripe subscription status onto the member's dunning flag."""
    if email and status in store.PAYMENT_STATE_BY_STATUS:
        store.set_payment_state(MAP_DB_PATH, email, store.PAYMENT_STATE_BY_STATUS[status])


def _block_banned_checkout(*, email: str, tier: str, session_id: object,
                           customer_id: object) -> None:
    """Record and alert on a banned member's checkout; no invite, no access."""
    log.error("checkout %s by banned member %s; no invite issued", session_id, email)
    store.record_event(MAP_DB_PATH, email, "Checkout blocked",
                       f"banned member paid for {tier}; no invite issued")
    send_alert_email(*alerts.banned_checkout(email=email, tier=tier, session_id=session_id,
                                             customer_id=customer_id))


def _reset_existing_records(*, email: str, customer_id: object, access: dict) -> None:
    """Disable the records the new tier no longer covers and re-stamp the rest."""
    # Existing access survives the invite window: redeeming re-scopes the
    # share in place on every covered server. Disable-first only when the
    # new tier leaves a current server uncovered (no per-server unshare),
    # or when the member is only findable via the invite-code fallback
    # (Plex email differs, so coverage can't be evaluated — fail closed).
    records = client.find_users_by_email(email)
    if records:
        existing = tiers.stale_record_ids(
            records=records, covered_servers=access["server_names"])
    else:
        existing = resolve_user_ids(client=client, store_path=MAP_DB_PATH,
                                    customer_id=customer_id, email=email)
    for uid in existing:
        client.disable_user(uid)
    if existing:
        log.info("reset %d existing record(s) for %s pending re-join",
                 len(existing), email)
    # Covered records keep access without ever redeeming the new invite,
    # so the purchase itself must stamp the paid expiry — otherwise a
    # shorter pre-signup window (e.g. the 14-day Invited backfill) would
    # survive the checkout.
    disabled = set(existing)
    surviving = [r["id"] for r in records if r["id"] not in disabled]
    expires = access_expiry_iso()
    for uid in surviving:
        client.set_expiry(uid, expires)
    if surviving:
        log.info("stamped expiry %s on %d surviving record(s) for %s",
                 expires, len(surviving), email)


def _on_checkout_completed(obj: dict) -> None:
    """Mint and mail the tier invite for a completed checkout, once per session."""
    email = (obj.get("customer_details") or {}).get("email") or obj.get("customer_email")
    customer_id = obj.get("customer")
    if not email:
        log.warning("no email on session %s", obj.get("id"))
        return
    session_id = obj.get("id")
    tier = tiers.normalize_tier((obj.get("metadata") or {}).get("tier"))
    tag = store.get_member_tag(MAP_DB_PATH, email)
    # A banned address can still reach a Payment Link. Nothing is issued
    # and nothing is recorded against the customer; the operator is told,
    # because the charge itself went through and is theirs to refund.
    if tag == "banned":
        _block_banned_checkout(email=email, tier=tier, session_id=session_id,
                               customer_id=customer_id)
        return
    access = resolve_tier_scope(tier, context=f"checkout {session_id}")
    # Everything below the invite can raise (a slow Wizarr write, SMTP), and
    # a raise leaves the event unmarked so Stripe retries the whole handler.
    # The session -> invite binding is what stops that retry from minting a
    # second invite and mailing the member a second link.
    issued = store.get_session_invite(MAP_DB_PATH, session_id) if session_id else None
    if issued:
        code = issued["invite_code"]
        log.info("checkout %s already has invite %s; reusing it", session_id, code)
    else:
        code = invites.mint(client=client, tier=tier, scope=access)["code"]
        if session_id:
            store.record_session_invite(MAP_DB_PATH, session_id, code)
    if customer_id:
        store.upsert_pending(MAP_DB_PATH, customer_id, email, code, tier=tier)
    # A completed checkout settles whatever failed on the previous cycle.
    store.set_payment_state(MAP_DB_PATH, email, None)
    if not (issued and issued["emailed"]):
        send_invite_email(email, f"{PUBLIC_INVITE_BASE}/j/{code}")
        log.info("sent invite to %s", email)
        if session_id:
            store.mark_session_invite_emailed(MAP_DB_PATH, session_id)
        store.record_event(MAP_DB_PATH, email, "Signed up",
                           f"{tier} tier — invite emailed")
        # Inside the once-per-checkout branch on purpose: a Stripe retry of
        # a session whose invite already went out must not mail twice.
        _signup_alert(email=email, tier=tier, session=obj, code=code)
    # VIP access is never time-boxed or reshuffled — a VIP's checkout is
    # just a contribution, so their records stay exactly as they are (no
    # disable, no expiry stamp).
    if tag == "vip":
        log.info("%s is VIP — existing records left untouched", email)
        return
    _reset_existing_records(email=email, customer_id=customer_id, access=access)


def _on_invoice_paid(obj: dict) -> None:
    """Extend a renewal's access, or restore it when the payer holds no records."""
    customer_id = obj["customer"]
    email = obj.get("customer_email") or customer_email(customer_id)
    # A paid invoice settles any dunning, including the signup one that is
    # otherwise skipped below. A retry that finally succeeds is exactly
    # the case this flag exists to close out.
    if email:
        store.set_payment_state(MAP_DB_PATH, email, None)
    if obj.get("billing_reason") == "subscription_create":
        log.info("skipping first (signup) invoice for %s", obj.get("customer"))
        return
    tag = store.get_member_tag(MAP_DB_PATH, email) if email else None
    # A ban outranks a payment: nothing is extended and nothing restored.
    if email and tag == "banned":
        log.warning("renewal: %s is banned; access not extended", email)
        store.record_event(MAP_DB_PATH, email, "Payment received",
                           "banned; access not extended")
        return
    if email:
        store.set_subscribed(MAP_DB_PATH, email, True)
    # VIP access is never time-boxed — acknowledge the payment, leave expiry alone.
    if email and tag == "vip":
        log.info("renewal: %s is VIP — expiry untouched", email)
        store.record_event(MAP_DB_PATH, email, "Payment received",
                           "VIP — expiry untouched")
        return
    ids = resolve_user_ids(client=client, store_path=MAP_DB_PATH,
                           customer_id=customer_id, email=email)
    expires = access_expiry_iso()
    for uid in ids:
        client.set_expiry(uid, expires)
    if ids:
        log.info("renewed %d record(s) for %s (expires %s)", len(ids), email, expires)
        store.record_event(MAP_DB_PATH, email, "Payment received",
                           f"access extended to {expires[:10]}")
    elif email:
        # Paid, but nothing to extend. Never leave this as a log line: the
        # member is locked out right now and only a new invite fixes it.
        row = store.customer_row(MAP_DB_PATH, email)
        restore_access(email=email, customer_id=customer_id,
                       tier=row["tier"] if row else None)
    else:
        log.warning("renewal: no wizarr user for %s / %s", customer_id, email)


def _on_payment_failed(obj: dict) -> None:
    """Flag the payer as past due and alert; access is held while Stripe retries."""
    # Stripe retries a failed charge for weeks before giving up. Access is
    # deliberately untouched for that whole window (they have paid for the
    # period they are in), but the admin UI stops calling them healthy, so
    # a member in dunning is visible before their window runs out.
    customer_id = obj.get("customer")
    email = obj.get("customer_email") or customer_email(customer_id)
    if not email:
        log.warning("payment failed for %s with no resolvable email", customer_id)
        return
    store.set_payment_state(MAP_DB_PATH, email, "past_due")
    log.warning("payment failed for %s (invoice %s)", email, obj.get("id"))
    store.record_event(MAP_DB_PATH, email, "Payment failed",
                       f"Stripe charge declined; access held while it retries "
                       f"({alerts.describe_invoice(obj)})")
    _payment_failed_alert(email=email, invoice=obj)


def _on_subscription_updated(obj: dict) -> None:
    """Mirror the subscription's new status onto the member's dunning flag."""
    customer_id = obj.get("customer")
    status = obj.get("status") or ""
    m = store.get_mapping(MAP_DB_PATH, customer_id) if customer_id else None
    email = (m and m["email"]) or (customer_email(customer_id) if customer_id else None)
    sync_payment_state(email=email, status=status)
    log.info("subscription for %s is %s", email, status)


def _on_subscription_deleted(obj: dict) -> None:
    """Disable the member's records, unless somebody still pays for them."""
    customer_id = obj["customer"]
    m = store.get_mapping(MAP_DB_PATH, customer_id)
    email = (m and m["email"]) or customer_email(customer_id)
    # This customer really did stop, but the person behind it may not
    # have: a second customer at the same address (they re-checked out
    # from scratch), or a linked second address (they pay under another
    # email). subscribed and payment_state are per email, so they only
    # move when nothing of theirs at this address still pays.
    sibling = (live_sibling_customer(
        db_path=MAP_DB_PATH, email=email, dead_customer=customer_id) if email else None)
    if email and sibling:
        store.set_payment_state(MAP_DB_PATH, email, None)
    elif email:
        store.set_subscribed(MAP_DB_PATH, email, False)
    # A VIP's access is a standing grant, not something the subscription
    # buys. The renewal handler already leaves their expiry alone and the
    # sweep skips them; disabling them here undid both.
    if email and store.get_member_tag(MAP_DB_PATH, email) == "vip":
        log.info("cancel: %s is VIP; access left alone", email)
        store.record_event(MAP_DB_PATH, email, "Canceled",
                           "subscription ended; access kept, VIP")
        return
    paying = sibling or (still_subscribed_elsewhere(MAP_DB_PATH, email) if email else None)
    if paying:
        log.info("cancel: %s still pays under %s; access left alone", email, paying)
        store.record_event(
            MAP_DB_PATH, email, "Canceled",
            f"subscription ended; access kept, still paying under {paying}")
        return
    ids = resolve_user_ids(client=client, store_path=MAP_DB_PATH,
                           customer_id=customer_id, email=email)
    for uid in ids:
        client.disable_user(uid)
    if ids:
        log.info("disabled %d record(s) for %s", len(ids), email)
    else:
        log.info("cancel: no wizarr user for %s / %s", customer_id, email)
    if email:
        store.record_event(MAP_DB_PATH, email, "Canceled",
                           f"subscription ended — {len(ids)} server record(s) disabled")


# Every event type the bridge acts on. A type missing from the table falls
# through handle_event untouched and is still marked processed, so Stripe
# stops redelivering it.
_HANDLERS = {
    "checkout.session.completed": _on_checkout_completed,
    "invoice.paid": _on_invoice_paid,
    "invoice.payment_failed": _on_payment_failed,
    "customer.subscription.updated": _on_subscription_updated,
    "customer.subscription.deleted": _on_subscription_deleted,
}


def handle_event(event: dict) -> None:
    """Act on one Stripe event: checkout -> invite, renewal -> extend, cancel -> disable.

    Duplicate deliveries (Stripe retries) are dropped via the processed_events
    table. The event is only marked processed after the type-specific handling
    below completes without raising, so a crash mid-handler (e.g. Wizarr
    unreachable, no libraries resolved) leaves the event unmarked and Stripe's
    retry reprocesses it instead of the signup being silently lost.
    """
    event_id = event.get("id")
    if event_id and store.is_event_processed(MAP_DB_PATH, event_id):
        log.info("skipping already-processed event %s", event_id)
        return

    etype = event["type"]
    obj = event["data"]["object"]
    log.info("stripe event: %s", etype)

    handler = _HANDLERS.get(etype)
    if handler:
        handler(obj)

    if event_id:
        store.mark_event_processed(MAP_DB_PATH, event_id)


# Public URL is /stripe/webhook. Tailscale Funnel mounts the bridge with
# --set-path=/stripe and strips that prefix, so behind Funnel the request
# arrives as /webhook. Accept both paths so direct/local calls (README,
# `stripe listen`) and Funnel-proxied calls hit the same handler.
@app.post("/stripe/webhook")
@app.post("/webhook")
async def stripe_webhook(request: Request, stripe_signature: str = Header(None)):
    """Verify the Stripe signature, then hand the parsed event to handle_event."""
    payload = await request.body()
    try:
        stripe.Webhook.construct_event(payload, stripe_signature, STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(400, "invalid signature")
    # construct_event returns a StripeObject (no dict .get); the verified raw
    # payload is the same bytes, so decode it into a plain dict for handling.
    handle_event(json.loads(payload))
    return {"ok": True}
