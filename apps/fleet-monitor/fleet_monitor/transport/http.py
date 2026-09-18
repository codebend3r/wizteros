from dataclasses import dataclass

import httpx


@dataclass(frozen=True, slots=True)
class HttpResult:
    ok: bool
    status: int
    body: str
    reason: str


def _classify(error: Exception) -> str:
    """Name why a request failed. A refused socket-proxy connection and a
    genuine DNS miss must never look identical to the incident machine."""
    if isinstance(error, httpx.ConnectTimeout | httpx.ReadTimeout):
        return "timeout"
    if isinstance(error, httpx.ConnectError):
        text = str(error)
        if "Name or service not known" in text or "nodename nor servname" in text:
            return "dns"
        return "refused"
    return "transport_error"


async def get_json(
    url: str,
    *,
    timeout: float = 8.0,
    headers: dict[str, str] | None = None,
    verify: bool = True,
) -> HttpResult:
    """GET a URL, never raising. A dead endpoint degrades that target only.

    `verify` is off only for the two Plex servers that insist on https: they
    present Plex's *.plex.direct wildcard certificate on a LAN ip, which no
    verifier can accept, and the owner token is what authorizes the request
    on either transport. Everything else keeps the default.
    """
    try:
        async with httpx.AsyncClient(timeout=timeout, verify=verify) as client:
            response = await client.get(url, headers=headers or {})
    except Exception as error:
        return HttpResult(ok=False, status=0, body="", reason=_classify(error))

    ok = 200 <= response.status_code < 300
    return HttpResult(
        ok=ok,
        status=response.status_code,
        body=response.text,
        reason="" if ok else f"http_{response.status_code}",
    )
