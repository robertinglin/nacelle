from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import threading
from collections import Counter, deque
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Callable, Iterable, Sequence

import fcntl

from .agent import run_agent
from .config import CommandConfig, HarnessConfig
from .db import Database, utc_now
from .discover import discover_tests
from .gitops import GitError, GitManager
from .models import AgentRun, CandidateAttempt, PatchInfo, Task, TestCase, TestResult
from .node_source import prepare_node_source, prepare_target_repository
from .oracle_cache import (
    build_oracle_cache_entry,
    oracle_cache_matches,
    oracle_cache_statuses,
    save_oracle_cache,
)
from .primitives import is_primitive_path, primitive_tests
from .runner import TestRunner, is_retryable_infrastructure, mutated_test, synthetic_canaries
from .scheduler import schedule_tasks
from .scope import source_test_inventory, summarize_scope
from .validation import (
    build_substrate_identity,
    classify_browser_failure,
    choose_guards,
    run_check,
    run_workspace_setup,
    substrate_cache_hit,
    substrate_prerequisite_tests,
    substrate_scope_fingerprint,
    validate_adapter_controls,
    validate_candidate,
)

Emit = Callable[[str], None]


def is_substrate_path(path: str) -> bool:
    return path.startswith(".bnh/substrate/")


def make_run_id(prefix: str = "run") -> str:
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    return f"{prefix}-{stamp}-{secrets.token_hex(3)}"


def chunks(values: Sequence[TestCase], size: int) -> Iterable[Sequence[TestCase]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


class SnapshotDriftError(RuntimeError):
    """Raised when a scan observes more than one target workspace snapshot."""

    def __init__(
        self,
        *,
        expected: str,
        observed_before: str,
        observed_after: str,
        results: Sequence[TestResult] = (),
    ) -> None:
        self.expected = expected
        self.observed_before = observed_before
        self.observed_after = observed_after
        self.results = tuple(results)
        super().__init__(
            "target workspace snapshot changed during scan: "
            f"expected={expected[:16]}, before={observed_before[:16]}, "
            f"after={observed_after[:16]}"
        )


class InfrastructureBurstError(RuntimeError):
    """Raised when the adapter dies for an entire scan batch."""


@contextmanager
def loop_lease(state_dir: Path) -> Iterable[None]:
    """Allow one harness loop per variant, with kernel-managed cleanup."""

    lock_path = state_dir / "loop.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+", encoding="utf-8") as handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            handle.seek(0)
            owner = handle.read().strip() or "unknown"
            raise RuntimeError(
                f"another harness loop already owns {lock_path} (pid {owner})"
            ) from exc
        handle.seek(0)
        handle.truncate()
        handle.write(f"{os.getpid()}\n")
        handle.flush()
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


class Harness:
    def __init__(self, config: HarnessConfig, emit: Emit = print):
        self.config = config
        self.emit = emit
        self.config.project.state_dir.mkdir(parents=True, exist_ok=True)
        self.db = Database(self.config.project.state_dir / "state.sqlite3")
        self.git = GitManager(config)
        self.runner = TestRunner(config)
        self._print_lock = threading.Lock()
        self._active_run_id: str | None = None
        self._active_iteration = 0

    def say(self, message: str) -> None:
        with self._print_lock:
            try:
                self.db.record_event(
                    message,
                    run_id=self._active_run_id,
                    iteration=self._active_iteration,
                )
            except Exception:
                # Activity reporting must not stop compatibility work.
                pass
            self.emit(message)

    def _record_adapter_progress(
        self,
        event: dict[str, object],
        *,
        run_id: str,
        iteration: int,
        attempt_id: str,
    ) -> None:
        """Persist only generic adapter activity; never echo candidate text."""

        phase = str(event.get("phase", "unknown"))
        name = str(event.get("event", "activity"))
        fields = []
        for key in (
            "stage", "module", "spec", "citgmVersion", "browser", "timeoutMs",
            "entry", "command", "argumentCount", "label", "childActive",
            "stream", "bytes", "chunks", "events", "files", "code", "timedOut",
        ):
            if key in event:
                fields.append(f"{key}={event[key]}")
        counters = event.get("counters")
        if isinstance(counters, dict):
            fields.append("counters=" + json.dumps(counters, sort_keys=True, separators=(",", ":")))
        message = f"adapter progress · {phase}/{name}"
        if fields:
            message += " · " + " ".join(fields)
        self.db.record_event(
            message,
            run_id=run_id,
            iteration=iteration,
            kind="runner",
            status="progress",
            attempt_id=attempt_id,
        )
        self.emit(message)

    def _agent_identity(self) -> tuple[str, str]:
        provider = self.config.agent.provider or Path(self.config.agent.command[0]).name
        model = self.config.agent.model or self.config.agent.env.get("BNH_AGENT_MODEL", "auto")
        return provider, model

    def _agent_label(self) -> str:
        provider, model = self._agent_identity()
        return f"{provider}/{model}"

    def _workspace_identity(self, worktree: Path) -> str:
        identity = getattr(self.git, "workspace_identity", None)
        if callable(identity):
            return str(identity(worktree))
        return str(self.git.head(worktree))

    def _checkpoint_integration(self, integration: Path) -> str:
        """Commit harness-owned integration edits before creating test worktrees."""

        if self.git.is_clean(integration):
            return self.git.head(integration)
        dirty = self.git._git("status", "--porcelain", cwd=integration, check=False)
        self.say(
            "integration worktree had uncommitted harness changes; "
            f"checkpointing them before execution{(': ' + dirty[:240]) if dirty else ''}"
        )
        self.git._git("add", "-A", cwd=integration, timeout=300)
        commit = self.git.commit_integration("bnh: checkpoint integration workspace")
        self.say(f"integration checkpoint committed at {commit[:12]}")
        return commit

    def initialize(self, *, run_setup: bool = True) -> Path:
        prepare_target_repository(self.config.project)
        integration = self.git.ensure_integration()
        self.git.ensure_shared_browser_runtime()
        prepare_node_source(self.config.project)
        self.db.set_meta("integration_worktree", str(integration))
        self.db.set_meta("integration_branch", self.config.project.integration_branch)
        self.db.set_meta("config", str(self.config.path))
        if run_setup:
            ok, output = run_workspace_setup(
                self.config,
                worktree=integration,
                run_id="init",
                iteration=0,
                attempt_id="integration",
            )
            if not ok:
                raise RuntimeError(f"workspace setup failed in integration worktree:\n{output}")
        self._checkpoint_integration(integration)
        return integration

    def discover(self) -> list[TestCase]:
        tests = discover_tests(self.config.project.node_repo, self.config.discovery)
        self.db.upsert_tests(tests)
        self.db.disable_missing_tests([test.path for test in tests])
        scope_summary = summarize_scope((test.path, test.suite) for test in tests)
        scope_summary["source_inventory"] = source_test_inventory(self.config.project.node_repo)
        self.db.set_meta("scope_summary", json.dumps(scope_summary, sort_keys=True))
        inventory = scope_summary["source_inventory"]
        if isinstance(inventory, dict):
            self.say(
                f"discovered {len(tests)} runnable entries; source inventory has "
                f"{inventory.get('test_files', 0)} test-* files "
                f"({inventory.get('javascript_test_files', 0)} JS/MJS/CJS)"
            )
        else:
            self.say(f"discovered {len(tests)} runnable entries")
        counts = scope_summary["counts"]
        if isinstance(counts, dict):
            rendered = ", ".join(f"{kind}={count}" for kind, count in counts.items() if count)
            if rendered:
                self.say(f"proof scope: {rendered}")
        return tests

    def _run_scan_batch(
        self,
        *,
        tests: Sequence[TestCase],
        spec: CommandConfig,
        worktree: Path,
        phase: str,
        run_id: str,
        iteration: int,
        batch_index: int,
        total: int,
        expected_snapshot: str | None = None,
        timeout_seconds: float | None = None,
    ) -> list[TestResult]:
        title = {
            "canonical-oracle": "Node oracle",
            "canonical-target": "Browser target baseline",
            "exploratory-target": "Browser exploratory target",
        }.get(phase, "Test runner")
        runner_id = f"{phase}-i{iteration:04d}-b{batch_index:04d}"
        message = f"{title} · batch {batch_index} · {len(tests)} test(s) ({total} selected)"
        self.db.record_event(
            message,
            run_id=run_id,
            iteration=iteration,
            kind="runner",
            status="started",
            attempt_id=runner_id,
        )
        observed_before = self._workspace_identity(worktree)
        if expected_snapshot is not None and observed_before != expected_snapshot:
            raise SnapshotDriftError(
                expected=expected_snapshot,
                observed_before=observed_before,
                observed_after=observed_before,
            )
        try:
            batch_spec = replace(spec, timeout_seconds=timeout_seconds) if timeout_seconds is not None else spec
            results = self.runner.run_many(
                list(tests),
                spec=batch_spec,
                worktree=worktree,
                phase=phase,
                run_id=run_id,
                iteration=iteration,
                concurrency=self.config.loop.target_concurrency,
                on_progress=lambda event: self._record_adapter_progress(
                    event,
                    run_id=run_id,
                    iteration=iteration,
                    attempt_id=runner_id,
                ),
            )
        except Exception as exc:
            self.db.record_event(
                f"{message} · failed: {type(exc).__name__}: {exc}",
                run_id=run_id,
                iteration=iteration,
                kind="runner",
                status="failed",
                attempt_id=runner_id,
            )
            raise
        observed_after = self._workspace_identity(worktree)
        if observed_after != observed_before:
            raise SnapshotDriftError(
                expected=expected_snapshot or observed_before,
                observed_before=observed_before,
                observed_after=observed_after,
                results=results,
            )
        counts = Counter(result.status for result in results)
        summary = ", ".join(f"{status}={count}" for status, count in sorted(counts.items()))
        self.db.record_event(
            f"{message} · finished ({summary or 'no results'})",
            run_id=run_id,
            iteration=iteration,
            kind="runner",
            status="finished",
            attempt_id=runner_id,
        )
        return results

    def _block_if_oracle_unavailable(self, *, run_id: str, iteration: int) -> bool:
        if self.config.oracle is None:
            return False

        blocked: list[tuple[str, str]] = []
        for test in self.db.list_tests():
            if is_primitive_path(test.path) or is_substrate_path(test.path):
                continue
            state = self.db.test_state(test.path) or {}
            oracle_status = str(state.get("oracle_status", "unknown"))
            if oracle_status not in {"pass", "skip"}:
                blocked.append((test.path, oracle_status))
        if not blocked:
            return False

        counts = Counter(status for _, status in blocked)
        breakdown = ", ".join(f"{status}={count}" for status, count in sorted(counts.items()))
        notes = (
            f"{len(blocked)} enabled non-primitive tests have unavailable oracle results"
            f" ({breakdown})"
        )
        eligible = [
            test
            for test in self.db.list_tests(oracle_eligible=True)
            if not is_primitive_path(test.path)
            and not is_substrate_path(test.path)
            and (self.db.test_state(test.path) or {}).get("target_status") != "pass"
        ]
        if eligible:
            self.say(
                f"oracle unavailable for {len(blocked)} test(s); continuing with "
                f"{len(eligible)} eligible target test(s)"
            )
            return False
        self.db.update_run(run_id, iteration=iteration, status="oracle_blocked", notes=notes)
        self.say(f"stopped: {notes}")
        return True

    def _record_results(
        self,
        results: Sequence[TestResult],
        *,
        run_id: str | None,
        iteration: int,
        phase: str,
        canonical: str | None,
        attempt_id: str | None = None,
        commit: str = "",
    ) -> None:
        for result in results:
            self.db.record_result(
                result,
                run_id=run_id,
                iteration=iteration,
                phase=phase,
                attempt_id=attempt_id,
                workspace_commit=commit,
                canonical=canonical,
            )

    def _record_snapshot_drift(
        self,
        *,
        run_id: str,
        iteration: int,
        phase: str,
        attempt_id: str,
        error: SnapshotDriftError,
    ) -> None:
        if error.results:
            self._record_results(
                error.results,
                run_id=run_id,
                iteration=iteration,
                phase=f"{phase}-invalidated",
                attempt_id=attempt_id,
                canonical=None,
                commit=error.observed_before,
            )
        message = (
            f"{phase} stopped: target snapshot drifted during batch; "
            f"expected={error.expected[:12]} before={error.observed_before[:12]} "
            f"after={error.observed_after[:12]}"
        )
        self.db.record_event(
            message,
            run_id=run_id,
            iteration=iteration,
            kind="runner",
            status="snapshot_drift",
            attempt_id=attempt_id,
        )
        self.db.update_run(run_id, iteration=iteration, status="snapshot_drift", notes=message)
        self.emit(message)

    def _reject_infrastructure_burst(
        self,
        *,
        run_id: str,
        iteration: int,
        phase: str,
        attempt_id: str,
        results: Sequence[TestResult],
        snapshot: str,
    ) -> None:
        if not results or not all(
            result.status == "infra_error" and is_retryable_infrastructure(result)
            for result in results
        ):
            return
        self._record_results(
            results,
            run_id=run_id,
            iteration=iteration,
            phase=f"{phase}-infra-invalidated",
            attempt_id=attempt_id,
            canonical=None,
            commit=snapshot,
        )
        message = (
            f"{phase} stopped: adapter infrastructure failed for all {len(results)} "
            f"tests in batch; snapshot={snapshot[:12]}"
        )
        self.db.record_event(
            message,
            run_id=run_id,
            iteration=iteration,
            kind="runner",
            status="infrastructure_burst",
            attempt_id=attempt_id,
        )
        self.db.update_run(
            run_id,
            iteration=iteration,
            status="infrastructure_blocked",
            notes=message,
        )
        self.emit(message)
        raise InfrastructureBurstError(message)

    def scan(
        self,
        *,
        run_id: str,
        iteration: int,
        tests: Sequence[TestCase] | None = None,
        refresh: bool = False,
        run_oracle: bool = True,
        failure_limit: int | None = None,
        include_oracle_ineligible: bool = False,
        retry_infra: bool = False,
        retry_unknown: bool = False,
    ) -> list[TestResult]:
        if sum((include_oracle_ineligible, retry_infra, retry_unknown)) > 1:
            raise ValueError("scan retry modes are mutually exclusive")
        integration = self.initialize(run_setup=False)
        selected = list(tests) if tests is not None else self.db.list_tests()
        if not selected:
            return []
        scan_snapshot = self._workspace_identity(integration)
        self.say(f"scan snapshot: {scan_snapshot[:12]}")

        if self.config.oracle is not None and run_oracle:
            cache_entry = build_oracle_cache_entry(self.config, selected)
            cache_hit = not refresh and oracle_cache_matches(self.config, cache_entry)
            if cache_hit:
                oracle_tests = []
                statuses = oracle_cache_statuses(self.config)
                if statuses:
                    self.db.set_oracle_statuses(statuses)
                else:
                    self.db.mark_oracle_pass([test.path for test in selected])
                self.say(f"oracle cache hit: {cache_entry['key'][:12]}")
            else:
                oracle_tests = list(selected)
                reason = "forced refresh" if refresh else "identity or oracle inputs changed"
                self.say(f"oracle cache miss ({reason}): {cache_entry['key'][:12]}")
            oracle_results: list[TestResult] = []
            for batch_index, batch in enumerate(chunks(oracle_tests, 64), start=1):
                self.say(
                    f"oracle batch {batch_index}: {len(batch)} tests "
                    f"({sum(1 for _ in oracle_tests)} total selected)"
                )
                try:
                    results = self._run_scan_batch(
                        tests=batch,
                        spec=self.config.oracle,
                        worktree=integration,
                        phase="canonical-oracle",
                        run_id=run_id,
                        iteration=iteration,
                        batch_index=batch_index,
                        total=len(oracle_tests),
                        expected_snapshot=scan_snapshot,
                    )
                except SnapshotDriftError as exc:
                    self._record_snapshot_drift(
                        run_id=run_id,
                        iteration=iteration,
                        phase="canonical-oracle",
                        attempt_id=f"canonical-oracle-i{iteration:04d}-b{batch_index:04d}",
                        error=exc,
                    )
                    raise
                self._reject_infrastructure_burst(
                    run_id=run_id,
                    iteration=iteration,
                    phase="canonical-oracle",
                    attempt_id=f"canonical-oracle-i{iteration:04d}-b{batch_index:04d}",
                    results=results,
                    snapshot=scan_snapshot,
                )
                self._record_results(
                    results,
                    run_id=run_id,
                    iteration=iteration,
                    phase="canonical-oracle",
                    canonical="oracle",
                    commit=self._workspace_identity(integration),
                )
                oracle_results.extend(results)
            if oracle_tests and len(oracle_results) == len(oracle_tests) and all(
                result.status in {"pass", "fail", "skip", "timeout"}
                for result in oracle_results
            ):
                save_oracle_cache(
                    self.config,
                    cache_entry,
                    statuses={result.test_path: result.status for result in oracle_results},
                )

        eligible: list[TestCase] = []
        phase = "exploratory-target" if include_oracle_ineligible else "canonical-target"
        canonical = None if include_oracle_ineligible else "target"
        for test in selected:
            state = self.db.test_state(test.path) or {}
            if include_oracle_ineligible:
                if state.get("oracle_status") != "pass":
                    eligible.append(test)
                continue
            if retry_infra:
                if (
                    (
                        not run_oracle
                        or self.config.oracle is None
                        or state.get("oracle_status") == "pass"
                    )
                    and state.get("target_status") == "infra_error"
                ):
                    eligible.append(test)
                continue
            if retry_unknown:
                if state.get("target_status") == "unknown":
                    eligible.append(test)
                continue
            if not run_oracle or self.config.oracle is None or state.get("oracle_status") == "pass":
                if refresh or state.get("target_status") == "unknown":
                    eligible.append(test)

        all_results: list[TestResult] = []
        total = len(eligible)
        target_failure_limit = (
            self.config.loop.scan_failure_limit
            if failure_limit is None
            else max(0, failure_limit)
        )
        target_batch_size = 64
        known_failures = 0
        parked_timeouts: list[TestCase] = []
        last_batch_index = 0
        for batch_index, batch in enumerate(chunks(eligible, target_batch_size), start=1):
            last_batch_index = batch_index
            self.say(f"target batch {batch_index}: {len(batch)} tests ({total} total selected)")
            try:
                results = self._run_scan_batch(
                    tests=batch,
                    spec=self.config.target,
                    worktree=integration,
                    phase=phase,
                    run_id=run_id,
                    iteration=iteration,
                    batch_index=batch_index,
                    total=total,
                    expected_snapshot=scan_snapshot,
                    timeout_seconds=getattr(self.config.loop, "scan_timeout_seconds", None),
                )
            except SnapshotDriftError as exc:
                self._record_snapshot_drift(
                    run_id=run_id,
                    iteration=iteration,
                    phase=phase,
                    attempt_id=f"{phase}-i{iteration:04d}-b{batch_index:04d}",
                    error=exc,
                )
                raise
            self._reject_infrastructure_burst(
                run_id=run_id,
                iteration=iteration,
                phase=phase,
                attempt_id=f"{phase}-i{iteration:04d}-b{batch_index:04d}",
                results=results,
                snapshot=scan_snapshot,
            )
            self._record_results(
                results,
                run_id=run_id,
                iteration=iteration,
                phase=phase,
                canonical=canonical,
                commit=self._workspace_identity(integration),
            )
            timed_out = {result.test_path for result in results if result.status == "timeout"}
            parked_timeouts.extend(test for test in batch if test.path in timed_out)
            all_results.extend(result for result in results if result.status != "timeout")
            known_failures += sum(result.status not in {"pass", "timeout"} for result in results)
            if target_failure_limit and known_failures >= target_failure_limit:
                self.say(
                    f"target scan stopped after {known_failures} actionable failure(s); "
                    f"{total - len(all_results)} test(s) remain unscanned"
                )
                break
        if parked_timeouts:
            self.say(
                f"parked {len(parked_timeouts)} timed-out test(s); "
                "leaving them queued for a later timeout pass"
            )
        return all_results

    def _empty_patch(self, attempt_id: str, reason: str) -> PatchInfo:
        path = self.config.project.state_dir / "patches" / f"{attempt_id}.patch"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")
        return PatchInfo(
            path=path,
            sha256="",
            size_bytes=0,
            changed_files=(),
            diff_stat="",
            valid=False,
            rejection_reason=reason,
        )

    def _candidate_worker(
        self,
        *,
        task: Task,
        worktree: Path,
        base_commit: str,
        guards: Sequence[TestCase],
        run_id: str,
        iteration: int,
        model_slot: int,
    ) -> CandidateAttempt:
        attempt_id = f"{run_id}-{task.task_id}-r{task.replica}"
        attempt_dir = self.config.project.state_dir / "attempts" / attempt_id
        attempt_dir.mkdir(parents=True, exist_ok=True)

        setup_ok, setup_output = run_workspace_setup(
            self.config,
            worktree=worktree,
            run_id=run_id,
            iteration=iteration,
            attempt_id=attempt_id,
        )
        (attempt_dir / "setup-before.txt").write_text(setup_output, encoding="utf-8")
        if not setup_ok:
            self.db.update_agent_session(
                attempt_id,
                status="failed",
                finished_at=utc_now(),
            )
            return CandidateAttempt(
                attempt_id=attempt_id,
                task=task,
                worktree=worktree,
                base_commit=base_commit,
                agent=AgentRun(None, False, 0, "", "", "workspace setup failed"),
                patch=self._empty_patch(attempt_id, "workspace setup failed before agent"),
                check_ok=False,
                check_output=setup_output,
                reason="workspace setup failed before agent",
            )

        # Candidate/merge results are deliberately not used as the next
        # agent's failure context. A candidate may pass in its private
        # worktree while the canonical integration still fails; mixing those
        # phases tells the next agent that a failing test is already green.
        failures = {
            test.path: self.db.latest_result(
                test.path,
                canonical_phase_prefix="canonical-target",
                run_id=run_id,
            )
            for test in task.tests
        }
        history = self.db.previous_attempts([test.path for test in task.tests])

        def on_metadata(**fields: object) -> None:
            finished = bool(fields.pop("finished", False))
            if finished:
                fields["finished_at"] = utc_now()
            self.db.update_agent_session(attempt_id, **fields)

        def on_restart() -> None:
            self.git.reset_worktree(worktree, base_commit)
            self.db.record_event(
                "agent restart requested; reset worktree to the attempt base",
                run_id=run_id,
                iteration=iteration,
                kind="agent",
                status="restarting",
                attempt_id=attempt_id,
            )

        try:
            agent_result = run_agent(
                config=self.config,
                worktree=worktree,
                task=task,
                failures=failures,
                previous_attempts=history,
                run_id=run_id,
                iteration=iteration,
                attempt_dir=attempt_dir,
                model_offset=model_slot,
                on_metadata=on_metadata,
                control_action=lambda: self.db.agent_action(attempt_id),
                clear_control_action=lambda: self.db.clear_agent_action(attempt_id),
                on_restart=on_restart,
            )
        except Exception as exc:
            self.db.update_agent_session(
                attempt_id,
                status="failed",
                finished_at=utc_now(),
            )
            agent_result = AgentRun(
                exit_code=None,
                timed_out=False,
                duration_ms=0,
                stdout="",
                stderr=f"agent invocation error: {type(exc).__name__}: {exc}",
                summary=f"agent invocation error: {type(exc).__name__}: {exc}",
            )
        (attempt_dir / "agent.stdout.txt").write_text(agent_result.stdout, encoding="utf-8")
        (attempt_dir / "agent.stderr.txt").write_text(agent_result.stderr, encoding="utf-8")

        if agent_result.stopped:
            self.git.reset_worktree(worktree, base_commit)
            return CandidateAttempt(
                attempt_id=attempt_id,
                task=task,
                worktree=worktree,
                base_commit=base_commit,
                agent=agent_result,
                patch=self._empty_patch(attempt_id, "agent stopped by dashboard"),
                reason="agent stopped by dashboard",
            )

        try:
            patch = self.git.collect_patch(
                worktree=worktree,
                base_commit=base_commit,
                attempt_id=attempt_id,
                validation=self.config.validation,
            )
        except Exception as exc:
            patch = self._empty_patch(attempt_id, f"patch collection failed: {type(exc).__name__}: {exc}")

        attempt = CandidateAttempt(
            attempt_id=attempt_id,
            task=task,
            worktree=worktree,
            base_commit=base_commit,
            agent=agent_result,
            patch=patch,
        )
        if not patch.valid:
            attempt.reason = patch.rejection_reason
            return attempt

        post_setup_ok, post_setup_output = run_workspace_setup(
            self.config,
            worktree=worktree,
            run_id=run_id,
            iteration=iteration,
            attempt_id=attempt_id,
        )
        (attempt_dir / "setup-after.txt").write_text(post_setup_output, encoding="utf-8")
        if not post_setup_ok:
            attempt.patch.valid = False
            attempt.patch.rejection_reason = "workspace setup failed after agent changes"
            attempt.reason = attempt.patch.rejection_reason
            return attempt

        attempt = validate_candidate(
            attempt,
            config=self.config,
            runner=self.runner,
            guards=guards,
            run_id=run_id,
            iteration=iteration,
        )
        (attempt_dir / "validation.txt").write_text(
            attempt.check_output + "\n\n" + attempt.reason,
            encoding="utf-8",
        )
        return attempt

    def _record_candidate(self, run_id: str, iteration: int, attempt: CandidateAttempt) -> None:
        self.db.increment_attempts([test.path for test in attempt.task.tests])
        self.db.record_attempt(run_id, iteration, attempt)
        for result in attempt.assigned_results:
            self.db.record_result(
                result,
                run_id=run_id,
                iteration=iteration,
                phase="candidate-assigned",
                attempt_id=attempt.attempt_id,
                workspace_commit=attempt.base_commit,
            )
        for result in attempt.guard_results:
            self.db.record_result(
                result,
                run_id=run_id,
                iteration=iteration,
                phase="candidate-guard",
                attempt_id=attempt.attempt_id,
                workspace_commit=attempt.base_commit,
            )

    def _run_candidate_round(
        self,
        *,
        tasks: Sequence[Task],
        run_id: str,
        iteration: int,
        current_base: str,
        passing_cases: Sequence[TestCase],
        label: str = "iteration",
    ) -> int:
        worktrees: dict[str, Path] = {}
        guards_by_attempt: dict[str, list[TestCase]] = {}
        worker_count = min(3, max(1, self.config.loop.workers))
        self.say(
            f"{label} {iteration}: queueing {len(tasks)} agent attempts "
            f"with {worker_count} concurrent workers from {current_base[:12]}"
        )
        next_task_index = 0
        available_model_slots = deque(range(worker_count))
        accepted = 0
        try:
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                futures = {}

                def submit(task: Task) -> None:
                    attempt_id = f"{run_id}-{task.task_id}-r{task.replica}"
                    task_base = self.git.head(self.git.integration)
                    worktree = self.git.create_agent_worktree(attempt_id, task_base)
                    worktrees[task.task_id] = worktree
                    guards_by_attempt[attempt_id] = choose_guards(
                        passing_cases,
                        assigned=task.tests,
                        count=self.config.loop.guard_tests,
                        seed=f"{self.config.loop.random_seed}:{run_id}:{iteration}:{task.task_id}",
                    )
                    model_slot = available_model_slots.popleft()
                    self.db.record_event(
                        f"{self._agent_label()} slot {model_slot + 1} started for "
                        f"{len(task.tests)} assigned test(s): "
                        f"{', '.join(test.path for test in task.tests[:4])}"
                        f"{'…' if len(task.tests) > 4 else ''} via {task.strategy}",
                        run_id=run_id,
                        iteration=iteration,
                        kind="agent",
                        status="started",
                        attempt_id=attempt_id,
                    )
                    attempt_dir = self.config.project.state_dir / "attempts" / attempt_id
                    provider, model = self._agent_identity()
                    self.db.start_agent_session(
                        run_id=run_id,
                        iteration=iteration,
                        attempt_id=attempt_id,
                        task_id=task.task_id,
                        strategy=task.strategy,
                        assigned_tests=[test.path for test in task.tests],
                        provider=provider,
                        model=model,
                        worktree=worktrees[task.task_id],
                        stdout_path=attempt_dir / "agent.stdout.log",
                        stderr_path=attempt_dir / "agent.stderr.log",
                        output_path=attempt_dir / "agent.output.log",
                    )
                    future = executor.submit(
                        self._candidate_worker,
                        task=task,
                        worktree=worktrees[task.task_id],
                        base_commit=task_base,
                        guards=guards_by_attempt[attempt_id],
                        run_id=run_id,
                        iteration=iteration,
                        model_slot=model_slot,
                    )
                    futures[future] = (task, attempt_id, model_slot, task_base)

                while next_task_index < len(tasks) and len(futures) < worker_count:
                    submit(tasks[next_task_index])
                    next_task_index += 1

                while futures:
                    completed, _ = wait(tuple(futures), return_when=FIRST_COMPLETED)
                    for future in completed:
                        task, attempt_id, model_slot, task_base = futures.pop(future)
                        try:
                            attempt = future.result()
                        except Exception as exc:
                            self.db.update_agent_session(
                                attempt_id,
                                status="failed",
                                finished_at=utc_now(),
                            )
                            attempt = CandidateAttempt(
                                attempt_id=attempt_id,
                                task=task,
                                worktree=worktrees[task.task_id],
                                base_commit=task_base,
                                agent=AgentRun(None, False, 0, "", str(exc), str(exc)),
                                patch=self._empty_patch(
                                    attempt_id,
                                    f"candidate worker crashed: {type(exc).__name__}: {exc}",
                                ),
                                reason=f"candidate worker crashed: {type(exc).__name__}: {exc}",
                            )
                        self._record_candidate(run_id, iteration, attempt)
                        self.db.record_event(
                            f"agent finished: {attempt.reason or 'candidate collected'}",
                            run_id=run_id,
                            iteration=iteration,
                            kind="agent",
                            status="finished",
                            attempt_id=attempt_id,
                        )
                        self.say(f"attempt {attempt.attempt_id}: score={attempt.score:.1f}; {attempt.reason}")
                        if attempt.patch.valid and attempt.score > 0:
                            guards = guards_by_attempt.get(attempt.attempt_id, [])
                            merged, detail = self._merge_candidate(
                                attempt=attempt,
                                guards=guards,
                                run_id=run_id,
                                iteration=iteration,
                            )
                            attempt.accepted = merged
                            attempt.reason = detail if not merged else f"accepted as {detail}"
                            self.db.mark_attempt(
                                attempt.attempt_id,
                                accepted=merged,
                                reason=attempt.reason,
                                score=attempt.score,
                            )
                            if merged:
                                accepted += 1
                                self.say(f"accepted {attempt.attempt_id} as {detail[:12]}")
                            else:
                                self.say(f"rejected at merge {attempt.attempt_id}: {detail}")
                        available_model_slots.append(model_slot)
                        if next_task_index < len(tasks):
                            submit(tasks[next_task_index])
                            next_task_index += 1

            return accepted
        finally:
            for path in worktrees.values():
                self.runner.close_worktree(path)
                self.git.remove_worktree(path)

    def _run_primitives(self, *, run_id: str, integration: Path) -> bool:
        tests = primitive_tests(self.config.primitives.items)
        if not tests:
            return True
        self.db.upsert_tests(tests)
        self.db.mark_oracle_pass([test.path for test in tests])
        integration_head = self.git.head(integration)
        contract_fingerprint = hashlib.sha256(
            json.dumps(
                sorted((test.path, test.source_sha256) for test in tests),
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        if (
            self.db.get_meta("primitive_phase.integration_head") == integration_head
            and self.db.get_meta("primitive_phase.contract_fingerprint") == contract_fingerprint
            and all(
                (self.db.test_state(test.path) or {}).get("target_status") == "pass"
                for test in tests
            )
        ):
            self.say("primitive phase: reusing green shared capabilities")
            return True

        primitive_paths = {test.path for test in tests}
        self.say(f"primitive phase: checking {len(tests)} shared browser capabilities first")
        self.scan(
            run_id=run_id,
            iteration=0,
            tests=tests,
            refresh=True,
            run_oracle=False,
        )

        for round_number in range(1, self.config.primitives.max_rounds + 1):
            unresolved = [
                test
                for test in tests
                if (state := self.db.test_state(test.path)) is None
                or state.get("target_status") != "pass"
            ]
            if not unresolved:
                self.db.set_meta("primitive_phase.integration_head", self.git.head(integration))
                self.db.set_meta("primitive_phase.contract_fingerprint", contract_fingerprint)
                self.say("primitive phase: all shared capabilities pass")
                return True
            tasks = schedule_tasks(
                unresolved,
                state_for=self.db.test_state,
                batch_size=1,
                max_attempts=min(len(unresolved), max(1, self.config.loop.workers * 2)),
                iteration=round_number,
                stalled_iterations=round_number - 1,
            )
            if not tasks:
                break
            self.say(
                f"primitive phase round {round_number}/{self.config.primitives.max_rounds}: "
                f"{len(unresolved)} capability(s) need work"
            )
            current_base = self.git.head(integration)
            passing_cases = [
                test
                for path in self.db.passing_paths()
                if path not in primitive_paths
                and not is_substrate_path(path)
                and (test := self.db.get_test(path)) is not None
            ]
            accepted = self._run_candidate_round(
                tasks=tasks,
                run_id=run_id,
                iteration=round_number,
                current_base=current_base,
                passing_cases=passing_cases,
                label="primitive round",
            )
            self.scan(
                run_id=run_id,
                iteration=round_number,
                tests=unresolved,
                refresh=True,
                run_oracle=False,
            )
            if accepted == 0:
                self.say("primitive phase: no capability patch accepted this round")

        unresolved_names = [
            test.path
            for test in tests
            if (state := self.db.test_state(test.path)) is None
            or state.get("target_status") != "pass"
        ]
        self.say(
            "primitive phase blocked before upstream tests: "
            + ", ".join(unresolved_names[:8])
            + ("…" if len(unresolved_names) > 8 else "")
        )
        return False

    def _run_substrate_prerequisites(self, *, run_id: str, integration: Path) -> bool:
        """Run the browser substrate gate without dispatching compatibility agents."""

        tests = substrate_prerequisite_tests()
        self.db.upsert_tests(tests)
        head = self.git.head(integration)
        scope = substrate_scope_fingerprint(integration, self.config)
        identity = build_substrate_identity(
            head,
            scope,
            [(test.path, test.source_sha256) for test in tests],
        )
        if substrate_cache_hit(self.db.get_meta, identity):
            self.db.record_event(
                f"substrate prerequisites reused for integration {head[:12]}",
                run_id=run_id,
                iteration=0,
                kind="substrate",
                status="reused",
            )
            self.say(f"substrate prerequisites: reused green result {identity[:12]}")
            return True

        self.db.record_event(
            f"substrate prerequisites started for integration {head[:12]}",
            run_id=run_id,
            iteration=0,
            kind="substrate",
            status="started",
        )
        self.say("primitive phase: checking shared browser capabilities first")
        self.say("substrate prerequisites: checking browser-native VFS, streams, output, and process")
        results = self.runner.run_many(
            list(tests),
            spec=self.config.target,
            worktree=integration,
            phase="substrate-prerequisite",
            run_id=run_id,
            iteration=0,
            concurrency=1,
        )
        self._record_results(
            results,
            run_id=run_id,
            iteration=0,
            phase="substrate-prerequisite",
            canonical="target",
            commit=head,
        )
        failures = [
            f"{result.test_path}={result.status}/{classify_browser_failure(result)}"
            for result in results
            if result.status != "pass"
        ]
        if failures:
            reason = "substrate prerequisite failure: " + ", ".join(failures[:6])
            self.db.set_meta("substrate_prerequisite.identity", identity)
            self.db.set_meta("substrate_prerequisite.status", "failed")
            self.db.record_event(
                reason,
                run_id=run_id,
                iteration=0,
                kind="substrate",
                status="failed",
            )
            self.say(f"stopped before upstream assignment: {reason}")
            return False

        self.db.set_meta("substrate_prerequisite.identity", identity)
        self.db.set_meta("substrate_prerequisite.status", "pass")
        self.db.set_meta("substrate_prerequisite.integration_head", head)
        self.db.set_meta("substrate_prerequisite.scope", scope)
        self.db.record_event(
            f"substrate prerequisites passed for integration {head[:12]}",
            run_id=run_id,
            iteration=0,
            kind="substrate",
            status="finished",
        )
        self.say("substrate prerequisites: green; upstream assignment is enabled")
        return True

    def _merge_candidate(
        self,
        *,
        attempt: CandidateAttempt,
        guards: Sequence[TestCase],
        run_id: str,
        iteration: int,
    ) -> tuple[bool, str]:
        candidate_passing = {
            result.test_path for result in attempt.assigned_results if result.status == "pass"
        }
        if not candidate_passing:
            return False, "candidate has no passing assigned tests"
        if all((self.db.test_state(path) or {}).get("target_status") == "pass" for path in candidate_passing):
            return False, "candidate was superseded by an earlier accepted patch"

        self.runner.close_worktree(self.git.integration)
        if not self.git.is_clean(self.git.integration):
            dirty = self.git._git("status", "--porcelain", cwd=self.git.integration, check=False)
            self.say(
                "merge: recovering dirty harness integration worktree"
                + (f": {dirty[:240]}" if dirty else "")
            )
            self.git.rollback_integration()
        if not self.git.is_clean(self.git.integration):
            return False, "integration worktree remained dirty after harness recovery"
        try:
            self.git.apply_patch(attempt.patch.path)
        except Exception as exc:
            self.runner.close_worktree(self.git.integration)
            self.git.rollback_integration()
            return False, f"patch did not apply to current integration head: {type(exc).__name__}: {exc}"

        if not self.git.has_staged_changes():
            self.runner.close_worktree(self.git.integration)
            self.git.rollback_integration()
            return False, "patch applied with no staged changes"

        setup_ok, setup_output = run_workspace_setup(
            self.config,
            worktree=self.git.integration,
            run_id=run_id,
            iteration=iteration,
            attempt_id=attempt.attempt_id,
        )
        if not setup_ok:
            self.runner.close_worktree(self.git.integration)
            self.git.rollback_integration()
            return False, f"integration setup failed after apply:\n{setup_output}"

        check_ok, check_output = run_check(
            self.config,
            worktree=self.git.integration,
            run_id=run_id,
            iteration=iteration,
            attempt_id=attempt.attempt_id,
        )
        if not check_ok:
            self.runner.close_worktree(self.git.integration)
            self.git.rollback_integration()
            return False, f"integration check failed after apply:\n{check_output}"

        assigned_results = self.runner.run_many(
            list(attempt.task.tests),
            spec=self.config.target,
            worktree=self.git.integration,
            phase="merge-assigned",
            run_id=run_id,
            iteration=iteration,
            attempt_id=attempt.attempt_id,
            concurrency=1,
        )
        merged_status = {result.test_path: result.status for result in assigned_results}
        lost = [path for path in candidate_passing if merged_status.get(path) != "pass"]
        if lost:
            self.runner.close_worktree(self.git.integration)
            self.git.rollback_integration()
            return False, "candidate gains disappeared on current head: " + ", ".join(sorted(lost))

        guard_results: list[TestResult] = []
        if guards:
            guard_results = self.runner.run_many(
                list(guards),
                spec=self.config.target,
                worktree=self.git.integration,
                phase="merge-guards",
                run_id=run_id,
                iteration=iteration,
                attempt_id=attempt.attempt_id,
                concurrency=1,
            )
            bad = [result.test_path for result in guard_results if result.status != "pass"]
            if bad:
                self.runner.close_worktree(self.git.integration)
                self.git.rollback_integration()
                return False, "merge guard regressions: " + ", ".join(bad[:8])

        controls_ok, _, controls_reason = validate_adapter_controls(
            self.config,
            self.runner,
            worktree=self.git.integration,
            run_id=run_id,
            iteration=iteration,
            attempt_id=attempt.attempt_id,
        )
        if not controls_ok:
            self.runner.close_worktree(self.git.integration)
            self.git.rollback_integration()
            return False, f"merge negative controls failed: {controls_reason}"

        if self.config.validation.require_source_override and self.config.loop.mutation_tests > 0:
            passing_tests = [test for test in attempt.task.tests if test.path in candidate_passing]
            for test in passing_tests[: self.config.loop.mutation_tests]:
                mutant = mutated_test(self.config.project.node_repo, test)
                result = self.runner.run_one(
                    mutant,
                    spec=self.config.target,
                    worktree=self.git.integration,
                    phase="merge-mutation",
                    run_id=run_id,
                    iteration=iteration,
                    attempt_id=attempt.attempt_id,
                )
                if result.status != "fail":
                    self.runner.close_worktree(self.git.integration)
                    self.git.rollback_integration()
                    return False, f"merge source mutation was not observed for {test.path}"

        if self.git.has_unstaged_tracked_changes():
            self.runner.close_worktree(self.git.integration)
            self.git.rollback_integration()
            return False, "validation commands modified tracked files outside the staged patch"

        title = next(iter(sorted(candidate_passing)))
        try:
            commit = self.git.commit_integration(
                f"bnh: improve Node compatibility for {title}"
            )
        except Exception as exc:
            self.runner.close_worktree(self.git.integration)
            self.git.rollback_integration()
            return False, f"commit failed: {type(exc).__name__}: {exc}"

        for result in assigned_results:
            self.db.record_result(
                result,
                run_id=run_id,
                iteration=iteration,
                phase="canonical-target-merge",
                attempt_id=attempt.attempt_id,
                workspace_commit=commit,
                canonical="target",
            )
        for result in guard_results:
            self.db.record_result(
                result,
                run_id=run_id,
                iteration=iteration,
                phase="canonical-target-merge-guard",
                attempt_id=attempt.attempt_id,
                workspace_commit=commit,
                canonical="target",
            )
        self.db.record_merge(
            run_id=run_id,
            iteration=iteration,
            attempt_id=attempt.attempt_id,
            commit_sha=commit,
            patch_sha256=attempt.patch.sha256,
            tests=sorted(candidate_passing),
        )
        self.git._git("clean", "-fd", cwd=self.git.integration, check=False)
        return True, commit

    def loop(self, *, refresh: bool = False, max_iterations_override: int | None = None) -> str:
        with loop_lease(self.config.project.state_dir):
            return self._loop(
                refresh=refresh,
                max_iterations_override=max_iterations_override,
            )

    def _loop(self, *, refresh: bool = False, max_iterations_override: int | None = None) -> str:
        integration = self.initialize(run_setup=True)
        discovered = self.discover()
        base_commit = self.git.head(integration)
        previous_run = self.db.latest_run(variant=self.config.project.variant)
        run_id = str(previous_run["id"]) if previous_run else make_run_id()
        starting_iteration = int(previous_run.get("iteration", 0)) if previous_run else 0
        self.db.set_meta("current_session_id", make_run_id("session"))
        self.db.set_meta("current_session_started_at", utc_now())
        self._active_run_id = run_id
        self._active_iteration = starting_iteration
        if previous_run:
            self.db.resume_run(
                run_id,
                iteration=starting_iteration,
                notes=f"resumed variant workspace at {base_commit[:12]}",
            )
            self.say(f"resuming run {run_id} at integration {base_commit[:12]}")
        else:
            self.db.start_run(run_id, base_commit, variant=self.config.project.variant)
            self.say(f"run {run_id} started at {base_commit[:12]}")
        try:
            prerequisites_ok = self._run_substrate_prerequisites(run_id=run_id, integration=integration)
            if not prerequisites_ok:
                self.db.update_run(
                    run_id,
                    status="substrate_blocked",
                    notes="browser substrate prerequisites were not green; upstream assignment stopped",
                )
                return run_id
            self.scan(
                run_id=run_id,
                iteration=0,
                tests=discovered,
                refresh=refresh,
                run_oracle=True,
            )
            summary = self.db.summary()
            self.say(
                f"baseline: pass={summary['pass']} fail={summary['fail']} "
                f"skip={summary['skip']} timeout={summary['timeout']} "
                f"infra={summary['infra_error']} unknown={summary['unknown']}"
            )
            if self._block_if_oracle_unavailable(run_id=run_id, iteration=starting_iteration):
                return run_id

            iteration = starting_iteration
            stalled = 0
            configured_max = (
                max_iterations_override
                if max_iterations_override is not None
                else self.config.loop.max_iterations
            )
            while True:
                self._active_iteration = iteration
                failures = self.db.list_actionable_tests(
                    oracle_enabled=self.config.oracle is not None,
                    max_attempts=self.config.loop.max_attempts_per_test,
                )
                if not failures:
                    remaining_unbounded = self.db.list_actionable_tests(
                        oracle_enabled=self.config.oracle is not None,
                        max_attempts=0,
                    )
                    if remaining_unbounded:
                        self.db.update_run(
                            run_id,
                            iteration=iteration,
                            status="exhausted",
                            notes="all remaining tests reached max_attempts_per_test",
                        )
                        self.say("stopped: all remaining tests reached max_attempts_per_test")
                        return run_id
                    eligible = (
                        self.db.list_tests(oracle_eligible=True)
                        if self.config.oracle is not None
                        else self.db.list_tests()
                    )
                    eligible = [
                        test for test in eligible
                        if not is_primitive_path(test.path) and not is_substrate_path(test.path)
                    ]
                    unknown = [
                        test
                        for test in eligible
                        if (self.db.test_state(test.path) or {}).get("target_status") == "unknown"
                    ]
                    if unknown:
                        self.say(
                            f"no known failures; sampling {len(unknown)} unscanned target test(s)"
                        )
                        self.scan(
                            run_id=run_id,
                            iteration=iteration,
                            tests=unknown,
                            refresh=False,
                            run_oracle=False,
                        )
                    else:
                        self.say("no known failures; running a full confirmation scan")
                        self.scan(
                            run_id=run_id,
                            iteration=iteration,
                            tests=eligible,
                            refresh=True,
                            run_oracle=False,
                        )
                    confirmed = self.db.list_actionable_tests(
                        oracle_enabled=self.config.oracle is not None,
                        max_attempts=0,
                    )
                    if not confirmed:
                        remaining_unknown = [
                            test
                            for test in eligible
                            if (self.db.test_state(test.path) or {}).get("target_status") == "unknown"
                        ]
                        if remaining_unknown:
                            self.say(
                                f"sample passed; {len(remaining_unknown)} target test(s) remain unscanned"
                            )
                            continue
                        if self._block_if_oracle_unavailable(run_id=run_id, iteration=iteration):
                            return run_id
                        controls_ok, _, reason = validate_adapter_controls(
                            self.config,
                            self.runner,
                            worktree=integration,
                            run_id=run_id,
                            iteration=iteration,
                        )
                        if controls_ok:
                            self.db.update_run(run_id, iteration=iteration, status="green")
                            self.say(f"run {run_id} is green")
                            return run_id
                        self.say(f"full suite passed but adapter controls failed: {reason}")
                        failures = [
                            case for case, expected in synthetic_canaries() if expected == "pass"
                        ]
                    else:
                        failures = confirmed

                iteration += 1
                if configured_max and iteration > configured_max:
                    self.db.update_run(
                        run_id,
                        iteration=iteration - 1,
                        status="iteration_limit",
                        notes=f"max iterations: {configured_max}",
                    )
                    self.say(f"stopped at configured iteration limit {configured_max}")
                    return run_id
                self._active_iteration = iteration
                self.db.update_run(run_id, iteration=iteration)

                tasks = schedule_tasks(
                failures,
                state_for=self.db.test_state,
                batch_size=self.config.loop.batch_size,
                max_attempts=min(len(failures), self.config.loop.queue_depth),
                    iteration=iteration,
                    stalled_iterations=stalled,
                )
                if not tasks:
                    self.db.update_run(run_id, iteration=iteration, status="stalled", notes="scheduler produced no tasks")
                    return run_id

                current_base = self.git.head(integration)
                passing_cases = [
                    test
                    for path in self.db.passing_paths()
                    if not is_primitive_path(path)
                    and not is_substrate_path(path)
                    and (test := self.db.get_test(path)) is not None
                ]
                accepted = self._run_candidate_round(
                    tasks=tasks,
                    run_id=run_id,
                    iteration=iteration,
                    current_base=current_base,
                    passing_cases=passing_cases,
                )

                if accepted:
                    stalled = 0
                    current_failures = self.db.list_actionable_tests(
                        oracle_enabled=self.config.oracle is not None,
                        max_attempts=0,
                    )
                    self.say(
                        f"iteration {iteration}: accepted {accepted}; refreshing {len(current_failures)} failures"
                    )
                    self.scan(
                        run_id=run_id,
                        iteration=iteration,
                        tests=current_failures,
                        refresh=True,
                        run_oracle=False,
                    )
                    if iteration % self.config.loop.refresh_all_every == 0:
                        eligible = (
                            self.db.list_tests(oracle_eligible=True)
                            if self.config.oracle is not None
                            else self.db.list_tests()
                        )
                        eligible = [
                            test for test in eligible
                            if not is_primitive_path(test.path) and not is_substrate_path(test.path)
                        ]
                        self.say(f"iteration {iteration}: scheduled full regression refresh")
                        self.scan(
                            run_id=run_id,
                            iteration=iteration,
                            tests=eligible,
                            refresh=True,
                            run_oracle=False,
                        )
                else:
                    stalled += 1
                    self.say(
                        f"iteration {iteration}: no patch accepted; stall depth is {stalled}. "
                        "The next scheduler pass will rotate strategy lanes."
                    )
                    if stalled % self.config.loop.stall_iterations == 0:
                        eligible = (
                            self.db.list_tests(oracle_eligible=True)
                            if self.config.oracle is not None
                            else self.db.list_tests()
                        )
                        eligible = [
                            test for test in eligible
                            if not is_primitive_path(test.path) and not is_substrate_path(test.path)
                        ]
                        self.say(
                            f"stall depth {stalled}: refreshing all {len(eligible)} eligible tests "
                            "before another agent round"
                        )
                        self.scan(
                            run_id=run_id,
                            iteration=iteration,
                            tests=eligible,
                            refresh=True,
                            run_oracle=False,
                        )
        except (SnapshotDriftError, InfrastructureBurstError):
            # The scan already persisted the invalidated batch and marked the
            # run. Do not launch agents against a moving target workspace.
            return run_id
        except KeyboardInterrupt:
            self.db.update_run(run_id, status="interrupted", notes="keyboard interrupt")
            raise
        except Exception as exc:
            self.db.update_run(run_id, status="failed", notes=f"{type(exc).__name__}: {exc}")
            raise

    def status_text(self) -> str:
        summary = self.db.summary()
        lines = [
            (
                f"entries={summary['total']} pass={summary['pass']} fail={summary['fail']} "
                f"skip={summary['skip']} timeout={summary['timeout']} "
                f"infra={summary['infra_error']} unknown={summary['unknown']}"
            )
        ]
        raw_scope = self.db.get_meta("scope_summary")
        if raw_scope:
            try:
                scope_summary = json.loads(raw_scope)
            except json.JSONDecodeError:
                scope_summary = {}
            counts = scope_summary.get("counts") if isinstance(scope_summary, dict) else None
            if isinstance(counts, dict):
                rendered = ", ".join(f"{kind}={count}" for kind, count in counts.items() if count)
                if rendered:
                    lines.append(f"proof scope: {rendered}")
            inventory = scope_summary.get("source_inventory")
            if isinstance(inventory, dict):
                lines.append(
                    "source inventory: "
                    f"test-*={inventory.get('test_files', 0)} "
                    f"JS/MJS/CJS={inventory.get('javascript_test_files', 0)}"
                )
        clusters = self.db.top_failure_clusters()
        if clusters:
            lines.append("top failure clusters:")
            for cluster in clusters:
                lines.append(
                    f"  {cluster['count']:>4}  {cluster['suite']:<12} "
                    f"{cluster['failure_fingerprint'] or 'unknown':<20} {cluster['example']}"
                )
        return "\n".join(lines)

    def write_report(self, output: Path) -> Path:
        summary = self.db.summary()
        clusters = self.db.top_failure_clusters(25)
        payload = {
            "generated_at": datetime.now(UTC).isoformat(),
            "config": str(self.config.path),
            "integration_branch": self.config.project.integration_branch,
            "integration_head": self.git.head(self.git.ensure_integration()),
            "summary": summary,
            "scope": json.loads(self.db.get_meta("scope_summary") or "{}"),
            "failure_clusters": clusters,
        }
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return output
