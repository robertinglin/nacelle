from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from browser_node_harness.config import (
    AgentConfig,
    CommandConfig,
    DiscoveryConfig,
    HarnessConfig,
    LoopConfig,
    ProjectConfig,
    ValidationConfig,
    WorkspaceConfig,
)
from browser_node_harness.models import Task, TestCase
from browser_node_harness.prompting import prepare_task_context


class PromptingTests(unittest.TestCase):
    def test_copies_exact_upstream_file_and_includes_core_guidance(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            node_repo = root / "node"
            source_path = node_repo / "test" / "parallel" / "test-stdout.js"
            source_path.parent.mkdir(parents=True)
            source_path.write_text("process.stdout.write('hello');\n", encoding="utf-8")
            config = HarnessConfig(
                path=root / "harness.toml",
                project=ProjectConfig(target_repo=root / "target", node_repo=node_repo, state_dir=root / "state"),
                discovery=DiscoveryConfig(),
                target=CommandConfig(command=("target",), cwd=".", timeout_seconds=1),
                oracle=None,
                agent=AgentConfig(command=("opencode",), core_features=("stdout", "vfs")),
                workspace=WorkspaceConfig(),
                loop=LoopConfig(),
                validation=ValidationConfig(),
            )
            task = Task(
                task_id="task-1",
                tests=(
                    TestCase(
                        path="test/parallel/test-stdout.js",
                        suite="parallel",
                        source_sha256="sha",
                    ),
                ),
                cluster_key="stdout",
                strategy="subsystem-first",
                replica=0,
            )

            _, prompt = prepare_task_context(
                config=config,
                worktree=root / "worktree",
                task=task,
                failures={},
                previous_attempts=[],
            )

            copied = root / "worktree" / ".bnh-context" / "upstream" / "test/parallel/test-stdout.js"
            payload = json.loads((root / "worktree" / ".bnh-context" / "task.json").read_text())
            runner = (root / "worktree" / ".bnh-context" / "run_assigned.py").read_text()
            self.assertEqual(copied.read_text(encoding="utf-8"), source_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["tests"][0]["source_file"], ".bnh-context/upstream/test/parallel/test-stdout.js")
            self.assertIn("source_override=source", runner)
            self.assertIn("WORKTREE = Path.cwd()", runner)
            self.assertIn("exact upstream file(s)", prompt)
            self.assertIn("stdout", prompt)
            self.assertIn("virtual filesystem", prompt)
            self.assertIn("Use only `.bnh-context/run_assigned.py` for reproduction", prompt)
            self.assertIn("reports `infra_error`", prompt)
            self.assertIn("source of truth if `task.json` contains an older status", prompt)


if __name__ == "__main__":
    unittest.main()
