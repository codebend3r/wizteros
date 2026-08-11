# Fleet monitor design

**Date:** 2026-08-10
**Status:** design, not yet planned
**Scope:** a self-hosted tool to observe and optimize the five-box Synology fleet and the *arr stack running on it

## Problem

There is no single place that answers "is the stack healthy, and where is it heading". The
existing `stack-health` skill probes the paid-access path (Stripe to Wizarr to Plex) and
nothing else. It is a point-in-time probe with no history, so it cannot answer "when did
this break", "how often does it break", or "when will this disk fill".

Everything else is manual: SSH into a box, run `df`, read `docker ps`, guess.

## What is actually collectable

Measured on 2026-08-10, not assumed. This table is the constraint the design has to respect.

| Host | IP | CPU | Cores | RAM | `/dev/dri` | Docker | `/volume1` |
|---|---|---|---|---|---|---|---|
| `vermithor` | .3 | Celeron J3455 | 4 | 15.8 GB | yes (i915) | yes | 93T / 95T (**99%**) |
| `meleys` | .2 | Ryzen Embedded R1600 | 2c/4t | 32.1 GB | no | yes | 80T / 84T (95%) |
| `syrax` | .5 | Atom C3538 | 4 | 32.1 GB | no | no | 37T / 41T (92%) |
| `vhagar` | .6 | Celeron J4125 | 4 | 7.8 GB | yes (i915) | yes | 34T / 37T (93%) |
| `caraxes` | .4 | ARMv8 | 4 | **1.6 GB** | no | no | 23T / 27T (88%) |

Docker is installable on any x86_64 box, so the Docker column is current state, not a
constraint. `vhagar` gained Container Manager 24.0.2 on 2026-08-11 when Jellyfin was
installed there. `caraxes` is `aarch64` and Synology's Container Manager is x86-only, so
it is the one box where Docker genuinely cannot run.

Model numbers, since they decide the transcoding story: `vermithor` DS918+, `meleys`
DS923+, `syrax` DS1618+, `vhagar` DS920+, `caraxes` DS418. Only `eth1` (or `eth2` on
meleys) is up on each box; the rest are linkdown. `meleys` is the only 10GbE link, every
other box is 1GbE.

Plex Media Server runs natively (not containerized) on all five.

### Two tiers of host, not five equal ones

The fleet is not homogeneous and the monitor should not pretend it is.

- **Arr hosts: `vermithor` and `meleys`.** The only two running the *arr stack. Full depth: host vitals, container state, application health, queue state.
- **Media host with containers: `vhagar`.** As of 2026-08-11 it runs Jellyfin in Docker, plus Plex natively. It needs a container layer but has no *arr application layer.
- **Media hosts: `syrax`, `caraxes`.** Plex and storage only. Host vitals and Plex session data. There is no container layer to monitor, and the design must not render that absence as a gap.

The lesson from vhagar arriving as a container host mid-design is that "which hosts run
containers" is not a fixed property either. The monitor therefore treats a host's Docker
endpoint as optional configuration and its container list as discovered per tick, so a box
gaining or losing Docker is a one-line config change rather than a redesign.

### Per-signal feasibility

| Signal | Source | Availability |
|---|---|---|
| CPU per-core and aggregate | `/proc/stat` | all 5 |
| Load average | `/proc/loadavg` | all 5 |
| Memory | `/proc/meminfo` | all 5 |
| Network per NIC | `/proc/net/dev` | all 5 |
| Disk I/O | `/proc/diskstats` | all 5 |
| Volume usage | `df -Pk` | all 5 |
| CPU temperature | `/sys/class/hwmon/*/temp*_input` | all 5 |
| SMART, drive temps, NVMe wear | `smartctl`, `/usr/sbin/nvme` | all 5, **needs sudo** |
| GPU | `/sys/class/drm/card0/gt_*_freq_mhz` | **2 of 5 only** |
| Container state and restarts | Docker API | vermithor, meleys |
| Container CPU/mem/net | Docker API stats | vermithor, meleys |
| Plex sessions and transcode mode | Plex HTTP API | all 5 |
| *arr app health warnings | Sonarr/Radarr/Lidarr/Prowlarr HTTP API | vermithor, meleys |
| Download queue state | SABnzbd HTTP API | vermithor, meleys |
| Bridge and Wizarr | HTTP, as `stack-health` already does | meleys |

### The GPU caveat, stated plainly

"GPU monitoring" cannot mean what it means on a desktop. Only `vermithor` and `vhagar`
expose a render node, both Intel iGPUs on the `i915` driver. DSM does not ship
`intel_gpu_top`, and the i915 perf interface needed for a true busy percentage is not
available. What sysfs gives is frequency: `gt_act_freq_mhz` against `gt_max_freq_mhz`
(measured at 100 idle, 750 max on both boxes).

So the GPU signal is two things combined:

1. **Frequency ratio** as a coarse load proxy on the two boxes that have an iGPU.
2. **Transcode decisions** from the media server APIs on all five, which report per
   session whether the transcode is hardware accelerated.

The second is the more useful number anyway. "Three CPU transcodes running on caraxes,
which has no iGPU and 1.6 GB of RAM" is an actionable statement. "GPU at 47%" is not.

The design records this as a first-class limitation, visible in the UI, rather than
inventing a utilization number that is not real.

### Measured transcode capacity, and where Jellyfin landed

`meleys` was ruled out for Jellyfin: verified 2026-08-11 it has no `/dev/dri`, an empty
`/sys/class/drm`, and neither `amdgpu` nor `radeon` loaded. Not a missing driver.
Synology does not enable the Vega iGPU on the DS923+ generation, and the box is 2 physical
cores, not 4. `syrax` (Atom C3538, Denverton) has no iGPU at all, and `caraxes` is ARM.

**Jellyfin was installed on `vhagar` (DS920+, J4125) on 2026-08-11**, the best iGPU in the
fleet. Measured there against a real 4K HEVC 10-bit HDR file:

| Path | Speed | Concurrent streams |
|---|---|---|
| 4K HEVC to 1080p H.264, no tone mapping | 2.65x realtime, 64 fps | about 2 |
| 4K HDR to 1080p SDR, `tonemap_vaapi` | **1.19x realtime, 29 fps** | **about 1** |

The tone-mapped number is the one that matters for an HDR library, and it is the honest
ceiling: barely real time, so a single 4K HDR transcode saturates the iGPU and a second
concurrent one will buffer. Anything beyond that needs the client to direct play.

This is a monitoring input, not just background. The "transcode pressure" rule exists to
catch exactly this, and the measured 1.19x is the threshold it should alarm against.

## Approaches considered

### A. Prometheus + Grafana + node_exporter + cAdvisor + Uptime Kuma

The industry-standard stack. Mature, good alerting, PromQL is powerful.

Rejected because the agent story does not survive contact with DSM. `node_exporter` would
need to be installed on five boxes with no package manager, in `/usr/local`, which DSM
updates clear; one of them is ARM and has 1.6 GB of RAM. And after all that work the result
is a generic infrastructure dashboard. Nothing in it knows what Sonarr is, so it cannot
tell you an indexer has been failing for two days. The goal is a management tool for the
*arr stack, and this approach spends its entire budget on YAML and gets no closer to that.

### B. Agentless collector, SQLite, custom UI in the existing monorepo (recommended)

One service that polls everything from one place: SSH for host vitals, the Docker API for
container state, HTTP for the application layer. Nothing installed on any DSM box.

Recommended, for four reasons:

1. **Nothing to install on DSM.** No agent to survive a DSM update, no ARM build for
   caraxes, no memory footprint on the 1.6 GB box. The blast radius of the monitor is one
   container on one host.
2. **It can speak the *arr stack natively.** `GET /api/v3/health` on Sonarr returns real
   warnings (indexer unavailable, download client unreachable, root folder missing). No
   generic exporter surfaces that. This is the difference between a dashboard and a
   management tool.
3. **The fleet is small enough that the heavy machinery is not needed.** Five hosts,
   fifteen containers, roughly 200 series at a 30 second tick is about 576k points a day.
   SQLite with rollups handles that comfortably. Prometheus would be solving a scale
   problem that does not exist here.
4. **It fits the repo that already exists.** FastAPI service conventions, a React admin
   portal with working auth, `deploy-nas`, and the hard-won SSH knowledge in the
   `synology-nas-ssh` skill are all already here.

Cost: it has to be built, and SSH polling means 30 second resolution rather than 1 second.
Neither matters for capacity planning and downtime tracking, which is what this is for.

### C. Off-the-shelf, Beszel or Netdata plus Uptime Kuma

Fastest to stand up, decent charts. Rejected for the same two reasons as A: agents on DSM,
and no *arr awareness. It also splits the answer across two UIs, so "the disk filled
because Sonarr imported 400 GB overnight" is a correlation a human has to make by hand.

## Architecture

A new Nx app, `apps/fleet-monitor/`, FastAPI on Python 3.12 in a container. Deliberately
**not** folded into `stripe-bridge`: that service is the payment path and needs to stay
small and auditable.

The UI is a new section inside the existing `admin-portal` rather than a third app, so it
inherits the auth, tokens, and styles that already work.

```
Collector container (on vermithor)
  |
  |-- SSH (ControlMaster, 1 connection per host) ---> 5 DSM hosts: /proc, sysfs, df, smart
  |-- Docker API (local socket, read-only) --------> vermithor containers
  |-- Docker API (socket-proxy over LAN) ----------> meleys containers
  |-- HTTP ----------------------------------------> 15 app endpoints, 5 Plex, funnel
  |
  v
SQLite (WAL) --> FastAPI read API --> admin-portal /fleet section
```

### Layers

Each is a separate module with one job, testable without the others.

1. **`probes/`** Pure parsing. Bytes in, structured metrics out. `proc.py`, `smart.py`,
   `gpu.py`, `docker.py`, `arr.py`, `plex.py`. No I/O at all, so the whole parsing surface
   is unit-testable against captured fixture files. This is where the DSM quirks live
   (SMART attribute 194 matched by ID and not by name, NVMe routed to `nvme` rather than
   `smartctl`), and keeping them in pure functions means they can be tested without a NAS.
2. **`transport/`** The only I/O. `ssh.py` and `http.py`. A transport failure returns a
   typed error, never an exception that kills a tick.
3. **`collector.py`** An asyncio scheduler. Per target, per cadence, fan out, collect,
   hand samples to the store. One slow or dead target never blocks another.
4. **`store.py`** SQLite in WAL mode. Tables: `targets`, `samples`, `rollups_5m`,
   `rollups_1h`, `incidents`.
5. **`incidents.py`** The up/down state machine. Consumes check results, emits incident
   open and close events, computes uptime percentage and MTTR.
6. **`rules.py`** The optimization layer. Reads history, emits recommendations.
7. **`api.py`** Read endpoints for the SPA.

### Collection design

**One batched script per host per tick, not N commands.** A tick assembles a single shell
script, sends it over one SSH connection, and parses the delimited result. With
ControlMaster persisting the connection there is no TCP or auth cost per tick. Five hosts
every 30 seconds is five round trips, not fifty.

**Counters are stored raw, rates are computed at read time.** `/proc/stat`,
`/proc/net/dev`, and `/proc/diskstats` are monotonic counters. Storing the counter rather
than a precomputed rate means a reboot is detectable (the counter goes backwards, so that
one delta is dropped rather than rendered as a spike), and the rate window can change
without a re-collection.

**Cadence tiers**, because not everything moves at the same speed:

| Tier | Interval | What |
|---|---|---|
| Vitals | 30s | CPU, memory, network, load, container state |
| Application | 60s | arr health, Plex sessions, queue depth, HTTP up/down |
| Slow hardware | 15min | SMART, drive temps, NVMe wear, `df` |

**Docker access without storing sudo passwords.** The collector runs on vermithor with
`/var/run/docker.sock` mounted read-only, so local containers need no credentials. Meleys
runs a read-only socket proxy exposing only the GET endpoints the collector needs, reached
over the LAN. No sudo password lives in the collector for container data.

**SMART is the one exception and it degrades gracefully.** `smartctl` requires sudo, and
each box has its own password. SMART collection is therefore opt-in per host via
configuration; a host without it reports every other metric normally and shows drive
health as "not collected" rather than failing the tick or silently reporting healthy.

### Downtime model

A **target** is anything with a binary up or down state. About 40 of them: 5 hosts over
SSH, 15 containers by Docker state, 15 application HTTP endpoints (the same containers
answering on their own ports, which is a distinct signal from the container being up), 5
Plex servers, and the public Funnel.

Container state and HTTP endpoint are tracked separately on purpose. A container that is
`Up` while its port refuses connections is the exact failure mode that a container-only
check reports as healthy.

An incident opens after **2 consecutive failures** and closes after **2 consecutive
successes**. The hysteresis matters: a single dropped packet is not an outage, and a
monitor that pages on one is a monitor that gets ignored.

**Targets are discovered, so they must also be retirable.** The container set on the two
stack hosts is not fixed: Jellyfin is arriving on meleys, apps get renamed, stacks get
recreated. A new container needs no special case, it simply starts getting checked. A
removed one does need a case: without retirement, a container deleted while it happened
to be down leaves an incident open forever and its uptime pinned at zero. Retirement is
scoped per host, because both vermithor and meleys run a container named `sonarr` and one
host's cleanup must never reach into the other's.

Incidents are rows with an open and close timestamp, which gives uptime percentage over
24h, 7d and 30d, MTTR, and a timeline. This is what answers "why did meleys' sonarr
restart three hours ago" the next time it happens.

### The self-monitoring blind spot

The collector runs on vermithor, so it cannot report vermithor being down. This is
inherent to self-hosted monitoring and the design does not pretend otherwise:

- Every tick writes a heartbeat row.
- The UI shows "last collected N seconds ago" prominently and turns stale after 3 missed
  ticks, so a dead collector reads as dead rather than as a frozen green dashboard.
- An optional outbound dead-man's-switch ping covers the case where the whole box is gone.

### Optimization rules

This is the part that makes it a management tool rather than a chart viewer. Each rule
reads history and emits a recommendation with the evidence behind it.

| Rule | Emits |
|---|---|
| Disk runway | Linear fit on `df` history: "vermithor `/volume1` fills in ~N days at the current rate" |
| Transcode pressure | Sessions transcoding on a host with no render node: "CPU transcode on meleys, 2 physical cores, no iGPU" |
| Competing media servers | Plex and Jellyfin transcoding on the same host at the same time |
| Restart loops | `restart_count` delta over 24h per container |
| arr health | Warnings surfaced verbatim from `/api/v3/health` |
| Queue stalls | SABnzbd queue depth flat while a download is nominally active |
| Drive wear | Reallocated sector trend, NVMe `percentage_used` |
| Memory pressure | Sustained low available memory, which caraxes is a standing candidate for |
| Inotify headroom | Watch and instance usage against the ceiling, which two media servers scanning the same libraries push twice as hard |

The disk runway rule would have flagged vermithor at 99% before it became urgent, which is
the whole argument for building this.

### Error handling

Failure is the normal case in a fleet monitor, so it is designed for rather than handled.

- A dead target degrades that target only. Never a tick, never another host.
- Every collection result is one of: fresh sample, typed failure, or explicitly not
  collected. The UI distinguishes all three. "Not collected" is never rendered as healthy,
  which is the same rule the `stack-health` skill already enforces about skipped checks.
- Transport errors carry the reason (timeout, auth, connection refused) so a wrong SSH key
  and a powered-off NAS do not look identical.
- SQLite writes are batched per tick in one transaction. A crash mid-tick loses at most
  one tick.

### Testing

- **Probes:** unit tests against captured fixtures from the real boxes. Every quirk in the
  table above gets a fixture, including an NVMe drive, a `sataN` box, an `sdX` box, and an
  ARM box.
- **Store and rollups:** unit tests against a temp SQLite file, including counter reset
  handling and rollup correctness.
- **Incidents:** table-driven tests over synthetic check sequences (flap, sustained
  outage, recovery, missing data).
- **Rules:** unit tests over synthetic history.
- **Transports:** integration tests against the real fleet, marked so they can be skipped
  off the LAN.

## Phasing

The full scope is several independent subsystems, so it is decomposed. Each phase is its
own plan and ships something usable.

**Phase 1, vertical slice.** SSH transport, host vitals probes, container state, the store
with rollups, the incident state machine, and one fleet overview page. At the end of this
phase the tool answers "what is the fleet doing right now" and "what went down recently".

**Phase 2, application layer.** arr APIs, media server sessions and transcode attribution,
SABnzbd queue, GPU frequency, per-container CPU and memory. Answers "what is the stack
doing", not just "what are the boxes doing".

Media server sessions cover both Plex (all five hosts, via each server's own API or
Tautulli) and Jellyfin (meleys, once installed). Jellyfin's `/Sessions` endpoint reports
`TranscodingInfo` including `HardwareAccelerationType`, which is a cleaner hardware-versus-
software signal than Plex exposes, so the transcode pressure rule will actually be better
informed on meleys than on the Plex-only hosts.

**Phase 3, rules and alerting.** The optimization rules, plus delivery. There is already a
`plex-slack-webhook` stack on vermithor and an SMTP mailer in the bridge, so delivery
reuses one of those rather than adding a channel.

**Phase 4, control actions.** Restart a container, pause a queue, from the UI. Deliberately
last, and behind the existing admin auth. A read-only tool that is trusted is worth more
than a write-capable one that is not.

## Out of scope

- Anything installed on a DSM box. The moment an agent is required, approach A was the
  better choice and this design should be revisited.
- Replacing `stack-health`. That skill stays as the fast, dependency-free, read-only probe
  of the payment path. The monitor consumes the same signals and adds history.
- Log aggregation. Container logs stay where they are; the monitor reads them only to
  answer specific rules.
- Monitoring anything outside the LAN, apart from the existing public Funnel check.

## Known unknowns

- **Plex tokens.** Each of the five servers needs a token for the session API. They exist
  in each server's preferences file and are readable over SSH, but this has not yet been
  verified end to end.
- **Jellyfin API key.** Not yet applicable; Jellyfin is planned but not installed. Its key
  is generated in the Jellyfin admin UI rather than read from a config file, so unlike the
  *arr keys it cannot be picked up automatically and will need to be supplied once.
  Ports `8096`, `8920`, `7359` and `1900` were confirmed free on meleys on 2026-08-11, so
  a default Jellyfin install will not collide with anything already listening there,
  including the `2375` the socket proxy will use.
- **arr API keys.** Confirmed readable at
  `/volume1/docker/essoz/<App>/config/config.xml` on vermithor. The equivalent paths on
  meleys are under `/volume1/docker/westeroz/` and are assumed but not yet confirmed.
- **Where the collector lives long term.** Vermithor is chosen because it has the lower
  load average and hosts the main *arr stack, but it is also the box at 99% disk. The
  SQLite file is small (tens of MB at these rates), so this is judged acceptable; if
  vermithor gets worse the collector moves to meleys with a config change.
