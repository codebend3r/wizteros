import re

import requests

# Per-user writes reconcile with the Plex server the record lives on, so they
# are as slow as /api/users itself. A 10s ceiling used to time out mid-loop and
# leave a checkout half-applied while the write still landed server-side.
USER_WRITE_TIMEOUT = 45


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
        """
        payload = {
            "server_ids": list(server_ids),
            "expires_in_days": expires_in_days,
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
        used_by = None
        for inv in r.json().get("invitations", []):
            if inv.get("code") == code:
                used_by = inv.get("used_by")
                break
        if not used_by:
            return []
        # Wizarr marshals used_by as fields.String over a User relationship
        # with no __str__, so the live API returns the repr "<User 281>". The
        # number is the redeeming record's id; resolve it to that record's
        # email so sibling-server records are covered too. The username path
        # stays for a Wizarr that one day serializes a real username.
        repr_match = re.fullmatch(r"\s*<User (\d+)>\s*", used_by) if isinstance(used_by, str) else None
        if not repr_match:
            return [u["id"] for u in self._users({"username": used_by})]
        record_id = int(repr_match.group(1))
        users = self._users({})
        record = next((u for u in users if u.get("id") == record_id), None)
        if record is None:
            return []
        email = record.get("email")
        if not email:
            return [record_id]
        return [u["id"] for u in users
                if (u.get("email") or "").lower() == email.lower()]

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
