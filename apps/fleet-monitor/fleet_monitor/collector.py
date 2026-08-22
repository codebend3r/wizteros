import asyncio
import json
import logging
import sqlite3
from collections.abc import Callable, Iterable
from datetime import datetime, timezone

from fleet_monitor import config, db, incidents, rollups, store
from fleet_monitor.config import Host
from fleet_monitor.incidents import CheckResult
from fleet_monitor.probes import docker, proc, script, system
from fleet_monitor.probes.docker import ContainerState
from fleet_monitor.probes.types import Sample
from fleet_monitor.transport import http, ssh

log = logging.getLogger("fleet.collector")

# section name -> parser. Missing sections are skipped, never defaulted.
_PARSERS = {
    "stat": proc.parse_stat,
    "meminfo": proc.parse_meminfo,
    "netdev": proc.parse_net_dev,
    "loadavg": proc.parse_loadavg,
    "uptime": proc.parse_uptime,
    "gpu": system.parse_gpu_freq,
    "df": system.parse_df,
    "hwmon": system.parse_hwmon,
    "inotify": system.parse_inotify,
}

_SLOW_EVERY = config.SLOW_INTERVAL // config.VITALS_INTERVAL

# Transport reasons that mean nothing was observed rather than that the target
# failed. spawn_error is raised on this side of the wire - ssh missing from
# PATH, or the process out of file descriptors - so recording it as a failed
# host check would manufacture an outage on all five hosts at once, from a
# fault none of them have. Same contract the docker endpoint already follows.
_NOT_OBSERVED = frozenset({"spawn_error"})


def _section_samples(
    name: str, parser: Callable[[str], tuple[Sample, ...]], body: str
) -> tuple[Sample, ...]:
    """One section's samples, or none if its parser could not read it.

    The isolation is the point. Without it the whole run is one generator, and
    a single malformed byte anywhere discards every section for that host
    rather than the one it came from.
    """
    try:
        return tuple(parser(body))
    except Exception:
        log.warning("section %r failed to parse (%d bytes)", name, len(body), exc_info=True)
        return ()


def samples_from_sections(sections: dict[str, str]) -> tuple[Sample, ...]:
    """Run every section through its parser and flatten the result.

    A section that never arrived is skipped rather than defaulted, so a
    truncated response yields less data instead of fabricated zeroes.
    """
    return tuple(
        sample
        for name, parser in _PARSERS.items()
        if name in sections
        for sample in _section_samples(name, parser, sections[name])
    )


def _log_raised[T](label: str, outcomes: Iterable[T | BaseException]) -> tuple[T, ...]:
    """Name any job that raised and return only the ones that produced a value.

    gather(return_exceptions=True) is what keeps one wedged host from taking
    the whole round down, but a swallowed exception is a silent hole, so every
    one of them is logged here before being dropped.

    Only `Exception` is swallowed. A BaseException that is not one is the
    process being torn down - CancelledError above all - and absorbing that
    makes graceful shutdown impossible, so it is re-raised instead.
    """
    collected = tuple(outcomes)
    fatal = next(
        (
            item
            for item in collected
            if isinstance(item, BaseException) and not isinstance(item, Exception)
        ),
        None,
    )
    if fatal is not None:
        raise fatal
    raised = tuple(item for item in collected if isinstance(item, Exception))
    if raised:
        log.warning(
            "%s: %d job(s) raised: %s", label, len(raised), "; ".join(map(repr, raised))
        )
    return tuple(item for item in collected if not isinstance(item, Exception))


async def _probe(host: Host, body: str, timeout: int) -> ssh.SshResult:
    return await ssh.run(host.ip, body, user=config.ssh_user(), timeout=timeout)


def _write_sections(
    connection: sqlite3.Connection, host: Host, at: datetime, stdout: str
) -> int:
    return store.write_samples(
        connection,
        f"host:{host.name}",
        at,
        samples_from_sections(script.split_sections(stdout)),
    )


async def collect_host(
    host: Host, at: datetime, path: str, *, timeout: int = config.VITALS_TIMEOUT
) -> tuple[CheckResult, ...]:
    """One host, one vitals round trip. Empty when nothing was observed.

    The host itself is a target the collector really did observe: the ssh run
    either worked or it did not, so either outcome is a real check and is
    recorded. A failure writes no samples, so an unreachable box never renders
    as a healthy empty one.

    Two cases are not that. A local spawn failure says nothing about the host,
    so no check is recorded at all. And an ssh run that exits 0 carrying a
    payload nothing could parse observed the box but measured none of it, which
    is not a healthy round either: it is recorded as a failure named
    empty_payload rather than as a success with zero samples.

    The samples and the check derived from them share one session, so a round
    cannot leave a check recorded against readings that were never written.
    """
    result = await _probe(host, script.VITALS_SCRIPT, timeout)
    if result.reason in _NOT_OBSERVED:
        log.warning("vitals probe for %s could not run: %s", host.name, result.reason)
        return ()

    with db.session(path) as connection:
        written = _write_sections(connection, host, at, result.stdout) if result.ok else 0
        check = CheckResult(
            target=f"host:{host.name}",
            ok=result.ok and written > 0,
            reason=result.reason or ("" if written else "empty_payload"),
        )
        incidents.record(connection, check, at)
    return (check,)


async def collect_slow(
    host: Host, at: datetime, path: str, *, timeout: int = config.SLOW_TIMEOUT
) -> None:
    """One host, one slow-tier round trip: disks, temperatures, inotify.

    Deliberately records no check. The vitals tier already checks this exact
    host over this exact transport every 30 seconds, and folding a second
    result into the same streak at the same instant would halve the incident
    hysteresis: one slow round could open or close an incident on its own.
    """
    result = await _probe(host, script.SLOW_SCRIPT, timeout)
    if not result.ok:
        log.warning("slow probe failed for %s: %s", host.name, result.reason)
        return
    with db.session(path) as connection:
        _write_sections(connection, host, at, result.stdout)


def _container_check(host: Host, state: ContainerState) -> CheckResult:
    """One container's check result.

    "stopped" and "running but failing its healthcheck" stay distinct reasons,
    because an incident opened with an empty reason tells the operator nothing.
    """
    reason = (
        "not_running"
        if not state.running
        else "unhealthy"
        if state.health == "unhealthy"
        else ""
    )
    return CheckResult(
        target=f"container:{host.name}/{state.name}", ok=not reason, reason=reason
    )


def _endpoint_only(path: str, host: Host, at: datetime, reason: str) -> tuple[CheckResult, ...]:
    """Record the docker endpoint's failure and nothing else.

    This is the whole not-collected contract in one place. The endpoint was
    observed, so its failure is a real check. The containers behind it were
    not observed at all, and record() has no way to say so: ok=False would
    fabricate an outage for every container on the host, ok=True would
    silently close a real one. So no container result is recorded, and
    retire_absent is not reached either - an empty observed set here would
    close every live container's incident as "removed".
    """
    check = CheckResult(target=f"docker:{host.name}", ok=False, reason=reason)
    with db.session(path) as connection:
        incidents.record(connection, check, at)
    return (check,)


async def collect_containers(
    host: Host, at: datetime, path: str, *, timeout: float = 8.0
) -> tuple[CheckResult, ...]:
    """Container state for one docker host, plus a per-container check.

    Returns the endpoint check first, then one check per container. On any
    transport or payload failure only the endpoint check comes back, because
    the containers were never observed.

    Every check on this host lands in one session. A twelve-container host used
    to spend twelve connections and twelve transactions on a single
    observation, so a round that died midway left half the containers with an
    advanced streak and half without.
    """
    if not host.docker_url:
        return ()

    response = await http.get_json(
        f"{host.docker_url}/containers/json?all=1", timeout=timeout
    )
    if not response.ok:
        return _endpoint_only(path, host, at, response.reason)

    try:
        payload = json.loads(response.body)
    except json.JSONDecodeError:
        return _endpoint_only(path, host, at, "bad_json")

    # a 200 carrying an object rather than an array is a proxy error page, not
    # an empty fleet; treating it as zero containers would retire all of them
    if not isinstance(payload, list):
        return _endpoint_only(path, host, at, "bad_json")

    states = docker.parse_containers(payload)
    endpoint = CheckResult(target=f"docker:{host.name}", ok=True, reason="")
    checks = (endpoint, *(_container_check(host, state) for state in states))

    with db.session(path) as connection:
        store.write_samples(
            connection, f"host:{host.name}", at, docker.to_samples(states)
        )
        for check in checks:
            incidents.record(connection, check, at)
        # the container set is discovered, not declared: adding jellyfin to
        # meleys needs no config change here, and removing an app must not
        # leave its incident open forever. Only reachable on the success path,
        # so `seen` is always a set the collector actually observed.
        incidents.retire_absent(
            connection,
            prefix=f"container:{host.name}/",
            seen={state.name for state in states},
            at=at,
        )
    return checks


async def tick(at: datetime, path: str) -> tuple[CheckResult, ...]:
    """One collection round across the whole fleet, fully concurrent.

    Every check in the returned tuple was recorded; every target the round
    could not observe is simply absent from it.
    """
    host_jobs = tuple(collect_host(host, at, path) for host in config.HOSTS)
    docker_jobs = tuple(
        collect_containers(host, at, path) for host in config.HOSTS if host.docker_url
    )
    outcomes = await asyncio.gather(*host_jobs, *docker_jobs, return_exceptions=True)
    completed = _log_raised("tick", outcomes)

    with db.session(path) as connection:
        store.write_heartbeat(connection, at)
    return tuple(check for checks in completed for check in checks)


def is_slow_round(index: int) -> bool:
    """Whether the slow tier is due on this vitals round.

    Round 0 counts, so the first round after a restart carries disk and
    temperature data instead of leaving a 15 minute hole in the dashboard.
    """
    return index % _SLOW_EVERY == 0


def compact_and_prune(path: str, now: datetime) -> None:
    """Roll closed buckets up and drop what has outlived its retention.

    Synchronous on purpose, and never called directly from the loop: run_forever
    hands it to a worker thread. sqlite connections are thread-affine, so the
    session is opened here, inside whichever thread ends up running it.
    """
    with db.session(path) as connection:
        for tier in rollups.RESOLUTIONS:
            rollups.compact(connection, tier.name, now)
        rollups.prune(connection, now)


def init_db(path: str) -> None:
    """Create every table this process writes. Idempotent, order-independent."""
    with db.session(path) as connection:
        store.init_db(connection)
        rollups.init_db(connection)
        incidents.init_db(connection)


async def run_forever(path: str) -> None:
    """Vitals every 30s, slow hardware and compaction every 15 minutes."""
    init_db(path)
    loop = asyncio.get_running_loop()
    due = loop.time()
    rounds = 0
    while True:
        now = datetime.now(tz=timezone.utc)
        await tick(now, path)
        if is_slow_round(rounds):
            _log_raised(
                "slow tier",
                await asyncio.gather(
                    *(collect_slow(host, now, path) for host in config.HOSTS),
                    return_exceptions=True,
                ),
            )
            # off the event loop: this is blocking sqlite, and a stalled loop
            # is a stalled vitals tier, which is what MAX_ROUND_SECONDS and
            # every tolerance derived from it are supposed to bound
            await asyncio.to_thread(compact_and_prune, path, now)
        rounds += 1
        # measured from when the round was due, not from when it finished, so a
        # long round is absorbed rather than added to every interval after it
        due += config.VITALS_INTERVAL
        await asyncio.sleep(max(0.0, due - loop.time()))


if __name__ == "__main__":
    # `python -m fleet_monitor.collector` runs the loop against the same
    # database the API reads. Where and how it is actually scheduled is a
    # deployment decision, and deliberately not one this module makes.
    logging.basicConfig(level=logging.INFO)
    asyncio.run(run_forever(config.db_path()))
