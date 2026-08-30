from __future__ import annotations

import hashlib
import json
import random
import secrets
from pathlib import Path
from typing import Callable, Sequence

from .config import CommandConfig, HarnessConfig
from .models import CandidateAttempt, TestCase, TestResult
from .process import render, render_argv, run_process, sanitized_environment
from .runner import TestRunner, mutated_test, synthetic_canaries

_SUBSTRATE_SCOPE_FILES = (
    "runtime.js",
    "runtime/index.js",
    "runtime/compat.js",
    "runtime/vfs.js",
    "runtime/streams.js",
    "runtime/process.js",
    "runtime/messaging.js",
    "runtime/process-worker.js",
    "runtime/process-entry.js",
    "runtime/async-hooks.js",
    "runtime/diagnostics.js",
    "runtime/module-loader.js",
    "runtime/node-test.js",
    "runtime/domain.js",
    "runtime/dgram.js",
    "runtime/unsupported-builtins.js",
    "target-bridge.js",
)

_SUBSTRATE_ADAPTER_FILES = (
    "adapters/playwright/adapter-core.mjs",
)


def substrate_scope_fingerprint(integration: Path, config: HarnessConfig) -> str:
    """Fingerprint runtime sources plus the config scope that affects a browser run."""

    digest = hashlib.sha256()
    for relative in _SUBSTRATE_SCOPE_FILES:
        path = integration / relative
        digest.update(relative.encode())
        digest.update(b"\0")
        if not path.is_file():
            digest.update(b"<missing>")
            continue
        digest.update(path.read_bytes())
    for relative in _SUBSTRATE_ADAPTER_FILES:
        path = config.root / relative
        digest.update(relative.encode())
        digest.update(b"\0")
        if not path.is_file():
            digest.update(b"<missing>")
            continue
        digest.update(path.read_bytes())
    config_scope = {
        "target": {
            "command": config.target.command,
            "cwd": config.target.cwd,
            "env": sorted(config.target.env.items()),
            "protocol": config.target.protocol,
            "timeout_seconds": config.target.timeout_seconds,
            "max_output_chars": config.target.max_output_chars,
        },
        "variant": config.project.variant,
    }
    digest.update(json.dumps(config_scope, sort_keys=True, separators=(",", ":")).encode())
    return digest.hexdigest()


def build_substrate_identity(
    integration_head: str,
    scope_fingerprint: str,
    prerequisite_sources: Sequence[tuple[str, str]],
) -> str:
    payload = {
        "integration_head": integration_head,
        "scope": scope_fingerprint,
        "tests": sorted(prerequisite_sources),
    }
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def substrate_cache_hit(get_meta: Callable[[str], str | None], identity: str) -> bool:
    return get_meta("substrate_prerequisite.identity") == identity and get_meta("substrate_prerequisite.status") == "pass"


def classify_browser_failure(result: TestResult) -> str:
    """Return a stable infrastructure classification for structured browser failures."""

    run_result = result.details.get("run_result") if isinstance(result.details, dict) else None
    error = run_result.get("error") if isinstance(run_result, dict) else None
    code = error.get("code") if isinstance(error, dict) else result.details.get("classification")
    if code in {"ERR_INVALID_CAPABILITY", "ERR_CAPABILITY_DENIED", "ERR_NOT_SUPPORTED"}:
        return "substrate"
    if result.status in {"infra_error", "timeout"}:
        return "infrastructure"
    return "test"


def substrate_prerequisite_tests() -> tuple[TestCase, ...]:
    """Small browser-only probes for the shared VFS, output, stream, and process seams."""

    sources = {
        "vfs": """const assert = require('node:assert');
const fs = require('node:fs');
const path = '/node/.bnh-substrate-vfs';
fs.writeFileSync(path, new Uint8Array([0, 255, 1]));
assert.deepStrictEqual([...fs.readFileSync(path)], [0, 255, 1]);
fs.unlinkSync(path);
""",
        "streams-output-process": """const assert = require('node:assert');
const { Readable, Writable } = require('node:stream');
const seen = [];
const writable = new Writable({ write(chunk, _encoding, callback) { seen.push([...chunk]); callback(); } });
writable.on('finish', () => assert.deepStrictEqual(seen.flat(), [115, 117, 98, 115, 116, 114, 97, 116, 101]));
Readable.from(['substrate']).pipe(writable);
assert.strictEqual(typeof process.pid, 'number');
assert.ok(Array.isArray(process.argv));
process.stdout.write(new Uint8Array([115, 117, 98]));
process.stderr.write('strate\\n');
""",
    }
    return tuple(
        TestCase(
            path=f".bnh/substrate/{name}.js",
            suite="bnh-substrate-prerequisite",
            source_sha256=hashlib.sha256(source.encode()).hexdigest(),
            modules=("assert", "fs", "stream", "process"),
            source_override=source,
        )
        for name, source in sources.items()
    )


def run_command_spec(
    config: HarnessConfig,
    spec: CommandConfig,
    *,
    worktree: Path,
    run_id: str,
    iteration: int,
    attempt_id: str,
) -> tuple[bool, str]:
    if spec.protocol != "oneshot":
        return False, "workspace/setup validation commands must use protocol='oneshot'"
    mapping = {
        "config": str(config.path),
        "config_dir": str(config.root),
        "target_repo": str(config.project.target_repo),
        "node_repo": str(config.project.node_repo),
        "state_dir": str(config.project.state_dir),
        "worktree": str(worktree),
        "run_id": run_id,
        "iteration": str(iteration),
        "attempt_id": attempt_id,
    }
    argv = render_argv(spec.command, mapping)
    cwd = Path(render(spec.cwd, mapping)).resolve()
    env = sanitized_environment(inherit=spec.inherit_env, extra=spec.env, mapping=mapping)
    result = run_process(
        argv,
        cwd=cwd,
        env=env,
        timeout_seconds=spec.timeout_seconds,
        max_output_chars=spec.max_output_chars,
    )
    output = f"$ {' '.join(argv)}\n\nstdout:\n{result.stdout}\n\nstderr:\n{result.stderr}"
    return (not result.timed_out and result.exit_code == 0), output


def run_workspace_setup(
    config: HarnessConfig,
    *,
    worktree: Path,
    run_id: str,
    iteration: int,
    attempt_id: str,
) -> tuple[bool, str]:
    spec = config.workspace.setup
    if spec is None:
        return True, ""
    return run_command_spec(
        config, spec, worktree=worktree, run_id=run_id, iteration=iteration, attempt_id=attempt_id
    )


def run_check(
    config: HarnessConfig,
    *,
    worktree: Path,
    run_id: str,
    iteration: int,
    attempt_id: str,
) -> tuple[bool, str]:
    spec = config.validation.check
    if spec is None:
        return True, ""
    return run_command_spec(
        config, spec, worktree=worktree, run_id=run_id, iteration=iteration, attempt_id=attempt_id
    )


def validate_adapter_controls(
    config: HarnessConfig,
    runner: TestRunner,
    *,
    worktree: Path,
    run_id: str,
    iteration: int,
    attempt_id: str = "",
) -> tuple[bool, list[TestResult], str]:
    if not config.validation.require_source_override:
        return True, [], "source-override controls disabled"
    canaries = synthetic_canaries()
    tests = [case for case, _ in canaries]
    results = runner.run_many(
        tests,
        spec=config.target,
        worktree=worktree,
        phase="canary",
        run_id=run_id,
        iteration=iteration,
        attempt_id=attempt_id,
        concurrency=1,
    )
    mismatches = []
    for (_, expected), result in zip(canaries, results, strict=True):
        if result.status != expected:
            mismatches.append(f"{result.test_path}: expected {expected}, got {result.status}")
    if mismatches:
        return False, results, "; ".join(mismatches)
    return True, results, ""


def choose_guards(
    all_passing: Sequence[TestCase],
    *,
    assigned: Sequence[TestCase],
    count: int,
    seed: str,
) -> list[TestCase]:
    assigned_paths = {test.path for test in assigned}
    pool = [test for test in all_passing if test.path not in assigned_paths]
    if len(pool) <= count:
        return pool
    rng = random.Random(seed)
    return rng.sample(pool, count)


def validate_candidate(
    attempt: CandidateAttempt,
    *,
    config: HarnessConfig,
    runner: TestRunner,
    guards: Sequence[TestCase],
    run_id: str,
    iteration: int,
) -> CandidateAttempt:
    if not attempt.patch.valid:
        attempt.reason = attempt.patch.rejection_reason
        return attempt

    attempt.check_ok, attempt.check_output = run_check(
        config,
        worktree=attempt.worktree,
        run_id=run_id,
        iteration=iteration,
        attempt_id=attempt.attempt_id,
    )
    if not attempt.check_ok:
        attempt.reason = "validation check command failed"
        return attempt

    assigned_results = runner.run_many(
        list(attempt.task.tests),
        spec=config.target,
        worktree=attempt.worktree,
        phase="candidate-assigned",
        run_id=run_id,
        iteration=iteration,
        attempt_id=attempt.attempt_id,
        concurrency=1,
    )
    attempt.assigned_results = assigned_results
    passing_assigned = [
        test
        for test, result in zip(attempt.task.tests, assigned_results, strict=True)
        if result.status == "pass"
    ]
    infra_results = [
        result
        for result in assigned_results
        if result.status in {"infra_error", "timeout"}
    ]
    if infra_results:
        details = ", ".join(
            f"{result.test_path}={result.status}" for result in infra_results[:4]
        )
        attempt.reason = f"assigned test runner failure: {details}"
        return attempt
    if config.loop.accept_partial:
        if not passing_assigned:
            attempt.reason = "patch did not make any assigned test pass"
            return attempt
    elif len(passing_assigned) != len(attempt.task.tests):
        attempt.reason = "not every assigned test passed"
        return attempt

    controls_ok, _, controls_reason = validate_adapter_controls(
        config,
        runner,
        worktree=attempt.worktree,
        run_id=run_id,
        iteration=iteration,
        attempt_id=attempt.attempt_id,
    )
    if not controls_ok:
        attempt.reason = f"adapter negative controls failed: {controls_reason}"
        return attempt

    if guards:
        attempt.guard_results = runner.run_many(
            list(guards),
            spec=config.target,
            worktree=attempt.worktree,
            phase="candidate-guards",
            run_id=run_id,
            iteration=iteration,
            attempt_id=attempt.attempt_id,
            concurrency=1,
        )
        bad_guards = [result.test_path for result in attempt.guard_results if result.status != "pass"]
        if bad_guards:
            attempt.reason = "passing-test regressions: " + ", ".join(bad_guards[:8])
            return attempt

    if config.validation.require_source_override and config.loop.mutation_tests > 0:
        selected = passing_assigned[: config.loop.mutation_tests]
        for test in selected:
            mutant = mutated_test(config.project.node_repo, test, secrets.token_hex(8))
            result = runner.run_one(
                mutant,
                spec=config.target,
                worktree=attempt.worktree,
                phase="candidate-mutation",
                run_id=run_id,
                iteration=iteration,
                attempt_id=attempt.attempt_id,
            )
            if result.status != "fail":
                attempt.mutation_ok = False
                attempt.reason = (
                    f"source mutation was not observed for {test.path}: expected fail, got {result.status}"
                )
                return attempt

    pass_count = len(passing_assigned)
    attempt.score = (
        pass_count * 1000.0
        + len(attempt.guard_results) * 5.0
        - attempt.patch.size_bytes / 20_000.0
        - len(attempt.patch.changed_files) * 2.0
        - attempt.agent.duration_ms / 3_600_000.0
    )
    attempt.reason = f"candidate passed {pass_count}/{len(attempt.task.tests)} assigned tests"
    return attempt
