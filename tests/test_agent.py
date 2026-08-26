from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from browser_node_harness.agent import run_agent
from browser_node_harness.models import ProcessResult, Task


class AgentEnvironmentTests(unittest.TestCase):
    def test_run_agent_injects_harness_pythonpath_for_detached_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            worktree = root / "target-worktree"
            worktree.mkdir()
            attempt_dir = root / "attempt"
            config = SimpleNamespace(
                root=root,
                path=root / "harness.toml",
                project=SimpleNamespace(
                    target_repo=root / "target",
                    node_repo=root / "node",
                    state_dir=root / "state",
                ),
                agent=SimpleNamespace(
                    command=("agent",),
                    cwd="{worktree}",
                    prompt_transport="stdin",
                    provider="test",
                    model="model",
                    inherit_env=True,
                    env={"PYTHONPATH": "existing-src"},
                    timeout_seconds=1,
                    max_output_chars=100,
                ),
            )
            task = Task(
                task_id="task-1",
                tests=(),
                cluster_key="buffer",
                strategy="subsystem-first",
                replica=0,
            )
            captured: dict[str, dict[str, str]] = {}

            def fake_run_process(*args, **kwargs):
                captured["env"] = kwargs["env"]
                return ProcessResult(
                    argv=("agent",),
                    cwd=worktree,
                    exit_code=0,
                    stdout="implemented\n",
                    stderr="",
                    duration_ms=1,
                )

            with patch(
                "browser_node_harness.agent.prepare_task_context",
                return_value=(worktree / ".bnh-context/prompt.md", "prompt"),
            ), patch("browser_node_harness.agent.run_process", side_effect=fake_run_process):
                run_agent(
                    config=config,
                    worktree=worktree,
                    task=task,
                    failures={},
                    previous_attempts=[],
                    run_id="run-1",
                    iteration=1,
                    attempt_dir=attempt_dir,
                )

            expected = str((root / "src").resolve())
            self.assertEqual(
                captured["env"]["PYTHONPATH"],
                expected + os.pathsep + "existing-src",
            )


if __name__ == "__main__":
    unittest.main()
