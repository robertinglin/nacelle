from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from browser_node_harness.config import CommandConfig, DiscoveryConfig, ProjectConfig
from browser_node_harness.db import Database
from browser_node_harness.models import TestCase, TestResult
from browser_node_harness.oracle_cache import (
    build_oracle_cache_entry,
    load_oracle_cache,
    oracle_cache_statuses,
    oracle_cache_matches,
    oracle_cache_path,
    save_oracle_cache,
)
from browser_node_harness.orchestrator import Harness


class OracleCacheKeyTests(unittest.TestCase):
    def _config(
        self,
        root: Path,
        *,
        version: str = "v22.0.1",
        revision: str = "node-commit-1",
        command: tuple[str, ...] = ("reference-node", "{request}"),
        discovery: DiscoveryConfig | None = None,
        oracle_env: dict[str, str] | None = None,
    ) -> SimpleNamespace:
        binary = root / "node"
        binary.write_bytes(b"node-build-1")
        config = SimpleNamespace(
            project=ProjectConfig(
                target_repo=root,
                node_repo=root,
                state_dir=root / ".bnh-state" / "v22",
                node_binary=str(binary),
            ),
            discovery=discovery or DiscoveryConfig(),
            oracle=CommandConfig(
                command=command,
                cwd="{node_repo}",
                timeout_seconds=120,
                env=oracle_env or {"PYTHONPATH": "src"},
                inherit_env=False,
                max_output_chars=120_000,
            ),
        )
        config._oracle_version = version
        config._oracle_revision = revision
        return config

    @staticmethod
    def _command_output(config: SimpleNamespace, argv: list[str] | tuple[str, ...], **_kwargs: object) -> tuple[bool, str]:
        if list(argv[:3]) == ["git", "rev-parse", "HEAD"]:
            return True, config._oracle_revision
        if list(argv[:3]) == ["git", "status", "--porcelain"]:
            return True, ""
        return True, config._oracle_version

    def test_persists_inspectable_cache_and_hits_on_exact_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            config = self._config(root)
            test = TestCase("test/parallel/test-one.js", "parallel", "source-1")
            with patch(
                "browser_node_harness.oracle_cache._run_command",
                side_effect=lambda argv, **kwargs: self._command_output(config, argv, **kwargs),
            ):
                entry = build_oracle_cache_entry(config, [test])
                save_oracle_cache(config, entry)
                self.assertTrue(oracle_cache_matches(config, entry))

            stored = json.loads(oracle_cache_path(config).read_text(encoding="utf-8"))
            self.assertEqual(stored["key"], entry["key"])
            self.assertEqual(stored["inputs"]["node"]["version"], "v22.0.1")
            self.assertEqual(load_oracle_cache(config), stored)

    def test_persists_nonpassing_oracle_statuses(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            config = self._config(root)
            statuses = {"test/parallel/test-one.js": "skip"}
            with patch(
                "browser_node_harness.oracle_cache._run_command",
                side_effect=lambda argv, **kwargs: self._command_output(config, argv, **kwargs),
            ):
                entry = build_oracle_cache_entry(
                    config,
                    [TestCase("test/parallel/test-one.js", "parallel", "source-1")],
                )
                save_oracle_cache(config, entry, statuses=statuses)
                self.assertTrue(oracle_cache_matches(config, entry))
            self.assertEqual(oracle_cache_statuses(config), statuses)

    def test_node_version_invalidates_cache(self) -> None:
        self._assert_key_changes("version", "v22.0.2")

    def test_source_revision_invalidates_cache(self) -> None:
        self._assert_key_changes("revision", "node-commit-2")

    def test_oracle_command_invalidates_cache(self) -> None:
        self._assert_key_changes("command", ("other-oracle", "{request}"))

    def test_discovery_scope_invalidates_cache(self) -> None:
        self._assert_key_changes(
            "discovery",
            DiscoveryConfig(include=("test/sequential/test-*.js",)),
        )

    def test_oracle_config_invalidates_cache(self) -> None:
        self._assert_key_changes("oracle_env", {"PYTHONPATH": "different-src"})

    def _assert_key_changes(self, field: str, value: object) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            base = self._config(root)
            changed_kwargs = {
                "version": base._oracle_version,
                "revision": base._oracle_revision,
                "command": base.oracle.command,
                "discovery": base.discovery,
                "oracle_env": base.oracle.env,
            }
            changed_kwargs[field] = value
            changed = self._config(root, **changed_kwargs)
            test = TestCase("test/parallel/test-one.js", "parallel", "source-1")

            with patch(
                "browser_node_harness.oracle_cache._run_command",
                side_effect=lambda argv, **kwargs: self._command_output(base, argv, **kwargs),
            ):
                base_key = build_oracle_cache_entry(base, [test])["key"]
            with patch(
                "browser_node_harness.oracle_cache._run_command",
                side_effect=lambda argv, **kwargs: self._command_output(changed, argv, **kwargs),
            ):
                changed_key = build_oracle_cache_entry(changed, [test])["key"]
            self.assertNotEqual(base_key, changed_key)


class OracleScanCacheTests(unittest.TestCase):
    def test_scan_reuses_cache_and_refresh_still_forces_oracle(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            binary = root / "node"
            binary.write_bytes(b"node-build-1")
            config = SimpleNamespace(
                project=ProjectConfig(
                    target_repo=root,
                    node_repo=root,
                    state_dir=root / ".bnh-state" / "v22",
                    node_binary=str(binary),
                ),
                discovery=DiscoveryConfig(),
                oracle=CommandConfig(
                    command=("reference-node", "{request}"),
                    cwd="{node_repo}",
                    timeout_seconds=120,
                    env={"PYTHONPATH": "src"},
                ),
                target=CommandConfig(
                    command=("browser-node", "{request}"),
                    cwd="{worktree}",
                    timeout_seconds=120,
                ),
                loop=SimpleNamespace(target_concurrency=1, scan_failure_limit=3),
            )
            test = TestCase("test/parallel/test-one.js", "parallel", "source-1")
            db = Database(config.project.state_dir / "state.sqlite3")
            db.upsert_tests([test])
            db.start_run("run-test", "head")
            calls: list[CommandConfig] = []

            def run_many(tests, *, spec, **_kwargs):
                calls.append(spec)
                return [TestResult(tests[0].path, "pass", 0, 1)]

            harness = Harness.__new__(Harness)
            harness.config = config
            harness.db = db
            harness.runner = SimpleNamespace(run_many=run_many)
            harness.git = SimpleNamespace(head=lambda _worktree: "head")
            harness.initialize = lambda run_setup=False: root
            harness.emit = lambda _message: None
            harness._print_lock = threading.Lock()
            harness._active_run_id = "run-test"
            harness._active_iteration = 0

            def command_output(argv, **_kwargs):
                if argv[0] == "git" and argv[1] == "rev-parse":
                    return True, "node-commit-1"
                if argv[0] == "git":
                    return True, ""
                return True, "v22.0.1"

            with patch("browser_node_harness.oracle_cache._run_command", side_effect=command_output):
                harness.scan(run_id="run-test", iteration=0, tests=[test])
                harness.scan(run_id="run-test", iteration=0, tests=[test])
                harness.scan(run_id="run-test", iteration=0, tests=[test], refresh=True)

            self.assertEqual(calls, [config.oracle, config.target, config.oracle, config.target])


if __name__ == "__main__":
    unittest.main()
