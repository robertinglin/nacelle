from __future__ import annotations

import json
import os
import queue
import signal
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence


_PROGRESS_PREFIX = "BNH_PROGRESS "


def parse_progress_line(line: str) -> dict[str, Any] | None:
    if not line.startswith(_PROGRESS_PREFIX):
        return None
    try:
        payload = json.loads(line[len(_PROGRESS_PREFIX) :])
    except json.JSONDecodeError:
        return None
    if not isinstance(payload, dict) or payload.get("type") != "progress":
        return None
    return payload


class JsonlAdapterError(RuntimeError):
    pass


class JsonlWorker:
    def __init__(self, argv: Sequence[str], cwd: Path, env: Mapping[str, str], index: int):
        self.argv = tuple(argv)
        self.cwd = cwd
        self.env = dict(env)
        self.index = index
        self.process: subprocess.Popen[str] | None = None
        self.stdout_queue: queue.Queue[str | None] = queue.Queue()
        self.stderr_lines: deque[str] = deque(maxlen=300)
        self._start_lock = threading.Lock()
        self._call_lock = threading.Lock()
        self._progress_callback: Callable[[dict[str, Any]], None] | None = None
        self._progress_run_id: str | None = None
        self._start()

    def _start(self) -> None:
        with self._start_lock:
            if self.process is not None and self.process.poll() is None:
                return
            if self.process is not None:
                self._close_streams(self.process)
            stdout_queue: queue.Queue[str | None] = queue.Queue()
            stderr_lines: deque[str] = deque(maxlen=300)
            process = subprocess.Popen(
                list(self.argv),
                cwd=str(self.cwd),
                env=self.env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                errors="replace",
                bufsize=1,
                start_new_session=(os.name != "nt"),
            )
            self.process = process
            self.stdout_queue = stdout_queue
            self.stderr_lines = stderr_lines
            assert process.stdout is not None
            assert process.stderr is not None
            threading.Thread(
                target=self._read_stdout,
                args=(process, stdout_queue),
                daemon=True,
            ).start()
            threading.Thread(
                target=self._read_stderr,
                args=(process, stderr_lines),
                daemon=True,
            ).start()

    @staticmethod
    def _read_stdout(
        process: subprocess.Popen[str],
        output: queue.Queue[str | None],
    ) -> None:
        assert process.stdout is not None
        try:
            for line in process.stdout:
                output.put(line.rstrip("\r\n"))
        finally:
            process.stdout.close()
            output.put(None)

    def _read_stderr(self, process: subprocess.Popen[str], output: deque[str]) -> None:
        assert process.stderr is not None
        try:
            for line in process.stderr:
                clean = line.rstrip("\r\n")
                progress = parse_progress_line(clean)
                if progress is not None:
                    expected_run_id = self._progress_run_id
                    if expected_run_id is not None and str(progress.get("runId")) != expected_run_id:
                        continue
                    callback = self._progress_callback
                    if callback is not None:
                        try:
                            callback(progress)
                        except Exception:
                            pass
                    continue
                output.append(clean)
        finally:
            process.stderr.close()

    @staticmethod
    def _close_streams(process: subprocess.Popen[str]) -> None:
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None and not stream.closed:
                try:
                    stream.close()
                except OSError:
                    pass

    def _kill(self) -> None:
        process = self.process
        if process is None or process.poll() is not None:
            return
        try:
            if os.name == "nt":
                process.terminate()
            else:
                # Signal the daemon rather than immediately killing it so it can
                # close its browser and target development server cleanly.
                os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=3)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            if os.name == "nt":
                process.kill()
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
        self._close_streams(process)

    def _clear_progress(self) -> None:
        self._progress_callback = None
        self._progress_run_id = None

    def call(
        self,
        request: dict[str, Any],
        timeout_seconds: float,
        *,
        on_progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> tuple[dict[str, Any] | None, str, int, bool]:
        # JsonlPool lends one worker to one caller, but the lock also keeps the
        # class safe when used directly in tests or by future integrations.
        with self._call_lock:
            self._start()
            process = self.process
            stdout_queue = self.stdout_queue
            stderr_lines = self.stderr_lines
            assert process is not None and process.stdin is not None
            self._progress_callback = on_progress
            context = request.get("context")
            self._progress_run_id = (
                str(context.get("run_id"))
                if isinstance(context, dict) and context.get("run_id") is not None
                else None
            )
            stderr_lines.clear()
            request_id = str(request.setdefault("request_id", f"w{self.index}-{time.time_ns()}"))
            started = time.monotonic()
            try:
                process.stdin.write(json.dumps(request, separators=(",", ":")) + "\n")
                process.stdin.flush()
            except (BrokenPipeError, OSError) as exc:
                self._kill()
                self._clear_progress()
                return None, f"adapter stdin failed: {exc}\n{self.stderr_tail(stderr_lines)}", 0, False

            deadline = started + timeout_seconds
            noise: list[str] = []
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._kill()
                    self._clear_progress()
                    duration = int((time.monotonic() - started) * 1000)
                    return None, f"JSONL adapter timed out\n{self.stderr_tail(stderr_lines)}", duration, True
                try:
                    line = stdout_queue.get(timeout=remaining)
                except queue.Empty:
                    self._kill()
                    self._clear_progress()
                    duration = int((time.monotonic() - started) * 1000)
                    return None, f"JSONL adapter timed out\n{self.stderr_tail(stderr_lines)}", duration, True
                if line is None:
                    self._clear_progress()
                    duration = int((time.monotonic() - started) * 1000)
                    code = process.poll()
                    self._close_streams(process)
                    noise_text = "\n".join(noise[-20:])
                    return None, (
                        f"JSONL adapter exited before a response (exit={code})\n"
                        f"stdout noise:\n{noise_text}\n{self.stderr_tail(stderr_lines)}"
                    ), duration, False
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    noise.append(line)
                    continue
                if not isinstance(payload, dict):
                    noise.append(line)
                    continue
                response_id = payload.get("request_id")
                if response_id is None:
                    noise.append(f"response omitted request_id: {line}")
                    continue
                if str(response_id) != request_id:
                    noise.append(f"unexpected response id {response_id}: {line}")
                    continue
                duration = int((time.monotonic() - started) * 1000)
                self._clear_progress()
                error_text = "\n".join(noise[-20:])
                if stderr_lines:
                    error_text = (error_text + "\n" + self.stderr_tail(stderr_lines)).strip()
                return payload, error_text, duration, False

    def stderr_tail(self, lines: deque[str] | None = None) -> str:
        return "\n".join(lines if lines is not None else self.stderr_lines)

    def close(self) -> None:
        self._kill()


class JsonlPool:
    def __init__(
        self,
        argv: Sequence[str],
        cwd: Path,
        env: Mapping[str, str],
        size: int,
    ):
        self.argv = tuple(argv)
        self.cwd = cwd
        self.env = dict(env)
        self.workers = [JsonlWorker(argv, cwd, env, index) for index in range(max(1, size))]
        self.available: queue.Queue[JsonlWorker] = queue.Queue()
        for worker in self.workers:
            self.available.put(worker)

    def call(
        self,
        request: dict[str, Any],
        timeout_seconds: float,
        *,
        on_progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> tuple[dict[str, Any] | None, str, int, bool]:
        worker = self.available.get()
        try:
            return worker.call(request, timeout_seconds, on_progress=on_progress)
        finally:
            self.available.put(worker)

    def close(self) -> None:
        for worker in self.workers:
            worker.close()
