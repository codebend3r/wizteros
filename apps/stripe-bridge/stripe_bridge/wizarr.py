import logging
import re

import requests

log = logging.getLogger("bridge.wizarr")

# Per-user writes reconcile with the Plex server the record lives on, so they
# are as slow as /api/users itself. A 10s ceiling used to time out mid-loop and
# leave a checkout half-applied while the write still landed server-side.
USER_WRITE_TIMEOUT = 45

# Wizarr does not take an arbitrary expiry. Its API routes expires_in_days
# through a fixed lookup ({1: "day", 7: "week", 30: "month"} in
# app/blueprints/api/api_routes.py) and falls back to "never" for anything
# else. So an unhonored number does not shorten the invite, it removes the
# expiry altogether, and the link stays redeemable for good.
EXPIRY_DAYS_HONORED = (1, 7, 30)


def honored_expiry_days(days: int) -> int:
    """The shortest expiry Wizarr honors that is still no shorter than `days`.

    Snapping up rather than down: a window that is too short can kill a paying
    member's invite before they ever redeem it, whereas one that is too long
    only delays the backstop. Past the largest honored value there is no finite
    choice left, so that one is used instead of decaying into "never".
    """
    return next((d for d in EXPIRY_DAYS_HONORED if d >= days), EXPIRY_DAYS_HONORED[-1])


# Wizarr marshals an invitation's used_by as fields.String over a User
# relationship with no __str__, so the live API returns the repr "<User 281>"
# rather than a name. The number is the redeeming record's id. The username
# path stays for a Wizarr that one day serializes a real username.
_USED_BY_REPR = re.compile(r"\s*<User (\d+)>\s*")


def redeemer_record(*, invitation: dict, users: list) -> dict | None:
    """The user record that redeemed `invitation`, or None when nothing resolves.

    Resolves either shape Wizarr can put in used_by: the "<User N>" repr, whose
    number is the record id, or a plain username. Returns None for an
    unredeemed invitation and for a redeemer who is no longer on the server,
    so a dead id is never handed back to a caller that writes with it.
    """
    used_by = invitation.get("used_by")
    if not isinstance(used_by, str) or not used_by:
        return None
    match = _USED_BY_REPR.fullmatch(used_by)
    if match:
        record_id = int(match.group(1))
        return next((u for u in users if u.get("id") == record_id), None)
    return next((u for u in users
                 if (u.get("username") or "").lower() == used_by.lower()), None)


def redeemer_email(*, invitation: dict, users: list) -> str | None:
    """The lowercased email of the record that redeemed `invitation`.

    None when the invitation is unredeemed, when the redeeming record is gone,
    or when that record carries no email of its own (a local Plex account).
    """
    record = redeemer_record(invitation=invitation, users=users)
    return ((record or {}).get("email") or "").lower() or None


class WizarrClient:
    """Thin wrapper around the Wizarr REST API used by the bridge."""

    def __init__(self, base_url: str, api_key: str):
        """Store the API location and key; rstrip avoids "//" when building URLs."""
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self) -> dict:
        """Auth and content-type headers every API call needs."""
        return {"X-API-Key": self.api_key, "Content-Type": "application/json"}

    def list_libraries(self) -> list:
        """All libraries Wizarr knows (id, name, server_id, server_name, enabled)."""
        r = requests.get(
            f"{self.base_url}/api/libraries",
            headers=self._headers(),
            timeout=10,
        )
        r.raise_for_status()
        return r.json().get("libraries", [])

    def create_invite(self, server_ids, expires_in_days: int, duration,
                      unlimited: bool = False, library_ids=None,
                      allow_downloads: bool = False) -> dict:
        """Create an invite for the given servers; return just its code and url.

        library_ids=None leaves scoping to Wizarr's defaults; a list scopes the
        invite to exactly those libraries.

        expires_in_days is snapped to a value Wizarr honors before it is sent,
        because the API turns every other number into an invite that never
        expires rather than rejecting it.
        """
        expires = honored_expiry_days(expires_in_days)
        if expires != expires_in_days:
            log.warning(
                "wizarr honors an expiry of %s days only, so %d was snapped up to "
                "%d; the invite expires rather than living forever",
                ", ".join(str(d) for d in EXPIRY_DAYS_HONORED),
                expires_in_days, expires)
        payload = {
            "server_ids": list(server_ids),
            "expires_in_days": expires,
            "duration": duration,
            "unlimited": unlimited,
            "allow_downloads": allow_downloads,
        }
        if library_ids is not None:
            payload["library_ids"] = list(library_ids)
        r = requests.post(
            f"{self.base_url}/api/invitations",
            headers=self._headers(),
            json=payload,
            timeout=10,
        )
        r.raise_for_status()
        inv = r.json()["invitation"]
        return {"code": inv["code"], "url": inv["url"]}

    def list_invitations(self) -> list:
        """Every invitation Wizarr holds, used and unused alike.

        Callers must read scope from server_names, never specific_libraries:
        the serializer reports specific_libraries as [] even for a correctly
        scoped invite, so it cannot tell a scoped invite from an unscoped one.
        """
        r = requests.get(
            f"{self.base_url}/api/invitations",
            headers=self._headers(),
            timeout=10,
        )
        r.raise_for_status()
        return r.json().get("invitations", [])

    def delete_invitation(self, invitation_id: int) -> None:
        """Delete one invitation by its numeric id (not its code)."""
        r = requests.delete(
            f"{self.base_url}/api/invitations/{invitation_id}",
            headers=self._headers(),
            timeout=10,
        )
        r.raise_for_status()

    def _users(self, params: dict) -> list:
        """Query /api/users with the given filters and return the user list."""
        # /api/users is slow (Wizarr reconciles with each Plex server per call),
        # routinely ~15s, so allow generous headroom.
        r = requests.get(
            f"{self.base_url}/api/users",
            headers=self._headers(),
            params=params,
            timeout=45,
        )
        r.raise_for_status()
        return r.json().get("users", [])

    def list_users(self) -> list:
        """Every user record Wizarr knows (one per person per server)."""
        return self._users({})

    def find_users_by_email(self, email: str) -> list[dict]:
        """All user records for an email (one record per server)."""
        return [u for u in self._users({"email": email})
                if (u.get("email") or "").lower() == email.lower()]

    def find_user_ids_by_email(self, email: str) -> list[int]:
        """All record ids for an email (one record per server)."""
        return [u["id"] for u in self.find_users_by_email(email)]

    def find_user_ids_by_invite(self, code: str) -> list[int]:
        """All record ids for the Plex account that redeemed the invite.

        Fallback for when the Stripe email differs from the Plex account email.
        """
        r = requests.get(
            f"{self.base_url}/api/invitations",
            headers=self._headers(),
            timeout=10,
        )
        r.raise_for_status()
        invitation = next(
            (inv for inv in r.json().get("invitations", []) if inv.get("code") == code),
            None,
        )
        if not (invitation or {}).get("used_by"):
            return []
        users = self._users({})
        record = redeemer_record(invitation=invitation, users=users)
        if record is None:
            return []
        email = (record.get("email") or "").lower()
        # A record with no email cannot fan out to its sibling servers; the one
        # record that redeemed the invite is still the right thing to act on.
        if not email:
            return [record["id"]]
        return [u["id"] for u in users if (u.get("email") or "").lower() == email]

    def set_expiry(self, user_id: int, expires_iso: str | None) -> None:
        """Set a record's expiry to an absolute ISO datetime, or None to clear it.

        Wizarr validates the body against its schema (expires: date-time
        string), so a literal null is rejected with a 400 — clearing to
        unlimited must omit the key entirely.
        """
        r = requests.put(
            f"{self.base_url}/api/users/{user_id}/update-expiry",
            headers=self._headers(),
            json={} if expires_iso is None else {"expires": expires_iso},
            timeout=USER_WRITE_TIMEOUT,
        )
        r.raise_for_status()

    def disable_user(self, user_id: int) -> None:
        """Disable (not delete) a user record so its access stops."""
        r = requests.post(
            f"{self.base_url}/api/users/{user_id}/disable",
            headers=self._headers(),
            timeout=USER_WRITE_TIMEOUT,
        )
        r.raise_for_status()
