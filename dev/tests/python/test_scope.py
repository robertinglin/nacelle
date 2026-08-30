from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from browser_node_harness.models import TestCase
from browser_node_harness.scope import classify_test_path, source_test_inventory, summarize_scope


class ScopeTests(unittest.TestCase):
    def test_classification_selects_runner_and_proof_by_path(self) -> None:
        cases = {
            "test/parallel/test-buffer.js": ("browser_js", "playwright-browser"),
            "test/message/test-child.js": ("message_expected_output", "playwright-browser-message"),
            "test/pseudo-tty/test-terminal.js": ("pseudo_tty_expected_output", "playwright-browser-pseudo-tty"),
            "test/addons/hello/test.js": ("native_addon", "native-addon-adapter"),
            "test/node-api/test-napi.js": ("native_api", "native-api-adapter"),
            "test/wpt/url/test-url.js": ("wpt", "playwright-wpt"),
            "test/embedding/test-embed.js": ("other_special", "specialized-suite-adapter"),
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                requirement = classify_test_path(path)
                self.assertEqual((requirement.kind, requirement.runner), expected)
                self.assertTrue(requirement.proof)

    def test_classification_is_stable_and_conservative_for_unknown_suites(self) -> None:
        self.assertEqual(
            classify_test_path("./test/custom/test-case.js", "custom").kind,
            "other_special",
        )
        self.assertEqual(
            classify_test_path("test/parallel/test-case.txt").kind,
            "other_special",
        )

    def test_summary_has_stable_counts_and_all_requirements(self) -> None:
        report = summarize_scope(
            (
                ("test/parallel/test-a.js", "parallel"),
                ("test/message/test-b.js", "message"),
                ("test/addons/a/test-c.js", "addons"),
            )
        )
        self.assertEqual(report["total"], 3)
        self.assertEqual(report["counts"]["browser_js"], 1)
        self.assertEqual(report["counts"]["message_expected_output"], 1)
        self.assertEqual(report["counts"]["native_addon"], 1)
        self.assertEqual(report["test_file_entries"], 2)
        self.assertEqual(report["special_layout_entries"], 1)
        runnable = report["runnable_inventory"]
        self.assertEqual(runnable["total"], 3)
        self.assertEqual(runnable["node_test_file_entries"], 2)
        self.assertEqual(runnable["special_layout_entries"], 1)
        self.assertEqual(
            [(entry["path"], entry["proof_category"], entry["runner"]) for entry in runnable["entries"]],
            [
                ("test/parallel/test-a.js", "browser_js", "playwright-browser"),
                ("test/message/test-b.js", "message_expected_output", "playwright-browser-message"),
                ("test/addons/a/test-c.js", "native_addon", "native-addon-adapter"),
            ],
        )
        self.assertEqual(runnable["entries"][0]["runnable_layout"], "node_test_file")
        self.assertEqual(runnable["entries"][2]["source_file"], True)
        self.assertEqual(runnable["entries"][2]["runnable_layout"], "special_layout")
        self.assertEqual(report["proof_coverage"], {"categorized_entries": 3, "entries_without_proof": 0})
        self.assertEqual(report["requirements"][0]["proof_category"], "browser_js")
        self.assertEqual(
            [item["kind"] for item in report["requirements"]],
            [
                "browser_js",
                "message_expected_output",
                "pseudo_tty_expected_output",
                "native_addon",
                "native_api",
                "wpt",
                "other_special",
            ],
        )

    def test_test_case_keeps_scope_explicit_when_rehydrated(self) -> None:
        test = TestCase("test/message/test-child.js", "message", "sha")
        self.assertEqual(test.scope, "message_expected_output")
        self.assertEqual(test.scope_requirement.kind, test.scope)

    def test_standard_node_js_suites_are_browser_proof_suites(self) -> None:
        self.assertEqual(
            classify_test_path("test/es-module/test-import.mjs", "es-module").kind,
            "browser_js",
        )
        self.assertEqual(
            classify_test_path("test/sqlite/test.js", "sqlite").kind,
            "native_addon",
        )
        self.assertEqual(
            classify_test_path("test/sea/test.js", "sea").kind,
            "other_special",
        )

    def test_source_inventory_counts_support_files_separately(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            (root / "test" / "parallel").mkdir(parents=True)
            (root / "test" / "common").mkdir(parents=True)
            (root / "test" / "parallel" / "test-one.js").write_text("", encoding="utf-8")
            (root / "test" / "parallel" / "test-two.txt").write_text("", encoding="utf-8")
            (root / "test" / "common" / "test-helper.js").write_text("", encoding="utf-8")
            inventory = source_test_inventory(root)
            self.assertEqual(inventory["test_files"], 3)
            self.assertEqual(inventory["javascript_test_files"], 2)
            self.assertEqual(inventory["source_test_files"], 3)
            self.assertEqual(inventory["source_javascript_test_files"], 2)


if __name__ == "__main__":
    unittest.main()
