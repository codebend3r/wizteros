import os
from dataclasses import dataclass

VITALS_INTERVAL = 30
SLOW_INTERVAL = 900


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
