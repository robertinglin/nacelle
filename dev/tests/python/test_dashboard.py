from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from browser_node_harness import dashboard
from browser_node_harness.dashboard import create_dashboard_server, dashboard_snapshot
from browser_node_harness.db import Database
from browser_node_harness.models import TestCase, TestResult


class DashboardTests(unittest.TestCase):
    def test_snapshot_exposes_latest_target_and_prior_regression(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            db = Database(Path(raw) / "state.sqlite3")
            test = TestCase("test/parallel/test-regression.js", "parallel", "source")
            db.upsert_tests([test])
            db.start_run("run-1", "abc123")
            db.record_result(
                TestResult(test.path, "pass", 0, 10, fingerprint="baseline"),
                run_id="run-1",
                iteration=0,
                phase="canonical-target",
                canonical="target",
            )
            db.record_result(
                TestResult(test.path, "fail", 1, 20, fingerprint="regressed"),
                run_id="run-1",
                iteration=1,
                phase="canonical-target",
                canonical="target",
            )

            state = db.test_state(test.path)
            self.assertEqual(state["target_status"], "fail")
            self.assertEqual(state["prior_target_status"], "pass")
            self.assertEqual(json.loads(state["prior_target_snapshot_json"])["status"], "pass")
            self.assertEqual(state["target_regression_count"], 1)

            snapshot = dashboard_snapshot(db)
            self.assertEqual(snapshot["regression_count"], 1)
            self.assertEqual(snapshot["summary"]["regression_count"], 1)
            self.assertEqual(snapshot["regressions"][0]["path"], test.path)
            self.assertTrue(snapshot["regressions"][0]["is_regression"])
            self.assertEqual(snapshot["regressions"][0]["target_snapshot"]["status"], "fail")
            self.assertEqual(snapshot["regressions"][0]["prior_target_snapshot"]["status"], "pass")

    def test_snapshot_uses_requested_variant_run(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            db = Database(Path(raw) / "state.sqlite3")
            db.start_run("run-default", "abc123", variant="default")
            db.update_run("run-default", status="complete")
            db.start_run("run-v22", "def456", variant="v22")

            snapshot = dashboard_snapshot(db, variant="v22")

            self.assertEqual(snapshot["run"]["id"], "run-v22")

    def test_existing_database_migrates_target_history_from_results(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            db_path = Path(raw) / "legacy.sqlite3"
            with sqlite3.connect(db_path) as conn:
                conn.executescript(
                    """
                    CREATE TABLE tests (
                        path TEXT PRIMARY KEY,
                        suite TEXT NOT NULL,
                        source_sha256 TEXT NOT NULL,
                        flags_json TEXT NOT NULL,
                        modules_json TEXT NOT NULL,
                        size_bytes INTEGER NOT NULL,
                        enabled INTEGER NOT NULL DEFAULT 1,
                        oracle_status TEXT NOT NULL DEFAULT 'unknown',
                        target_status TEXT NOT NULL DEFAULT 'unknown',
                        failure_fingerprint TEXT NOT NULL DEFAULT '',
                        last_duration_ms INTEGER NOT NULL DEFAULT 0,
                        attempt_count INTEGER NOT NULL DEFAULT 0,
                        consecutive_failures INTEGER NOT NULL DEFAULT 0,
                        updated_at TEXT NOT NULL
                    );
                    CREATE TABLE results (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        run_id TEXT,
                        iteration INTEGER NOT NULL,
                        phase TEXT NOT NULL,
                        attempt_id TEXT,
                        test_path TEXT NOT NULL,
                        workspace_commit TEXT NOT NULL DEFAULT '',
                        status TEXT NOT NULL,
                        exit_code INTEGER,
                        duration_ms INTEGER NOT NULL,
                        fingerprint TEXT NOT NULL DEFAULT '',
                        stdout TEXT NOT NULL DEFAULT '',
                        stderr TEXT NOT NULL DEFAULT '',
                        log_dir TEXT NOT NULL DEFAULT '',
                        created_at TEXT NOT NULL
                    );
                    """
                )
                conn.execute(
                    "INSERT INTO tests(path, suite, source_sha256, flags_json, modules_json, size_bytes, target_status, updated_at) VALUES (?, ?, ?, '[]', '[]', 0, 'fail', ?)",
                    ("test/parallel/test-legacy.js", "parallel", "source", "2026-08-23T00:00:00+00:00"),
                )
                for status, iteration in (("pass", 0), ("fail", 1)):
                    conn.execute(
                        """
                        INSERT INTO results(
                            run_id, iteration, phase, test_path, status,
                            exit_code, duration_ms, fingerprint, created_at
                        ) VALUES ('run-legacy', ?, 'canonical-target', ?, ?, ?, 1, ?, ?)
                        """,
                        (
                            iteration,
                            "test/parallel/test-legacy.js",
                            status,
                            0 if status == "pass" else 1,
                            status,
                            f"2026-08-23T00:00:0{iteration}+00:00",
                        ),
                    )

            db = Database(db_path)
            state = db.test_state("test/parallel/test-legacy.js")
            self.assertEqual(state["target_status"], "fail")
            self.assertEqual(state["prior_target_status"], "pass")
            self.assertEqual(json.loads(state["target_snapshot_json"])["status"], "fail")
            self.assertEqual(json.loads(state["prior_target_snapshot_json"])["status"], "pass")
            self.assertEqual(state["target_regression_count"], 1)

    def test_snapshot_reports_active_agents_and_events(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            db = Database(Path(raw) / "state.sqlite3")
            db.start_run("run-1", "abc123")
            db.record_event(
                "agent started",
                run_id="run-1",
                iteration=2,
                kind="agent",
                status="started",
                attempt_id="attempt-1",
            )

            snapshot = dashboard_snapshot(db)
            self.assertEqual(snapshot["run"]["id"], "run-1")
            self.assertEqual(len(snapshot["active_agents"]), 1)
            self.assertEqual(snapshot["active_agents"][0]["attempt_id"], "attempt-1")

            db.record_event(
                "agent finished",
                run_id="run-1",
                iteration=2,
                kind="agent",
                status="finished",
                attempt_id="attempt-1",
            )
            self.assertEqual(dashboard_snapshot(db)["active_agents"], [])

    def test_snapshot_titles_active_baselines_and_removes_finished_runner(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            db = Database(Path(raw) / "state.sqlite3")
            db.start_run("run-1", "abc123")
            db.record_event(
                "oracle baseline started",
                run_id="run-1",
                kind="runner",
                status="started",
                attempt_id="canonical-oracle-run-1",
            )
            db.record_event(
                "browser target baseline started",
                run_id="run-1",
                kind="runner",
                status="started",
                attempt_id="canonical-target-run-1",
            )

            runners = dashboard_snapshot(db)["active_runners"]
            self.assertEqual(
                {
                    runner["attempt_id"]: (runner["title"], runner["status"])
                    for runner in runners
                },
                {
                    "canonical-oracle-run-1": ("Node oracle baseline", "started"),
                    "canonical-target-run-1": ("Browser target baseline", "started"),
                },
            )

            db.record_event(
                "oracle baseline finished",
                run_id="run-1",
                kind="runner",
                status="finished",
                attempt_id="canonical-oracle-run-1",
            )
            self.assertEqual(
                [runner["attempt_id"] for runner in dashboard_snapshot(db)["active_runners"]],
                ["canonical-target-run-1"],
            )

    def test_snapshot_reports_agent_identity_logs_and_controls(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            db = Database(root / "state.sqlite3")
            db.start_run("run-1", "abc123")
            attempt_dir = root / "attempts" / "attempt-1"
            attempt_dir.mkdir(parents=True)
            stdout = attempt_dir / "agent.stdout.log"
            stderr = attempt_dir / "agent.stderr.log"
            output = attempt_dir / "agent.output.log"
            stdout.write_text("working on VFS\n", encoding="utf-8")
            stderr.write_text("opencode/big-pickle\n", encoding="utf-8")
            output.write_text("working on VFS\nopencode/big-pickle\n", encoding="utf-8")
            db.start_agent_session(
                run_id="run-1",
                iteration=1,
                attempt_id="attempt-1",
                task_id="task-1",
                strategy="subsystem-first",
                assigned_tests=["test/parallel/test-stdout.js"],
                provider="openrouter",
                model="qwen/qwen3-coder:free",
                worktree=root / "worktree",
                stdout_path=stdout,
                stderr_path=stderr,
                output_path=output,
            )

            snapshot = dashboard_snapshot(db)
            self.assertEqual(snapshot["active_agents"][0]["provider"], "openrouter")
            self.assertIn("working on VFS", snapshot["active_agents"][0]["stdout_tail"])
            self.assertIn("opencode/big-pickle", snapshot["active_agents"][0]["output_tail"])
            self.assertTrue(db.request_agent_action("attempt-1", "restart"))
            self.assertEqual(db.agent_action("attempt-1"), "restart")

    def test_server_serves_page_and_json_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            db_path = Path(raw) / "state.sqlite3"
            Database(db_path)
            with patch.object(dashboard, "ThreadingHTTPServer") as server_factory:
                server = create_dashboard_server(db_path, host="127.0.0.1", port=8787)
            self.assertIs(server, server_factory.return_value)
            server_factory.assert_called_once()
            self.assertEqual(server_factory.call_args.args[0], ("127.0.0.1", 8787))
            self.assertIn("Nacelle Harness", dashboard._PAGE)
            self.assertIn("data-autoscroll", dashboard._PAGE)
            self.assertIn("clear-attempts", dashboard._PAGE)
            self.assertIn("Proof scope", dashboard._PAGE)
            self.assertIn("runnable harness entries", dashboard._PAGE)
            self.assertIn("Node test-* source files", dashboard._PAGE)
            self.assertIn("proof category + runner", dashboard._PAGE)
            self.assertIn("Target regressions", dashboard._PAGE)
            self.assertIn("Regressions", dashboard._PAGE)

    def test_snapshot_exposes_source_and_runnable_proof_inventory(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            db = Database(Path(raw) / "state.sqlite3")
            db.set_meta(
                "scope_summary",
                json.dumps(
                    {
                        "total": 1,
                        "source_inventory": {
                            "source_test_files": 10,
                            "source_javascript_test_files": 9,
                        },
                        "runnable_inventory": {
                            "total": 1,
                            "node_test_file_entries": 1,
                            "special_layout_entries": 0,
                            "entries": [
                                {
                                    "path": "test/parallel/test-one.js",
                                    "proof_category": "browser_js",
                                    "runner": "playwright-browser",
                                    "proof": "oracle_pass_and_browser_target_pass",
                                }
                            ],
                        },
                        "proof_coverage": {
                            "categorized_entries": 1,
                            "entries_without_proof": 0,
                        },
                    }
                ),
            )

            scope = dashboard_snapshot(db)["scope"]

            self.assertEqual(scope["source_inventory"]["source_test_files"], 10)
            self.assertEqual(scope["runnable_inventory"]["total"], 1)
            self.assertEqual(scope["runnable_inventory"]["entries"][0]["runner"], "playwright-browser")
            self.assertEqual(scope["proof_coverage"]["entries_without_proof"], 0)

    def test_snapshot_hides_rejected_attempts_from_prior_session(self) -> None:
        class SnapshotDatabase:
            def latest_run(self):
                return {"id": "run-1"}

            def recent_attempts(self, *, run_id):
                return [
                    {"id": "old-rejected", "accepted": 0, "created_at": "2026-08-22T10:00:00+00:00"},
                    {"id": "old-accepted", "accepted": 1, "created_at": "2026-08-22T10:00:00+00:00"},
                    {"id": "current-rejected", "accepted": 0, "created_at": "2026-08-22T11:00:01+00:00"},
                ]

            def get_meta(self, key):
                return {
                    "current_session_id": "session-1",
                    "current_session_started_at": "2026-08-22T11:00:00+00:00",
                }.get(key)

            def recent_merges(self, *, run_id):
                return []

            def active_agents(self, *, run_id):
                return []

            def active_runners(self, *, run_id):
                return []

            def recent_agent_sessions(self, *, run_id):
                return []

            def recent_events(self, *, run_id):
                return []

            def summary(self):
                return {}

            def top_failure_clusters(self, limit):
                return []

        attempts = dashboard_snapshot(SnapshotDatabase())["attempts"]
        self.assertEqual([attempt["id"] for attempt in attempts], ["old-accepted", "current-rejected"])

    def test_snapshot_hides_stale_active_agents_and_runners(self) -> None:
        class SnapshotDatabase:
            def latest_run(self):
                return {"id": "run-1"}

            def recent_attempts(self, *, run_id):
                return []

            def get_meta(self, key):
                return {
                    "current_session_id": "session-1",
                    "current_session_started_at": "2026-08-22T11:00:00+00:00",
                }.get(key)

            def recent_merges(self, *, run_id):
                return []

            def active_agents(self, *, run_id):
                return [
                    {"attempt_id": "stale-agent", "started_at": "2026-08-22T10:59:59+00:00"},
                    {"attempt_id": "current-agent", "started_at": "2026-08-22T11:00:00+00:00"},
                ]

            def active_runners(self, *, run_id):
                return [
                    {"attempt_id": "canonical-oracle-stale", "created_at": "2026-08-22T10:59:59+00:00"},
                    {"attempt_id": "canonical-target-current", "created_at": "2026-08-22T11:00:00+00:00"},
                ]

            def recent_agent_sessions(self, *, run_id):
                return []

            def recent_events(self, *, run_id):
                return []

            def summary(self):
                return {}

            def top_failure_clusters(self, limit):
                return []

        snapshot = dashboard_snapshot(SnapshotDatabase())
        self.assertEqual(
            [agent["attempt_id"] for agent in snapshot["active_agents"]],
            ["current-agent"],
        )
        self.assertEqual(
            [runner["attempt_id"] for runner in snapshot["active_runners"]],
            ["canonical-target-current"],
        )


if __name__ == "__main__":
    unittest.main()
