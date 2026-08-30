from __future__ import annotations

import atexit
import hashlib
import json
import re
import secrets
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Sequence

from .config import CommandConfig, HarnessConfig
from .fingerprint import failure_fingerprint
from .jsonl_adapter import JsonlPool
from .models import Status, TestCase, TestResult
from .output_contract import compare_expected_output, load_expected_contract
from .process import render, render_argv, run_process, sanitized_environment

_VALID_STATUSES: set[str] = {"pass", "fail", "skip", "timeout", "infra_error"}
_SAFE_PATH_RE = re.compile(r"[^A-Za-z0-9_.-]+")
_BROWSER_ERROR_LINE_RE = re.compile(
    r"(?m)^(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*(?:Error|Exception)|Error):"
)
_BROWSER_ENTRY_FRAME_RE = re.compile(r"(?m)^\s+at globalThis\.__bnhRun\b")
_BROWSER_TEST_FRAME_RE = re.compile(r"(?m)^\s+at .*\/(?:node|runtime)\/[^\n]+")
_INFRASTRUCTURE_ERROR_CODES = {
    "ERR_CAPABILITY_DENIED",
    "ERR_INVALID_CAPABILITY",
    "ERR_NOT_SUPPORTED",
}
_RETRYABLE_INFRASTRUCTURE_MARKERS = (
    "ERR_CONNECTION_REFUSED",
    "net::ERR_CONNECTION_REFUSED",
    "adapter exited before a response",
    "adapter stdin failed",
    "JSONL adapter timed out",
)


def _truncate_output(value: str, limit: int) -> str:
    if len(value) <= limit:
        return value
    half = max(1, limit // 2)
    omitted = len(value) - half * 2
    return f"{value[:half]}\n\n... <{omitted} chars omitted> ...\n\n{value[-half:]}"


def structured_failure_text(details: dict[str, object]) -> str:
    """Return the browser runtime failure that adapter stderr may omit."""

    parts: list[str] = []
    run_result = details.get("run_result")
    if isinstance(run_result, dict):
        error = run_result.get("error")
        if isinstance(error, dict):
            parts.append(
                str(
                    error.get("stack")
                    or error.get("message")
                    or error.get("code")
                    or ""
                )
            )
        else:
            outcome = run_result.get("outcome")
            if outcome:
                parts.append(str(outcome))

    test_output = details.get("test_output")
    if isinstance(test_output, dict):
        for key in ("stderr", "stdout"):
            value = test_output.get(key)
            if isinstance(value, str) and value:
                parts.append(value)
    return "\n".join(part for part in parts if part)


def classify_adapter_payload(payload: dict[str, object]) -> Status:
    """Classify a result while reconciling the browser's structured evidence."""

    payload_status = str(payload.get("status", ""))
    if payload_status not in _VALID_STATUSES:
        return "infra_error"
    status: Status = payload_status  # type: ignore[assignment]
    details = payload.get("details")
    if not isinstance(details, dict):
        return status

    run_result = details.get("run_result")
    if not isinstance(run_result, dict):
        code = details.get("classification")
        if status == "pass" and code in _INFRASTRUCTURE_ERROR_CODES:
            return "infra_error"
        return status

    outcome = run_result.get("outcome")
    error = run_result.get("error")
    error_code = error.get("code") if isinstance(error, dict) else None
    if outcome == "timed_out" or error_code == "ERR_RUN_TIMEOUT":
        return "timeout"
    if outcome == "unsupported" or error_code in _INFRASTRUCTURE_ERROR_CODES:
        return "infra_error"
    if outcome in {"failed", "cancelled"}:
        return "infra_error" if status == "infra_error" else "fail"

    if outcome == "passed" and status == "pass":
        exit_info = run_result.get("exit")
        if isinstance(exit_info, dict) and exit_info.get("code") not in {None, 0}:
            return "fail"
        if error is not None:
            return "fail"
        test_output = details.get("test_output")
        test_stderr = test_output.get("stderr") if isinstance(test_output, dict) else ""
        if (
            isinstance(test_stderr, str)
            and _BROWSER_ERROR_LINE_RE.search(test_stderr)
            and (
                _BROWSER_ENTRY_FRAME_RE.search(test_stderr)
                or _BROWSER_TEST_FRAME_RE.search(test_stderr)
            )
        ):
            # The browser runtime can report a passed worker after its entry
            # evaluation throws. The entry frame distinguishes that from a
            # test deliberately writing an Error or a warning to stderr.
            return "fail"
    return status


def is_retryable_infrastructure(result: TestResult) -> bool:
    """Identify adapter-process failures that are safe to retry once."""

    if result.status not in {"infra_error", "timeout"}:
        return False
    evidence = "\n".join((result.stderr, result.stdout)).lower()
    return any(marker.lower() in evidence for marker in _RETRYABLE_INFRASTRUCTURE_MARKERS)


class TestRunner:
    def __init__(self, config: HarnessConfig):
        self.config = config
        self.requests_dir = config.project.state_dir / "requests"
        self.logs_dir = config.project.state_dir / "logs"
        self.requests_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self._pools: dict[tuple[object, ...], JsonlPool] = {}
        self._pool_worktrees: dict[tuple[object, ...], Path] = {}
        self._pool_lock = threading.Lock()
        atexit.register(self.close)

    def _mapping(
        self,
        *,
        test: TestCase,
        worktree: Path,
        request_path: Path,
        result_path: Path,
        run_id: str,
        iteration: int,
        attempt_id: str,
    ) -> dict[str, str]:
        test_abs = self.config.project.node_repo / test.path
        return {
            "config": str(self.config.path),
            "config_dir": str(self.config.root),
            "target_repo": str(self.config.project.target_repo),
            "node_repo": str(self.config.project.node_repo),
            "state_dir": str(self.config.project.state_dir),
            "worktree": str(worktree),
            "request": str(request_path),
            "result": str(result_path),
            "test": test.path,
            "test_abs": str(test_abs),
            "node_binary": self.config.project.node_binary,
            "run_id": run_id,
            "iteration": str(iteration),
            "attempt_id": attempt_id,
        }

    def _capability_manifest(self, test: TestCase, spec: CommandConfig) -> dict[str, object]:
        """Build the explicit browser grant for one isolated run."""

        entry = f"/node/{test.path.lstrip('/')}"
        environment_keys = {
            "NODE_TEST_CONTEXT",
            "NODE_TEST_KNOWN_GLOBALS",
            "BNH_BROWSER",
            "BNH_VARIANT",
            *spec.env,
        }
        output_limit = max(0, spec.max_output_chars)
        environment = {"allowed": sorted(environment_keys)}
        return {
            "vfs": {
                "mounts": [{"path": "/node", "mode": "read-write", "artifacts": []}],
            },
            # Upstream tests routinely create helper workers and cluster
            # children. The grant applies only to the mounted /node VFS, so
            # allowing those entries does not expose host filesystem paths.
            "workers": {"entryModules": ["*"], "maxChildren": 8},
            "ipc": {"enabled": True},
            "signals": {"allowed": ["SIGTERM", "SIGINT", "SIGKILL"]},
            "output": {
                "maxBytes": output_limit,
                "stdoutBytes": output_limit,
                "stderrBytes": output_limit,
                "highWaterMark": min(output_limit, 16 * 1024),
            },
            "envVars": environment,
            "process.env": environment,
        }

    def _command_context(
        self,
        spec: CommandConfig,
        mapping: dict[str, str],
        *,
        persistent: bool,
    ) -> tuple[tuple[str, ...], Path, dict[str, str]]:
        argv = render_argv(spec.command, mapping)
        cwd = Path(render(spec.cwd, mapping)).resolve()
        env = sanitized_environment(inherit=spec.inherit_env, extra=spec.env, mapping=mapping)
        env["BNH_NODE_BINARY"] = self.config.project.node_binary
        if persistent:
            env["BNH_PROTOCOL"] = "jsonl"
        else:
            env.update(
                {
                    "BNH_REQUEST_FILE": mapping["request"],
                    "BNH_RESULT_FILE": mapping["result"],
                }
            )
        return argv, cwd, env

    def _ensure_jsonl_pool(
        self,
        spec: CommandConfig,
        worktree: Path,
        mapping: dict[str, str],
        size: int,
    ) -> tuple[JsonlPool, tuple[str, ...], Path]:
        argv, cwd, env = self._command_context(spec, mapping, persistent=True)
        key: tuple[object, ...] = (
            spec.command,
            spec.cwd,
            str(worktree.resolve()),
            tuple(argv),
            str(cwd),
            tuple(sorted(env.items())),
        )
        with self._pool_lock:
            pool = self._pools.get(key)
            if pool is not None and len(pool.workers) < max(1, size):
                pool.close()
                self._pools.pop(key, None)
                self._pool_worktrees.pop(key, None)
                pool = None
            if pool is None:
                pool = JsonlPool(argv, cwd, env, max(1, size))
                self._pools[key] = pool
                self._pool_worktrees[key] = worktree.resolve()
        return pool, argv, cwd

    def close_worktree(self, worktree: Path) -> None:
        target = worktree.resolve()
        with self._pool_lock:
            keys = [key for key, value in self._pool_worktrees.items() if value == target]
            pools = [self._pools.pop(key) for key in keys]
            for key in keys:
                self._pool_worktrees.pop(key, None)
        for pool in pools:
            pool.close()

    def close(self) -> None:
        with self._pool_lock:
            pools = list(self._pools.values())
            self._pools.clear()
            self._pool_worktrees.clear()
        for pool in pools:
            pool.close()

    def run_one(
        self,
        test: TestCase,
        *,
        spec: CommandConfig,
        worktree: Path,
        phase: str,
        run_id: str = "adhoc",
        iteration: int = 0,
        attempt_id: str = "",
        pool_size: int = 1,
    ) -> TestResult:
        nonce = secrets.token_hex(6)
        request_path = self.requests_dir / f"{run_id}-{nonce}.request.json"
        result_path = self.requests_dir / f"{run_id}-{nonce}.result.json"
        mapping = self._mapping(
            test=test,
            worktree=worktree,
            request_path=request_path,
            result_path=result_path,
            run_id=run_id,
            iteration=iteration,
            attempt_id=attempt_id,
        )
        expected_contract = load_expected_contract(self.config.project.node_repo, test)
        request: dict[str, object] = {
            "schema_version": 1,
            "test": {
                "path": test.path,
                "absolute_path": str(self.config.project.node_repo / test.path),
                "suite": test.suite,
                "flags": list(test.flags),
                "modules": list(test.modules),
                "source_sha256": test.source_sha256,
                "source_override": test.source_override,
            },
            "paths": {
                "node_repo": str(self.config.project.node_repo),
                "target_repo": str(self.config.project.target_repo),
                "worktree": str(worktree),
                "state_dir": str(self.config.project.state_dir),
                "result": str(result_path),
            },
            "limits": {"timeout_seconds": spec.timeout_seconds},
            "expected": expected_contract,
            "capabilities": self._capability_manifest(test, spec),
            "proxy": spec.proxy,
            "context": {
                "phase": phase,
                "run_id": run_id,
                "iteration": iteration,
                "attempt_id": attempt_id,
            },
        }
        request_path.write_text(json.dumps(request, indent=2), encoding="utf-8")

        payload: dict[str, object] | None = None
        parse_error = ""
        process_stdout = ""
        process_stderr = ""
        process_exit_code: int | None = None
        process_timed_out = False
        process_duration_ms = 0

        if spec.protocol == "jsonl":
            pool, argv, cwd = self._ensure_jsonl_pool(spec, worktree, mapping, pool_size)
            raw_payload, adapter_noise, process_duration_ms, process_timed_out = pool.call(
                request, spec.timeout_seconds + 5
            )
            if raw_payload is not None:
                payload = raw_payload
                process_exit_code = 0
            else:
                parse_error = adapter_noise or "JSONL adapter returned no result"
            process_stderr = adapter_noise
        else:
            argv, cwd, env = self._command_context(spec, mapping, persistent=False)
            process = run_process(
                argv,
                cwd=cwd,
                env=env,
                timeout_seconds=spec.timeout_seconds + 5,
                max_output_chars=spec.max_output_chars,
            )
            process_stdout = process.stdout
            process_stderr = process.stderr
            process_exit_code = process.exit_code
            process_timed_out = process.timed_out
            process_duration_ms = process.duration_ms
            if result_path.exists():
                try:
                    loaded = json.loads(result_path.read_text(encoding="utf-8"))
                    if isinstance(loaded, dict):
                        payload = loaded
                    else:
                        parse_error = "result JSON was not an object"
                except (OSError, json.JSONDecodeError) as exc:
                    parse_error = f"invalid result JSON: {exc}"
            elif process_stdout:
                for line in reversed(process_stdout.splitlines()):
                    if not line.lstrip().startswith("{"):
                        continue
                    try:
                        loaded = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(loaded, dict) and "status" in loaded:
                        payload = loaded
                        break

        if process_timed_out:
            status: Status = "timeout"
        elif payload is not None:
            status = classify_adapter_payload(payload)
            payload_status = str(payload.get("status", ""))
            if payload_status not in _VALID_STATUSES:
                parse_error = f"adapter result has invalid status: {payload_status!r}"
        elif parse_error:
            status = "infra_error"
        else:
            parse_error = "adapter produced no result"
            status = "infra_error"

        exit_code_raw = payload.get("exit_code") if payload is not None else process_exit_code
        exit_code = int(exit_code_raw) if isinstance(exit_code_raw, int) else process_exit_code
        duration_raw = payload.get("duration_ms") if payload is not None else None
        duration_ms = int(duration_raw) if isinstance(duration_raw, (int, float)) else process_duration_ms
        adapter_stdout = str(payload.get("stdout", "")) if payload is not None else ""
        adapter_stderr = str(payload.get("stderr", "")) if payload is not None else ""
        stdout = _truncate_output(adapter_stdout or process_stdout, spec.max_output_chars)
        stderr_parts = [part for part in (adapter_stderr, process_stderr, parse_error) if part]
        stderr = _truncate_output("\n".join(dict.fromkeys(stderr_parts)), spec.max_output_chars)
        details = payload.get("details", {}) if payload is not None else {}
        if not isinstance(details, dict):
            details = {"adapter_details": details}
        details.update(
            {
                "argv": list(argv),
                "cwd": str(cwd),
                "adapter_exit_code": process_exit_code,
                "adapter_timed_out": process_timed_out,
                "adapter_protocol": spec.protocol,
            }
        )
        if expected_contract is not None:
            expected_output = expected_contract.get("output")
            expected_details = {
                "output_path": expected_contract.get("output_path"),
                "input_path": expected_contract.get("input_path"),
                "requires_tty": expected_contract.get("requires_tty", False),
            }
            if not isinstance(expected_output, str):
                status = "infra_error"
                parse_error = (
                    f"missing expected output contract: {expected_contract.get('output_path')}"
                )
                stderr = _truncate_output(
                    "\n".join(dict.fromkeys(part for part in (adapter_stderr, process_stderr, parse_error) if part)),
                    spec.max_output_chars,
                )
                expected_details["matched"] = False
                expected_details["mismatch"] = {"reason": "missing-output-file"}
            else:
                comparison_stdout = stdout
                comparison_stderr = stderr
                test_output = details.get("test_output")
                if isinstance(test_output, dict):
                    if isinstance(test_output.get("stdout"), str):
                        comparison_stdout = test_output["stdout"]
                    if isinstance(test_output.get("stderr"), str):
                        comparison_stderr = test_output["stderr"]
                comparison = compare_expected_output(
                    test.path, expected_output, comparison_stdout, comparison_stderr
                )
                expected_details.update(comparison)
                if status in {"pass", "fail"}:
                    if comparison["matched"]:
                        status = "pass"
                    else:
                        status = "fail"
                        mismatch = comparison["mismatch"]
                        parse_error = f"expected output mismatch: {mismatch}"
                        stderr = _truncate_output(
                            "\n".join(dict.fromkeys(part for part in (adapter_stderr, process_stderr, parse_error) if part)),
                            spec.max_output_chars,
                        )
            if expected_contract.get("requires_tty") and not details.get("tty_supported", False):
                if status == "pass":
                    status = "infra_error"
                expected_details["unsupported_boundary"] = "pseudo-tty"
                details["unsupported"] = "browser adapter does not provide a pseudo-terminal"
            details["expected_output"] = expected_details

        fingerprint = ""
        if status != "pass":
            structured_failure = structured_failure_text(details)
            fingerprint = failure_fingerprint(
                "\n".join(part for part in (stderr, structured_failure) if part),
                stdout,
                roots=(self.config.project.node_repo, worktree, self.config.project.state_dir),
            )

        safe_test = _SAFE_PATH_RE.sub("_", test.path)[-120:]
        log_dir = self.logs_dir / run_id / f"i{iteration:04d}" / phase / f"{safe_test}-{nonce}"
        log_dir.mkdir(parents=True, exist_ok=True)
        (log_dir / "request.json").write_text(json.dumps(request, indent=2), encoding="utf-8")
        (log_dir / "stdout.txt").write_text(stdout, encoding="utf-8", errors="replace")
        (log_dir / "stderr.txt").write_text(stderr, encoding="utf-8", errors="replace")
        (log_dir / "result.json").write_text(
            json.dumps(
                {
                    "status": status,
                    "exit_code": exit_code,
                    "duration_ms": duration_ms,
                    "fingerprint": fingerprint,
                    "details": details,
                },
                indent=2,
            ),
            encoding="utf-8",
        )

        request_path.unlink(missing_ok=True)
        result_path.unlink(missing_ok=True)
        return TestResult(
            test_path=test.path,
            status=status,
            exit_code=exit_code,
            duration_ms=duration_ms,
            stdout=stdout,
            stderr=stderr,
            fingerprint=fingerprint,
            details=details,
            log_dir=log_dir,
        )

    def run_many(
        self,
        tests: Sequence[TestCase],
        *,
        spec: CommandConfig,
        worktree: Path,
        phase: str,
        run_id: str,
        iteration: int,
        attempt_id: str = "",
        concurrency: int = 1,
    ) -> list[TestResult]:
        if not tests:
            return []
        def execute(batch: Sequence[TestCase]) -> list[TestResult]:
            if spec.protocol == "jsonl":
                nonce = secrets.token_hex(4)
                mapping = self._mapping(
                    test=batch[0],
                    worktree=worktree,
                    request_path=self.requests_dir / f"pool-{nonce}.request.json",
                    result_path=self.requests_dir / f"pool-{nonce}.result.json",
                    run_id=run_id,
                    iteration=iteration,
                    attempt_id=attempt_id,
                )
                self._ensure_jsonl_pool(spec, worktree, mapping, max(1, concurrency))
            ordered: dict[str, TestResult] = {}
            with ThreadPoolExecutor(max_workers=max(1, concurrency)) as executor:
                futures = {
                    executor.submit(
                        self.run_one,
                        test,
                        spec=spec,
                        worktree=worktree,
                        phase=phase,
                        run_id=run_id,
                        iteration=iteration,
                        attempt_id=attempt_id,
                        pool_size=max(1, concurrency),
                    ): test.path
                    for test in batch
                }
                for future in as_completed(futures):
                    path = futures[future]
                    try:
                        ordered[path] = future.result()
                    except Exception as exc:
                        ordered[path] = TestResult(
                            test_path=path,
                            status="infra_error",
                            exit_code=None,
                            duration_ms=0,
                            stderr=f"harness runner exception: {type(exc).__name__}: {exc}",
                            fingerprint=failure_fingerprint(str(exc)),
                        )
            return [ordered[test.path] for test in batch]

        results = execute(tests)
        retry_paths = [
            test
            for test, result in zip(tests, results)
            if is_retryable_infrastructure(result)
        ]
        if not retry_paths:
            return results

        # Force a fresh daemon/browser/server after a refused connection or
        # dead adapter. Keep ordinary unsupported-boundary infra results intact.
        self.close_worktree(worktree)
        retried = execute(retry_paths)
        retried_by_path = {result.test_path: result for result in retried}
        return [retried_by_path.get(result.test_path, result) for result in results]


def synthetic_canaries(nonce: str | None = None) -> list[tuple[TestCase, Status]]:
    token = nonce or secrets.token_hex(8)
    cases = [
        (
            TestCase(
                path=f".bnh/canary/pass-{token}.js",
                suite="bnh-canary",
                source_sha256=hashlib.sha256(token.encode()).hexdigest(),
                modules=("assert",),
                source_override="const assert = require('node:assert'); assert.strictEqual(2 + 2, 4);\n",
            ),
            "pass",
        ),
        (
            TestCase(
                path=f".bnh/canary/throw-{token}.js",
                suite="bnh-canary",
                source_sha256=hashlib.sha256((token + "throw").encode()).hexdigest(),
                source_override=f"throw new Error('BNH_NEGATIVE_CONTROL_{token}');\n",
            ),
            "fail",
        ),
        (
            TestCase(
                path=f".bnh/canary/exit-{token}.js",
                suite="bnh-canary",
                source_sha256=hashlib.sha256((token + "exit").encode()).hexdigest(),
                source_override="process.exitCode = 17;\n",
            ),
            "fail",
        ),
    ]
    return cases


def mutated_test(node_repo: Path, test: TestCase, nonce: str | None = None) -> TestCase:
    token = nonce or secrets.token_hex(8)
    source = (
        test.source_override
        if test.source_override is not None
        else (node_repo / test.path).read_text(encoding="utf-8", errors="replace")
    )
    override = f"throw new Error('BNH_MUTATION_{token}');\n{source}"
    return TestCase(
        path=test.path,
        suite=test.suite,
        source_sha256=hashlib.sha256(override.encode()).hexdigest(),
        flags=test.flags,
        modules=test.modules,
        size_bytes=len(override.encode()),
        source_override=override,
    )
