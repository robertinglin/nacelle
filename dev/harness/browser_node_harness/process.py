from __future__ import annotations

import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from collections.abc import Callable
from typing import Any, Mapping, Sequence

from .models import ProcessResult

_SECRET_MARKERS = (
    "API_KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "PRIVATE_KEY",
    "AUTH",
    "COOKIE",
    "CREDENTIAL",
)

_BASE_ENV_KEYS = {
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "TERM",
}
_PROGRESS_PREFIX = "BNH_PROGRESS "


class MissingPlaceholder(KeyError):
    pass


class _StrictFormat(dict[str, str]):
    def __missing__(self, key: str) -> str:
        raise MissingPlaceholder(key)


def render(value: str, mapping: Mapping[str, str]) -> str:
    return value.format_map(_StrictFormat(mapping))


def render_argv(argv: Sequence[str], mapping: Mapping[str, str]) -> tuple[str, ...]:
    return tuple(render(item, mapping) for item in argv)


def sanitized_environment(*, inherit: bool, extra: Mapping[str, str], mapping: Mapping[str, str]) -> dict[str, str]:
    if inherit:
        env = dict(os.environ)
    else:
        env = {key: value for key, value in os.environ.items() if key in _BASE_ENV_KEYS}
        for key in list(env):
            upper = key.upper()
            if any(marker in upper for marker in _SECRET_MARKERS):
                env.pop(key, None)
    for key, value in extra.items():
        env[key] = render(value, mapping)
    return env


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    half = max(1, limit // 2)
    omitted = len(text) - (half * 2)
    return f"{text[:half]}\n\n... <{omitted} chars omitted> ...\n\n{text[-half:]}"


def run_process(
    argv: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    timeout_seconds: float,
    stdin_text: str | None = None,
    max_output_chars: int = 80_000,
    on_output: Callable[[str, str], None] | None = None,
    on_progress: Callable[[dict[str, Any]], None] | None = None,
    stop_requested: Callable[[], str | None] | None = None,
    on_started: Callable[[int], None] | None = None,
) -> ProcessResult:
    started = time.monotonic()
    process = subprocess.Popen(
        list(argv),
        cwd=str(cwd),
        env=dict(env),
        stdin=subprocess.PIPE if stdin_text is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        bufsize=1,
        start_new_session=(os.name != "nt"),
    )
    if on_started is not None:
        try:
            on_started(process.pid)
        except Exception:
            pass
    stdout_chunks: list[str] = []
    stderr_chunks: list[str] = []

    def read_output(pipe: Any, stream: str, chunks: list[str]) -> None:
        for line in iter(pipe.readline, ""):
            if stream == "stderr" and line.startswith(_PROGRESS_PREFIX):
                try:
                    progress = json.loads(line[len(_PROGRESS_PREFIX) :].rstrip("\r\n"))
                except json.JSONDecodeError:
                    progress = None
                if isinstance(progress, dict) and progress.get("type") == "progress":
                    if on_progress is not None:
                        try:
                            on_progress(progress)
                        except Exception:
                            pass
                    continue
            chunks.append(line)
            if on_output is not None:
                try:
                    on_output(stream, line)
                except Exception:
                    pass
        pipe.close()

    stdout_thread = threading.Thread(
        target=read_output,
        args=(process.stdout, "stdout", stdout_chunks),
        daemon=True,
    )
    stderr_thread = threading.Thread(
        target=read_output,
        args=(process.stderr, "stderr", stderr_chunks),
        daemon=True,
    )
    stdout_thread.start()
    stderr_thread.start()

    if stdin_text is not None and process.stdin is not None:
        def write_input() -> None:
            try:
                process.stdin.write(stdin_text)
                process.stdin.close()
            except (BrokenPipeError, OSError):
                pass

        threading.Thread(target=write_input, daemon=True).start()

    timed_out = False
    termination_reason = ""
    deadline = time.monotonic() + timeout_seconds
    while process.poll() is None:
        if time.monotonic() >= deadline:
            timed_out = True
            termination_reason = "timeout"
            _terminate_process(process)
            break
        if stop_requested is not None:
            try:
                requested = stop_requested()
            except Exception:
                requested = None
            if requested in {"stop", "restart"}:
                termination_reason = requested
                _terminate_process(process)
                break
        time.sleep(0.1)

    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        _kill_process(process)
        process.wait()
    stdout_thread.join(timeout=3)
    stderr_thread.join(timeout=3)
    stdout = "".join(stdout_chunks)
    stderr = "".join(stderr_chunks)
    duration_ms = int((time.monotonic() - started) * 1000)
    return ProcessResult(
        argv=tuple(str(item) for item in argv),
        cwd=cwd,
        exit_code=process.returncode,
        stdout=_truncate(stdout or "", max_output_chars),
        stderr=_truncate(stderr or "", max_output_chars),
        duration_ms=duration_ms,
        timed_out=timed_out,
        pid=process.pid,
        termination_reason=termination_reason,
    )


def _terminate_process(process: subprocess.Popen[str]) -> None:
    if os.name == "nt":
        process.terminate()
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass


def _kill_process(process: subprocess.Popen[str]) -> None:
    if os.name == "nt":
        process.kill()
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
