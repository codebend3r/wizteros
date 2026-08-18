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


@pytest.mark.asyncio
async def test_run_returns_a_typed_failure_when_ssh_cannot_be_spawned(monkeypatch):
    # forces asyncio.create_subprocess_exec to raise FileNotFoundError for
    # real, by hiding the ssh binary from PATH, so the spawn-time guard is
    # proven against an actual OSError rather than a mock
    monkeypatch.setenv("PATH", "/nonexistent-empty-dir-for-fleet-monitor-tests")

    result = await ssh.run("192.0.2.1", "echo hi", control_dir="/tmp/fm-spawn-test", timeout=1)

    assert result.ok is False
    assert result.stdout == ""
    assert result.reason == "spawn_error"
