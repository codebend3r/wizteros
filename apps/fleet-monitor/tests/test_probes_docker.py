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


def test_parse_containers_defaults_a_null_restart_count_and_started_at():
    # a key present with a JSON null, not merely absent: entry.get(key) would
    # return None rather than the default, so this must be coerced, not just
    # defaulted via .get(key, default)
    states = docker.parse_containers([_payload(RestartCount=None, StartedAt=None)])

    assert states[0].restart_count == 0
    assert states[0].started_at == ""


def test_to_samples_emits_up_and_healthy_gauges():
    states = docker.parse_containers([
        _payload(Names=["/sonarr"]),
        _payload(Names=["/radarr"], State="exited", Status="Exited (0) 3 hours ago"),
    ])
    got = {s.metric: s.value for s in docker.to_samples(states)}

    assert got["container.sonarr.up"] == 1.0
    assert got["container.radarr.up"] == 0.0
    assert got["container.sonarr.healthy"] == 1.0


def test_to_samples_never_emits_a_restart_count_sample():
    # GET /containers/json never returns RestartCount, so a sample built from
    # it would read as a constant zero forever, indistinguishable from a
    # genuinely healthy container. Never re-add this without an inspect-based
    # source for the field.
    states = docker.parse_containers([_payload()])
    metrics = {s.metric for s in docker.to_samples(states)}

    assert not any(metric.endswith(".restart_count") for metric in metrics)
