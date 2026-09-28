"""Stripe-to-Wizarr bridge service.

No longer shipped: the NAS runs the NestJS port in apps/stripe-bridge-nest,
whose package.json is the version marker scripts/release.sh moves. This
`__version__` stays at the release the marker moved on, and the Python app
remains only as the reference the port's parity check diffs against.
"""

__version__ = "0.3.9"
