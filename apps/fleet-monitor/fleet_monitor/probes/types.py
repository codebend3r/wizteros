from dataclasses import dataclass
from typing import Literal

Kind = Literal["gauge", "counter"]


@dataclass(frozen=True, slots=True)
class Sample:
    """One measurement. Deliberately carries no timestamp: probes are pure and
    never read the clock, so the collector stamps samples on arrival."""

    metric: str
    value: float
    kind: Kind


@dataclass(frozen=True, slots=True)
class ProbeFailure:
    """A named reason a probe produced nothing. Distinct from an empty result,
    so 'not collected' is never rendered as healthy."""

    source: str
    reason: str
