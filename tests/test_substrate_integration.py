from __future__ import annotations

import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

from browser_node_harness.db import Database
from browser_node_harness.models import TestResult
from browser_node_harness.orchestrator import Harness
from browser_node_harness.validation import (
    build_substrate_identity,
    classify_browser_failure,
    substrate_cache_hit,
    substrate_scope_fingerprint,
)


class SubstrateCacheTests(unittest.TestCase):
    def _config(self, root: Path):
        return SimpleNamespace(
            target=SimpleNamespace(
                command=("browser-adapter",),
                cwd="{worktree}",
                env={"BNH_BROWSER": "chromium"},
                protocol="jsonl",
                timeout_seconds=10,
                max_output_chars=100,
            ),
            project=SimpleNamespace(variant="v22"),
            root=root,
        )

    def test_identity_changes_for_head_runtime_or_test_scope(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            integration = Path(raw)
            (integration / "runtime").mkdir()
            for relative in (
                "runtime.js",
                "runtime/index.js",
                "runtime/compat.js",
                "runtime/vfs.js",
                "runtime/streams.js",
                "runtime/process.js",
                "runtime/messaging.js",
                "runtime/process-worker.js",
                "runtime/process-entry.js",
                "target-bridge.js",
            ):
                (integration / relative).write_text(relative, encoding="utf-8")
            (integration / "adapters/playwright").mkdir(parents=True)
            (integration / "adapters/playwright/adapter-core.mjs").write_text("adapter", encoding="utf-8")
            scope = substrate_scope_fingerprint(integration, self._config(integration))
            identity = build_substrate_identity("head-a", scope, [("vfs", "sha-a")])
            values = {"substrate_prerequisite.identity": identity, "substrate_prerequisite.status": "pass"}
            self.assertTrue(substrate_cache_hit(values.get, identity))
            self.assertNotEqual(identity, build_substrate_identity("head-b", scope, [("vfs", "sha-a")]))
            (integration / "runtime/streams.js").write_text("changed", encoding="utf-8")
            changed_scope = substrate_scope_fingerprint(integration, self._config(integration))
            self.assertNotEqual(identity, build_substrate_identity("head-a", changed_scope, [("vfs", "sha-a")]))
            self.assertNotEqual(identity, build_substrate_identity("head-a", scope, [("vfs", "sha-b")]))
            (integration / "adapters/playwright/adapter-core.mjs").write_text("changed", encoding="utf-8")
            adapter_scope = substrate_scope_fingerprint(integration, self._config(integration))
            self.assertNotEqual(identity, build_substrate_identity("head-a", adapter_scope, [("vfs", "sha-a")]))

    def test_failure_classification_distinguishes_substrate_from_test_failure(self) -> None:
        substrate = TestResult(
            ".bnh/substrate/vfs.js",
            "infra_error",
            None,
            1,
            details={"run_result": {"error": {"code": "ERR_CAPABILITY_DENIED"}}},
        )
        failed_test = TestResult("test.js", "fail", 1, 1)
        self.assertEqual(classify_browser_failure(substrate), "substrate")
        self.assertEqual(classify_browser_failure(failed_test), "test")


class SubstratePrerequisitePhaseTests(unittest.TestCase):
    def test_green_result_is_cached_and_head_change_invalidates_it(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            harness = Harness.__new__(Harness)
            harness.config = SimpleNamespace(
                target=SimpleNamespace(
                    command=("adapter",),
                    cwd="{worktree}",
                    env={},
                    protocol="oneshot",
                    timeout_seconds=10,
                    max_output_chars=100,
                ),
                project=SimpleNamespace(variant="v22"),
                root=root,
            )
            harness.db = Database(root / "state.sqlite3")
            harness.emit = (messages := []).append
            harness._print_lock = threading.Lock()
            harness._active_run_id = "run-substrate"
            harness._active_iteration = 0
            head = ["head-a"]
            harness.git = SimpleNamespace(head=lambda _integration: head[0])
            calls = []

            def run_many(tests, **_kwargs):
                calls.append([test.path for test in tests])
                return [TestResult(test.path, "pass", 0, 1) for test in tests]

            harness.runner = SimpleNamespace(run_many=run_many)
            integration = root / "integration"
            integration.mkdir()
            harness.db.start_run("run-substrate", "head-a", variant="v22")

            self.assertTrue(harness._run_substrate_prerequisites(run_id="run-substrate", integration=integration))
            self.assertTrue(harness._run_substrate_prerequisites(run_id="run-substrate", integration=integration))
            self.assertEqual(len(calls), 1)
            head[0] = "head-b"
            self.assertTrue(harness._run_substrate_prerequisites(run_id="run-substrate", integration=integration))
            self.assertEqual(len(calls), 2)
            self.assertTrue(any("reused green" in message for message in messages))


if __name__ == "__main__":
    unittest.main()
