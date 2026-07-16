import requests


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

    def find_user_ids_by_email(self, email: str) -> list[int]:
        """All record ids for an email (one record per server)."""
        return [u["id"] for u in self._users({"email": email})
                if (u.get("email") or "").lower() == email.lower()]

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
        return [u["id"] for u in self._users({"username": used_by})]

    def set_expiry(self, user_id: int, expires_iso: str) -> None:
        """Set a record's expiry to an absolute ISO datetime (not additive)."""
        r = requests.put(
            f"{self.base_url}/api/users/{user_id}/update-expiry",
            headers=self._headers(),
            json={"expires": expires_iso},
            timeout=10,
        )
        r.raise_for_status()

    def disable_user(self, user_id: int) -> None:
        """Disable (not delete) a user record so its access stops."""
        r = requests.post(
            f"{self.base_url}/api/users/{user_id}/disable",
            headers=self._headers(),
            timeout=10,
        )
        r.raise_for_status()
