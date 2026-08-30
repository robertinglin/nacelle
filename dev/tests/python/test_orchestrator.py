from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from browser_node_harness.config import CommandConfig
from browser_node_harness.db import Database
from browser_node_harness.models import TestCase, TestResult
from browser_node_harness.orchestrator import Harness, loop_lease


class OracleGuardTests(unittest.TestCase):
    def test_loop_lease_rejects_a_second_owner(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            state_dir = Path(raw)
            with loop_lease(state_dir):
                with self.assertRaisesRegex(RuntimeError, "another harness loop"):
                    with loop_lease(state_dir):
                        pass

    def test_unavailable_oracle_does_not_stop_known_target_work(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            harness = Harness.__new__(Harness)
            harness.config = SimpleNamespace(oracle=SimpleNamespace())
            harness.db = Database(root / "state.sqlite3")
            harness.emit = (messages := []).append
            harness._print_lock = threading.Lock()
            harness._active_run_id = "run-test"
            harness._active_iteration = 0

            harness.db.upsert_tests(
                [
                    TestCase(
                        path=".bnh/primitives/vfs.js",
                        suite="bnh-primitives",
                        source_sha256="primitive",
                    ),
                    TestCase(
                        path="test/parallel/test-failed.js",
                        suite="parallel",
                        source_sha256="failed",
                    ),
                    TestCase(
                        path="test/parallel/test-target-failed.js",
                        suite="parallel",
                        source_sha256="target-failed",
                    ),
                    TestCase(
                        path="test/parallel/test-unknown.js",
                        suite="parallel",
                        source_sha256="unknown",
                    ),
                ]
            )
            harness.db.start_run("run-test", "base", variant="v22")
            harness.db.record_result(
                TestResult(
                    test_path="test/parallel/test-target-failed.js",
                    status="pass",
                    exit_code=0,
                    duration_ms=1,
                ),
                run_id="run-test",
                iteration=0,
                phase="canonical-oracle",
                canonical="oracle",
            )
            harness.db.record_result(
                TestResult(
                    test_path="test/parallel/test-failed.js",
                    status="fail",
                    exit_code=1,
                    duration_ms=1,
                ),
                run_id="run-test",
                iteration=0,
                phase="canonical-oracle",
                canonical="oracle",
            )

            harness.db.record_result(
                TestResult(
                    test_path="test/parallel/test-target-failed.js",
                    status="fail",
                    exit_code=1,
                    duration_ms=1,
                ),
                run_id="run-test",
                iteration=0,
                phase="canonical-target",
                canonical="target",
            )

            self.assertFalse(harness._block_if_oracle_unavailable(run_id="run-test", iteration=0))
            run = harness.db.get_run("run-test")
            self.assertIsNotNone(run)
            self.assertEqual(run["status"], "running")
            self.assertTrue(any("continuing with" in message for message in messages))

    def test_unavailable_oracle_blocks_when_no_target_work_remains(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            harness = Harness.__new__(Harness)
            harness.config = SimpleNamespace(oracle=SimpleNamespace())
            harness.db = Database(root / "state.sqlite3")
            harness.emit = (messages := []).append
            harness._print_lock = threading.Lock()
            harness._active_run_id = "run-test"
            harness._active_iteration = 0
            test = TestCase("test/parallel/test-passed.js", "parallel", "passed")
            harness.db.upsert_tests([test])
            harness.db.start_run("run-test", "base", variant="v22")
            harness.db.record_result(
                TestResult(test.path, "pass", 0, 1),
                run_id="run-test",
                iteration=0,
                phase="canonical-target",
                canonical="target",
            )
            self.assertTrue(harness._block_if_oracle_unavailable(run_id="run-test", iteration=0))
            self.assertEqual(harness.db.get_run("run-test")["status"], "oracle_blocked")


class AgentFailureContextTests(unittest.TestCase):
    def test_canonical_target_context_excludes_private_candidate_passes(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            db = Database(Path(raw) / "state.sqlite3")
            test = TestCase("test/parallel/test-failing.js", "parallel", "source")
            db.upsert_tests([test])
            db.start_run("run-one", "head")
            db.record_result(
                TestResult(test.path, "fail", 1, 1),
                run_id="run-one",
                iteration=0,
                phase="canonical-target",
                canonical="target",
            )
            db.start_run("run-two", "head")
            db.record_result(
                TestResult(test.path, "fail", 1, 1),
                run_id="run-two",
                iteration=1,
                phase="canonical-target",
                canonical="target",
            )
            db.record_result(
                TestResult(test.path, "pass", 0, 1),
                run_id="run-two",
                iteration=1,
                phase="candidate-assigned",
            )

            latest = db.latest_result(test.path)
            canonical = db.latest_result(
                test.path,
                canonical_phase_prefix="canonical-target",
                run_id="run-two",
            )
            self.assertEqual(latest["status"], "pass")
            self.assertEqual(canonical["status"], "fail")


class BoundedTargetScanTests(unittest.TestCase):
    def _harness(self, root: Path, *, scan_failure_limit: int = 3, target_concurrency: int = 1) -> Harness:
        harness = Harness.__new__(Harness)
        harness.config = SimpleNamespace(
            oracle=None,
            loop=SimpleNamespace(
                scan_failure_limit=scan_failure_limit,
                target_concurrency=target_concurrency,
            ),
            target=SimpleNamespace(),
        )
        harness.db = Database(root / "state.sqlite3")
        harness.git = SimpleNamespace(head=lambda _integration: "head")
        harness.emit = (messages := []).append
        harness.messages = messages
        harness._print_lock = threading.Lock()
        harness._active_run_id = "run-test"
        harness._active_iteration = 0
        harness.db.start_run("run-test", "head")
        harness.initialize = lambda run_setup=False: root
        return harness

    @staticmethod
    def _tests(count: int) -> list[TestCase]:
        return [
            TestCase(path=f"test/parallel/test-{index}.js", suite="parallel", source_sha256=str(index))
            for index in range(count)
        ]

    def test_actionable_tests_exclude_unknown_target_status(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            db = Database(Path(raw) / "state.sqlite3")
            tests = self._tests(5)
            db.upsert_tests(tests)
            db.start_run("run-test", "head")
            for test, status in zip(
                tests[1:],
                ("fail", "skip", "timeout", "infra_error"),
            ):
                db.record_result(
                    TestResult(
                        test_path=test.path,
                        status=status,
                        exit_code=1,
                        duration_ms=1,
                    ),
                    run_id="run-test",
                    iteration=0,
                    phase="canonical-target",
                    canonical="target",
                )

            actionable = db.list_actionable_tests(oracle_enabled=False)

            self.assertEqual([test.path for test in actionable], [test.path for test in tests[1:]])
            self.assertNotIn(tests[0].path, [test.path for test in actionable])

    def test_bounded_scan_finishes_current_batch_before_failure_budget_stop(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            harness = self._harness(Path(raw), scan_failure_limit=2)
            tests = self._tests(4)
            harness.db.upsert_tests(tests)
            calls: list[tuple[str, ...]] = []

            def run_many(batch, **_kwargs):
                calls.append(tuple(test.path for test in batch))
                return [
                    TestResult(test_path=test.path, status="fail", exit_code=1, duration_ms=1)
                    for test in batch
                ]

            harness.runner = SimpleNamespace(run_many=run_many)

            results = harness.scan(
                run_id="run-test",
                iteration=0,
                tests=tests,
                run_oracle=False,
            )

            self.assertEqual([result.test_path for result in results], [test.path for test in tests])
            self.assertEqual(calls, [tuple(test.path for test in tests)])
            self.assertEqual(
                [harness.db.test_state(test.path)["target_status"] for test in tests],
                ["fail"] * len(tests),
            )
            self.assertTrue(any("4 actionable failure(s)" in message for message in harness.messages))

    def test_zero_failure_limit_scans_all_selected_tests(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            harness = self._harness(Path(raw), scan_failure_limit=3)
            tests = self._tests(4)
            harness.db.upsert_tests(tests)
            calls: list[tuple[str, ...]] = []

            def run_many(batch, **_kwargs):
                calls.append(tuple(test.path for test in batch))
                return [
                    TestResult(test_path=test.path, status="pass", exit_code=0, duration_ms=1)
                    for test in batch
                ]

            harness.runner = SimpleNamespace(run_many=run_many)

            results = harness.scan(
                run_id="run-test",
                iteration=0,
                tests=tests,
                run_oracle=False,
                failure_limit=0,
            )

            self.assertEqual([result.test_path for result in results], [test.path for test in tests])
            self.assertEqual(calls, [tuple(test.path for test in tests)])
            self.assertEqual(
                [harness.db.test_state(test.path)["target_status"] for test in tests],
                ["pass"] * len(tests),
            )

    def test_parked_timeouts_are_not_retried_in_same_scan(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            harness = self._harness(Path(raw), scan_failure_limit=0)
            tests = self._tests(2)
            harness.db.upsert_tests(tests)
            harness.config.loop.scan_timeout_seconds = 15
            calls: list[float | None] = []

            def run_many(batch, **kwargs):
                calls.append(kwargs["spec"].timeout_seconds)
                return [
                    TestResult(test.path, "timeout", None, 1)
                    for test in batch
                ]

            harness.runner = SimpleNamespace(run_many=run_many)
            harness.config.target = CommandConfig(command=(), cwd="", timeout_seconds=120)

            results = harness.scan(
                run_id="run-test",
                iteration=0,
                tests=tests,
                run_oracle=False,
                failure_limit=0,
            )

            self.assertEqual(results, [])
            self.assertEqual(calls, [15])

    def test_oracle_ineligible_exploration_does_not_change_canonical_target_status(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            harness = self._harness(Path(raw), scan_failure_limit=3)
            harness.config.oracle = SimpleNamespace()
            tests = self._tests(4)
            harness.db.upsert_tests(tests)
            for test, status in zip(tests, ("fail", "skip", "timeout", "pass")):
                harness.db.record_result(
                    TestResult(test.path, status, 1 if status != "pass" else 0, 1),
                    run_id="run-test",
                    iteration=0,
                    phase="canonical-oracle",
                    canonical="oracle",
                )
            calls: list[tuple[str, str]] = []

            def run_many(batch, **kwargs):
                calls.extend((test.path, kwargs["phase"]) for test in batch)
                return [
                    TestResult(test.path, "pass", 0, 1)
                    for test in batch
                ]

            harness.runner = SimpleNamespace(run_many=run_many)

            results = harness.scan(
                run_id="run-test",
                iteration=0,
                tests=tests,
                run_oracle=False,
                include_oracle_ineligible=True,
                failure_limit=0,
            )

            self.assertEqual([result.test_path for result in results], [test.path for test in tests[:3]])
            self.assertEqual({phase for _, phase in calls}, {"exploratory-target"})
            self.assertEqual(
                [harness.db.test_state(test.path)["target_status"] for test in tests],
                ["unknown"] * 4,
            )
            with harness.db.connect() as connection:
                self.assertEqual(
                    connection.execute(
                        "SELECT COUNT(*) FROM results WHERE phase='exploratory-target'"
                    ).fetchone()[0],
                    3,
                )

    def test_infrastructure_retry_selects_only_current_target_infra_failures(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            harness = self._harness(Path(raw), scan_failure_limit=3)
            tests = self._tests(4)
            harness.db.upsert_tests(tests)
            for test, status in zip(tests, ("pass", "infra_error", "fail", "unknown")):
                if status != "unknown":
                    harness.db.record_result(
                        TestResult(test.path, status, 0 if status == "pass" else 1, 1),
                        run_id="run-test",
                        iteration=0,
                        phase="canonical-target",
                        canonical="target",
                    )
            calls: list[tuple[str, ...]] = []

            def run_many(batch, **_kwargs):
                calls.append(tuple(test.path for test in batch))
                return [TestResult(test.path, "pass", 0, 1) for test in batch]

            harness.runner = SimpleNamespace(run_many=run_many)

            results = harness.scan(
                run_id="run-test",
                iteration=0,
                tests=tests,
                run_oracle=False,
                retry_infra=True,
                failure_limit=0,
            )

            self.assertEqual([result.test_path for result in results], [tests[1].path])
            self.assertEqual(calls, [(tests[1].path,)])
            self.assertEqual(
                [harness.db.test_state(test.path)["target_status"] for test in tests],
                ["pass", "pass", "fail", "unknown"],
            )

    def test_no_oracle_infrastructure_retry_includes_oracle_ineligible_rows(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            harness = self._harness(Path(raw), scan_failure_limit=3)
            harness.config.oracle = SimpleNamespace()
            tests = self._tests(2)
            harness.db.upsert_tests(tests)
            for test, status in zip(tests, ("fail", "skip")):
                harness.db.record_result(
                    TestResult(test.path, status, 1, 1),
                    run_id="run-test",
                    iteration=0,
                    phase="canonical-oracle",
                    canonical="oracle",
                )
                harness.db.record_result(
                    TestResult(test.path, "infra_error", 1, 1),
                    run_id="run-test",
                    iteration=0,
                    phase="canonical-target",
                    canonical="target",
                )
            calls: list[tuple[str, ...]] = []

            def run_many(batch, **_kwargs):
                calls.append(tuple(test.path for test in batch))
                return [TestResult(test.path, "pass", 0, 1) for test in batch]

            harness.runner = SimpleNamespace(run_many=run_many)

            results = harness.scan(
                run_id="run-test",
                iteration=0,
                tests=tests,
                run_oracle=False,
                retry_infra=True,
                failure_limit=0,
            )

            self.assertEqual([result.test_path for result in results], [test.path for test in tests])
            self.assertEqual(calls, [tuple(test.path for test in tests)])

    def test_no_oracle_allows_unknown_target_results_past_oracle_gate(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            harness = self._harness(Path(raw), scan_failure_limit=3)
            harness.config.oracle = SimpleNamespace()
            tests = self._tests(3)
            harness.db.upsert_tests(tests)
            for test, status in zip(tests, ("fail", "skip", "pass")):
                harness.db.record_result(
                    TestResult(test.path, status, 0 if status == "pass" else 1, 1),
                    run_id="run-test",
                    iteration=0,
                    phase="canonical-oracle",
                    canonical="oracle",
                )
            calls: list[tuple[str, ...]] = []

            def run_many(batch, **_kwargs):
                calls.append(tuple(test.path for test in batch))
                return [TestResult(test.path, "pass", 0, 1) for test in batch]

            harness.runner = SimpleNamespace(run_many=run_many)

            results = harness.scan(
                run_id="run-test",
                iteration=0,
                tests=tests,
                run_oracle=False,
                failure_limit=0,
            )

            self.assertEqual([result.test_path for result in results], [test.path for test in tests])
            self.assertEqual(calls, [tuple(test.path for test in tests)])

    def test_unknown_retry_updates_only_unknown_canonical_target_results(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            harness = self._harness(Path(raw), scan_failure_limit=3)
            tests = self._tests(3)
            harness.db.upsert_tests(tests)
            for test, status in zip(tests, ("unknown", "fail", "pass")):
                if status != "unknown":
                    harness.db.record_result(
                        TestResult(test.path, status, 0 if status == "pass" else 1, 1),
                        run_id="run-test",
                        iteration=0,
                        phase="canonical-target",
                        canonical="target",
                    )
            calls: list[tuple[str, ...]] = []

            def run_many(batch, **_kwargs):
                calls.append(tuple(test.path for test in batch))
                return [TestResult(test.path, "pass", 0, 1) for test in batch]

            harness.runner = SimpleNamespace(run_many=run_many)

            results = harness.scan(
                run_id="run-test",
                iteration=0,
                tests=tests,
                run_oracle=False,
                retry_unknown=True,
                failure_limit=0,
            )

            self.assertEqual([result.test_path for result in results], [tests[0].path])
            self.assertEqual(calls, [(tests[0].path,)])
            self.assertEqual(
                [harness.db.test_state(test.path)["target_status"] for test in tests],
                ["pass", "fail", "pass"],
            )

    def test_snapshot_drift_invalidates_batch_without_overwriting_target_status(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            harness = self._harness(root, scan_failure_limit=0)
            tests = self._tests(2)
            harness.db.upsert_tests(tests)
            snapshot = ["head"]
            harness.git = SimpleNamespace(head=lambda _integration: snapshot[0])

            def run_many(batch, **_kwargs):
                results = [TestResult(test.path, "pass", 0, 1) for test in batch]
                snapshot[0] = "changed"
                return results

            harness.runner = SimpleNamespace(run_many=run_many)

            with self.assertRaises(RuntimeError):
                harness.scan(
                    run_id="run-test",
                    iteration=0,
                    tests=tests,
                    run_oracle=False,
                    failure_limit=0,
                )

            self.assertEqual(
                [harness.db.test_state(test.path)["target_status"] for test in tests],
                ["unknown", "unknown"],
            )
            run = harness.db.get_run("run-test")
            self.assertIsNotNone(run)
            self.assertEqual(run["status"], "snapshot_drift")
            with harness.db.connect() as connection:
                row = connection.execute(
                    "SELECT phase, status FROM results ORDER BY id DESC LIMIT 1"
                ).fetchone()
            self.assertEqual(tuple(row), ("canonical-target-invalidated", "pass"))

    def test_stable_snapshot_is_persisted_on_canonical_result(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            harness = self._harness(root, scan_failure_limit=0)
            test = self._tests(1)[0]
            harness.db.upsert_tests([test])
            harness.runner = SimpleNamespace(
                run_many=lambda batch, **_kwargs: [TestResult(item.path, "pass", 0, 1) for item in batch]
            )

            harness.scan(
                run_id="run-test",
                iteration=0,
                tests=[test],
                run_oracle=False,
                failure_limit=0,
            )

            with harness.db.connect() as connection:
                row = connection.execute(
                    "SELECT workspace_commit FROM results ORDER BY id DESC LIMIT 1"
                ).fetchone()
            self.assertEqual(row["workspace_commit"], "head")

    def test_adapter_burst_stops_scan_without_marking_tests_as_infra_failures(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            harness = self._harness(root, scan_failure_limit=0)
            tests = self._tests(2)
            harness.db.upsert_tests(tests)
            harness.runner = SimpleNamespace(
                run_many=lambda batch, **_kwargs: [
                    TestResult(
                        item.path,
                        "infra_error",
                        None,
                        1,
                        stderr="page.goto: net::ERR_CONNECTION_REFUSED",
                    )
                    for item in batch
                ]
            )

            with self.assertRaises(RuntimeError):
                harness.scan(
                    run_id="run-test",
                    iteration=0,
                    tests=tests,
                    run_oracle=False,
                    failure_limit=0,
                )

            self.assertEqual(
                [harness.db.test_state(test.path)["target_status"] for test in tests],
                ["unknown", "unknown"],
            )
            self.assertEqual(harness.db.get_run("run-test")["status"], "infrastructure_blocked")


class PrimitiveReuseTests(unittest.TestCase):
    def _harness(self, root: Path, head: str) -> Harness:
        harness = Harness.__new__(Harness)
        harness.config = SimpleNamespace(
            primitives=SimpleNamespace(items=("vfs",), max_rounds=1),
        )
        harness.db = Database(root / "state.sqlite3")
        harness.git = SimpleNamespace(head=lambda integration: head)
        harness.emit = (messages := []).append
        harness.messages = messages
        harness._print_lock = threading.Lock()
        harness._active_run_id = "run-test"
        harness._active_iteration = 0
        harness.db.start_run("run-test", head)
        return harness

    @staticmethod
    def _scan_passing(harness: Harness):
        def scan(*, run_id, iteration, tests, **kwargs):
            for test in tests:
                harness.db.record_result(
                    TestResult(
                        test_path=test.path,
                        status="pass",
                        exit_code=0,
                        duration_ms=1,
                    ),
                    run_id=run_id,
                    iteration=iteration,
                    phase="canonical-target",
                    workspace_commit="head",
                    canonical="target",
                )

        return scan

    def test_reuses_green_primitives_when_head_and_contract_are_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            harness = self._harness(Path(raw), "head")
            scan = self._scan_passing(harness)
            with patch("browser_node_harness.orchestrator.primitive_tests") as primitive_tests:
                primitive_tests.return_value = (
                    TestCase(
                        path=".bnh/primitives/vfs.js",
                        suite="bnh-primitives",
                        source_sha256="vfs-contract",
                    ),
                )
                with patch.object(harness, "scan", side_effect=scan) as scan_mock:
                    self.assertTrue(harness._run_primitives(run_id="run-test", integration=Path(raw)))
                    self.assertTrue(harness._run_primitives(run_id="run-test", integration=Path(raw)))

            self.assertEqual(scan_mock.call_count, 1)
            self.assertTrue(any("reusing green shared capabilities" in message for message in harness.messages))

    def test_reruns_verification_when_integration_head_changes(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            harness = self._harness(Path(raw), "head")
            scan = self._scan_passing(harness)
            primitive = TestCase(
                path=".bnh/primitives/vfs.js",
                suite="bnh-primitives",
                source_sha256="vfs-contract",
            )
            with patch("browser_node_harness.orchestrator.primitive_tests", return_value=(primitive,)):
                with patch.object(harness, "scan", side_effect=scan) as scan_mock:
                    self.assertTrue(harness._run_primitives(run_id="run-test", integration=Path(raw)))
                    harness.git.head = lambda integration: "new-head"
                    self.assertTrue(harness._run_primitives(run_id="run-test", integration=Path(raw)))

            self.assertEqual(scan_mock.call_count, 2)
            self.assertEqual(harness.db.get_meta("primitive_phase.integration_head"), "new-head")

    def test_reruns_verification_when_primitive_contract_changes(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            harness = self._harness(Path(raw), "head")
            scan = self._scan_passing(harness)
            original = TestCase(
                path=".bnh/primitives/vfs.js",
                suite="bnh-primitives",
                source_sha256="vfs-contract",
            )
            changed = TestCase(
                path=".bnh/primitives/vfs.js",
                suite="bnh-primitives",
                source_sha256="changed-vfs-contract",
            )
            with patch("browser_node_harness.orchestrator.primitive_tests", return_value=(original,)):
                with patch.object(harness, "scan", side_effect=scan) as scan_mock:
                    self.assertTrue(harness._run_primitives(run_id="run-test", integration=Path(raw)))
                    primitive_tests_mock = patch(
                        "browser_node_harness.orchestrator.primitive_tests",
                        return_value=(changed,),
                    )
                    with primitive_tests_mock:
                        self.assertTrue(harness._run_primitives(run_id="run-test", integration=Path(raw)))

            self.assertEqual(scan_mock.call_count, 2)


if __name__ == "__main__":
    unittest.main()
