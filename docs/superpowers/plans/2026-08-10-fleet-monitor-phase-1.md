# Fleet Monitor Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an agentless collector that polls the five Synology hosts and their containers, stores history in SQLite, tracks up/down incidents, and renders a fleet overview page in the existing admin portal.

**Architecture:** A new Nx app `apps/fleet-monitor/` (FastAPI, Python 3.12, containerized) polls hosts over one multiplexed SSH connection each and the Docker API for container state. Parsing is isolated in pure functions under `probes/` so the whole parsing surface is unit-testable against fixtures captured from the real boxes. All I/O lives in `transport/`. Samples land in SQLite; an incident state machine turns check results into open/close events with hysteresis.

**Tech Stack:** Python 3.12, FastAPI, uvicorn, httpx, asyncio, SQLite (stdlib `sqlite3`, WAL mode), pytest, ruff. Front end is the existing React 19 + TanStack Query + SCSS modules admin portal.

**Spec:** `docs/superpowers/specs/2026-08-10-fleet-monitor-design.md`

## Global Constraints

- **Python target is 3.12.** Ruff is pinned `target-version = "py312"` with `select = ["E4", "E7", "E9", "F", "I", "RUF"]`. Import order (`I`) is enforced.
- **The new app ships with no `version` field in its `package.json`.** `scripts/release.sh` validates exactly three version markers (root `package.json`, `apps/admin-portal/package.json`, `__version__` in `apps/stripe-bridge/stripe_bridge/__init__.py`) and hard-fails when they disagree. A fourth versioned app would break every release. The app is `private: true`, so no version field is needed. Do not add one, and do not edit `release.sh`.
- **Bridge-style package-absolute imports:** `from fleet_monitor import store`, `from fleet_monitor.probes import proc`. Never parent-relative.
- **Web imports use the `@/` alias**, never `../`. Same-directory `./` is fine.
- **Probes are pure.** No clock, no network, no filesystem. They take `str` and return data. The collector stamps timestamps. This is what makes them testable without a NAS, and it is not negotiable.
- **SSH always passes `-o LogLevel=ERROR`.** Current OpenSSH prints a post-quantum key-exchange warning on every connection to these DSM boxes, and it corrupts stdout parsing.
- **Never conflate "not collected" with "healthy."** Every result is one of: fresh sample, typed failure, or explicitly not collected. This mirrors the rule the `stack-health` skill already enforces about skipped checks.
- **No en dashes or em dashes** in any code, comment, commit message, or doc.
- **Commits:** subject starts `WZ:` followed by a short title, body favors bullets. Never add Claude attribution. **Do not run `git commit` until CJ has said to.** The commit steps below are part of the plan; executing them is CJ's call.
- **TypeScript:** type aliases only, never `interface`. No `any`, no non-null assertions, no type casts. Named exports only.
- **SCSS:** modules for components, `display: grid` over flex, spacing via `gap` and container padding, never margins. Tokens from `styles/globals.scss`. Responsive to 320px with no horizontal page scroll.

## Fleet reference (measured 2026-08-10)

| Host        | IP           | Cores | RAM     | `/dev/dri` | Docker                     |
| ----------- | ------------ | ----- | ------- | ---------- | -------------------------- |
| `vermithor` | 192.168.50.3 | 4     | 15.8 GB | yes        | yes                        |
| `meleys`    | 192.168.50.2 | 2c/4t | 32.1 GB | no         | yes                        |
| `syrax`     | 192.168.50.5 | 4     | 32.1 GB | no         | no                         |
| `vhagar`    | 192.168.50.6 | 4     | 7.8 GB  | yes        | **yes** (added 2026-08-11) |
| `caraxes`   | 192.168.50.4 | 4     | 1.6 GB  | no         | no (aarch64, unsupported)  |

`vhagar` runs Jellyfin as of 2026-08-11, so it is a third Docker host. `caraxes` is the
only box where Docker cannot run at all.

SSH user is `crivas` with `~/.ssh/id_ed25519` on all five.

## File structure

```
apps/fleet-monitor/
├── fleet_monitor/
│   ├── __init__.py
│   ├── probes/
│   │   ├── __init__.py
│   │   ├── types.py        Sample, ProbeFailure, Kind
│   │   ├── proc.py         /proc/stat, meminfo, net/dev, loadavg, uptime
│   │   ├── system.py       df, hwmon temps, i915 GPU frequency
│   │   ├── script.py       batched shell script builder + response splitter
│   │   └── docker.py       Docker API JSON to container state
│   ├── transport/
│   │   ├── __init__.py
│   │   ├── ssh.py          ControlMaster SSH runner
│   │   └── http.py         async HTTP with typed failures
│   ├── store.py            SQLite schema, writes, reads, counter rates
│   ├── rollups.py          5m and 1h aggregation, retention pruning
│   ├── incidents.py        up/down state machine
│   ├── collector.py        asyncio scheduler
│   ├── config.py           host and target configuration
│   └── api.py              FastAPI read endpoints
├── tests/
│   ├── __init__.py
│   ├── fixtures/           real captures from the boxes
│   └── test_*.py
├── scripts/
│   ├── test-monitor.sh
│   └── lint-monitor.sh
├── Dockerfile
├── package.json
├── project.json
├── pytest.ini
├── ruff.toml
├── requirements.txt
└── requirements-dev.txt
```

Split by responsibility, not layer: `probes/` is "understand a byte stream", `transport/` is "go get bytes", and they never mix. A parsing bug is then always a probe test, never an integration test.

---

### Task 1: Scaffold the fleet-monitor Nx app

**Files:**

- Create: `apps/fleet-monitor/package.json`
- Create: `apps/fleet-monitor/project.json`
- Create: `apps/fleet-monitor/pytest.ini`
- Create: `apps/fleet-monitor/ruff.toml`
- Create: `apps/fleet-monitor/requirements.txt`
- Create: `apps/fleet-monitor/requirements-dev.txt`
- Create: `apps/fleet-monitor/Dockerfile`
- Create: `apps/fleet-monitor/scripts/test-monitor.sh`
- Create: `apps/fleet-monitor/scripts/lint-monitor.sh`
- Create: `apps/fleet-monitor/fleet_monitor/__init__.py`
- Create: `apps/fleet-monitor/tests/__init__.py`
- Test: `apps/fleet-monitor/tests/test_scaffold.py`
- Modify: `package.json` (root, add `setup:py:monitor` and `test:monitor` aliases)

**Interfaces:**

- Consumes: nothing.
- Produces: the Nx project `fleet-monitor` with working `test` and `lint:py` targets. Every later task's test command is `bunx nx run fleet-monitor:test`.

- [ ] **Step 1: Write the failing test**

`apps/fleet-monitor/tests/test_scaffold.py`:

```python
import fleet_monitor


def test_package_imports():
    assert fleet_monitor.__name__ == "fleet_monitor"
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd apps/fleet-monitor && python3 -m pytest tests/test_scaffold.py -q`
Expected: FAIL, collection error, `ModuleNotFoundError: No module named 'fleet_monitor'`

- [ ] **Step 3: Create the Python package and test package markers**

`apps/fleet-monitor/fleet_monitor/__init__.py`:

```python
"""Agentless fleet monitor for the Synology boxes and the arr stack.

Deliberately carries no __version__ marker: scripts/release.sh moves exactly
three versions in lockstep and a fourth would break the release check.
"""
```

`apps/fleet-monitor/tests/__init__.py`: empty file.

- [ ] **Step 4: Create the Python tooling config**

`apps/fleet-monitor/pytest.ini`:

```ini
[pytest]
pythonpath = .
testpaths = tests
```

`apps/fleet-monitor/ruff.toml`:

```toml
# Pinned so lint matches everywhere; without this ruff falls back to
# whatever machine-level config is present, which CI won't have.
target-version = "py312"

[lint]
select = ["E4", "E7", "E9", "F", "I", "RUF"]
```

`apps/fleet-monitor/requirements.txt`:

```
fastapi
uvicorn[standard]
httpx
```

`apps/fleet-monitor/requirements-dev.txt`:

```
-r requirements.txt
pytest
pytest-asyncio
ruff
```

- [ ] **Step 5: Create the run scripts**

`apps/fleet-monitor/scripts/test-monitor.sh`:

```bash
#!/usr/bin/env bash
# Run the fleet-monitor pytest suite with the app venv, falling back to the
# system python3 (CI installs the requirements with plain pip, no venv).
# Backs the `fleet-monitor:test` Nx target.
set -euo pipefail
cd "$(dirname "$0")/.."

PY="$PWD/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

if ! "$PY" -m pytest --version >/dev/null 2>&1; then
  echo "pytest not available - bootstrap the venv with: bun run setup:py:monitor" >&2
  exit 1
fi

exec "$PY" -m pytest -q
```

`apps/fleet-monitor/scripts/lint-monitor.sh`:

```bash
#!/usr/bin/env bash
# Run ruff with the app venv, falling back to whatever ruff is on PATH (CI
# installs the requirements with plain pip, no venv). Backs the
# `fleet-monitor:lint:py` and `lint:py:fix` Nx targets.
set -euo pipefail
cd "$(dirname "$0")/.."

RUFF="$PWD/.venv/bin/ruff"
if [ ! -x "$RUFF" ]; then
  RUFF="$(command -v ruff)" || {
    echo "ruff not available - bootstrap the venv with: bun run setup:py:monitor" >&2
    exit 1
  }
fi

exec "$RUFF" check "$@" .
```

Then: `chmod +x apps/fleet-monitor/scripts/*.sh`

- [ ] **Step 6: Create the Nx project files**

`apps/fleet-monitor/package.json`. Note the deliberate absence of a `version` field:

```json
{
  "name": "fleet-monitor",
  "private": true,
  "scripts": {
    "lint:py": "bash scripts/lint-monitor.sh",
    "lint:py:fix": "bash scripts/lint-monitor.sh --fix",
    "test": "bash scripts/test-monitor.sh"
  },
  "nx": {
    "includedScripts": ["lint:py", "lint:py:fix", "test"]
  }
}
```

`apps/fleet-monitor/project.json`:

```json
{
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "name": "fleet-monitor",
  "projectType": "application",
  "sourceRoot": "apps/fleet-monitor/fleet_monitor",
  "tags": ["scope:monitor", "lang:python"],
  "targets": {
    "docker-build": {
      "executor": "nx:run-commands",
      "cache": false,
      "options": {
        "command": "docker build -t fleet-monitor apps/fleet-monitor",
        "cwd": "{workspaceRoot}"
      }
    }
  }
}
```

`apps/fleet-monitor/Dockerfile`:

```dockerfile
FROM python:3.12-slim
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-client \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY fleet_monitor/ ./fleet_monitor/
ENV FM_DB_PATH=/data/fleet.db
VOLUME ["/data"]
CMD ["uvicorn", "fleet_monitor.api:app", "--host", "0.0.0.0", "--port", "8010"]
```

- [ ] **Step 7: Add the root aliases**

In the root `package.json` `scripts` block, after the existing `setup:py` line:

```json
    "setup:py:monitor": "python3 -m venv apps/fleet-monitor/.venv && apps/fleet-monitor/.venv/bin/pip install -r apps/fleet-monitor/requirements-dev.txt",
    "test:monitor": "nx run fleet-monitor:test",
```

- [ ] **Step 8: Bootstrap the venv and run the test**

Run:

```bash
bun run setup:py:monitor
bunx nx run fleet-monitor:test
```

Expected: PASS, 1 test.

- [ ] **Step 9: Confirm the release check still passes and lint is clean**

Run:

```bash
bunx nx run fleet-monitor:lint:py
bunx nx show project fleet-monitor --json | head -5
node -p "require('./apps/fleet-monitor/package.json').version"
```

Expected: lint clean; the project shows `test`, `lint:py`, `lint:py:fix`, `docker-build`; the version read prints `undefined`, which is what keeps `release.sh` correct.

- [ ] **Step 10: Commit**

```bash
git add apps/fleet-monitor package.json
git commit -m "WZ: Scaffold the fleet-monitor app

- Add the fleet-monitor Nx project with test and lint:py targets
- Ship it versionless so release.sh keeps validating exactly three markers
- Add setup:py:monitor and test:monitor root aliases"
```

---

### Task 2: Pure /proc parsers

**Files:**

- Create: `apps/fleet-monitor/fleet_monitor/probes/__init__.py`
- Create: `apps/fleet-monitor/fleet_monitor/probes/types.py`
- Create: `apps/fleet-monitor/fleet_monitor/probes/proc.py`
- Create: `apps/fleet-monitor/tests/fixtures/caraxes_proc_stat.txt`
- Create: `apps/fleet-monitor/tests/fixtures/caraxes_proc_meminfo.txt`
- Create: `apps/fleet-monitor/tests/fixtures/caraxes_proc_net_dev.txt`
- Test: `apps/fleet-monitor/tests/test_probes_proc.py`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `Sample(metric: str, value: float, kind: str)`, a frozen dataclass. `kind` is `"gauge"` or `"counter"`.
  - `ProbeFailure(source: str, reason: str)`, a frozen dataclass.
  - `proc.parse_stat(text: str) -> tuple[Sample, ...]`
  - `proc.parse_meminfo(text: str) -> tuple[Sample, ...]`
  - `proc.parse_net_dev(text: str) -> tuple[Sample, ...]`
  - `proc.parse_loadavg(text: str) -> tuple[Sample, ...]`
  - `proc.parse_uptime(text: str) -> tuple[Sample, ...]`

- [ ] **Step 1: Capture the real fixtures from caraxes**

caraxes is the ARM box with 1.6 GB of RAM, which makes it the most different from the rest and therefore the best default fixture.

Run:

```bash
cd apps/fleet-monitor/tests/fixtures
ssh -o LogLevel=ERROR crivas@192.168.50.4 'head -6 /proc/stat' > caraxes_proc_stat.txt
ssh -o LogLevel=ERROR crivas@192.168.50.4 'head -8 /proc/meminfo' > caraxes_proc_meminfo.txt
ssh -o LogLevel=ERROR crivas@192.168.50.4 'cat /proc/net/dev' > caraxes_proc_net_dev.txt
```

If off the LAN, use these verified captures instead.

`caraxes_proc_stat.txt`:

```
cpu  25839572 27406112 12199815 304159064 9504147 0 1283448 0 0 0
cpu0 6444566 6850358 3054453 76012278 2360456 0 375923 0 0 0
cpu1 6466416 6819666 3049186 76074497 2379143 0 309129 0 0 0
cpu2 6455449 6871226 3037462 76069246 2375519 0 289142 0 0 0
cpu3 6473141 6864862 3058714 76003043 2389029 0 309254 0 0 0
```

`caraxes_proc_meminfo.txt`:

```
MemTotal:        1683776 kB
MemFree:          125592 kB
MemAvailable:     741756 kB
Buffers:           16044 kB
Cached:           711756 kB
```

`caraxes_proc_net_dev.txt` (note the two header lines and the tab-free column alignment):

```
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  sit0:       0       0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
    lo: 1798182301 7665058    0    0    0     0          0         0 1798182301 7665058    0    0    0     0       0          0
    eth0: 884213551 2211903    0    0    0     0          0         0 331882714 1443122    0    0    0     0       0          0
```

- [ ] **Step 2: Write the failing tests**

`apps/fleet-monitor/tests/test_probes_proc.py`:

```python
from pathlib import Path

from fleet_monitor.probes import proc

FIXTURES = Path(__file__).parent / "fixtures"


def _by_metric(samples):
    return {s.metric: s.value for s in samples}


def test_parse_stat_emits_per_core_and_total_counters():
    text = (FIXTURES / "caraxes_proc_stat.txt").read_text()
    got = _by_metric(proc.parse_stat(text))

    assert got["cpu.total.user"] == 25839572.0
    assert got["cpu.total.idle"] == 304159064.0
    assert got["cpu.total.iowait"] == 9504147.0
    assert got["cpu0.user"] == 6444566.0
    assert got["cpu3.idle"] == 76003043.0
    # 5 cpu lines x 8 tracked fields
    assert len(proc.parse_stat(text)) == 40
    assert all(s.kind == "counter" for s in proc.parse_stat(text))


def test_parse_meminfo_converts_kb_to_bytes():
    text = (FIXTURES / "caraxes_proc_meminfo.txt").read_text()
    got = _by_metric(proc.parse_meminfo(text))

    assert got["mem.total_bytes"] == 1683776 * 1024
    assert got["mem.available_bytes"] == 741756 * 1024
    assert got["mem.cached_bytes"] == 711756 * 1024
    assert all(s.kind == "gauge" for s in proc.parse_meminfo(text))


def test_parse_net_dev_skips_loopback_and_tunnels():
    text = (FIXTURES / "caraxes_proc_net_dev.txt").read_text()
    got = _by_metric(proc.parse_net_dev(text))

    assert got["net.eth0.rx_bytes"] == 884213551.0
    assert got["net.eth0.tx_bytes"] == 331882714.0
    assert "net.lo.rx_bytes" not in got
    assert "net.sit0.rx_bytes" not in got


def test_parse_net_dev_skips_docker_bridges():
    # vermithor carries 11 docker* interfaces; they are noise, not fleet traffic
    text = (
        "Inter-|   Receive  |  Transmit\n"
        " face |bytes ...\n"
        "  eth0: 100 1 0 0 0 0 0 0 200 2 0 0 0 0 0 0\n"
        "  docker0: 300 3 0 0 0 0 0 0 400 4 0 0 0 0 0 0\n"
        "  docker41a7c36: 500 5 0 0 0 0 0 0 600 6 0 0 0 0 0 0\n"
    )
    got = _by_metric(proc.parse_net_dev(text))

    assert got == {"net.eth0.rx_bytes": 100.0, "net.eth0.tx_bytes": 200.0}


def test_parse_loadavg():
    got = _by_metric(proc.parse_loadavg("0.20 0.18 0.12 1/721 21708\n"))

    assert got["load.1m"] == 0.20
    assert got["load.5m"] == 0.18
    assert got["load.15m"] == 0.12
    assert got["procs.running"] == 1.0
    assert got["procs.total"] == 721.0


def test_parse_uptime():
    got = _by_metric(proc.parse_uptime("950412.67 3698765.43\n"))

    assert got["uptime.seconds"] == 950412.67


def test_parsers_are_total_on_empty_input():
    # a truncated tick must yield nothing, never raise: one bad host cannot
    # be allowed to kill a collection round
    assert proc.parse_stat("") == ()
    assert proc.parse_meminfo("") == ()
    assert proc.parse_net_dev("") == ()
    assert proc.parse_loadavg("") == ()
    assert proc.parse_uptime("") == ()
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bunx nx run fleet-monitor:test`
Expected: FAIL, `ModuleNotFoundError: No module named 'fleet_monitor.probes'`

- [ ] **Step 4: Write the shared types**

`apps/fleet-monitor/fleet_monitor/probes/__init__.py`: empty file.

`apps/fleet-monitor/fleet_monitor/probes/types.py`:

```python
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
```

- [ ] **Step 5: Write the /proc parsers**

`apps/fleet-monitor/fleet_monitor/probes/proc.py`:

```python
from fleet_monitor.probes.types import Sample

# /proc/stat orders these fields after the cpu label. Trailing guest fields are
# ignored: they are already counted inside user and nice.
_CPU_FIELDS = ("user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal")

# Values are in kB. Anything not listed here is not worth a row per tick.
_MEM_KEYS = {
    "MemTotal": "mem.total_bytes",
    "MemFree": "mem.free_bytes",
    "MemAvailable": "mem.available_bytes",
    "Buffers": "mem.buffers_bytes",
    "Cached": "mem.cached_bytes",
    "SwapTotal": "mem.swap_total_bytes",
    "SwapFree": "mem.swap_free_bytes",
}

_SKIP_IFACES = frozenset({"lo", "sit0"})

# Byte columns in /proc/net/dev after the interface name: receive starts at 0,
# transmit at 8 (each half is bytes packets errs drop fifo frame compressed
# multicast).
_RX_BYTES = 0
_TX_BYTES = 8


def parse_stat(text: str) -> tuple[Sample, ...]:
    """Per-core and aggregate CPU jiffy counters from /proc/stat."""
    rows = [ln.split() for ln in text.splitlines() if ln.startswith("cpu")]
    return tuple(
        Sample(
            metric=f"cpu.{'total' if row[0] == 'cpu' else row[0]}.{field}",
            value=float(row[index + 1]),
            kind="counter",
        )
        for row in rows
        for index, field in enumerate(_CPU_FIELDS)
        if index + 1 < len(row)
    )


def parse_meminfo(text: str) -> tuple[Sample, ...]:
    """Memory gauges from /proc/meminfo, converted from kB to bytes."""
    rows = (ln.split(":", 1) for ln in text.splitlines() if ":" in ln)
    return tuple(
        Sample(metric=_MEM_KEYS[key], value=float(rest.split()[0]) * 1024, kind="gauge")
        for key, rest in rows
        if key in _MEM_KEYS and rest.split()
    )


def parse_net_dev(text: str) -> tuple[Sample, ...]:
    """Per-interface byte counters, minus loopback, tunnels and docker bridges.

    The docker* bridges are skipped because vermithor alone carries eleven of
    them and none of them describe traffic entering or leaving the box.
    """
    body = text.splitlines()[2:]
    rows = [ln.split(":", 1) for ln in body if ":" in ln]
    named = [(name.strip(), rest.split()) for name, rest in rows]
    return tuple(
        sample
        for name, fields in named
        if name not in _SKIP_IFACES
        and not name.startswith("docker")
        and len(fields) > _TX_BYTES
        for sample in (
            Sample(metric=f"net.{name}.rx_bytes", value=float(fields[_RX_BYTES]), kind="counter"),
            Sample(metric=f"net.{name}.tx_bytes", value=float(fields[_TX_BYTES]), kind="counter"),
        )
    )


def parse_loadavg(text: str) -> tuple[Sample, ...]:
    """Load averages and the runnable/total process counts from /proc/loadavg."""
    fields = text.split()
    if len(fields) < 4 or "/" not in fields[3]:
        return ()
    running, total = fields[3].split("/", 1)
    return (
        Sample(metric="load.1m", value=float(fields[0]), kind="gauge"),
        Sample(metric="load.5m", value=float(fields[1]), kind="gauge"),
        Sample(metric="load.15m", value=float(fields[2]), kind="gauge"),
        Sample(metric="procs.running", value=float(running), kind="gauge"),
        Sample(metric="procs.total", value=float(total), kind="gauge"),
    )


def parse_uptime(text: str) -> tuple[Sample, ...]:
    """Seconds since boot from /proc/uptime.

    Read from /proc rather than the uptime command because the DSM uptime
    output carries Synology's own IO and CPU suffixes, which shift the columns.
    """
    fields = text.split()
    if not fields:
        return ()
    return (Sample(metric="uptime.seconds", value=float(fields[0]), kind="gauge"),)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bunx nx run fleet-monitor:test`
Expected: PASS, 8 tests.

- [ ] **Step 7: Run lint**

Run: `bunx nx run fleet-monitor:lint:py`
Expected: clean, no findings.

- [ ] **Step 8: Commit**

```bash
git add apps/fleet-monitor/fleet_monitor/probes apps/fleet-monitor/tests
git commit -m "WZ: Add pure /proc parsers to fleet-monitor

- Parse stat, meminfo, net/dev, loadavg and uptime into Samples
- Skip loopback, sit0 and the eleven docker bridges on vermithor
- Keep parsers total: a truncated tick yields nothing rather than raising
- Fixtures captured from caraxes, the ARM box"
```

---

### Task 3: System probes for disk, temperature and GPU

**Files:**

- Create: `apps/fleet-monitor/fleet_monitor/probes/system.py`
- Test: `apps/fleet-monitor/tests/test_probes_system.py`

**Interfaces:**

- Consumes: `Sample` from `fleet_monitor.probes.types`.
- Produces:
  - `system.parse_df(text: str) -> tuple[Sample, ...]`
  - `system.parse_hwmon(text: str) -> tuple[Sample, ...]`
  - `system.parse_gpu_freq(text: str) -> tuple[Sample, ...]`

- [ ] **Step 1: Write the failing tests**

`apps/fleet-monitor/tests/test_probes_system.py`:

```python
from fleet_monitor.probes import system


def _by_metric(samples):
    return {s.metric: s.value for s in samples}


def test_parse_df_reports_bytes_and_percent():
    # df -Pk output; -P forces one line per filesystem even for long device names
    text = (
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
        "/dev/mapper/cachedev_0 101815078912 99863519232 1951559680 99% /volume1\n"
    )
    got = _by_metric(system.parse_df(text))

    assert got["disk.volume1.total_bytes"] == 101815078912 * 1024
    assert got["disk.volume1.used_bytes"] == 99863519232 * 1024
    assert got["disk.volume1.available_bytes"] == 1951559680 * 1024
    assert got["disk.volume1.used_percent"] == 99.0


def test_parse_df_handles_the_lvm_and_crypt_device_names():
    # caraxes uses /dev/vg1/volume_1 and meleys uses /dev/mapper/cryptvol_1
    text = (
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n"
        "/dev/vg1/volume_1 28991029248 24696061952 3652116480 88% /volume1\n"
    )
    got = _by_metric(system.parse_df(text))

    assert got["disk.volume1.used_percent"] == 88.0


def test_parse_hwmon_reads_millidegrees():
    # the collector emits one "name=<chip> <label>=<millidegrees>" line per sensor
    text = "coretemp temp1_input=41000\ncoretemp temp2_input=39000\n"
    got = _by_metric(system.parse_hwmon(text))

    assert got["temp.coretemp.temp1"] == 41.0
    assert got["temp.coretemp.temp2"] == 39.0


def test_parse_gpu_freq_emits_ratio():
    # vermithor and vhagar idle at 100 MHz against a 750 MHz ceiling
    got = _by_metric(system.parse_gpu_freq("100\n750\n"))

    assert got["gpu.freq_mhz"] == 100.0
    assert got["gpu.freq_max_mhz"] == 750.0
    assert got["gpu.freq_ratio"] == 100.0 / 750.0


def test_parse_gpu_freq_absent_on_boxes_without_a_render_node():
    # meleys, syrax and caraxes have no /dev/dri, so the script emits nothing
    assert system.parse_gpu_freq("") == ()


def test_parse_gpu_freq_survives_a_zero_ceiling():
    assert _by_metric(system.parse_gpu_freq("0\n0\n")).get("gpu.freq_ratio") is None


def test_parse_inotify_reports_ceilings_and_usage():
    # both docker hosts sit at 262144 watches after the 2026-08-08 raise
    text = "max_user_watches=262144\nmax_user_instances=1024\ninstances_in_use=37\n"
    got = _by_metric(system.parse_inotify(text))

    assert got["inotify.max_user_watches"] == 262144.0
    assert got["inotify.max_user_instances"] == 1024.0
    assert got["inotify.instances_in_use"] == 37.0
    assert got["inotify.instances_used_ratio"] == 37.0 / 1024.0


def test_parse_inotify_skips_an_unreadable_value():
    # cat failing leaves the key with an empty value, which must not become 0
    got = _by_metric(system.parse_inotify("max_user_watches=\nmax_user_instances=1024\n"))

    assert "inotify.max_user_watches" not in got
    assert got["inotify.max_user_instances"] == 1024.0


def test_system_parsers_are_total_on_empty_input():
    assert system.parse_df("") == ()
    assert system.parse_hwmon("") == ()
    assert system.parse_inotify("") == ()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx nx run fleet-monitor:test`
Expected: FAIL, `ModuleNotFoundError: No module named 'fleet_monitor.probes.system'`

- [ ] **Step 3: Write the system parsers**

`apps/fleet-monitor/fleet_monitor/probes/system.py`:

```python
from fleet_monitor.probes.types import Sample

_BLOCK_BYTES = 1024


def parse_df(text: str) -> tuple[Sample, ...]:
    """Volume usage from `df -Pk <mount>`.

    -P is required: without it df wraps long device names onto a second line,
    and the fleet runs three different naming schemes (/dev/mapper/cachedev_0,
    /dev/mapper/cryptvol_1, /dev/vg1/volume_1).
    """
    rows = [ln.split() for ln in text.splitlines()[1:] if ln.strip()]
    return tuple(
        sample
        for fields in rows
        if len(fields) >= 6
        for name in (fields[5].lstrip("/").replace("/", "_") or "root",)
        for sample in (
            Sample(
                metric=f"disk.{name}.total_bytes",
                value=float(fields[1]) * _BLOCK_BYTES,
                kind="gauge",
            ),
            Sample(
                metric=f"disk.{name}.used_bytes",
                value=float(fields[2]) * _BLOCK_BYTES,
                kind="gauge",
            ),
            Sample(
                metric=f"disk.{name}.available_bytes",
                value=float(fields[3]) * _BLOCK_BYTES,
                kind="gauge",
            ),
            Sample(
                metric=f"disk.{name}.used_percent",
                value=float(fields[4].rstrip("%")),
                kind="gauge",
            ),
        )
    )


def parse_hwmon(text: str) -> tuple[Sample, ...]:
    """Chip temperatures from lines shaped `<chip> <label>_input=<millidegrees>`.

    The collector flattens the hwmon tree into that shape because the sysfs
    layout differs across the fleet; only vermithor exposes a coretemp chip at
    hwmon0.
    """
    rows = [ln.split() for ln in text.splitlines() if "=" in ln]
    return tuple(
        Sample(
            metric=f"temp.{fields[0]}.{key.removesuffix('_input')}",
            value=float(raw) / 1000.0,
            kind="gauge",
        )
        for fields in rows
        if len(fields) >= 2
        for key, _, raw in (fields[1].partition("="),)
        if raw.lstrip("-").isdigit()
    )


def parse_inotify(text: str) -> tuple[Sample, ...]:
    """Inotify ceilings and instance usage from `key=value` lines.

    Tracked because meleys exhausted its watch limit once already (raised from
    8192 to 262144 on 2026-08-08). Running a second media server against the
    same libraries doubles the demand on the same ceiling, so the headroom is
    worth watching rather than rediscovering the hard way.
    """
    pairs = [line.split("=", 1) for line in text.splitlines() if "=" in line]
    values = {
        key: float(raw)
        for key, raw in pairs
        if raw.strip() and raw.strip().lstrip("-").isdigit()
    }
    base = tuple(
        Sample(metric=f"inotify.{key}", value=value, kind="gauge")
        for key, value in values.items()
    )
    ceiling = values.get("max_user_instances", 0.0)
    in_use = values.get("instances_in_use")
    if ceiling <= 0 or in_use is None:
        return base
    return (
        *base,
        Sample(metric="inotify.instances_used_ratio", value=in_use / ceiling, kind="gauge"),
    )


def parse_gpu_freq(text: str) -> tuple[Sample, ...]:
    """Intel i915 frequency from gt_act_freq_mhz and gt_max_freq_mhz.

    This is a load proxy, not a utilization percentage. DSM ships no
    intel_gpu_top and does not expose the i915 perf interface, so a true busy
    percentage is not obtainable.

    Only vermithor and vhagar have a render node at all. Verified 2026-08-11:
    meleys has no /dev/dri, an empty /sys/class/drm, and no amdgpu or radeon
    module loaded, because Synology does not enable the Vega iGPU on the
    R1600. That is a permanent property of the box, not a missing driver, so
    anything transcoding on meleys is doing it in software on 2 physical cores.
    """
    fields = text.split()
    if len(fields) < 2:
        return ()
    current, ceiling = float(fields[0]), float(fields[1])
    base = (
        Sample(metric="gpu.freq_mhz", value=current, kind="gauge"),
        Sample(metric="gpu.freq_max_mhz", value=ceiling, kind="gauge"),
    )
    if ceiling <= 0:
        return base
    return (*base, Sample(metric="gpu.freq_ratio", value=current / ceiling, kind="gauge"))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx nx run fleet-monitor:test`
Expected: PASS, 18 tests total.

- [ ] **Step 5: Run lint**

Run: `bunx nx run fleet-monitor:lint:py`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/fleet-monitor/fleet_monitor/probes/system.py apps/fleet-monitor/tests/test_probes_system.py
git commit -m "WZ: Add disk, temperature and GPU probes to fleet-monitor

- Parse df -Pk across all three device naming schemes on the fleet
- Flatten hwmon into chip/label temperature gauges in degrees
- Read i915 frequency as a load proxy, with the no-render-node case empty"
```

---

### Task 4: Batched collection script and response splitter

**Files:**

- Create: `apps/fleet-monitor/fleet_monitor/probes/script.py`
- Test: `apps/fleet-monitor/tests/test_probes_script.py`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces:
  - `script.VITALS_SCRIPT: str`, the shell script sent to a host each vitals tick.
  - `script.SLOW_SCRIPT: str`, the 15-minute disk and temperature script.
  - `script.split_sections(text: str) -> dict[str, str]`

This is the piece that makes the whole design cheap: one script per host per tick instead of one command per metric.

- [ ] **Step 1: Write the failing tests**

`apps/fleet-monitor/tests/test_probes_script.py`:

```python
from fleet_monitor.probes import script


def test_split_sections_keys_by_sentinel():
    text = "###stat\ncpu 1 2 3\n###meminfo\nMemTotal: 4 kB\n"
    assert script.split_sections(text) == {
        "stat": "cpu 1 2 3\n",
        "meminfo": "MemTotal: 4 kB\n",
    }


def test_split_sections_ignores_preamble_before_the_first_sentinel():
    # a login banner or an ssh warning that slipped past LogLevel=ERROR
    text = "warning: something\n###stat\ncpu 1 2 3\n"
    assert script.split_sections(text) == {"stat": "cpu 1 2 3\n"}


def test_split_sections_keeps_an_empty_section_empty():
    # a host with no render node emits the gpu sentinel with nothing under it,
    # which must read as "collected, nothing there", not as a missing section
    text = "###stat\ncpu 1 2 3\n###gpu\n###loadavg\n0.1 0.2 0.3 1/2 3\n"
    sections = script.split_sections(text)

    assert sections["gpu"] == ""
    assert "gpu" in sections


def test_split_sections_on_empty_input():
    assert script.split_sections("") == {}


def test_vitals_script_covers_every_vitals_source():
    assert "###stat" in script.VITALS_SCRIPT
    assert "/proc/stat" in script.VITALS_SCRIPT
    assert "###meminfo" in script.VITALS_SCRIPT
    assert "###netdev" in script.VITALS_SCRIPT
    assert "###loadavg" in script.VITALS_SCRIPT
    assert "###uptime" in script.VITALS_SCRIPT


def test_vitals_script_tolerates_a_missing_render_node():
    # the gpu read must not fail the script on the three boxes without /dev/dri
    assert "gt_act_freq_mhz" in script.VITALS_SCRIPT
    assert "2>/dev/null" in script.VITALS_SCRIPT


def test_slow_script_covers_disk_and_temperature():
    assert "###df" in script.SLOW_SCRIPT
    assert "df -Pk" in script.SLOW_SCRIPT
    assert "###hwmon" in script.SLOW_SCRIPT


def test_slow_script_reads_inotify_headroom():
    # meleys ran out of inotify watches once already; a second media server
    # scanning the same libraries doubles the demand, so track the ceiling
    assert "###inotify" in script.SLOW_SCRIPT
    assert "max_user_watches" in script.SLOW_SCRIPT
    assert "max_user_instances" in script.SLOW_SCRIPT


def test_scripts_do_not_use_set_e():
    # a missing optional source must not abort the remaining sections
    assert "set -e" not in script.VITALS_SCRIPT
    assert "set -e" not in script.SLOW_SCRIPT
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx nx run fleet-monitor:test`
Expected: FAIL, `ModuleNotFoundError: No module named 'fleet_monitor.probes.script'`

- [ ] **Step 3: Write the script module**

`apps/fleet-monitor/fleet_monitor/probes/script.py`:

```python
_SENTINEL = "###"

# One script per tick, not one command per metric. With ControlMaster holding
# the connection open, a whole host costs one round trip.
#
# Deliberately no `set -e`: an absent optional source (no render node, no
# hwmon chip) must leave the remaining sections intact rather than truncate
# the response.
VITALS_SCRIPT = """
echo '###stat'; head -n 16 /proc/stat 2>/dev/null
echo '###meminfo'; head -n 8 /proc/meminfo 2>/dev/null
echo '###netdev'; cat /proc/net/dev 2>/dev/null
echo '###loadavg'; cat /proc/loadavg 2>/dev/null
echo '###uptime'; cat /proc/uptime 2>/dev/null
echo '###gpu'
if [ -r /sys/class/drm/card0/gt_act_freq_mhz ]; then
  cat /sys/class/drm/card0/gt_act_freq_mhz /sys/class/drm/card0/gt_max_freq_mhz 2>/dev/null
fi
"""

SLOW_SCRIPT = """
echo '###df'; df -Pk /volume1 2>/dev/null
echo '###hwmon'
for chip in /sys/class/hwmon/hwmon*; do
  name=$(cat "$chip/name" 2>/dev/null) || continue
  for sensor in "$chip"/temp*_input; do
    [ -r "$sensor" ] || continue
    echo "$name $(basename "$sensor")=$(cat "$sensor" 2>/dev/null)"
  done
done
echo '###inotify'
echo "max_user_watches=$(cat /proc/sys/fs/inotify/max_user_watches 2>/dev/null)"
echo "max_user_instances=$(cat /proc/sys/fs/inotify/max_user_instances 2>/dev/null)"
echo "instances_in_use=$(find /proc/*/fd -lname 'anon_inode:inotify' 2>/dev/null | wc -l)"
"""


def split_sections(text: str) -> dict[str, str]:
    """Split a batched response into {section name: body}.

    Anything before the first sentinel is dropped, which absorbs login banners
    and any ssh chatter that survived LogLevel=ERROR. A sentinel with no body
    yields an empty string rather than a missing key: "collected, nothing
    there" and "never collected" are different states and must stay different.
    """
    chunks = text.split(f"{_SENTINEL}")
    named = [chunk.split("\n", 1) for chunk in chunks[1:]]
    return {head.strip(): (rest[0] if rest else "") for head, *rest in named if head.strip()}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx nx run fleet-monitor:test`
Expected: PASS, 27 tests total.

- [ ] **Step 5: Verify the script against a real host end to end**

Run:

```bash
python3 - <<'PY'
import subprocess, sys
sys.path.insert(0, "apps/fleet-monitor")
from fleet_monitor.probes import script, proc, system
out = subprocess.run(
    ["ssh", "-o", "LogLevel=ERROR", "crivas@192.168.50.3", "bash -s"],
    input=script.VITALS_SCRIPT, capture_output=True, text=True,
).stdout
sections = script.split_sections(out)
print("sections:", sorted(sections))
print("cpu samples:", len(proc.parse_stat(sections["stat"])))
print("net samples:", len(proc.parse_net_dev(sections["netdev"])))
print("gpu:", system.parse_gpu_freq(sections["gpu"]))
PY
```

Expected: sections `['gpu', 'loadavg', 'meminfo', 'netdev', 'stat', 'uptime']`, a non-zero cpu and net sample count, and a populated GPU tuple since vermithor has a render node. Repeat against `crivas@192.168.50.4` (caraxes) and confirm `gpu: ()` there.

- [ ] **Step 6: Run lint and commit**

Run: `bunx nx run fleet-monitor:lint:py`

```bash
git add apps/fleet-monitor/fleet_monitor/probes/script.py apps/fleet-monitor/tests/test_probes_script.py
git commit -m "WZ: Batch fleet-monitor host collection into one script per tick

- Send a single sentinel-delimited script per host instead of N commands
- Drop any preamble before the first sentinel so ssh chatter cannot corrupt parsing
- Keep an empty section distinct from a missing one
- Omit set -e so an absent render node cannot truncate the response"
```

---

### Task 5: SSH transport with connection multiplexing

**Files:**

- Create: `apps/fleet-monitor/fleet_monitor/transport/__init__.py`
- Create: `apps/fleet-monitor/fleet_monitor/transport/ssh.py`
- Test: `apps/fleet-monitor/tests/test_transport_ssh.py`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `ssh.SshResult(ok: bool, stdout: str, reason: str)`, a frozen dataclass.
  - `ssh.build_argv(host: str, user: str, control_dir: str, timeout: int) -> tuple[str, ...]`
  - `async ssh.run(host: str, body: str, *, user: str = "crivas", control_dir: str = "/tmp/fm", timeout: int = 15) -> SshResult`
  - `ssh.classify(returncode: int, stderr: str) -> str`

- [ ] **Step 1: Write the failing tests**

`apps/fleet-monitor/tests/test_transport_ssh.py`:

```python
import pytest

from fleet_monitor.transport import ssh


def test_build_argv_multiplexes_and_silences_warnings():
    argv = ssh.build_argv(host="192.168.50.3", user="crivas", control_dir="/tmp/fm", timeout=15)
    joined = " ".join(argv)

    # LogLevel=ERROR is load bearing: current OpenSSH prints a post-quantum
    # key exchange warning on every connection to these DSM boxes
    assert "-oLogLevel=ERROR" in argv
    assert "-oControlMaster=auto" in argv
    assert "-oControlPersist=300" in argv
    assert "-oBatchMode=yes" in argv
    assert "-oConnectTimeout=15" in argv
    assert "/tmp/fm/" in joined
    assert argv[-2:] == ("crivas@192.168.50.3", "bash -s")


def test_build_argv_never_prompts():
    # a prompt would hang the collector forever rather than fail the tick
    argv = ssh.build_argv(host="h", user="u", control_dir="/tmp/fm", timeout=5)
    assert "-oBatchMode=yes" in argv


def test_classify_names_the_reason():
    assert ssh.classify(255, "Connection timed out") == "timeout"
    assert ssh.classify(255, "Permission denied (publickey).") == "auth"
    assert ssh.classify(255, "Connection refused") == "refused"
    assert ssh.classify(255, "No route to host") == "unreachable"
    assert ssh.classify(255, "something else entirely") == "ssh_error"
    assert ssh.classify(1, "") == "command_failed"


@pytest.mark.asyncio
async def test_run_returns_a_typed_failure_for_an_unroutable_host():
    # 192.0.2.1 is TEST-NET-1 and never answers
    result = await ssh.run("192.0.2.1", "echo hi", control_dir="/tmp/fm-test", timeout=2)

    assert result.ok is False
    assert result.stdout == ""
    assert result.reason in {"timeout", "unreachable", "refused", "ssh_error"}


@pytest.mark.asyncio
async def test_run_succeeds_against_localhost_shell():
    # exercises the happy path without needing the LAN: the transport shells
    # out, so a local bash proves the plumbing
    result = await ssh.run_local("echo '###hi'\necho body")

    assert result.ok is True
    assert "###hi" in result.stdout
    assert result.reason == ""
```

- [ ] **Step 2: Enable asyncio tests**

Append to `apps/fleet-monitor/pytest.ini`:

```ini
asyncio_mode = auto
```

Final file:

```ini
[pytest]
pythonpath = .
testpaths = tests
asyncio_mode = auto
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bunx nx run fleet-monitor:test`
Expected: FAIL, `ModuleNotFoundError: No module named 'fleet_monitor.transport'`

- [ ] **Step 4: Write the SSH transport**

`apps/fleet-monitor/fleet_monitor/transport/__init__.py`: empty file.

`apps/fleet-monitor/fleet_monitor/transport/ssh.py`:

```python
import asyncio
import os
from dataclasses import dataclass

# Matched against stderr, most specific first.
_REASONS = (
    ("timed out", "timeout"),
    ("Operation timed out", "timeout"),
    ("Permission denied", "auth"),
    ("Host key verification failed", "auth"),
    ("Connection refused", "refused"),
    ("No route to host", "unreachable"),
    ("Network is unreachable", "unreachable"),
)


@dataclass(frozen=True, slots=True)
class SshResult:
    ok: bool
    stdout: str
    reason: str


def classify(returncode: int, stderr: str) -> str:
    """Name why a run failed. A wrong key and a powered-off NAS must never
    look identical in the incident log."""
    if returncode == 0:
        return ""
    if returncode != 255:
        return "command_failed"
    match = next((name for needle, name in _REASONS if needle in stderr), None)
    return match or "ssh_error"


def build_argv(*, host: str, user: str, control_dir: str, timeout: int) -> tuple[str, ...]:
    """Argv for one multiplexed, non-interactive run.

    ControlMaster plus ControlPersist means the TCP handshake and key exchange
    happen once per five minutes rather than once per tick. BatchMode is what
    keeps a missing key a fast failure instead of a hung prompt.
    """
    return (
        "ssh",
        "-oLogLevel=ERROR",
        "-oBatchMode=yes",
        "-oStrictHostKeyChecking=accept-new",
        "-oControlMaster=auto",
        f"-oControlPath={control_dir}/%r@%h:%p",
        "-oControlPersist=300",
        f"-oConnectTimeout={timeout}",
        f"{user}@{host}",
        "bash -s",
    )


async def _capture(argv: tuple[str, ...], body: str, timeout: int) -> SshResult:
    process = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        raw_out, raw_err = await asyncio.wait_for(
            process.communicate(body.encode()), timeout=timeout * 2
        )
    except TimeoutError:
        process.kill()
        await process.wait()
        return SshResult(ok=False, stdout="", reason="timeout")

    stdout = raw_out.decode(errors="replace")
    stderr = raw_err.decode(errors="replace")
    reason = classify(process.returncode or 0, stderr)
    return SshResult(ok=not reason, stdout=stdout if not reason else "", reason=reason)


async def run(
    host: str,
    body: str,
    *,
    user: str = "crivas",
    control_dir: str = "/tmp/fm",
    timeout: int = 15,
) -> SshResult:
    """Run a script on a host over a multiplexed connection."""
    os.makedirs(control_dir, mode=0o700, exist_ok=True)
    argv = build_argv(host=host, user=user, control_dir=control_dir, timeout=timeout)
    return await _capture(argv, body, timeout)


async def run_local(body: str, *, timeout: int = 15) -> SshResult:
    """Run a script through a local bash. Used by tests to exercise the
    capture path without needing the LAN."""
    return await _capture(("bash", "-s"), body, timeout)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx nx run fleet-monitor:test`
Expected: PASS, 33 tests total. The unroutable-host test takes about 2 seconds.

- [ ] **Step 6: Verify multiplexing actually engages**

Run:

```bash
rm -rf /tmp/fm-bench && python3 - <<'PY'
import asyncio, sys, time
sys.path.insert(0, "apps/fleet-monitor")
from fleet_monitor.transport import ssh

async def main():
    for attempt in range(3):
        start = time.monotonic()
        result = await ssh.run("192.168.50.3", "echo ok", control_dir="/tmp/fm-bench")
        print(attempt, result.ok, result.stdout.strip(), f"{time.monotonic() - start:.3f}s")

asyncio.run(main())
PY
ls /tmp/fm-bench
```

Expected: all three print `True ok`. The first is noticeably slower than the second and third, and `/tmp/fm-bench` contains a `crivas@192.168.50.3:22` socket. That gap is the multiplexing working.

- [ ] **Step 7: Run lint and commit**

Run: `bunx nx run fleet-monitor:lint:py`

```bash
git add apps/fleet-monitor/fleet_monitor/transport apps/fleet-monitor/tests/test_transport_ssh.py apps/fleet-monitor/pytest.ini
git commit -m "WZ: Add a multiplexed ssh transport to fleet-monitor

- Hold one ControlMaster connection per host for five minutes
- Force LogLevel=ERROR so post-quantum warnings cannot corrupt stdout
- Force BatchMode so a missing key fails fast instead of hanging on a prompt
- Classify failures by reason so auth and unreachable stay distinguishable"
```

---

### Task 6: SQLite store with counter rates

**Files:**

- Create: `apps/fleet-monitor/fleet_monitor/store.py`
- Test: `apps/fleet-monitor/tests/test_store.py`

**Interfaces:**

- Consumes: `Sample` from `fleet_monitor.probes.types`.
- Produces:
  - `store.init_db(path: str) -> None`
  - `store.write_samples(path: str, target: str, at: datetime, samples: Iterable[Sample]) -> int`
  - `store.latest(path: str, target: str) -> dict[str, float]`
  - `store.series(path: str, target: str, metric: str, since: datetime) -> tuple[tuple[datetime, float], ...]`
  - `store.rate(previous: tuple[datetime, float], current: tuple[datetime, float]) -> float | None`
  - `store.rate_series(points: Sequence[tuple[datetime, float]]) -> tuple[tuple[datetime, float], ...]`
  - `store.write_heartbeat(path: str, at: datetime) -> None`
  - `store.last_heartbeat(path: str) -> datetime | None`

- [ ] **Step 1: Write the failing tests**

`apps/fleet-monitor/tests/test_store.py`:

```python
from datetime import datetime, timedelta, timezone

from fleet_monitor import store
from fleet_monitor.probes.types import Sample

T0 = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)


def test_write_and_read_latest(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)

    store.write_samples(db, "host:vermithor", T0, [
        Sample(metric="load.1m", value=0.46, kind="gauge"),
        Sample(metric="mem.total_bytes", value=16_642_768_896.0, kind="gauge"),
    ])

    assert store.latest(db, "host:vermithor") == {
        "load.1m": 0.46,
        "mem.total_bytes": 16_642_768_896.0,
    }


def test_latest_returns_the_newest_value_per_metric(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)

    store.write_samples(db, "host:meleys", T0, [Sample("load.1m", 1.01, "gauge")])
    store.write_samples(db, "host:meleys", T0 + timedelta(seconds=30),
                        [Sample("load.1m", 0.75, "gauge")])

    assert store.latest(db, "host:meleys")["load.1m"] == 0.75


def test_latest_is_empty_for_an_unknown_target(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    assert store.latest(db, "host:nope") == {}


def test_series_is_ordered_and_windowed(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    for offset in (0, 30, 60):
        store.write_samples(db, "host:syrax", T0 + timedelta(seconds=offset),
                            [Sample("load.1m", offset / 100, "gauge")])

    points = store.series(db, "host:syrax", "load.1m", since=T0 + timedelta(seconds=15))

    assert [value for _, value in points] == [0.3, 0.6]
    assert points[0][0] == T0 + timedelta(seconds=30)


def test_rate_divides_by_elapsed_seconds():
    assert store.rate((T0, 1000.0), (T0 + timedelta(seconds=10), 2000.0)) == 100.0


def test_rate_returns_none_on_a_counter_reset():
    # a reboot zeroes /proc counters; rendering that as a negative or a huge
    # spike would be a lie, so the delta is dropped
    assert store.rate((T0, 5000.0), (T0 + timedelta(seconds=10), 12.0)) is None


def test_rate_returns_none_on_zero_or_negative_elapsed():
    assert store.rate((T0, 1.0), (T0, 2.0)) is None
    assert store.rate((T0, 1.0), (T0 - timedelta(seconds=5), 2.0)) is None


def test_rate_series_drops_the_reset_pair_and_keeps_the_rest():
    points = (
        (T0, 100.0),
        (T0 + timedelta(seconds=10), 200.0),
        (T0 + timedelta(seconds=20), 5.0),      # reboot
        (T0 + timedelta(seconds=30), 105.0),
    )
    got = store.rate_series(points)

    assert [value for _, value in got] == [10.0, 10.0]
    assert [at for at, _ in got] == [T0 + timedelta(seconds=10), T0 + timedelta(seconds=30)]


def test_rate_series_needs_two_points():
    assert store.rate_series(((T0, 1.0),)) == ()
    assert store.rate_series(()) == ()


def test_heartbeat_roundtrips(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)

    assert store.last_heartbeat(db) is None
    store.write_heartbeat(db, T0)
    assert store.last_heartbeat(db) == T0


def test_init_db_is_idempotent(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    store.write_samples(db, "host:vhagar", T0, [Sample("load.1m", 0.14, "gauge")])
    store.init_db(db)

    assert store.latest(db, "host:vhagar")["load.1m"] == 0.14
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx nx run fleet-monitor:test`
Expected: FAIL, `ModuleNotFoundError: No module named 'fleet_monitor.store'`

- [ ] **Step 3: Write the store**

`apps/fleet-monitor/fleet_monitor/store.py`:

```python
import sqlite3
from collections.abc import Iterable, Sequence
from datetime import datetime

from fleet_monitor.probes.types import Sample

_SAMPLES_SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
    target TEXT NOT NULL,
    metric TEXT NOT NULL,
    at     TEXT NOT NULL,
    value  REAL NOT NULL,
    kind   TEXT NOT NULL
)
"""

_SAMPLES_INDEX = """
CREATE INDEX IF NOT EXISTS ix_samples_lookup ON samples (target, metric, at)
"""

_HEARTBEAT_SCHEMA = """
CREATE TABLE IF NOT EXISTS heartbeat (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    at TEXT NOT NULL
)
"""


def _conn(path: str) -> sqlite3.Connection:
    """Open the SQLite file in WAL mode so a read never blocks a tick's write."""
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    return connection


def init_db(path: str) -> None:
    with _conn(path) as connection:
        connection.execute(_SAMPLES_SCHEMA)
        connection.execute(_SAMPLES_INDEX)
        connection.execute(_HEARTBEAT_SCHEMA)


def write_samples(path: str, target: str, at: datetime, samples: Iterable[Sample]) -> int:
    """Insert one tick's samples in a single transaction.

    Batched on purpose: a crash mid-tick then loses that tick and nothing else.
    """
    stamp = at.isoformat()
    rows = [(target, s.metric, stamp, s.value, s.kind) for s in samples]
    if not rows:
        return 0
    with _conn(path) as connection:
        connection.executemany(
            "INSERT INTO samples (target, metric, at, value, kind) VALUES (?, ?, ?, ?, ?)",
            rows,
        )
    return len(rows)


def latest(path: str, target: str) -> dict[str, float]:
    """The newest value of every metric for one target."""
    with _conn(path) as connection:
        rows = connection.execute(
            """
            SELECT metric, value FROM samples
            WHERE target = ? AND at = (
                SELECT MAX(at) FROM samples AS inner
                WHERE inner.target = samples.target AND inner.metric = samples.metric
            )
            """,
            (target,),
        ).fetchall()
    return {row["metric"]: row["value"] for row in rows}


def series(
    path: str, target: str, metric: str, since: datetime
) -> tuple[tuple[datetime, float], ...]:
    with _conn(path) as connection:
        rows = connection.execute(
            "SELECT at, value FROM samples "
            "WHERE target = ? AND metric = ? AND at >= ? ORDER BY at",
            (target, metric, since.isoformat()),
        ).fetchall()
    return tuple((datetime.fromisoformat(row["at"]), row["value"]) for row in rows)


def rate(
    previous: tuple[datetime, float], current: tuple[datetime, float]
) -> float | None:
    """Per-second rate between two counter readings, or None when the pair is
    unusable.

    Counters are stored raw and converted here rather than at write time, so a
    reboot is detectable: the counter goes backwards, and that one delta is
    dropped instead of being rendered as a spike.
    """
    (previous_at, previous_value), (current_at, current_value) = previous, current
    elapsed = (current_at - previous_at).total_seconds()
    if elapsed <= 0 or current_value < previous_value:
        return None
    return (current_value - previous_value) / elapsed


def rate_series(
    points: Sequence[tuple[datetime, float]],
) -> tuple[tuple[datetime, float], ...]:
    """Convert a counter series into a rate series, dropping reset pairs."""
    pairs = zip(points, points[1:], strict=False)
    computed = ((current[0], rate(previous, current)) for previous, current in pairs)
    return tuple((at, value) for at, value in computed if value is not None)


def write_heartbeat(path: str, at: datetime) -> None:
    """Record that a collection round completed.

    The collector runs on a box it also monitors, so it cannot report that box
    being down. The UI reads this to show staleness instead of a frozen green
    dashboard.
    """
    with _conn(path) as connection:
        connection.execute(
            "INSERT INTO heartbeat (id, at) VALUES (1, ?) "
            "ON CONFLICT(id) DO UPDATE SET at = excluded.at",
            (at.isoformat(),),
        )


def last_heartbeat(path: str) -> datetime | None:
    with _conn(path) as connection:
        row = connection.execute("SELECT at FROM heartbeat WHERE id = 1").fetchone()
    return datetime.fromisoformat(row["at"]) if row else None
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx nx run fleet-monitor:test`
Expected: PASS, 44 tests total.

- [ ] **Step 5: Run lint and commit**

Run: `bunx nx run fleet-monitor:lint:py`

```bash
git add apps/fleet-monitor/fleet_monitor/store.py apps/fleet-monitor/tests/test_store.py
git commit -m "WZ: Add the fleet-monitor SQLite store

- Store counters raw and derive rates at read time
- Drop the delta across a counter reset rather than rendering a reboot spike
- Batch each tick into one transaction so a crash costs at most one tick
- Record a heartbeat so a dead collector reads as stale, not as healthy"
```

---

### Task 7: Rollups and retention

**Files:**

- Create: `apps/fleet-monitor/fleet_monitor/rollups.py`
- Test: `apps/fleet-monitor/tests/test_rollups.py`

**Interfaces:**

- Consumes: `store._conn`, `store.init_db`.
- Produces:
  - `rollups.init_db(path: str) -> None`
  - `rollups.bucket(at: datetime, seconds: int) -> datetime`
  - `rollups.compact(path: str, resolution: str, now: datetime) -> int`
  - `rollups.prune(path: str, now: datetime) -> dict[str, int]`
  - `rollups.RETENTION: dict[str, timedelta]`

Retention: raw samples 7 days, `rollup_5m` 90 days, `rollup_1h` 2 years. At roughly 200 series on a 30 second tick this keeps the database in the tens of megabytes, which matters because the collector's host is the box at 99% disk.

- [ ] **Step 1: Write the failing tests**

`apps/fleet-monitor/tests/test_rollups.py`:

```python
from datetime import datetime, timedelta, timezone

from fleet_monitor import rollups, store
from fleet_monitor.probes.types import Sample

T0 = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)


def _prepare(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    rollups.init_db(db)
    return db


def test_bucket_floors_to_the_resolution():
    at = datetime(2026, 8, 10, 12, 7, 43, tzinfo=timezone.utc)

    assert rollups.bucket(at, 300) == datetime(2026, 8, 10, 12, 5, tzinfo=timezone.utc)
    assert rollups.bucket(at, 3600) == datetime(2026, 8, 10, 12, 0, tzinfo=timezone.utc)


def test_compact_writes_min_max_avg_per_bucket(tmp_path):
    db = _prepare(tmp_path)
    for offset, value in ((0, 1.0), (60, 3.0), (120, 2.0)):
        store.write_samples(db, "host:meleys", T0 + timedelta(seconds=offset),
                            [Sample("load.1m", value, "gauge")])

    written = rollups.compact(db, "5m", now=T0 + timedelta(hours=1))

    assert written == 1
    rows = rollups.read(db, "5m", "host:meleys", "load.1m")
    assert rows == ((T0, 1.0, 3.0, 2.0, 3),)


def test_compact_does_not_touch_the_current_bucket(tmp_path):
    # the bucket still filling would be compacted from partial data and then
    # never corrected, so it is left alone until it closes
    db = _prepare(tmp_path)
    store.write_samples(db, "host:meleys", T0, [Sample("load.1m", 1.0, "gauge")])

    assert rollups.compact(db, "5m", now=T0 + timedelta(seconds=30)) == 0


def test_compact_is_idempotent(tmp_path):
    db = _prepare(tmp_path)
    store.write_samples(db, "host:meleys", T0, [Sample("load.1m", 1.0, "gauge")])

    rollups.compact(db, "5m", now=T0 + timedelta(hours=1))
    rollups.compact(db, "5m", now=T0 + timedelta(hours=1))

    assert len(rollups.read(db, "5m", "host:meleys", "load.1m")) == 1


def test_prune_drops_raw_samples_past_retention(tmp_path):
    db = _prepare(tmp_path)
    store.write_samples(db, "host:syrax", T0 - timedelta(days=8),
                        [Sample("load.1m", 9.0, "gauge")])
    store.write_samples(db, "host:syrax", T0, [Sample("load.1m", 1.0, "gauge")])

    dropped = rollups.prune(db, now=T0)

    assert dropped["samples"] == 1
    assert store.latest(db, "host:syrax")["load.1m"] == 1.0


def test_prune_keeps_rollups_longer_than_raw(tmp_path):
    db = _prepare(tmp_path)
    assert rollups.RETENTION["samples"] == timedelta(days=7)
    assert rollups.RETENTION["rollup_5m"] == timedelta(days=90)
    assert rollups.RETENTION["rollup_1h"] == timedelta(days=730)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx nx run fleet-monitor:test`
Expected: FAIL, `ModuleNotFoundError: No module named 'fleet_monitor.rollups'`

- [ ] **Step 3: Write the rollups module**

`apps/fleet-monitor/fleet_monitor/rollups.py`:

```python
from datetime import datetime, timedelta, timezone

from fleet_monitor.store import _conn

RESOLUTIONS = {"5m": 300, "1h": 3600}

RETENTION = {
    "samples": timedelta(days=7),
    "rollup_5m": timedelta(days=90),
    "rollup_1h": timedelta(days=730),
}

_ROLLUP_SCHEMA = """
CREATE TABLE IF NOT EXISTS rollup_{name} (
    target     TEXT NOT NULL,
    metric     TEXT NOT NULL,
    bucket     TEXT NOT NULL,
    min_value  REAL NOT NULL,
    max_value  REAL NOT NULL,
    avg_value  REAL NOT NULL,
    sample_count INTEGER NOT NULL,
    PRIMARY KEY (target, metric, bucket)
)
"""


def init_db(path: str) -> None:
    with _conn(path) as connection:
        for name in RESOLUTIONS:
            connection.execute(_ROLLUP_SCHEMA.format(name=name))


def bucket(at: datetime, seconds: int) -> datetime:
    """Floor a timestamp to its bucket start."""
    epoch = int(at.timestamp())
    return datetime.fromtimestamp(epoch - (epoch % seconds), tz=timezone.utc)


def compact(path: str, resolution: str, now: datetime) -> int:
    """Aggregate closed buckets into the rollup table.

    The bucket containing `now` is skipped: compacting it would freeze partial
    data that later samples would never correct.
    """
    seconds = RESOLUTIONS[resolution]
    cutoff = bucket(now, seconds).isoformat()
    with _conn(path) as connection:
        cursor = connection.execute(
            f"""
            INSERT INTO rollup_{resolution}
                (target, metric, bucket, min_value, max_value, avg_value, sample_count)
            SELECT target, metric,
                   strftime('%Y-%m-%dT%H:%M:%S+00:00',
                            (CAST(strftime('%s', at) AS INTEGER) / {seconds}) * {seconds},
                            'unixepoch') AS b,
                   MIN(value), MAX(value), AVG(value), COUNT(*)
            FROM samples
            WHERE at < ?
            GROUP BY target, metric, b
            ON CONFLICT(target, metric, bucket) DO UPDATE SET
                min_value = excluded.min_value,
                max_value = excluded.max_value,
                avg_value = excluded.avg_value,
                sample_count = excluded.sample_count
            """,
            (cutoff,),
        )
        return cursor.rowcount


def read(
    path: str, resolution: str, target: str, metric: str
) -> tuple[tuple[datetime, float, float, float, int], ...]:
    with _conn(path) as connection:
        rows = connection.execute(
            f"SELECT bucket, min_value, max_value, avg_value, sample_count "
            f"FROM rollup_{resolution} WHERE target = ? AND metric = ? ORDER BY bucket",
            (target, metric),
        ).fetchall()
    return tuple(
        (
            datetime.fromisoformat(row["bucket"]),
            row["min_value"],
            row["max_value"],
            row["avg_value"],
            row["sample_count"],
        )
        for row in rows
    )


def prune(path: str, now: datetime) -> dict[str, int]:
    """Drop rows past their retention window, newest resolution first."""
    with _conn(path) as connection:
        return {
            table: connection.execute(
                f"DELETE FROM {table} WHERE {'at' if table == 'samples' else 'bucket'} < ?",
                ((now - window).isoformat(),),
            ).rowcount
            for table, window in RETENTION.items()
        }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx nx run fleet-monitor:test`
Expected: PASS, 50 tests total.

- [ ] **Step 5: Run lint and commit**

```bash
git add apps/fleet-monitor/fleet_monitor/rollups.py apps/fleet-monitor/tests/test_rollups.py
git commit -m "WZ: Add fleet-monitor rollups and retention

- Compact closed buckets into 5m and 1h min/max/avg rows
- Leave the filling bucket alone so partial data is never frozen
- Prune raw at 7d, 5m at 90d, 1h at 2y to keep the db small on a 99% volume"
```

---

### Task 8: Docker container state

**Files:**

- Create: `apps/fleet-monitor/fleet_monitor/probes/docker.py`
- Create: `apps/fleet-monitor/fleet_monitor/transport/http.py`
- Test: `apps/fleet-monitor/tests/test_probes_docker.py`
- Test: `apps/fleet-monitor/tests/test_transport_http.py`

**Interfaces:**

- Consumes: `Sample` from `fleet_monitor.probes.types`.
- Produces:
  - `docker.ContainerState(name: str, running: bool, health: str, restart_count: int, started_at: str)`, frozen dataclass.
  - `docker.parse_containers(payload: list[dict]) -> tuple[ContainerState, ...]`
  - `docker.to_samples(states: Iterable[ContainerState]) -> tuple[Sample, ...]`
  - `http.HttpResult(ok: bool, status: int, body: str, reason: str)`, frozen dataclass.
  - `async http.get_json(url: str, *, timeout: float = 8.0, headers: dict[str, str] | None = None) -> HttpResult`

Container data comes from the Docker Engine API `GET /containers/json?all=1`, reached through the local socket on vermithor and a read-only socket proxy on meleys. No sudo password ever lives in the collector.

- [ ] **Step 1: Write the failing tests**

`apps/fleet-monitor/tests/test_probes_docker.py`:

```python
from fleet_monitor.probes import docker


def _payload(**overrides):
    base = {
        "Names": ["/sonarr"],
        "State": "running",
        "Status": "Up 11 days",
        "Labels": {},
    }
    return {**base, **overrides}


def test_parse_containers_strips_the_leading_slash():
    states = docker.parse_containers([_payload()])

    assert states[0].name == "sonarr"
    assert states[0].running is True


def test_parse_containers_reads_health_from_the_status_string():
    states = docker.parse_containers([_payload(Status="Up 8 days (healthy)")])
    assert states[0].health == "healthy"

    states = docker.parse_containers([_payload(Status="Up 2 minutes (unhealthy)")])
    assert states[0].health == "unhealthy"

    states = docker.parse_containers([_payload(Status="Up 11 days")])
    assert states[0].health == "none"


def test_parse_containers_marks_a_stopped_container_down():
    states = docker.parse_containers([_payload(State="exited", Status="Exited (0) 3 hours ago")])

    assert states[0].running is False
    assert states[0].health == "none"


def test_parse_containers_handles_a_missing_names_field():
    # a malformed payload must not kill the tick
    assert docker.parse_containers([{"State": "running"}]) == ()


def test_parse_containers_on_empty_payload():
    assert docker.parse_containers([]) == ()


def test_to_samples_emits_up_and_restart_gauges():
    states = docker.parse_containers([
        _payload(Names=["/sonarr"]),
        _payload(Names=["/radarr"], State="exited", Status="Exited (0) 3 hours ago"),
    ])
    got = {s.metric: s.value for s in docker.to_samples(states)}

    assert got["container.sonarr.up"] == 1.0
    assert got["container.radarr.up"] == 0.0
    assert got["container.sonarr.healthy"] == 1.0
```

`apps/fleet-monitor/tests/test_transport_http.py`:

```python
from fleet_monitor.transport import http


async def test_get_json_returns_a_typed_failure_for_a_dead_port():
    # port 1 on localhost refuses; the collector must degrade, not raise
    result = await http.get_json("http://127.0.0.1:1/containers/json", timeout=2.0)

    assert result.ok is False
    assert result.reason in {"refused", "timeout", "transport_error"}
    assert result.status == 0


async def test_get_json_reports_a_bad_url_as_a_typed_failure():
    result = await http.get_json("http://nonexistent.invalid/x", timeout=2.0)

    assert result.ok is False
    assert result.reason in {"dns", "timeout", "transport_error"}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx nx run fleet-monitor:test`
Expected: FAIL, `ModuleNotFoundError` for both new modules.

- [ ] **Step 3: Write the HTTP transport**

`apps/fleet-monitor/fleet_monitor/transport/http.py`:

```python
from dataclasses import dataclass

import httpx


@dataclass(frozen=True, slots=True)
class HttpResult:
    ok: bool
    status: int
    body: str
    reason: str


def _classify(error: Exception) -> str:
    if isinstance(error, httpx.ConnectTimeout | httpx.ReadTimeout):
        return "timeout"
    if isinstance(error, httpx.ConnectError):
        text = str(error)
        if "Name or service not known" in text or "nodename nor servname" in text:
            return "dns"
        return "refused"
    return "transport_error"


async def get_json(
    url: str, *, timeout: float = 8.0, headers: dict[str, str] | None = None
) -> HttpResult:
    """GET a URL, never raising. A dead endpoint degrades that target only."""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(url, headers=headers or {})
    except Exception as error:  # noqa: BLE001 - a tick must survive any transport fault
        return HttpResult(ok=False, status=0, body="", reason=_classify(error))

    ok = 200 <= response.status_code < 300
    return HttpResult(
        ok=ok,
        status=response.status_code,
        body=response.text,
        reason="" if ok else f"http_{response.status_code}",
    )
```

- [ ] **Step 4: Write the docker probe**

`apps/fleet-monitor/fleet_monitor/probes/docker.py`:

```python
from collections.abc import Iterable
from dataclasses import dataclass

from fleet_monitor.probes.types import Sample


@dataclass(frozen=True, slots=True)
class ContainerState:
    name: str
    running: bool
    health: str
    status: str


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
            status=entry.get("Status", ""),
        )
        for entry, names in named
        if names and isinstance(names[0], str)
    )


def to_samples(states: Iterable[ContainerState]) -> tuple[Sample, ...]:
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
        )
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx nx run fleet-monitor:test`
Expected: PASS, 59 tests total.

- [ ] **Step 6: Stand up the read-only socket proxy on meleys and vhagar**

This is the only change made to a NAS box in Phase 1, and it adds no write capability.
Do it on **both** remote Docker hosts. Vermithor needs no proxy: the collector runs there
and reads the local socket directly.

Create `/volume1/docker/fleet-monitor/docker-compose.yml` on meleys **and vhagar**:

```yaml
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy:latest
    container_name: docker-socket-proxy
    restart: unless-stopped
    ports:
      - '2375:2375'
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    environment:
      CONTAINERS: 1
      POST: 0
      EXEC: 0
      IMAGES: 0
      NETWORKS: 0
      VOLUMES: 0
```

`POST: 0` is what makes this read-only: no start, stop, restart, or exec can pass through it.

Verify both, and note that on vhagar `/volume1/docker` is created mode `000` with a
Synology ACL, so the compose directory needs `chmod 755` before anything can read it:

```bash
NAS=/Users/chesterrivas/.claude/skills/synology-nas-ssh/scripts/nas
for h in meleys:192.168.50.2 vhagar:192.168.50.6; do
  name="${h%%:*}"; ip="${h##*:}"
  $NAS sudo "$name" 'chmod -R 755 /volume1/docker/fleet-monitor'
  $NAS docker "$name" compose -f /volume1/docker/fleet-monitor/docker-compose.yml up -d
  echo "$name GET:  $(curl -s -o /dev/null -w '%{http_code}' "http://$ip:2375/containers/json?all=1")"
  echo "$name POST: $(curl -s -o /dev/null -w '%{http_code}' -X POST "http://$ip:2375/containers/x/restart")"
done
```

Expected: `GET 200` and `POST 403` on both. If a POST returns anything else, stop and fix the proxy config before continuing.

- [ ] **Step 7: Verify the probe against both hosts**

Run:

```bash
python3 - <<'PY'
import asyncio, json, sys
sys.path.insert(0, "apps/fleet-monitor")
from fleet_monitor.probes import docker
from fleet_monitor.transport import http

async def main():
    result = await http.get_json("http://192.168.50.2:2375/containers/json?all=1")
    states = docker.parse_containers(json.loads(result.body))
    for s in states:
        print(f"{s.name:20} running={s.running} health={s.health}")

asyncio.run(main())
PY
```

Expected: six containers on meleys (`sonarr`, `sabnzbd`, `radarr`, `stripe-bridge`, `wizarr`, `tautulli`), with `wizarr` and `tautulli` reporting `healthy`. Repeat against `192.168.50.6` and expect `jellyfin` plus the socket proxy.

- [ ] **Step 8: Run lint and commit**

```bash
git add apps/fleet-monitor/fleet_monitor/probes/docker.py apps/fleet-monitor/fleet_monitor/transport/http.py apps/fleet-monitor/tests/test_probes_docker.py apps/fleet-monitor/tests/test_transport_http.py
git commit -m "WZ: Add container state collection to fleet-monitor

- Parse GET /containers/json into typed container state
- Skip malformed entries so one bad row cannot cost the host's whole view
- Add an async http transport that returns typed failures instead of raising
- Reach meleys through a read-only socket proxy, so no sudo password is stored"
```

---

### Task 9: Incident state machine

**Files:**

- Create: `apps/fleet-monitor/fleet_monitor/incidents.py`
- Test: `apps/fleet-monitor/tests/test_incidents.py`

**Interfaces:**

- Consumes: `store._conn`.
- Produces:
  - `incidents.init_db(path: str) -> None`
  - `incidents.CheckResult(target: str, ok: bool, reason: str)`, frozen dataclass.
  - `incidents.record(path: str, result: CheckResult, at: datetime, *, threshold: int = 2) -> str | None`
  - `incidents.open_incidents(path: str) -> tuple[dict, ...]`
  - `incidents.history(path: str, since: datetime) -> tuple[dict, ...]`
  - `incidents.uptime_percent(path: str, target: str, since: datetime, now: datetime) -> float`
  - `incidents.retire_absent(path: str, prefix: str, seen: Collection[str], at: datetime) -> int`

Hysteresis is the whole point: an incident opens on the second consecutive failure and closes on the second consecutive success. A monitor that pages on one dropped packet is a monitor that gets ignored.

`retire_absent` exists because the container set is not fixed. Adding Jellyfin to meleys, renaming a container, or recreating a stack all change which targets exist. Without retirement, a container that is removed while it happens to be down leaves an incident open forever, and `uptime_percent` counts it as down for eternity. Targets are discovered, so they must also be retirable.

- [ ] **Step 1: Write the failing tests**

`apps/fleet-monitor/tests/test_incidents.py`:

```python
from datetime import datetime, timedelta, timezone

from fleet_monitor import incidents

T0 = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)


def _db(tmp_path):
    path = str(tmp_path / "fleet.db")
    incidents.init_db(path)
    return path


def _feed(path, target, flags, *, start=T0, step=30):
    return [
        incidents.record(
            path,
            incidents.CheckResult(target=target, ok=ok, reason="" if ok else "refused"),
            start + timedelta(seconds=step * index),
        )
        for index, ok in enumerate(flags)
    ]


def test_a_single_failure_does_not_open_an_incident(tmp_path):
    path = _db(tmp_path)
    _feed(path, "container:meleys/sonarr", [True, False, True])

    assert incidents.open_incidents(path) == ()


def test_two_consecutive_failures_open_an_incident(tmp_path):
    path = _db(tmp_path)
    _feed(path, "container:meleys/sonarr", [True, False, False])

    open_rows = incidents.open_incidents(path)
    assert len(open_rows) == 1
    assert open_rows[0]["target"] == "container:meleys/sonarr"
    assert open_rows[0]["reason"] == "refused"
    assert open_rows[0]["closed_at"] is None


def test_two_consecutive_successes_close_it(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:caraxes", [False, False, True, True])

    assert incidents.open_incidents(path) == ()
    closed = incidents.history(path, since=T0 - timedelta(hours=1))
    assert len(closed) == 1
    assert closed[0]["closed_at"] is not None


def test_a_flap_inside_an_open_incident_does_not_close_it(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:caraxes", [False, False, True, False, False])

    assert len(incidents.open_incidents(path)) == 1


def test_a_second_outage_opens_a_second_incident(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:syrax", [False, False, True, True, False, False])

    assert len(incidents.open_incidents(path)) == 1
    assert len(incidents.history(path, since=T0 - timedelta(hours=1))) == 2


def test_uptime_percent_over_a_window(tmp_path):
    path = _db(tmp_path)
    # down for the middle 30 minutes of a 60 minute window
    incidents.record(path, incidents.CheckResult("host:vhagar", False, "timeout"), T0)
    incidents.record(path, incidents.CheckResult("host:vhagar", False, "timeout"),
                     T0 + timedelta(seconds=30))
    incidents.record(path, incidents.CheckResult("host:vhagar", True, ""),
                     T0 + timedelta(minutes=30))
    incidents.record(path, incidents.CheckResult("host:vhagar", True, ""),
                     T0 + timedelta(minutes=30, seconds=30))

    got = incidents.uptime_percent(path, "host:vhagar", since=T0, now=T0 + timedelta(hours=1))

    assert 49.0 < got < 51.0


def test_uptime_is_100_with_no_incidents(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:vermithor", [True, True, True])

    assert incidents.uptime_percent(
        path, "host:vermithor", since=T0, now=T0 + timedelta(hours=1)
    ) == 100.0


def test_an_always_healthy_target_never_appears_in_history(tmp_path):
    path = _db(tmp_path)
    _feed(path, "host:vermithor", [True, True, True, True])

    assert incidents.history(path, since=T0 - timedelta(hours=1)) == ()


def test_retire_absent_closes_an_incident_for_a_removed_container(tmp_path):
    # a container removed while down would otherwise stay "open" forever and
    # drag its uptime toward zero for eternity
    path = _db(tmp_path)
    _feed(path, "container:meleys/oldapp", [False, False])
    assert len(incidents.open_incidents(path)) == 1

    closed = incidents.retire_absent(
        path, prefix="container:meleys/", seen={"sonarr", "radarr"}, at=T0 + timedelta(minutes=5)
    )

    assert closed == 1
    assert incidents.open_incidents(path) == ()
    assert incidents.history(path, since=T0 - timedelta(hours=1))[0]["reason"] == "removed"


def test_retire_absent_leaves_a_still_present_container_alone(tmp_path):
    path = _db(tmp_path)
    _feed(path, "container:meleys/sonarr", [False, False])

    closed = incidents.retire_absent(
        path, prefix="container:meleys/", seen={"sonarr"}, at=T0 + timedelta(minutes=5)
    )

    assert closed == 0
    assert len(incidents.open_incidents(path)) == 1


def test_retire_absent_does_not_reach_across_hosts(tmp_path):
    # vermithor and meleys both run a container called sonarr; retiring one
    # host's set must never touch the other's
    path = _db(tmp_path)
    _feed(path, "container:vermithor/sonarr", [False, False])

    closed = incidents.retire_absent(
        path, prefix="container:meleys/", seen=set(), at=T0 + timedelta(minutes=5)
    )

    assert closed == 0
    assert len(incidents.open_incidents(path)) == 1


def test_a_newly_discovered_container_needs_no_special_casing(tmp_path):
    # adding jellyfin to meleys must just work: first check, then normal rules
    path = _db(tmp_path)
    _feed(path, "container:meleys/jellyfin", [True, True])

    assert incidents.open_incidents(path) == ()
    assert incidents.uptime_percent(
        path, "container:meleys/jellyfin", since=T0, now=T0 + timedelta(hours=1)
    ) == 100.0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx nx run fleet-monitor:test`
Expected: FAIL, `ModuleNotFoundError: No module named 'fleet_monitor.incidents'`

- [ ] **Step 3: Write the incident module**

`apps/fleet-monitor/fleet_monitor/incidents.py`:

```python
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime

from fleet_monitor.store import _conn

_INCIDENTS_SCHEMA = """
CREATE TABLE IF NOT EXISTS incidents (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    target    TEXT NOT NULL,
    reason    TEXT NOT NULL DEFAULT '',
    opened_at TEXT NOT NULL,
    closed_at TEXT
)
"""

_STREAK_SCHEMA = """
CREATE TABLE IF NOT EXISTS check_streak (
    target     TEXT PRIMARY KEY,
    ok_run     INTEGER NOT NULL DEFAULT 0,
    fail_run   INTEGER NOT NULL DEFAULT 0,
    last_at    TEXT NOT NULL
)
"""


@dataclass(frozen=True, slots=True)
class CheckResult:
    target: str
    ok: bool
    reason: str = ""


def init_db(path: str) -> None:
    with _conn(path) as connection:
        connection.execute(_INCIDENTS_SCHEMA)
        connection.execute(_STREAK_SCHEMA)
        connection.execute(
            "CREATE INDEX IF NOT EXISTS ix_incidents_target ON incidents (target, opened_at)"
        )


def record(
    path: str, result: CheckResult, at: datetime, *, threshold: int = 2
) -> str | None:
    """Fold one check into the streak, opening or closing an incident on the
    threshold. Returns "opened", "closed", or None.

    Hysteresis is deliberate. A single dropped packet is not an outage, and a
    monitor that fires on one gets ignored, which is worse than no monitor.
    """
    with _conn(path) as connection:
        row = connection.execute(
            "SELECT ok_run, fail_run FROM check_streak WHERE target = ?", (result.target,)
        ).fetchone()
        ok_run = (row["ok_run"] if row else 0) + 1 if result.ok else 0
        fail_run = 0 if result.ok else (row["fail_run"] if row else 0) + 1

        connection.execute(
            "INSERT INTO check_streak (target, ok_run, fail_run, last_at) "
            "VALUES (?, ?, ?, ?) ON CONFLICT(target) DO UPDATE SET "
            "ok_run = excluded.ok_run, fail_run = excluded.fail_run, last_at = excluded.last_at",
            (result.target, ok_run, fail_run, at.isoformat()),
        )

        current = connection.execute(
            "SELECT id FROM incidents WHERE target = ? AND closed_at IS NULL",
            (result.target,),
        ).fetchone()

        if fail_run >= threshold and current is None:
            connection.execute(
                "INSERT INTO incidents (target, reason, opened_at) VALUES (?, ?, ?)",
                (result.target, result.reason, at.isoformat()),
            )
            return "opened"

        if ok_run >= threshold and current is not None:
            connection.execute(
                "UPDATE incidents SET closed_at = ? WHERE id = ?", (at.isoformat(), current["id"])
            )
            return "closed"

    return None


def _rows(path: str, sql: str, params: tuple) -> tuple[dict, ...]:
    with _conn(path) as connection:
        return tuple(dict(row) for row in connection.execute(sql, params).fetchall())


def open_incidents(path: str) -> tuple[dict, ...]:
    return _rows(
        path,
        "SELECT * FROM incidents WHERE closed_at IS NULL ORDER BY opened_at DESC",
        (),
    )


def history(path: str, since: datetime) -> tuple[dict, ...]:
    return _rows(
        path,
        "SELECT * FROM incidents WHERE opened_at >= ? ORDER BY opened_at DESC",
        (since.isoformat(),),
    )


def retire_absent(path: str, prefix: str, seen: Collection[str], at: datetime) -> int:
    """Close open incidents under `prefix` whose suffix is no longer present.

    Targets are discovered, not declared: a stack gains Jellyfin, loses an app,
    or renames one. Without this, a container removed while down keeps an
    incident open forever and drags its uptime toward zero.

    The prefix is per host on purpose. Both vermithor and meleys run a
    container named sonarr, so retiring one host's set must never reach into
    the other's.
    """
    present = frozenset(seen)
    with _conn(path) as connection:
        stale = [
            (row["id"], row["target"])
            for row in connection.execute(
                "SELECT id, target FROM incidents "
                "WHERE closed_at IS NULL AND target LIKE ? || '%'",
                (prefix,),
            ).fetchall()
            if row["target"].removeprefix(prefix) not in present
        ]
        connection.executemany(
            "UPDATE incidents SET closed_at = ?, reason = 'removed' WHERE id = ?",
            [(at.isoformat(), incident_id) for incident_id, _ in stale],
        )
        # drop the streak too, so a container that comes back under the same
        # name starts clean rather than inheriting its old failure run
        connection.executemany(
            "DELETE FROM check_streak WHERE target = ?",
            [(target,) for _, target in stale],
        )
    return len(stale)


def uptime_percent(path: str, target: str, since: datetime, now: datetime) -> float:
    """Percentage of the window the target was not inside an open incident.

    An incident still open at `now` counts as down through `now`; one that
    opened before the window is clipped to the window start.
    """
    window = (now - since).total_seconds()
    if window <= 0:
        return 100.0

    rows = _rows(
        path,
        "SELECT opened_at, closed_at FROM incidents "
        "WHERE target = ? AND (closed_at IS NULL OR closed_at >= ?)",
        (target, since.isoformat()),
    )
    down = sum(
        (min(closed, now) - max(opened, since)).total_seconds()
        for opened, closed in (
            (
                datetime.fromisoformat(row["opened_at"]),
                datetime.fromisoformat(row["closed_at"]) if row["closed_at"] else now,
            )
            for row in rows
        )
        if min(closed, now) > max(opened, since)
    )
    return round(max(0.0, (window - down) / window) * 100.0, 3)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bunx nx run fleet-monitor:test`
Expected: PASS, 71 tests total.

- [ ] **Step 5: Run lint and commit**

```bash
git add apps/fleet-monitor/fleet_monitor/incidents.py apps/fleet-monitor/tests/test_incidents.py
git commit -m "WZ: Add the fleet-monitor incident state machine

- Open on two consecutive failures, close on two consecutive successes
- Keep a flap inside an open incident from closing it early
- Compute uptime percent by clipping incidents to the requested window"
```

---

### Task 10: Collector and configuration

**Files:**

- Create: `apps/fleet-monitor/fleet_monitor/config.py`
- Create: `apps/fleet-monitor/fleet_monitor/collector.py`
- Test: `apps/fleet-monitor/tests/test_config.py`
- Test: `apps/fleet-monitor/tests/test_collector.py`

**Interfaces:**

- Consumes: everything above.
- Produces:
  - `config.Host(name: str, ip: str, has_gpu: bool, docker_url: str)`, frozen dataclass.
  - `config.HOSTS: tuple[Host, ...]`
  - `config.db_path() -> str`
  - `collector.samples_from_sections(sections: dict[str, str]) -> tuple[Sample, ...]`
  - `async collector.collect_host(host: Host, at: datetime, db: str) -> CheckResult`
  - `async collector.collect_containers(host: Host, at: datetime, db: str) -> tuple[CheckResult, ...]`
  - `async collector.tick(at: datetime, db: str) -> tuple[CheckResult, ...]`
  - `async collector.run_forever(db: str) -> None`

- [ ] **Step 1: Write the failing tests**

`apps/fleet-monitor/tests/test_config.py`:

```python
from fleet_monitor import config


def test_every_fleet_host_is_configured():
    assert {h.name for h in config.HOSTS} == {
        "vermithor", "meleys", "syrax", "vhagar", "caraxes"
    }


def test_only_vermithor_and_vhagar_have_a_render_node():
    # measured 2026-08-10: meleys is AMD, syrax is Atom, caraxes is ARM
    assert {h.name for h in config.HOSTS if h.has_gpu} == {"vermithor", "vhagar"}


def test_the_three_docker_hosts_are_configured():
    # vhagar joined on 2026-08-11 when Jellyfin was installed there; caraxes is
    # aarch64 and Synology's Container Manager is x86-only, so it never will
    assert {h.name for h in config.HOSTS if h.docker_url} == {
        "vermithor", "meleys", "vhagar"
    }


def test_ips_match_the_fleet():
    by_name = {h.name: h.ip for h in config.HOSTS}
    assert by_name["meleys"] == "192.168.50.2"
    assert by_name["vermithor"] == "192.168.50.3"
    assert by_name["caraxes"] == "192.168.50.4"
    assert by_name["syrax"] == "192.168.50.5"
    assert by_name["vhagar"] == "192.168.50.6"
```

`apps/fleet-monitor/tests/test_collector.py`:

```python
from datetime import datetime, timezone

from fleet_monitor import collector, config, incidents, store

T0 = datetime(2026, 8, 10, 12, 0, 0, tzinfo=timezone.utc)

SECTIONS = {
    "stat": "cpu  100 0 50 900 0 0 0 0 0 0\n",
    "meminfo": "MemTotal:  1683776 kB\nMemAvailable: 741756 kB\n",
    "netdev": "h1\nh2\n  eth0: 10 1 0 0 0 0 0 0 20 2 0 0 0 0 0 0\n",
    "loadavg": "0.20 0.18 0.12 1/721 21708\n",
    "uptime": "950412.67 3698765.43\n",
    "gpu": "",
}


def test_samples_from_sections_merges_every_parser():
    got = {s.metric for s in collector.samples_from_sections(SECTIONS)}

    assert "cpu.total.user" in got
    assert "mem.total_bytes" in got
    assert "net.eth0.rx_bytes" in got
    assert "load.1m" in got
    assert "uptime.seconds" in got


def test_samples_from_sections_skips_a_missing_section():
    # a truncated response must still yield whatever did arrive
    got = {s.metric for s in collector.samples_from_sections({"loadavg": "0.1 0.2 0.3 1/2 3\n"})}

    assert got == {"load.1m", "load.5m", "load.15m", "procs.running", "procs.total"}


def test_samples_from_sections_on_an_empty_response():
    assert collector.samples_from_sections({}) == ()


async def test_collect_host_records_a_failure_for_an_unroutable_ip(tmp_path):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    incidents.init_db(db)
    host = config.Host(name="ghost", ip="192.0.2.1", has_gpu=False, docker_url="")

    result = await collector.collect_host(host, T0, db, timeout=2)

    assert result.ok is False
    assert result.target == "host:ghost"
    assert result.reason != ""
    # nothing collected must not look like a healthy empty host
    assert store.latest(db, "host:ghost") == {}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bunx nx run fleet-monitor:test`
Expected: FAIL, `ModuleNotFoundError: No module named 'fleet_monitor.config'`

- [ ] **Step 3: Write the config**

`apps/fleet-monitor/fleet_monitor/config.py`:

```python
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
HOSTS = (
    Host("meleys", "192.168.50.2", has_gpu=False, docker_url="http://192.168.50.2:2375"),
    Host("vermithor", "192.168.50.3", has_gpu=True, docker_url="http://192.168.50.3:2375"),
    Host("caraxes", "192.168.50.4", has_gpu=False, docker_url=""),
    Host("syrax", "192.168.50.5", has_gpu=False, docker_url=""),
    Host("vhagar", "192.168.50.6", has_gpu=True, docker_url="http://192.168.50.6:2375"),
)


def db_path() -> str:
    return os.environ.get("FM_DB_PATH", "/data/fleet.db")


def ssh_user() -> str:
    return os.environ.get("FM_SSH_USER", "crivas")
```

- [ ] **Step 4: Write the collector**

`apps/fleet-monitor/fleet_monitor/collector.py`:

```python
import asyncio
import json
import logging
from datetime import datetime, timezone

from fleet_monitor import config, incidents, rollups, store
from fleet_monitor.config import Host
from fleet_monitor.incidents import CheckResult
from fleet_monitor.probes import docker, proc, script, system
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


def samples_from_sections(sections: dict[str, str]) -> tuple[Sample, ...]:
    """Run every section through its parser and flatten the result."""
    return tuple(
        sample
        for name, parser in _PARSERS.items()
        if name in sections
        for sample in parser(sections[name])
    )


async def collect_host(
    host: Host, at: datetime, db: str, *, body: str = "", timeout: int = 15
) -> CheckResult:
    """One host, one round trip. A failure records the incident and writes no
    samples, so an unreachable box never renders as a healthy empty one."""
    result = await ssh.run(
        host.ip, body or script.VITALS_SCRIPT, user=config.ssh_user(), timeout=timeout
    )
    check = CheckResult(target=f"host:{host.name}", ok=result.ok, reason=result.reason)
    incidents.record(db, check, at)
    if result.ok:
        store.write_samples(db, f"host:{host.name}", at, samples_from_sections(
            script.split_sections(result.stdout)
        ))
    return check


async def collect_containers(host: Host, at: datetime, db: str) -> tuple[CheckResult, ...]:
    """Container state for one docker host, plus a per-container check."""
    if not host.docker_url:
        return ()

    response = await http.get_json(f"{host.docker_url}/containers/json?all=1")
    if not response.ok:
        check = CheckResult(f"docker:{host.name}", ok=False, reason=response.reason)
        incidents.record(db, check, at)
        return (check,)

    try:
        payload = json.loads(response.body)
    except json.JSONDecodeError:
        check = CheckResult(f"docker:{host.name}", ok=False, reason="bad_json")
        incidents.record(db, check, at)
        return (check,)

    states = docker.parse_containers(payload)
    store.write_samples(db, f"host:{host.name}", at, docker.to_samples(states))

    checks = tuple(
        CheckResult(
            target=f"container:{host.name}/{state.name}",
            ok=state.running and state.health != "unhealthy",
            reason="" if state.running else "not_running",
        )
        for state in states
    )
    for check in (CheckResult(f"docker:{host.name}", ok=True, reason=""), *checks):
        incidents.record(db, check, at)

    # the container set is discovered, not declared: adding jellyfin to meleys
    # needs no config change here, and removing an app must not leave its
    # incident open forever
    incidents.retire_absent(
        db,
        prefix=f"container:{host.name}/",
        seen={state.name for state in states},
        at=at,
    )
    return checks


async def tick(at: datetime, db: str) -> tuple[CheckResult, ...]:
    """One collection round across the whole fleet, fully concurrent.

    gather with return_exceptions keeps one wedged host from taking the round
    down with it.
    """
    jobs = [collect_host(host, at, db) for host in config.HOSTS] + [
        collect_containers(host, at, db) for host in config.HOSTS if host.docker_url
    ]
    outcomes = await asyncio.gather(*jobs, return_exceptions=True)

    failures = [o for o in outcomes if isinstance(o, BaseException)]
    for failure in failures:
        log.warning("collection job raised: %s", failure)

    store.write_heartbeat(db, at)
    return tuple(
        check
        for outcome in outcomes
        if not isinstance(outcome, BaseException)
        for check in (outcome if isinstance(outcome, tuple) else (outcome,))
    )


async def run_forever(db: str) -> None:
    """Vitals every 30s, slow hardware and compaction every 15 minutes."""
    store.init_db(db)
    rollups.init_db(db)
    incidents.init_db(db)
    rounds = 0
    while True:
        now = datetime.now(tz=timezone.utc)
        await tick(now, db)
        if rounds % (config.SLOW_INTERVAL // config.VITALS_INTERVAL) == 0:
            await asyncio.gather(
                *(
                    collect_host(host, now, db, body=script.SLOW_SCRIPT)
                    for host in config.HOSTS
                ),
                return_exceptions=True,
            )
            rollups.compact(db, "5m", now)
            rollups.compact(db, "1h", now)
            rollups.prune(db, now)
        rounds += 1
        await asyncio.sleep(config.VITALS_INTERVAL)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx nx run fleet-monitor:test`
Expected: PASS, 79 tests total.

- [ ] **Step 6: Run one real tick against the live fleet**

Run:

```bash
python3 - <<'PY'
import asyncio, sys, tempfile
from datetime import datetime, timezone
sys.path.insert(0, "apps/fleet-monitor")
from fleet_monitor import collector, incidents, rollups, store

db = tempfile.mktemp(suffix=".db")
store.init_db(db); rollups.init_db(db); incidents.init_db(db)

async def main():
    checks = await collector.tick(datetime.now(tz=timezone.utc), db)
    for c in sorted(checks, key=lambda c: c.target):
        print(f"{'ok ' if c.ok else 'DOWN'} {c.target:34} {c.reason}")
    print()
    for host in ("vermithor", "meleys", "caraxes"):
        latest = store.latest(db, f"host:{host}")
        print(host, "metrics:", len(latest), "load1m:", latest.get("load.1m"),
              "disk%:", latest.get("disk.volume1.used_percent"))

asyncio.run(main())
PY
```

Expected: five `host:` checks ok, two `docker:` hosts ok, and one `container:` check per running container (fifteen today, sixteen once Jellyfin lands on meleys), and a non-zero metric count per host. `vermithor` should not yet show `disk.volume1.used_percent` because that is on the slow tier.

- [ ] **Step 7: Run lint and commit**

```bash
git add apps/fleet-monitor/fleet_monitor/config.py apps/fleet-monitor/fleet_monitor/collector.py apps/fleet-monitor/tests/test_config.py apps/fleet-monitor/tests/test_collector.py
git commit -m "WZ: Add the fleet-monitor collector and fleet config

- Poll all five hosts and both docker hosts concurrently per tick
- Skip missing sections rather than defaulting them, so a failure stays a failure
- Keep a wedged host from taking the round down with it
- Run slow hardware, compaction and pruning on the 15 minute tier"
```

---

### Task 11: Read API

**Files:**

- Create: `apps/fleet-monitor/fleet_monitor/api.py`
- Test: `apps/fleet-monitor/tests/test_api.py`
- Modify: `apps/fleet-monitor/requirements-dev.txt` (add `httpx` is already present via requirements; no change needed unless `TestClient` complains)

**Interfaces:**

- Consumes: `store`, `incidents`, `config`.
- Produces: `api.app`, a FastAPI application with:
  - `GET /health` -> `{"ok": true, "heartbeat_age_seconds": float | null, "stale": bool}`
  - `GET /fleet` -> `{"collected_at": str | null, "stale": bool, "hosts": [...]}`
  - `GET /incidents?hours=24` -> `{"open": [...], "recent": [...]}`

- [ ] **Step 1: Write the failing tests**

`apps/fleet-monitor/tests/test_api.py`:

```python
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from fleet_monitor import api, incidents, store
from fleet_monitor.probes.types import Sample


def _client(tmp_path, monkeypatch):
    db = str(tmp_path / "fleet.db")
    store.init_db(db)
    incidents.init_db(db)
    monkeypatch.setenv("FM_DB_PATH", db)
    return TestClient(api.app), db


def test_health_reports_stale_when_no_heartbeat(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    body = client.get("/health").json()

    assert body["stale"] is True
    assert body["heartbeat_age_seconds"] is None


def test_health_is_fresh_right_after_a_heartbeat(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    store.write_heartbeat(db, datetime.now(tz=timezone.utc))
    body = client.get("/health").json()

    assert body["stale"] is False
    assert body["heartbeat_age_seconds"] < 5


def test_health_goes_stale_after_three_missed_ticks(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    store.write_heartbeat(db, datetime.now(tz=timezone.utc) - timedelta(seconds=200))

    assert client.get("/health").json()["stale"] is True


def test_fleet_lists_every_configured_host(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    store.write_samples(db, "host:vermithor", datetime.now(tz=timezone.utc), [
        Sample("load.1m", 0.46, "gauge"),
        Sample("mem.total_bytes", 16_642_768_896.0, "gauge"),
        Sample("mem.available_bytes", 11_000_000_000.0, "gauge"),
    ])
    body = client.get("/fleet").json()

    assert {h["name"] for h in body["hosts"]} == {
        "vermithor", "meleys", "syrax", "vhagar", "caraxes"
    }
    vermithor = next(h for h in body["hosts"] if h["name"] == "vermithor")
    assert vermithor["metrics"]["load.1m"] == 0.46
    assert vermithor["has_gpu"] is True


def test_fleet_marks_a_never_collected_host_as_such(tmp_path, monkeypatch):
    client, _ = _client(tmp_path, monkeypatch)
    body = client.get("/fleet").json()
    caraxes = next(h for h in body["hosts"] if h["name"] == "caraxes")

    # "not collected" must be its own state, never an implied healthy zero
    assert caraxes["collected"] is False
    assert caraxes["metrics"] == {}


def test_incidents_splits_open_from_recent(tmp_path, monkeypatch):
    client, db = _client(tmp_path, monkeypatch)
    now = datetime.now(tz=timezone.utc)
    for offset in (0, 30):
        incidents.record(db, incidents.CheckResult("host:caraxes", False, "timeout"),
                         now + timedelta(seconds=offset))
    body = client.get("/incidents?hours=24").json()

    assert len(body["open"]) == 1
    assert body["open"][0]["target"] == "host:caraxes"
    assert len(body["recent"]) == 1
```

- [ ] **Step 2: Add the test client dependency**

Append to `apps/fleet-monitor/requirements-dev.txt`:

```
httpx
```

(`fastapi.testclient` needs it at test time; it is already a runtime dependency, but listing it keeps the dev file self-describing.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bunx nx run fleet-monitor:test`
Expected: FAIL, `ModuleNotFoundError: No module named 'fleet_monitor.api'`

- [ ] **Step 4: Write the API**

`apps/fleet-monitor/fleet_monitor/api.py`:

```python
from datetime import datetime, timedelta, timezone

from fastapi import FastAPI

from fleet_monitor import config, incidents, store

app = FastAPI(title="fleet-monitor")

# Three missed vitals ticks. Past this the dashboard is showing history, not
# the present, and must say so.
STALE_AFTER = config.VITALS_INTERVAL * 3


def _heartbeat_age(now: datetime) -> float | None:
    last = store.last_heartbeat(config.db_path())
    return (now - last).total_seconds() if last else None


@app.get("/health")
def health() -> dict:
    """Liveness plus staleness.

    The collector runs on a box it also monitors, so it cannot report that box
    being down. Staleness is how that blind spot surfaces instead of a frozen
    green dashboard.
    """
    age = _heartbeat_age(datetime.now(tz=timezone.utc))
    return {
        "ok": True,
        "heartbeat_age_seconds": age,
        "stale": age is None or age > STALE_AFTER,
    }


@app.get("/fleet")
def fleet() -> dict:
    db = config.db_path()
    now = datetime.now(tz=timezone.utc)
    last = store.last_heartbeat(db)
    age = (now - last).total_seconds() if last else None

    hosts = [
        {
            "name": host.name,
            "ip": host.ip,
            "has_gpu": host.has_gpu,
            "has_docker": bool(host.docker_url),
            "collected": bool(metrics),
            "metrics": metrics,
            "uptime_percent_24h": incidents.uptime_percent(
                db, f"host:{host.name}", since=now - timedelta(hours=24), now=now
            ),
        }
        for host in config.HOSTS
        for metrics in (store.latest(db, f"host:{host.name}"),)
    ]
    return {
        "collected_at": last.isoformat() if last else None,
        "stale": age is None or age > STALE_AFTER,
        "hosts": hosts,
    }


@app.get("/incidents")
def incident_feed(hours: int = 24) -> dict:
    db = config.db_path()
    since = datetime.now(tz=timezone.utc) - timedelta(hours=hours)
    return {
        "open": list(incidents.open_incidents(db)),
        "recent": list(incidents.history(db, since)),
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bunx nx run fleet-monitor:test`
Expected: PASS, 85 tests total.

- [ ] **Step 6: Run lint and commit**

```bash
git add apps/fleet-monitor/fleet_monitor/api.py apps/fleet-monitor/tests/test_api.py apps/fleet-monitor/requirements-dev.txt
git commit -m "WZ: Add the fleet-monitor read API

- Serve /health, /fleet and /incidents
- Surface collector staleness so the self-monitoring blind spot is visible
- Mark a never-collected host as such rather than as a healthy zero"
```

---

### Task 12: Fleet overview page in the admin portal

**Files:**

- Create: `apps/admin-portal/src/lib/fleetApi.ts`
- Create: `apps/admin-portal/src/lib/fleetApi.test.ts`
- Create: `apps/admin-portal/src/pages/Fleet/Fleet.tsx`
- Create: `apps/admin-portal/src/pages/Fleet/Fleet.module.scss`
- Create: `apps/admin-portal/src/pages/Fleet/Fleet.test.tsx`
- Create: `apps/admin-portal/src/pages/Fleet/HostCard.tsx`
- Create: `apps/admin-portal/src/pages/Fleet/HostCard.module.scss`
- Modify: `apps/admin-portal/src/AppRoutes.tsx`

**Interfaces:**

- Consumes: `GET /fleet` and `GET /incidents` from Task 11.
- Produces: the `/fleet` route.

- [ ] **Step 1: Write the failing API-client test**

`apps/admin-portal/src/lib/fleetApi.test.ts`:

Note the import: this repo's web tests import `expect`/`test` from `@/test/vi`, never from `bun:test`, and use flat `test()` calls rather than `describe` blocks. Match that.

```ts
import { expect, test } from '@/test/vi'
import { formatBytes, memoryUsedPercent, toHostSummary } from '@/lib/fleetApi'

test('memoryUsedPercent derives used percent from total and available', () => {
  expect(memoryUsedPercent({ 'mem.total_bytes': 1000, 'mem.available_bytes': 250 })).toBe(75)
})

test('memoryUsedPercent returns null when either metric is missing', () => {
  expect(memoryUsedPercent({ 'mem.total_bytes': 1000 })).toBeNull()
  expect(memoryUsedPercent({})).toBeNull()
})

test('memoryUsedPercent returns null on a zero total rather than dividing by zero', () => {
  expect(memoryUsedPercent({ 'mem.total_bytes': 0, 'mem.available_bytes': 0 })).toBeNull()
})

test('formatBytes scales to the largest sensible unit', () => {
  expect(formatBytes(1_683_776 * 1024)).toBe('1.6 GB')
  expect(formatBytes(101_815_078_912 * 1024)).toBe('92.6 TB')
})

test('formatBytes renders a dash for a missing value', () => {
  expect(formatBytes(null)).toBe('--')
})

test('toHostSummary marks an uncollected host as unknown rather than healthy', () => {
  const summary = toHostSummary({
    name: 'caraxes',
    ip: '192.168.50.4',
    has_gpu: false,
    has_docker: false,
    collected: false,
    metrics: {},
    uptime_percent_24h: 100,
  })

  expect(summary.status).toBe('unknown')
  expect(summary.loadPerCore).toBeNull()
})

test('toHostSummary normalizes load against four cores', () => {
  const summary = toHostSummary({
    name: 'meleys',
    ip: '192.168.50.2',
    has_gpu: false,
    has_docker: true,
    collected: true,
    metrics: { 'load.1m': 2 },
    uptime_percent_24h: 100,
  })

  expect(summary.loadPerCore).toBe(0.5)
  expect(summary.status).toBe('ok')
})

test('toHostSummary flags a host whose disk is over the warn threshold', () => {
  const summary = toHostSummary({
    name: 'vermithor',
    ip: '192.168.50.3',
    has_gpu: true,
    has_docker: true,
    collected: true,
    metrics: { 'disk.volume1.used_percent': 99 },
    uptime_percent_24h: 100,
  })

  expect(summary.status).toBe('warn')
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bunx nx run admin-portal:test`
Expected: FAIL, cannot resolve `@/lib/fleetApi`

- [ ] **Step 3: Write the API client**

`apps/admin-portal/src/lib/fleetApi.ts`:

```ts
export type FleetMetrics = Readonly<Record<string, number>>

export type FleetHost = {
  readonly name: string
  readonly ip: string
  readonly has_gpu: boolean
  readonly has_docker: boolean
  readonly collected: boolean
  readonly metrics: FleetMetrics
  readonly uptime_percent_24h: number
}

export type FleetResponse = {
  readonly collected_at: string | null
  readonly stale: boolean
  readonly hosts: readonly FleetHost[]
}

export type HostStatus = 'ok' | 'warn' | 'unknown'

export type HostSummary = {
  readonly name: string
  readonly ip: string
  readonly status: HostStatus
  readonly hasGpu: boolean
  readonly hasDocker: boolean
  readonly loadPerCore: number | null
  readonly memoryPercent: number | null
  readonly diskPercent: number | null
  readonly uptimePercent: number
}

// Every box in the fleet is 4-core, measured 2026-08-10.
const CORES = 4
const DISK_WARN_PERCENT = 90
const LOAD_WARN_PER_CORE = 1

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

export const formatBytes = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '--'
  const index = Math.min(
    UNITS.length - 1,
    Math.max(0, Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024))),
  )
  return `${(value / 1024 ** index).toFixed(1)} ${UNITS[index]}`
}

export const memoryUsedPercent = (metrics: FleetMetrics): number | null => {
  const total = metrics['mem.total_bytes'] ?? 0
  const available = metrics['mem.available_bytes'] ?? null
  if (total <= 0 || available === null) return null
  return Math.round(((total - available) / total) * 100)
}

export const toHostSummary = (host: FleetHost): HostSummary => {
  const load = host.metrics['load.1m'] ?? null
  const disk = host.metrics['disk.volume1.used_percent'] ?? null
  const loadPerCore = host.collected && load !== null ? load / CORES : null
  const memoryPercent = host.collected ? memoryUsedPercent(host.metrics) : null
  const overDisk = disk !== null && disk >= DISK_WARN_PERCENT
  const overLoad = loadPerCore !== null && loadPerCore >= LOAD_WARN_PER_CORE

  return {
    name: host.name,
    ip: host.ip,
    // "not collected" is its own state; it must never render as healthy
    status: !host.collected ? 'unknown' : overDisk || overLoad ? 'warn' : 'ok',
    hasGpu: host.has_gpu,
    hasDocker: host.has_docker,
    loadPerCore,
    memoryPercent,
    diskPercent: disk,
    uptimePercent: host.uptime_percent_24h,
  }
}

const base = import.meta.env.VITE_FLEET_BASE ?? ''

export const fetchFleet = async (): Promise<FleetResponse> => {
  const response = await fetch(`${base}/fleet`)
  if (!response.ok) throw new Error(`fleet request failed: ${response.status}`)
  return (await response.json()) as FleetResponse
}
```

- [ ] **Step 4: Run the client tests to verify they pass**

Run: `bunx nx run admin-portal:test`
Expected: PASS for `fleetApi.test.ts`.

- [ ] **Step 5: Write the failing component test**

`apps/admin-portal/src/pages/Fleet/Fleet.test.tsx`:

```tsx
import { expect, test } from '@/test/vi'
import { render, screen } from '@testing-library/react'
import type { HostSummary } from '@/lib/fleetApi'
import { HostCard } from '@/pages/Fleet/HostCard'

const summary: HostSummary = {
  name: 'vermithor',
  ip: '192.168.50.3',
  status: 'warn',
  hasGpu: true,
  hasDocker: true,
  loadPerCore: 0.12,
  memoryPercent: 29,
  diskPercent: 99,
  uptimePercent: 100,
}

test('HostCard names the host and its status in text, not by color alone', () => {
  render(<HostCard summary={summary} />)

  expect(screen.getByRole('heading', { name: 'vermithor' })).toBeInTheDocument()
  expect(screen.getByText('Needs attention')).toBeInTheDocument()
})

test('HostCard renders an uncollected host as unknown with no fabricated numbers', () => {
  render(
    <HostCard
      summary={{
        ...summary,
        status: 'unknown',
        loadPerCore: null,
        memoryPercent: null,
        diskPercent: null,
      }}
    />,
  )

  expect(screen.getByText('Not collected')).toBeInTheDocument()
  expect(screen.queryByText('0%')).toBeNull()
})

test('HostCard omits the gpu row on a host with no render node', () => {
  render(<HostCard summary={{ ...summary, hasGpu: false }} />)

  expect(screen.queryByText('GPU')).toBeNull()
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bunx nx run admin-portal:test`
Expected: FAIL, cannot resolve `@/pages/Fleet/HostCard`

- [ ] **Step 7: Write the host card**

`apps/admin-portal/src/pages/Fleet/HostCard.tsx`:

```tsx
import type { HostSummary } from '@/lib/fleetApi'
import styles from './HostCard.module.scss'

type HostCardProps = {
  readonly summary: HostSummary
}

const STATUS_LABEL = {
  ok: 'Healthy',
  warn: 'Needs attention',
  unknown: 'Not collected',
} as const

const percent = (value: number | null): string => (value === null ? '--' : `${value}%`)

export const HostCard = ({ summary }: HostCardProps) => (
  <article className={styles.card} data-status={summary.status}>
    <header className={styles.header}>
      <h3 className={styles.name}>{summary.name}</h3>
      {/* status is stated in text, never by color alone */}
      <p className={styles.status}>{STATUS_LABEL[summary.status]}</p>
    </header>

    <dl className={styles.metrics}>
      <div className={styles.row}>
        <dt>Load per core</dt>
        <dd>{summary.loadPerCore === null ? '--' : summary.loadPerCore.toFixed(2)}</dd>
      </div>
      <div className={styles.row}>
        <dt>Memory</dt>
        <dd>{percent(summary.memoryPercent)}</dd>
      </div>
      <div className={styles.row}>
        <dt>Disk</dt>
        <dd>{percent(summary.diskPercent)}</dd>
      </div>
      {summary.hasGpu && (
        <div className={styles.row}>
          <dt>GPU</dt>
          <dd>Intel iGPU present</dd>
        </div>
      )}
      <div className={styles.row}>
        <dt>Uptime 24h</dt>
        <dd>{summary.uptimePercent}%</dd>
      </div>
    </dl>
  </article>
)
```

`apps/admin-portal/src/pages/Fleet/HostCard.module.scss`:

```scss
@use '../../styles/globals.scss' as *;

.card {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);

  &[data-status='warn'] {
    border-color: var(--color-warning);
  }

  &[data-status='unknown'] {
    border-style: dashed;
  }
}

.header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: baseline;
  gap: var(--space-2);
}

.name {
  font-size: var(--font-size-lg);
  overflow-wrap: anywhere;
}

.status {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.metrics {
  display: grid;
  gap: var(--space-2);
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: var(--space-2);
  font-size: var(--font-size-sm);

  dd {
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
}

@media (max-width: 48rem) {
  .header {
    grid-template-columns: minmax(0, 1fr);
  }
}
```

If any token name above does not exist in `apps/admin-portal/src/styles/globals.scss`, use the nearest existing token rather than inventing one; `bunx nx run admin-portal:lint:css` will flag the mismatch.

- [ ] **Step 8: Write the page**

`apps/admin-portal/src/pages/Fleet/Fleet.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query'
import { fetchFleet, toHostSummary } from '@/lib/fleetApi'
import { HostCard } from '@/pages/Fleet/HostCard'
import styles from './Fleet.module.scss'

export const Fleet = () => {
  const { data, isPending, isError } = useQuery({
    queryKey: ['fleet'],
    queryFn: fetchFleet,
    refetchInterval: 30_000,
  })

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1>Fleet</h1>
        {!!data?.stale && (
          <p className={styles.stale} role="alert">
            Collector data is stale. The monitor runs on vermithor and cannot report that box being
            down, so treat everything below as history, not the present.
          </p>
        )}
      </header>

      {!!isPending && <p aria-live="polite">Loading fleet status.</p>}
      {!!isError && <p role="alert">Could not reach the fleet monitor.</p>}

      {!!data && (
        <section className={styles.grid} aria-label="Hosts">
          {data.hosts.map((host) => (
            <HostCard key={host.name} summary={toHostSummary(host)} />
          ))}
        </section>
      )}
    </main>
  )
}
```

`apps/admin-portal/src/pages/Fleet/Fleet.module.scss`:

```scss
@use '../../styles/globals.scss' as *;

.page {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-5);
  padding: var(--space-5);
}

.header {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-3);
}

.stale {
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-warning-surface);
  color: var(--color-warning-text);
  font-size: var(--font-size-sm);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
  gap: var(--space-4);
}
```

- [ ] **Step 9: Wire the route**

`AppRoutes.tsx` is a flat `<Routes>` list with no auth wrapper; the pages handle their own gating. Add the import in alphabetical position among the existing page imports and one route line:

```tsx
import { Fleet } from '@/pages/Fleet/Fleet'
```

```tsx
<Route path="/fleet" element={<Fleet />} />
```

Place the route line after `/email` to keep the list in the same order as the imports. Do not introduce an auth wrapper here; match the surrounding pattern.

- [ ] **Step 10: Run the full web gate**

Run:

```bash
bunx nx run admin-portal:test
bunx nx run admin-portal:lint:ts
bunx nx run admin-portal:lint:css
bunx nx run admin-portal:typecheck
bunx nx run admin-portal:format:check
```

Expected: all clean. `lint:ts` enforces the no-default-export, no-`any`, no-`interface` rules from CLAUDE.md; do not disable a rule to pass.

- [ ] **Step 11: Verify responsiveness at 320px**

Run `bun run dev`, open `/fleet`, and set the viewport to 320px wide. Confirm there is no horizontal page scroll in the loading, loaded, error and stale states. The card grid must collapse to one column and long host names must wrap rather than push the page wide.

- [ ] **Step 12: Run the whole repo gate and commit**

Run: `bun run verify`
Expected: clean across both apps.

```bash
git add apps/admin-portal/src/lib/fleetApi.ts apps/admin-portal/src/lib/fleetApi.test.ts apps/admin-portal/src/pages/Fleet apps/admin-portal/src/AppRoutes.tsx
git commit -m "WZ: Add the fleet overview page to the admin portal

- Render one card per host with load, memory, disk and 24h uptime
- Show status in text as well as color, and omit the GPU row where there is no render node
- Surface collector staleness as an alert rather than a silently frozen dashboard
- Collapse to a single column at 320px with no horizontal page scroll"
```

---

## Definition of done for Phase 1

- [ ] `bun run verify` is clean across `admin-portal`, `stripe-bridge` and `fleet-monitor`.
- [ ] `node -p "require('./apps/fleet-monitor/package.json').version"` prints `undefined`, so `scripts/release.sh` still validates exactly three markers.
- [ ] One real `collector.tick` against the live fleet returns 5 host checks, 2 docker checks and 15 container checks.
- [ ] `POST` through the meleys socket proxy returns `403`.
- [ ] `/fleet` renders all five hosts at 320px with no horizontal page scroll.
- [ ] A host powered off (or its IP blackholed) opens an incident on the second tick and closes it two ticks after it returns.
- [ ] A container started on meleys appears as a new `container:` target within one tick with no config change, and one removed while down has its incident closed with reason `removed` rather than left open.

## Self-review notes

Checked against the spec:

- **Spec sections with a task:** host vitals (Tasks 2, 3, 4, 5), GPU caveat (Task 3, and the UI omits the row entirely on the three boxes without a render node), container state (Task 8), store and rollups (Tasks 6, 7), incident model with hysteresis (Task 9), self-monitoring blind spot (Task 6 heartbeat, Task 11 staleness, Task 12 alert), error handling as three distinct states (Tasks 5, 8, 10, 11, 12), testing strategy (fixtures in Task 2, table-driven incidents in Task 9).
- **Deferred to later phases, as the spec says:** SMART and drive wear, arr and Plex APIs, optimization rules, alerting, control actions. Phase 1 collects `df` but not `smartctl`, so no sudo password is needed anywhere in this phase. That is a deliberate simplification and the reason the socket proxy exists.
- **Type consistency:** `Sample(metric, value, kind)` is used identically in Tasks 2, 3, 6, 8, 10. `CheckResult(target, ok, reason)` in Tasks 9 and 10. `store._conn` is imported by `rollups` and `incidents`, so `init_db` in all three is additive and order-independent. `HostSummary` in Task 12 matches the `/fleet` payload shape from Task 11 field for field.
- **Known gap:** the spec lists per-container CPU and memory as Phase 1 scope; this plan collects container up/health only. Per-container resource stats need the Docker `/stats` endpoint, which is a per-container streaming call and deserves its own task. It is folded into Phase 2 alongside the rest of the application layer rather than stretching Phase 1.
