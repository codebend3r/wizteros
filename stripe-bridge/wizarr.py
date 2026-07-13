import requests


class WizarrClient:
    def __init__(self, base_url: str, api_key: str, server_id: int):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.server_id = server_id

    def _headers(self) -> dict:
        return {"X-API-Key": self.api_key, "Content-Type": "application/json"}

    def create_invite(self, expires_in_days: int, duration, unlimited: bool = False) -> dict:
        r = requests.post(
            f"{self.base_url}/api/invitations",
            headers=self._headers(),
            json={
                "server_ids": [self.server_id],
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
        r = requests.get(
            f"{self.base_url}/api/users",
            headers=self._headers(),
            params=params,
            timeout=10,
        )
        r.raise_for_status()
        return r.json().get("users", [])

    def find_user_id_by_email(self, email: str) -> int | None:
        for u in self._users({"email": email}):
            return u["id"]
        return None

    def find_user_id_by_invite(self, code: str) -> int | None:
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
            return None
        for u in self._users({"username": used_by}):
            return u["id"]
        return None

    def extend_user(self, user_id: int, days: int) -> None:
        r = requests.post(
            f"{self.base_url}/api/users/{user_id}/extend",
            headers=self._headers(),
            json={"days": days},
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
