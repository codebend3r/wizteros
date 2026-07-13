import requests


class WizarrClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self) -> dict:
        return {"X-API-Key": self.api_key, "Content-Type": "application/json"}

    def list_server_ids(self) -> list:
        """Return the ids of all verified media servers."""
        r = requests.get(
            f"{self.base_url}/api/servers",
            headers=self._headers(),
            timeout=10,
        )
        r.raise_for_status()
        return [s["id"] for s in r.json().get("servers", []) if s.get("verified")]

    def create_invite(self, server_ids, expires_in_days: int, duration, unlimited: bool = False) -> dict:
        r = requests.post(
            f"{self.base_url}/api/invitations",
            headers=self._headers(),
            json={
                "server_ids": list(server_ids),
                "expires_in_days": expires_in_days,
                "duration": duration,
                "unlimited": unlimited,
            },
            timeout=10,
        )
        r.raise_for_status()
        inv = r.json()["invitation"]
        return {"code": inv["code"], "url": inv["url"]}

    def _users(self, params: dict) -> list:
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
        r = requests.post(
            f"{self.base_url}/api/users/{user_id}/disable",
            headers=self._headers(),
            timeout=10,
        )
        r.raise_for_status()
