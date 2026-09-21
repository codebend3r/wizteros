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
