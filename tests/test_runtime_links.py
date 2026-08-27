from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from browser_node_harness.runtime_links import RuntimeLinkError, link_shared_runtime


class RuntimeLinkTests(unittest.TestCase):
    def _make_source(self, root: Path) -> Path:
        source = root / "adapters" / "playwright"
        (source / "runtime").mkdir(parents=True)
        (source / "runtime.js").write_text("export const runtime = {};\n", encoding="utf-8")
        (source / "runtime" / "index.js").write_text("export {};\n", encoding="utf-8")
        (source / "server.js").write_text("server\n", encoding="utf-8")
        return source

    def test_links_runtime_and_is_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self._make_source(root)
            target = root / "integration"
            target.mkdir()

            changed = link_shared_runtime(source, target)

            self.assertEqual(changed, (target / "runtime.js", target / "runtime", target / "server.js"))
            self.assertTrue((target / "runtime.js").is_symlink())
            self.assertTrue((target / "runtime").is_symlink())
            self.assertTrue((target / "server.js").is_symlink())
            self.assertFalse(Path((target / "runtime.js").readlink()).is_absolute())
            self.assertFalse(Path((target / "runtime").readlink()).is_absolute())
            self.assertFalse(Path((target / "server.js").readlink()).is_absolute())
            self.assertEqual((target / "runtime.js").read_text(encoding="utf-8"), "export const runtime = {};\n")
            self.assertEqual(link_shared_runtime(source, target), ())

    def test_replaces_identical_copies_and_keeps_backups(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self._make_source(root)
            target = root / "integration"
            (target / "runtime").mkdir(parents=True)
            (target / "runtime.js").write_bytes((source / "runtime.js").read_bytes())
            (target / "runtime" / "index.js").write_bytes((source / "runtime" / "index.js").read_bytes())
            (target / "server.js").write_bytes((source / "server.js").read_bytes())
            backup = root / "backup"

            link_shared_runtime(source, target, backup_root=backup)

            self.assertTrue((target / "runtime.js").is_symlink())
            self.assertTrue((target / "runtime").is_symlink())
            self.assertTrue((target / "server.js").is_symlink())
            self.assertEqual((backup / "runtime.js").read_text(encoding="utf-8"), "export const runtime = {};\n")
            self.assertEqual((backup / "runtime" / "index.js").read_text(encoding="utf-8"), "export {};\n")
            self.assertEqual((backup / "server.js").read_text(encoding="utf-8"), "server\n")

    def test_replaces_older_subset_copy_without_losing_target_files(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self._make_source(root)
            (source / "runtime" / "new.js").write_text("new module\n", encoding="utf-8")
            target = root / "integration"
            (target / "runtime").mkdir(parents=True)
            (target / "runtime.js").write_bytes((source / "runtime.js").read_bytes())
            (target / "runtime" / "index.js").write_bytes((source / "runtime" / "index.js").read_bytes())

            link_shared_runtime(source, target, backup_root=root / "backup")

            self.assertTrue((target / "runtime").is_symlink())
            self.assertEqual((target / "runtime" / "new.js").read_text(encoding="utf-8"), "new module\n")
            self.assertEqual(
                (root / "backup" / "runtime" / "index.js").read_text(encoding="utf-8"),
                "export {};\n",
            )

    def test_refuses_different_content_without_partial_linking(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self._make_source(root)
            target = root / "integration"
            (target / "runtime").mkdir(parents=True)
            (target / "runtime.js").write_text("target-owned\n", encoding="utf-8")
            (target / "runtime" / "index.js").write_bytes((source / "runtime" / "index.js").read_bytes())

            with self.assertRaisesRegex(RuntimeLinkError, "different target content"):
                link_shared_runtime(source, target, backup_root=root / "backup")

            self.assertFalse((target / "runtime.js").is_symlink())
            self.assertFalse((target / "runtime").is_symlink())
            self.assertEqual((target / "runtime.js").read_text(encoding="utf-8"), "target-owned\n")

    def test_root_script_links_explicit_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = self._make_source(root)
            target = root / "integration"
            target.mkdir()
            script = Path(__file__).parents[1] / "link-runtime.py"

            result = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "--source-root",
                    str(source),
                    "--integration",
                    str(target),
                ],
                cwd=script.parent,
                check=True,
                capture_output=True,
                text=True,
            )

            self.assertIn("linked", result.stdout)
            self.assertTrue((target / "runtime.js").is_symlink())
            self.assertTrue((target / "runtime").is_symlink())


if __name__ == "__main__":
    unittest.main()
