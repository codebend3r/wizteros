import os
from dataclasses import dataclass

from fleet_monitor.transport.ssh import CAPTURE_FACTOR

VITALS_INTERVAL = 30
SLOW_INTERVAL = 900

# ssh connect budgets for the two tiers. transport.ssh gives a whole capture
# CAPTURE_FACTOR times the connect timeout before it kills the process, so the
# wall-clock ceiling of one probe is the product, not the timeout itself.
VITALS_TIMEOUT = 15
SLOW_TIMEOUT = 30

# The longest one collection round can legitimately take. Both tiers fan every
# host out concurrently, so fleet size does not enter into it; a slow round is
# the two tiers in series, each bounded by its own capture ceiling. Anything
# that measures the distance between rounds has to allow for this, because a
# round's own duration lands inside that distance.
#
# The factor is imported from the transport that spends it rather than restated
# here. It used to be a second copy with a test asserting the two were equal,
# which is a number telling you it wants one home.
MAX_ROUND_SECONDS = (VITALS_TIMEOUT + SLOW_TIMEOUT) * CAPTURE_FACTOR


@dataclass(frozen=True, slots=True)
class Host:
    name: str
    ip: str
    has_gpu: bool
    docker_url: str


# Measured 2026-08-10, GPU absence re-verified 2026-08-11.
#
# has_gpu is a permanent property, not a pending driver fix. Only vermithor
# (Celeron J3455) and vhagar (Celeron J4125) expose a render node. meleys has
# no /dev/dri, an empty /sys/class/drm and no amdgpu module because Synology
# does not enable the R1600's Vega iGPU; syrax is an Atom C3538 with no iGPU;
# caraxes is ARMv8 with 1.6 GB.
#
# Core count is deliberately not a field here. /proc/stat already reports one
# row per cpu on every tick, so the collector observes it; declaring it as well
# would be a second copy to keep in step, and the fleet is not uniform (the
# R1600 is 2 physical cores presenting 4 threads).
#
# docker_url is set where Docker exists: vermithor, meleys, and vhagar since
# 2026-08-11. caraxes is aarch64 and Container Manager is x86-only there.
# The container list under each is discovered per tick, so a new stack member
# needs no change here; only a host gaining Docker does.
#
# Measured 2026-08-15: all three refuse on :2375. vermithor runs Docker on a
# local unix socket, which this url cannot address, and meleys and vhagar need
# a socket proxy that is not deployed yet. So every docker fetch fails on every
# tick until all three have a reachable TCP endpoint. That failure is recorded
# against the docker: target only - the containers behind it are never
# observed, so no container result is recorded either way. See collector.
HOSTS = (
    Host(name="meleys", ip="192.168.50.2", has_gpu=False,
         docker_url="http://192.168.50.2:2375"),
    Host(name="vermithor", ip="192.168.50.3", has_gpu=True,
         docker_url="http://192.168.50.3:2375"),
    Host(name="caraxes", ip="192.168.50.4", has_gpu=False, docker_url=""),
    Host(name="syrax", ip="192.168.50.5", has_gpu=False, docker_url=""),
    Host(name="vhagar", ip="192.168.50.6", has_gpu=True,
         docker_url="http://192.168.50.6:2375"),
)


def db_path() -> str:
    """Where the SQLite file lives. /data is the container's mounted volume."""
    return os.environ.get("FM_DB_PATH", "/data/fleet.db")


def ssh_user() -> str:
    """The unprivileged account that holds the shared key on all five boxes."""
    return os.environ.get("FM_SSH_USER", "crivas")
