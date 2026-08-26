from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from browser_node_harness.models import TestCase
from browser_node_harness.output_contract import compare_expected_output, load_expected_contract


class OutputContractTests(unittest.TestCase):
    def test_message_output_uses_node_wildcards_and_ignores_diagnostics(self) -> None:
        result = compare_expected_output(
            "test/message/example.js",
            "Error: *\n",
            "== valgrind noise ==\n",
            "Error: actual detail\n",
        )
        self.assertTrue(result["matched"])

    def test_wrong_output_does_not_match_even_when_exit_would_be_zero(self) -> None:
        result = compare_expected_output(
            "test/message/example.js",
            "expected\n",
            "wrong\n",
            "",
        )
        self.assertFalse(result["matched"])
        self.assertEqual(result["mismatch"]["reason"], "line-mismatch")

    def test_pseudo_tty_comparison_strips_trailing_spaces(self) -> None:
        result = compare_expected_output(
            "test/pseudo-tty/example.js",
            "hello\n",
            "hello   \n",
            "",
        )
        self.assertTrue(result["matched"])

    def test_contract_marks_missing_output_and_tty_requirement(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            source = root / "test" / "pseudo-tty" / "example.js"
            source.parent.mkdir(parents=True)
            source.write_text("", encoding="utf-8")
            test = TestCase(path="test/pseudo-tty/example.js", suite="pseudo-tty", source_sha256="sha")

            contract = load_expected_contract(root, test)

            self.assertEqual(contract["output"], None)
            self.assertTrue(contract["required"])
            self.assertTrue(contract["requires_tty"])


if __name__ == "__main__":
    unittest.main()
