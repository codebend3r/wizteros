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
