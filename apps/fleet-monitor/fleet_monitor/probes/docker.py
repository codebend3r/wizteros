from collections.abc import Iterable
from dataclasses import dataclass

from fleet_monitor.probes.types import Sample


@dataclass(frozen=True, slots=True)
class ContainerState:
    """restart_count and started_at are not populated by GET /containers/json:
    that list endpoint never returns them, only `docker inspect` does. They
    stay at their defaults (0, "") until a future inspect-based enrichment
    exists. Do not derive a sample from either field until then - a metric
    that reads a constant is worse than no metric at all."""

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

    An entry whose first name is empty is skipped too. It would yield metrics
    shaped `container..up`, which the web's container pattern cannot match, and
    an incident against `container:<host>/` - an invisible container carrying an
    invisible incident.
    """
    named = [
        (entry, entry.get("Names") or [])
        for entry in payload
        if isinstance(entry, dict)
    ]
    return tuple(
        ContainerState(
            name=name,
            running=entry.get("State") == "running",
            health=_health(entry.get("Status", "")),
            restart_count=entry.get("RestartCount") or 0,
            started_at=entry.get("StartedAt") or "",
        )
        for entry, names in named
        if names and isinstance(names[0], str)
        for name in (names[0].lstrip("/"),)
        if name
    )


def to_samples(states: Iterable[ContainerState]) -> tuple[Sample, ...]:
    """Up, health, and has_healthcheck gauges, one triple per container.

    `healthy` means a healthcheck ran and passed, nothing weaker. Most
    containers on this fleet declare no healthcheck at all, and folding that
    into `healthy` would assert a check passed that was never run; dropping the
    sample instead would read as failing one. So the third gauge carries
    whether there is a check to believe, and the UI says plain "Up" when there
    is not.

    No restart_count sample: GET /containers/json never returns RestartCount,
    so ContainerState.restart_count is always the default and a sample built
    from it would read as a constant zero forever, indistinguishable from a
    genuinely healthy container.
    """
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
                value=1.0 if state.health == "healthy" and state.running else 0.0,
                kind="gauge",
            ),
            Sample(
                metric=f"container.{state.name}.has_healthcheck",
                value=0.0 if state.health == "none" else 1.0,
                kind="gauge",
            ),
        )
    )
