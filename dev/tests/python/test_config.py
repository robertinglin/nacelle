from __future__ import annotations

import tempfile
import textwrap
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
from unittest.mock import Mock, patch

from browser_node_harness.cli import _select_tests, build_parser, command_start, command_test
from browser_node_harness.config import ConfigError, ProjectConfig, load_config
from browser_node_harness.models import ProcessResult
from browser_node_harness.node_source import prepare_node_source, prepare_target_repository
from browser_node_harness.process import render


class ConfigTests(unittest.TestCase):
    def test_select_tests_rehydrates_primitive_source_overrides(self) -> None:
        harness = SimpleNamespace(
            config=SimpleNamespace(primitives=SimpleNamespace(items=("vfs",))),
            db=SimpleNamespace(get_test=lambda _path: None, upsert_tests=lambda _tests: None),
        )

        selected = _select_tests(harness, [".bnh/primitives/vfs.js"])

        self.assertEqual(len(selected), 1)
        self.assertTrue(selected[0].source_override)

    def test_start_launches_loop_from_config_root(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            config = SimpleNamespace(
                path=root / "harness.toml",
                root=root,
                project=SimpleNamespace(
                    node_repo=root,
                    node_repo_url=None,
                    node_repo_ref="main",
                    node_binary=sys.executable,
                    target_repo=root,
                    target_repo_url=None,
                    target_repo_ref="main",
                    state_dir=root / "state",
                ),
            )
            harness = SimpleNamespace(config=config, git=SimpleNamespace(validate_repo=lambda: None))
            args = SimpleNamespace(refresh=False, max_iterations=None, variant=None, host="127.0.0.1", port=8787)
            server = SimpleNamespace(server_port=8787, serve_forever=lambda: None, server_close=lambda: None)
            process = SimpleNamespace(pid=123, poll=lambda: 0)

            with patch("browser_node_harness.cli.create_dashboard_server", return_value=server), patch(
                "browser_node_harness.cli.subprocess.Popen", return_value=process
            ) as popen:
                self.assertEqual(command_start(harness, args), 0)

            self.assertEqual(popen.call_args.kwargs["cwd"], str(root))

    def test_start_command_accepts_dashboard_options(self) -> None:
        args = build_parser().parse_args(
            ["--config", "harness.toml", "start", "--port", "0", "--max-iterations", "2", "--variant", "v24"]
        )
        self.assertEqual(args.command, "start")
        self.assertEqual(args.port, 0)
        self.assertEqual(args.max_iterations, 2)
        self.assertEqual(args.variant, "v24")

    def test_test_defaults_to_configured_variant_integration_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            integration = root / "state" / "worktrees" / "integration-v22"
            integration.mkdir(parents=True)
            result = SimpleNamespace(
                status="pass",
                exit_code=0,
                duration_ms=1,
                test_path="test/example.js",
                fingerprint="",
                log_dir=integration / "log",
                stderr="",
            )
            runner = SimpleNamespace(run_many=Mock(return_value=[result]))
            harness = SimpleNamespace(
                config=SimpleNamespace(
                    project=SimpleNamespace(variant="v22"),
                    target=SimpleNamespace(),
                ),
                git=SimpleNamespace(integration=integration),
                runner=runner,
            )
            args = SimpleNamespace(worktree=None, tests=["test/example.js"], json=True)

            with patch("browser_node_harness.cli._select_tests", return_value=[result]) as select:
                self.assertEqual(command_test(harness, args), 0)

            self.assertEqual(select.call_count, 1)
            self.assertEqual(runner.run_many.call_args.kwargs["worktree"], integration)

    def test_test_rejects_missing_configured_variant_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            integration = root / "state" / "worktrees" / "integration-v22"
            harness = SimpleNamespace(
                config=SimpleNamespace(project=SimpleNamespace(variant="v22")),
                git=SimpleNamespace(integration=integration),
            )
            args = SimpleNamespace(worktree=None, tests=["test/example.js"], json=True)

            with self.assertRaisesRegex(ValueError, "configured v22 integration worktree does not exist"):
                command_test(harness, args)

    def test_test_honors_explicit_candidate_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            candidate = root / "candidate"
            candidate.mkdir()
            result = SimpleNamespace(
                status="pass",
                exit_code=0,
                duration_ms=1,
                test_path="test/example.js",
                fingerprint="",
                log_dir=candidate / "log",
                stderr="",
            )
            runner = SimpleNamespace(run_many=Mock(return_value=[result]))
            harness = SimpleNamespace(
                config=SimpleNamespace(
                    project=SimpleNamespace(variant="v22"),
                    target=SimpleNamespace(),
                ),
                git=SimpleNamespace(integration=root / "configured"),
                runner=runner,
            )
            args = SimpleNamespace(worktree=str(candidate), tests=["test/example.js"], json=True)

            with patch("browser_node_harness.cli._select_tests", return_value=[result]):
                self.assertEqual(command_test(harness, args), 0)

            self.assertEqual(runner.run_many.call_args.kwargs["worktree"], candidate)

    def test_scan_command_accepts_oracle_ineligible_exploration(self) -> None:
        args = build_parser().parse_args(
            ["--config", "harness.toml", "scan", "--include-oracle-ineligible", "--no-oracle"]
        )
        self.assertTrue(args.include_oracle_ineligible)
        self.assertTrue(args.no_oracle)

    def test_scan_command_accepts_infrastructure_retry(self) -> None:
        args = build_parser().parse_args(
            ["--config", "harness.toml", "scan", "--retry-infra", "--no-oracle"]
        )
        self.assertTrue(args.retry_infra)
        self.assertFalse(args.include_oracle_ineligible)

    def test_scan_command_accepts_unknown_result_retry(self) -> None:
        args = build_parser().parse_args(
            ["--config", "harness.toml", "scan", "--retry-unknown", "--no-oracle"]
        )
        self.assertTrue(args.retry_unknown)

    def test_browser_suite_scan_options(self) -> None:
        args = build_parser().parse_args(
            [
                "--config",
                "harness.toml",
                "--variant",
                "v22",
                "scan",
                "--browser-only",
                "--no-oracle",
                "--refresh",
                "--target-concurrency",
                "5",
                "--timeout-seconds",
                "10",
                "--failure-limit",
                "0",
            ]
        )
        self.assertTrue(args.browser_only)
        self.assertEqual(args.target_concurrency, 5)
        self.assertEqual(args.timeout_seconds, 10)
        self.assertEqual(args.failure_limit, 0)

    def test_variants_select_source_ref_and_inherit_target_branch(self) -> None:
        root = Path(__file__).resolve().parents[1]
        base = load_config(root / "harness.example.toml", variant="v22")
        self.assertEqual(base.project.base_ref, "v22.x")
        self.assertEqual(base.project.target_repo_ref, "v22.x")
        config = load_config(root / "harness.example.toml", variant="v24")
        self.assertEqual(config.project.variant, "v24")
        self.assertEqual(config.project.node_repo_ref, "v24.x")
        self.assertEqual(config.project.variant_base, "v22")
        self.assertEqual(config.project.base_ref, "bnh/integration-v22")
        self.assertEqual(config.project.integration_branch, "bnh/integration-v24")
        self.assertTrue(str(config.project.state_dir).endswith(".bnh-state/v24"))

    def test_node_source_is_cloned_and_updated_from_remote(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            remote = root / "node.git"
            seed = root / "seed"
            subprocess.run(["git", "init", "--bare", str(remote)], check=True, capture_output=True)
            seed.mkdir()
            subprocess.run(["git", "init", "-b", "main"], cwd=seed, check=True, capture_output=True)
            (seed / "test.js").write_text("v1\n", encoding="utf-8")
            (seed / "tools").mkdir()
            (seed / "tools" / "run.js").write_text("script\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=seed, check=True, capture_output=True)
            subprocess.run(
                ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "v1"],
                cwd=seed,
                check=True,
                capture_output=True,
            )
            subprocess.run(["git", "remote", "add", "origin", str(remote)], cwd=seed, check=True, capture_output=True)
            subprocess.run(["git", "push", "origin", "main"], cwd=seed, check=True, capture_output=True)

            project = ProjectConfig(
                target_repo=root / "target",
                node_repo=root / "checkout",
                state_dir=root / "state",
                node_binary=sys.executable,
                target_repo_url=str(remote),
                target_repo_ref="main",
                node_repo_url=str(remote),
                node_repo_ref="main",
            )
            prepare_target_repository(project)
            self.assertTrue((project.target_repo / "tools" / "run.js").is_file())
            prepare_node_source(project)
            self.assertEqual((project.node_repo / "tools" / "run.js").read_text(encoding="utf-8"), "script\n")

            (seed / "test.js").write_text("v2\n", encoding="utf-8")
            subprocess.run(["git", "add", "."], cwd=seed, check=True, capture_output=True)
            subprocess.run(
                ["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "v2"],
                cwd=seed,
                check=True,
                capture_output=True,
            )
            subprocess.run(["git", "push", "origin", "main"], cwd=seed, check=True, capture_output=True)
            prepare_node_source(project)
            self.assertEqual((project.node_repo / "test.js").read_text(encoding="utf-8"), "v2\n")

    def test_target_repository_preparation_serializes_concurrent_fetches(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            target = root / "target"
            (target / ".git").mkdir(parents=True)
            project = ProjectConfig(
                target_repo=target,
                node_repo=root / "node",
                state_dir=root / "state",
                node_binary=sys.executable,
                target_repo_url="https://example.invalid/node.git",
                target_repo_ref="v22.x",
            )
            active_fetches = 0
            maximum_active_fetches = 0
            state_lock = threading.Lock()

            def fake_git(args, *, cwd):
                nonlocal active_fetches, maximum_active_fetches
                if args[0] == "status":
                    return ProcessResult(
                        argv=("git", *args), cwd=cwd, exit_code=0, stdout="", stderr="", duration_ms=0
                    )
                with state_lock:
                    active_fetches += 1
                    maximum_active_fetches = max(maximum_active_fetches, active_fetches)
                time.sleep(0.05)
                with state_lock:
                    active_fetches -= 1
                return ProcessResult(
                    argv=("git", *args), cwd=cwd, exit_code=0, stdout="", stderr="", duration_ms=0
                )

            with patch("browser_node_harness.node_source._run_git", side_effect=fake_git) as run_git:
                with ThreadPoolExecutor(max_workers=2) as workers:
                    results = list(workers.map(lambda _: prepare_target_repository(project), range(2)))

            self.assertEqual(results, [target, target])
            self.assertEqual(maximum_active_fetches, 1)
            self.assertEqual(run_git.call_count, 4)

    def test_node_source_skips_build_when_managed_binary_exists(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            binary = root / "out" / "Release" / "node"
            binary.parent.mkdir(parents=True)
            binary.write_text("existing\n", encoding="utf-8")
            project = ProjectConfig(
                target_repo=root / "target",
                node_repo=root,
                state_dir=root / "state",
                node_binary="./out/Release/node",
            )

            with patch("browser_node_harness.node_source.run_process") as run:
                prepare_node_source(project)

            run.assert_not_called()

    def test_node_source_builds_missing_managed_binary_without_real_build(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            project = ProjectConfig(
                target_repo=root / "target",
                node_repo=root,
                state_dir=root / "state",
                node_binary="./out/Release/node",
            )
            calls: list[tuple[str, ...]] = []

            def fake_build(args, *, cwd, **_kwargs):
                calls.append(tuple(args))
                if args[0] == "make":
                    binary = cwd / "out" / "Release" / "node"
                    binary.parent.mkdir(parents=True, exist_ok=True)
                    binary.write_text("built\n", encoding="utf-8")
                return ProcessResult(
                    argv=tuple(args),
                    cwd=cwd,
                    exit_code=0,
                    stdout="",
                    stderr="",
                    duration_ms=0,
                )

            with patch("browser_node_harness.node_source.run_process", side_effect=fake_build):
                prepare_node_source(project)

            self.assertEqual(calls[0], ("./configure", "--without-npm"))
            self.assertEqual(calls[1][0], "make")
            self.assertRegex(calls[1][1], r"^-j[1-4]$")
            self.assertEqual(calls[1][2], "node")
            self.assertTrue((root / "out" / "Release" / "node").is_file())

    def test_node_source_does_not_reconfigure_an_existing_build_tree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "config.gypi").write_text("configured\n", encoding="utf-8")
            (root / "out").mkdir()
            (root / "out" / "Makefile").write_text("makefile\n", encoding="utf-8")
            project = ProjectConfig(
                target_repo=root / "target",
                node_repo=root,
                state_dir=root / "state",
                node_binary="./out/Release/node",
            )
            calls: list[tuple[str, ...]] = []

            def fake_make(args, *, cwd, **_kwargs):
                calls.append(tuple(args))
                binary = cwd / "out" / "Release" / "node"
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_text("built\n", encoding="utf-8")
                return ProcessResult(
                    argv=tuple(args),
                    cwd=cwd,
                    exit_code=0,
                    stdout="",
                    stderr="",
                    duration_ms=0,
                )

            with patch("browser_node_harness.node_source.run_process", side_effect=fake_make):
                prepare_node_source(project)

            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][0], "make")

    def test_node_source_does_not_build_relative_path_outside_repository(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            project = ProjectConfig(
                target_repo=root / "target",
                node_repo=root / "node",
                state_dir=root / "state",
                node_binary="../node-external",
            )
            project.node_repo.mkdir()

            with patch("browser_node_harness.node_source.run_process") as run:
                prepare_node_source(project)

            run.assert_not_called()

    def test_example_preserves_playwright_port_placeholder(self) -> None:
        root = Path(__file__).resolve().parents[1]
        config = load_config(root / "harness.example.toml")
        self.assertIn("{port}", render(config.target.env["BNH_BROWSER_URL"], {}))
        self.assertIn("{port}", render(config.target.env["BNH_SERVER_COMMAND"], {}))

    def test_example_runs_the_full_primitive_phase_before_upstream_tests(self) -> None:
        root = Path(__file__).resolve().parents[1]
        config = load_config(root / "harness.example.toml")

        self.assertTrue(config.primitives.enabled)
        self.assertGreaterEqual(len(config.primitives.items), 30)
        self.assertIn("globals", config.primitives.items)
        self.assertIn("vfs-io", config.primitives.items)
        self.assertIn("system-platform-unsupported-boundaries", config.primitives.items)
        self.assertIn("workers-communication", config.agent.core_features)
        self.assertIn("native-boundaries", config.agent.core_features)

    def test_validation_command_rejects_persistent_protocol(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            path = root / "harness.toml"
            path.write_text(
                textwrap.dedent(
                    """
                    version = 1
                    [project]
                    target_repo = "target"
                    node_repo = "node"
                    state_dir = "state"

                    [target]
                    command = ["target-adapter"]

                    [agent]
                    command = ["agent"]

                    [workspace]
                    [loop]

                    [validation]
                    [validation.check]
                    command = ["check"]
                    protocol = "jsonl"
                    """
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ConfigError, "validation.check.protocol"):
                load_config(path)


if __name__ == "__main__":
    unittest.main()
