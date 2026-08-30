from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from browser_node_harness.config import load_config
from browser_node_harness.orchestrator import Harness


def run(*argv: str, cwd: Path) -> None:
    subprocess.run(argv, cwd=cwd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


class EndToEndTests(unittest.TestCase):
    def test_parallel_agents_merge_and_reach_green(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            target = root / "target"
            node = root / "node"
            state = root / "state"
            target.mkdir()
            (node / "test" / "parallel").mkdir(parents=True)
            (node / "test" / "parallel" / "test-alpha.js").write_text("// alpha\n", encoding="utf-8")
            (node / "test" / "parallel" / "test-beta.js").write_text("// beta\n", encoding="utf-8")
            (target / "runtime.json").write_text('{"supported": []}\n', encoding="utf-8")
            run("git", "init", "-b", "main", cwd=target)
            run("git", "add", "runtime.json", cwd=target)
            run(
                "git",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "initial",
                cwd=target,
            )

            adapter = root / "adapter.py"
            adapter.write_text(
                textwrap.dedent(
                    """
                    import json
                    import sys
                    from pathlib import Path

                    request = json.loads(Path(sys.argv[1]).read_text())
                    override = request["test"].get("source_override")
                    if override is not None:
                        bad = (
                            "BNH_NEGATIVE_CONTROL" in override
                            or "BNH_MUTATION" in override
                            or "process.exitCode = 17" in override
                        )
                        status = "fail" if bad else "pass"
                    else:
                        feature = Path(request["test"]["path"]).stem.removeprefix("test-")
                        runtime = json.loads((Path(request["paths"]["worktree"]) / "runtime.json").read_text())
                        status = "pass" if feature in runtime["supported"] else "fail"
                    Path(request["paths"]["result"]).write_text(json.dumps({
                        "status": status,
                        "exit_code": 0 if status == "pass" else 1,
                        "duration_ms": 1,
                        "stdout": "",
                        "stderr": "" if status == "pass" else "unsupported feature",
                    }))
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            agent = root / "agent.py"
            agent.write_text(
                textwrap.dedent(
                    """
                    import json
                    import os
                    from pathlib import Path

                    task = json.loads(Path(os.environ["BNH_TASK_FILE"]).read_text())
                    runtime_path = Path.cwd() / "runtime.json"
                    runtime = json.loads(runtime_path.read_text())
                    for test in task["tests"]:
                        feature = Path(test["path"]).stem.removeprefix("test-")
                        if feature not in runtime["supported"]:
                            runtime["supported"].append(feature)
                    runtime["supported"].sort()
                    runtime_path.write_text(json.dumps(runtime, indent=2) + "\\n")
                    print("implemented " + ",".join(runtime["supported"]))
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            config_path = root / "harness.toml"
            config_path.write_text(
                textwrap.dedent(
                    f"""
                    version = 1
                    [project]
                    target_repo = {json.dumps(str(target))}
                    node_repo = {json.dumps(str(node))}
                    state_dir = {json.dumps(str(state))}
                    base_ref = "main"
                    integration_branch = "bnh/integration"
                    node_binary = {json.dumps(sys.executable)}

                    [discovery]
                    include = ["test/parallel/test-*.js"]

                    [target]
                    command = [{json.dumps(sys.executable)}, {json.dumps(str(adapter))}, "{{request}}"]
                    cwd = "{{worktree}}"
                    timeout_seconds = 10
                    inherit_env = false

                    [agent]
                    command = [{json.dumps(sys.executable)}, {json.dumps(str(agent))}]
                    cwd = "{{worktree}}"
                    prompt_transport = "stdin"
                    timeout_seconds = 10
                    inherit_env = true

                    [workspace]

                    [loop]
                    workers = 2
                    target_concurrency = 2
                    batch_size = 1
                    guard_tests = 1
                    mutation_tests = 1
                    max_iterations = 5
                    refresh_all_every = 1
                    accept_partial = true

                    [validation]
                    max_patch_bytes = 100000
                    max_changed_files = 5
                    require_source_override = true

                    [primitives]
                    enabled = true
                    items = ["stdout-stderr", "vfs"]
                    max_rounds = 1
                    """
                ).strip()
                + "\n",
                encoding="utf-8",
            )

            messages: list[str] = []
            harness = Harness(load_config(config_path), emit=messages.append)
            run_id = harness.loop()
            self.assertTrue(run_id.startswith("run-"))
            summary = harness.db.summary()
            self.assertEqual(summary["pass"], 4, messages)
            self.assertEqual(summary["fail"], 0, messages)
            self.assertLess(
                next(index for index, message in enumerate(messages) if "primitive phase: checking" in message),
                next(index for index, message in enumerate(messages) if message.startswith("baseline:")),
            )
            integration = state / "worktrees" / "integration"
            runtime = json.loads((integration / "runtime.json").read_text())
            self.assertEqual(runtime["supported"], ["alpha", "beta"])

            resumed_messages: list[str] = []
            resumed_harness = Harness(load_config(config_path), emit=resumed_messages.append)
            self.assertEqual(resumed_harness.loop(), run_id)
            with resumed_harness.db.connect() as connection:
                self.assertEqual(connection.execute("SELECT COUNT(*) FROM runs").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
