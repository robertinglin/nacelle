from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from browser_node_harness.gitops import GitError, GitManager, worktree_snapshot_identity


class GitOpsTests(unittest.TestCase):
    def _make_repo(self, root: Path) -> Path:
        target = root / "target"
        target.mkdir()
        subprocess.run(["git", "init", "-b", "main", str(target)], check=True, capture_output=True)
        (target / "tracked.txt").write_text("initial\n", encoding="utf-8")
        subprocess.run(["git", "add", "tracked.txt"], cwd=target, check=True, capture_output=True)
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "initial",
            ],
            cwd=target,
            check=True,
            capture_output=True,
        )
        return target

    def test_snapshot_identity_distinguishes_clean_head_from_dirty_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            target = self._make_repo(Path(raw))
            clean = worktree_snapshot_identity(target)
            before = subprocess.run(
                ["git", "status", "--porcelain=v1", "-z"],
                cwd=target,
                check=True,
                capture_output=True,
            ).stdout

            (target / "tracked.txt").write_text("changed\n", encoding="utf-8")
            dirty = worktree_snapshot_identity(target)
            after = subprocess.run(
                ["git", "status", "--porcelain=v1", "-z"],
                cwd=target,
                check=True,
                capture_output=True,
            ).stdout

            self.assertNotEqual(clean, dirty)
            self.assertEqual(dirty, worktree_snapshot_identity(target))
            self.assertEqual(before, b"")
            self.assertEqual(after, b" M tracked.txt\0")

    def test_snapshot_identity_includes_untracked_content_and_is_order_independent(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            target = self._make_repo(Path(raw))
            (target / "z-untracked.txt").write_text("z\n", encoding="utf-8")
            (target / "a-untracked.txt").write_text("a\n", encoding="utf-8")
            first = worktree_snapshot_identity(target)

            (target / "a-untracked.txt").unlink()
            (target / "z-untracked.txt").unlink()
            (target / "a-untracked.txt").write_text("a\n", encoding="utf-8")
            (target / "z-untracked.txt").write_text("z\n", encoding="utf-8")
            self.assertEqual(first, worktree_snapshot_identity(target))

            (target / "z-untracked.txt").write_text("changed\n", encoding="utf-8")
            self.assertNotEqual(first, worktree_snapshot_identity(target))

    def test_snapshot_identity_is_bounded_and_does_not_modify_index(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            target = self._make_repo(Path(raw))
            (target / "tracked.txt").write_text("x" * 100, encoding="utf-8")
            (target / "untracked.txt").write_text("y" * 100, encoding="utf-8")
            before = subprocess.run(
                ["git", "diff", "--cached", "--raw"],
                cwd=target,
                check=True,
                capture_output=True,
            ).stdout

            identity = worktree_snapshot_identity(target, max_files=1, max_bytes=4)
            after = subprocess.run(
                ["git", "diff", "--cached", "--raw"],
                cwd=target,
                check=True,
                capture_output=True,
            ).stdout

            self.assertEqual(len(identity), 64)
            self.assertEqual(before, after)

    def test_seeds_shared_browser_runtime_into_new_integration(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "adapters" / "playwright"
            (source / "runtime").mkdir(parents=True)
            (source / "runtime.js").write_text("export const runtime = {};\n", encoding="utf-8")
            (source / "runtime" / "index.js").write_text("export {};\n", encoding="utf-8")
            (source / "target-bridge.example.js").write_text("globalThis.bridge = true;\n", encoding="utf-8")

            target = root / "target"
            target.mkdir()
            subprocess.run(["git", "init", "-b", "main", str(target)], check=True, capture_output=True)
            (target / "README.md").write_text("target\n", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=target, check=True, capture_output=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "-m",
                    "initial",
                ],
                cwd=target,
                check=True,
                capture_output=True,
            )
            config = SimpleNamespace(
                root=root,
                project=SimpleNamespace(
                    target_repo=target,
                    state_dir=root / "state",
                    base_ref="main",
                    integration_branch="bnh/integration",
                    variant="v22",
                ),
            )
            manager = GitManager(config)
            integration = manager.ensure_integration()
            commit = manager.ensure_shared_browser_runtime()

            self.assertIsNotNone(commit)
            self.assertTrue((integration / "runtime.js").is_symlink())
            self.assertTrue((integration / "runtime").is_symlink())
            self.assertEqual((integration / "runtime.js").read_text(encoding="utf-8"), "export const runtime = {};\n")
            self.assertTrue((integration / "runtime" / "index.js").is_file())
            self.assertTrue((integration / "target-bridge.js").is_file())
            self.assertIn('type="module"', (integration / "harness.html").read_text(encoding="utf-8"))
            self.assertIsNone(manager.ensure_shared_browser_runtime())

    def test_existing_integration_reuses_shared_runtime_links(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "adapters" / "playwright"
            (source / "runtime").mkdir(parents=True)
            (source / "runtime.js").write_text("canonical runtime\n", encoding="utf-8")
            (source / "runtime" / "index.js").write_text("canonical module\n", encoding="utf-8")
            (source / "target-bridge.example.js").write_text("canonical bridge\n", encoding="utf-8")

            target = root / "target"
            target.mkdir()
            subprocess.run(["git", "init", "-b", "main", str(target)], check=True, capture_output=True)
            (target / "README.md").write_text("target\n", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=target, check=True, capture_output=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "-m",
                    "initial",
                ],
                cwd=target,
                check=True,
                capture_output=True,
            )
            config = SimpleNamespace(
                root=root,
                project=SimpleNamespace(
                    target_repo=target,
                    state_dir=root / "state",
                    base_ref="main",
                    integration_branch="bnh/integration",
                    variant="v22",
                ),
            )
            manager = GitManager(config)
            integration = manager.ensure_integration()
            first_commit = manager.ensure_shared_browser_runtime()
            self.assertIsNotNone(first_commit)

            (integration / "runtime.js").write_text("shared runtime\n", encoding="utf-8")

            reused_manager = GitManager(config)
            self.assertEqual(reused_manager.ensure_integration(), integration)
            self.assertIsNone(reused_manager.ensure_shared_browser_runtime())
            self.assertTrue((integration / "runtime.js").is_symlink())
            self.assertEqual(
                (integration / "runtime.js").read_text(encoding="utf-8"),
                "shared runtime\n",
            )

    def test_new_variant_reuses_runtime_from_base_integration(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "adapters" / "playwright"
            (source / "runtime").mkdir(parents=True)
            (source / "runtime.js").write_text("canonical runtime\n", encoding="utf-8")
            (source / "runtime" / "index.js").write_text("canonical module\n", encoding="utf-8")
            (source / "target-bridge.example.js").write_text("canonical bridge\n", encoding="utf-8")

            target = root / "target"
            target.mkdir()
            subprocess.run(["git", "init", "-b", "main", str(target)], check=True, capture_output=True)
            (target / "README.md").write_text("target\n", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=target, check=True, capture_output=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "-m",
                    "initial",
                ],
                cwd=target,
                check=True,
                capture_output=True,
            )
            base_config = SimpleNamespace(
                root=root,
                project=SimpleNamespace(
                    target_repo=target,
                    state_dir=root / "state-v22",
                    base_ref="main",
                    integration_branch="bnh/integration-v22",
                    variant="v22",
                ),
            )
            base_manager = GitManager(base_config)
            base_integration = base_manager.ensure_integration()
            base_commit = base_manager.ensure_shared_browser_runtime()
            self.assertIsNotNone(base_commit)

            variant_config = SimpleNamespace(
                root=root,
                project=SimpleNamespace(
                    target_repo=target,
                    state_dir=root / "state-v24",
                    base_ref="bnh/integration-v22",
                    integration_branch="bnh/integration-v24",
                    variant="v24",
                    variant_base="v22",
                ),
            )
            variant_manager = GitManager(variant_config)
            variant_integration = variant_manager.ensure_integration()
            variant_commit = variant_manager.ensure_shared_browser_runtime()

            self.assertIsNone(variant_commit)
            self.assertTrue((variant_integration / "runtime.js").is_symlink())
            self.assertTrue((variant_integration / "runtime").is_symlink())
            self.assertEqual(
                (variant_integration / "runtime.js").read_text(encoding="utf-8"),
                (base_integration / "runtime.js").read_text(encoding="utf-8"),
            )
            self.assertEqual(variant_manager.head(), base_commit)

    def test_new_integration_refuses_partial_runtime_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "adapters" / "playwright"
            (source / "runtime").mkdir(parents=True)
            (source / "runtime.js").write_text("canonical runtime\n", encoding="utf-8")
            (source / "runtime" / "index.js").write_text("canonical module\n", encoding="utf-8")
            (source / "target-bridge.example.js").write_text("canonical bridge\n", encoding="utf-8")

            target = root / "target"
            target.mkdir()
            subprocess.run(["git", "init", "-b", "main", str(target)], check=True, capture_output=True)
            (target / "runtime.js").write_text("target-owned runtime\n", encoding="utf-8")
            subprocess.run(["git", "add", "runtime.js"], cwd=target, check=True, capture_output=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "-m",
                    "initial",
                ],
                cwd=target,
                check=True,
                capture_output=True,
            )
            config = SimpleNamespace(
                root=root,
                project=SimpleNamespace(
                    target_repo=target,
                    state_dir=root / "state",
                    base_ref="main",
                    integration_branch="bnh/integration",
                    variant="v22",
                ),
            )
            manager = GitManager(config)
            manager.ensure_integration()

            with self.assertRaisesRegex(GitError, "partial shared browser runtime paths"):
                manager.ensure_shared_browser_runtime()
            self.assertEqual(
                (manager.integration / "runtime.js").read_text(encoding="utf-8"),
                "target-owned runtime\n",
            )

    def test_agent_worktree_prunes_missing_registration(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            target = root / "target"
            target.mkdir()
            subprocess.run(["git", "init", "-b", "main", str(target)], check=True, capture_output=True)
            (target / "runtime.js").write_text("export {}\n", encoding="utf-8")
            subprocess.run(["git", "add", "runtime.js"], cwd=target, check=True, capture_output=True)
            subprocess.run(
                [
                    "git",
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "-m",
                    "initial",
                ],
                cwd=target,
                check=True,
                capture_output=True,
            )
            commit = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=target,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            config = SimpleNamespace(
                project=SimpleNamespace(
                    target_repo=target,
                    state_dir=root / "state",
                    base_ref="main",
                    integration_branch="bnh/integration",
                    variant="v22",
                )
            )
            manager = GitManager(config)
            stale = manager.agents_root / "stale-attempt"
            manager._git("worktree", "add", "--detach", str(stale), commit)
            shutil.rmtree(stale)

            recreated = manager.create_agent_worktree("stale-attempt", commit)

            self.assertEqual(recreated, stale)
            self.assertTrue((recreated / "runtime.js").is_file())


if __name__ == "__main__":
    unittest.main()
