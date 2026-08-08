"""Stripe-to-Wizarr bridge service.

`__version__` tracks the workspace release version and is bumped in lockstep
with the root and admin-portal package.json files by `scripts/release.sh`.
It is the only version marker that reaches the running container, so
`GET /version` is the authoritative answer to "what release is the NAS on".
"""

__version__ = "0.2.1"
