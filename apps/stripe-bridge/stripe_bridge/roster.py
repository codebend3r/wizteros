"""Building the members list out of what Wizarr, Stripe and the store each know.

Pure functions of their arguments: no HTTP, no database, no snapshot. The
admin router does the reading and hands the four sources in, which is what
lets the list endpoint serve them from its warm snapshot while the member page
fetches the same shapes live.
"""

from typing import NotRequired, TypedDict

from stripe_bridge import tiers
from stripe_bridge.store import CustomerRow
from stripe_bridge.wizarr import redeemer_email


class Member(TypedDict):
    """One row of the members list: a person, not a Wizarr record.

    servers and libraries are what they hold right now; entitled is what
    their tier grants, which is what makes the two comparable on the member
    page. stripe_email is set only when they pay under a different address
    than their Plex account uses, and tag is stamped on later by
    with_overrides rather than assembled here.
    """

    member: str
    email: str
    tier: str
    downloads: bool | None
    expires: str | None
    servers: list[str]
    libraries: dict[str, list[str]]
    entitled: dict[str, list[str]]
    subscribed: bool
    payment_state: str | None
    invited_at: str | None
    customer_id: str | None
    stripe_email: str | None
    tag: NotRequired[str | None]


def plex_email_by_invite(*, invitations: list, users: list) -> dict[str, str]:
    """Invite code -> the Plex account email that redeemed it, both lowercased.

    This is the only link between a Stripe customer and a member who signed up
    to Plex under a different address. The bridge issues the invite against the
    checkout email; whoever redeems it is the person paying, whatever their
    Plex account is called.
    """
    resolved = {
        (invitation.get("code") or "").lower():
            redeemer_email(invitation=invitation, users=users)
        for invitation in invitations
    }
    return {code: email for code, email in resolved.items() if code and email}


def customer_by_plex_email(*, customers: dict[str, CustomerRow],
                           plex_email_by_invite: dict,
                           manual_links: dict | None = None) -> dict[str, dict]:
    """Plex email -> the Stripe customer row belonging to that person.

    Only rows whose email differs from the Plex email they resolve to are
    returned: a matching pair needs no linking, and keeping the map to real
    mismatches means the caller can treat a hit as "these are two addresses for
    one person" without re-comparing.

    Two sources, manual first. The redeemed invite answers on its own for
    anyone who signed up through their own checkout. It cannot answer for
    someone who re-subscribed under a re-typed address while already holding
    access: that invite is never redeemed, so `used_by` stays null and the
    paying customer keeps standing as a second member. `member_links` is the
    admin's answer for those, and it is marked so callers can tell a stated
    link from an inferred one.
    """
    linked: dict[str, dict] = {}
    for customer_email, row in customers.items():
        code = (row.get("invite_code") or "").lower()
        manual = (manual_links or {}).get(customer_email)
        plex_email = manual or (plex_email_by_invite.get(code) if code else None)
        if plex_email and plex_email != customer_email:
            linked[plex_email] = {**row, "stripe_email": customer_email,
                                  "manual_link": bool(manual)}
    return linked


def dedupe_members(users: list, customers: dict[str, CustomerRow], libraries: list,
                   linked: dict | None = None) -> list[Member]:
    """Collapse per-server Wizarr records into one entry per person.

    Key is the lowercased email (falling back to username). Aggregates the
    servers a person appears on and keeps the latest expiry across records.
    Tier and invited_at are joined from the bridge's store; downloads and
    per-server library access derive from tier.
    """
    people: dict[str, dict] = {}
    for u in users:
        email = (u.get("email") or "").strip()
        username = u.get("username") or ""
        key = (email or username).lower()
        if not key:
            continue
        person = people.setdefault(key, {
            "member": username, "email": email, "servers": [], "expires": None,
        })
        server = u.get("server")
        if server and server not in person["servers"]:
            person["servers"].append(server)
        exp = u.get("expires")
        if exp and (person["expires"] is None or exp > person["expires"]):
            person["expires"] = exp

    members = []
    for person in people.values():
        key = person["email"].lower() if person["email"] else ""
        # Their own address first; the invite linkage only answers for members
        # whose Plex account is under a different email than they pay with.
        # A manual link outranks even that: "they pay under X" is only ever
        # stated about someone whose own address is the dead or failing one,
        # so billing has to read from the customer the admin pointed at.
        link = (linked or {}).get(key) or {}
        if link.get("manual_link"):
            row = link
        elif key in customers:
            row = customers[key]
        else:
            row = link
        tier = tiers.canonical_tier(row.get("tier")) or "unknown"
        downloads = tiers.TIER_DOWNLOADS.get(tier) if tier != "unknown" else None
        servers = sorted(person["servers"])
        tier_libraries = tiers.tier_server_libraries(tier=tier, libraries=libraries)
        members.append({
            "member": person["member"],
            "email": person["email"],
            "tier": tier,
            "downloads": downloads,
            "expires": person["expires"],
            "servers": servers,
            "libraries": {server: tier_libraries.get(server, []) for server in servers},
            # The tier rules alone, NOT narrowed to the servers this member
            # happens to hold records on — that is what makes it comparable to
            # the live plex.tv share, which is how the member page tells
            # "entitled to" apart from "actually sharing".
            "entitled": tier_libraries,
            "subscribed": bool(row.get("subscribed")),
            "payment_state": row.get("payment_state"),
            "invited_at": row.get("invited_at"),
            "customer_id": row.get("customer_id"),
            # Only set when the member pays under a different address than
            # their Plex account uses. Equal addresses are the norm and would
            # just be the same string twice in the UI.
            "stripe_email": row.get("stripe_email"),
        })
    members.sort(key=lambda m: m["member"].lower())
    return members


def member_from_customer(email: str, row: CustomerRow, libraries: list) -> Member:
    """A table row for a subscriber the bridge knows who hasn't joined Wizarr yet.

    Their tier is known, so `entitled` (what redeeming would grant them) is
    known too and the member page can render a real Servers section instead of
    an empty one. `servers` and `libraries` stay empty on purpose: this member
    holds no Wizarr record, and the only other thing that could give them
    access is a live plex.tv share, which with_plex_access unions in
    afterwards. Filling them from the tier instead is how a locked-out member
    came to read "1 server, 19 libraries" on /manage while they could not
    watch anything at all.
    """
    resolved = tiers.canonical_tier(row.get("tier")) or "unknown"
    tier_libraries = tiers.tier_server_libraries(tier=resolved, libraries=libraries)
    return {
        "member": email.split("@")[0],
        "email": email,
        "tier": resolved,
        "downloads": tiers.TIER_DOWNLOADS.get(resolved) if resolved != "unknown" else None,
        "expires": None,
        "servers": [],
        "libraries": {},
        "entitled": tier_libraries,
        "subscribed": bool(row.get("subscribed")),
        "payment_state": row.get("payment_state"),
        "invited_at": row.get("invited_at"),
        "customer_id": row.get("customer_id"),
        # Nothing to contrast with: this row IS the Stripe address, and no
        # Plex account has claimed it yet.
        "stripe_email": None,
    }


def with_plex_access(members: list[Member], *, access: dict | None) -> list[Member]:
    """Union each member's live plex.tv share into their servers and libraries.

    plex.tv is ground truth for what a member can actually see: it covers
    legacy shares that never went through an invite, and members whose tier
    was never recorded (whose tier-derived library list is empty). access is
    the bulk lookup from _fetch_upstream; None (no token, or plex.tv failed)
    leaves the tier-derived values in place rather than failing the whole list.
    """
    if access is None:
        return members
    merged = []
    for member in members:
        shares = access.get(member["email"].lower()) if member["email"] else None
        if not shares:
            merged.append(member)
            continue
        servers = sorted({*member["servers"], *shares})
        merged.append({
            **member,
            "servers": servers,
            "libraries": {
                server: (shares[server]["libraries"] if server in shares
                         else member["libraries"].get(server, []))
                for server in servers
            },
        })
    return merged


def with_overrides(members: list[Member], *, tags: dict, downloads: dict) -> list[Member]:
    """Stamp each member dict with its admin overrides.

    tag: the manual designation ("vip"/"hvu"), None untagged. downloads: the
    admin's toggle wins over the tier-derived value when set.
    """
    return [
        {
            **m,
            "tag": tags.get(m["email"].lower()),
            "downloads": downloads.get(m["email"].lower(), m["downloads"]),
        }
        for m in members
    ]


def assemble_members(*, users: list, libraries: list, invitations: list,
                     customers: dict[str, CustomerRow], links: dict) -> list[Member]:
    """Every member the two sources know, as one list sorted by name.

    Wizarr's user list only holds people who redeemed an invite, so subscribers
    still sitting on a pending one are unioned in from the bridge's customer
    map. A customer already shown as someone else's Stripe address is left out
    of that union: standing as its own row as well is the "two entries for one
    person" the linkage exists to collapse.
    """
    linked = customer_by_plex_email(
        customers=customers,
        plex_email_by_invite=plex_email_by_invite(invitations=invitations, users=users),
        manual_links=links,
    )
    members = dedupe_members(users, customers, libraries, linked=linked)
    joined = {m["email"].lower() for m in members if m["email"]}
    claimed = {m["stripe_email"] for m in members if m.get("stripe_email")}
    pending = [
        member_from_customer(email, row, libraries)
        for email, row in customers.items()
        if email not in joined and email not in claimed
    ]
    return sorted(members + pending, key=lambda m: m["member"].lower())
