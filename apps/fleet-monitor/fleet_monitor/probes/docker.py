from collections.abc import Iterable
from dataclasses import dataclass

from fleet_monitor.probes.types import Sample


@dataclass(frozen=True, slots=True)
class ContainerState:
    name: str
    running: bool
    health: str
    restart_count: int
    started_at: str


def _health(status: str) -> str:
    if "(healthy)" in status:
        return "healthy"
    if "(unhealthy)" in status:
        return "unhealthy"
    return "none"


def parse_containers(payload: list[dict]) -> tuple[ContainerState, ...]:
    """Container state from GET /containers/json?all=1.

    A malformed entry is skipped rather than raised on: one bad row must not
    cost the whole host's container view.
    """
    named = [
        (entry, entry.get("Names") or [])
        for entry in payload
        if isinstance(entry, dict)
    ]
    return tuple(
        ContainerState(
            name=names[0].lstrip("/"),
            running=entry.get("State") == "running",
            health=_health(entry.get("Status", "")),
            restart_count=entry.get("RestartCount", 0),
            started_at=entry.get("StartedAt", ""),
        )
        for entry, names in named
        if names and isinstance(names[0], str)
    )


def to_samples(states: Iterable[ContainerState]) -> tuple[Sample, ...]:
    """Up, health, and restart-count gauges, one triple per container."""
    return tuple(
        sample
        for state in states
        for sample in (
            Sample(
                metric=f"container.{state.name}.up",
                value=1.0 if state.running else 0.0,
                kind="gauge",
            ),
            Sample(
                metric=f"container.{state.name}.healthy",
                value=1.0 if state.health in {"healthy", "none"} and state.running else 0.0,
                kind="gauge",
            ),
            Sample(
                metric=f"container.{state.name}.restart_count",
                value=float(state.restart_count),
                kind="counter",
            ),
        )
    )
