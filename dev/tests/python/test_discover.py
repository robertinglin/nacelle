from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from browser_node_harness.config import DiscoveryConfig
from browser_node_harness.discover import discover_tests


class DiscoverTests(unittest.TestCase):
    def test_flags_modules_and_excludes(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            directory = root / "test" / "parallel"
            directory.mkdir(parents=True)
            (directory / "test-one.js").write_text(
                "// Flags: --expose-gc --no-warnings\n"
                "const fs = require('node:fs');\n"
                "import assert from 'node:assert';\n",
                encoding="utf-8",
            )
            (directory / "test-skip.js").write_text("", encoding="utf-8")
            config = DiscoveryConfig(
                include=("test/parallel/test-*.js",),
                exclude=("**/test-skip.js",),
            )
            tests = discover_tests(root, config)
            self.assertEqual([test.path for test in tests], ["test/parallel/test-one.js"])
            self.assertEqual(tests[0].flags, ("--expose-gc", "--no-warnings"))
            self.assertEqual(tests[0].modules, ("assert", "fs"))
            self.assertEqual(tests[0].suite, "parallel")
            self.assertEqual(tests[0].scope, "browser_js")
            self.assertEqual(tests[0].scope_requirement.runner, "playwright-browser")
            self.assertEqual(tests[0].scope_requirement.proof, "oracle_pass_and_browser_target_pass")

    def test_message_and_pseudo_tty_sidecars_are_discovered(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            message = root / "test" / "message"
            pseudo_tty = root / "test" / "pseudo-tty"
            message.mkdir(parents=True)
            pseudo_tty.mkdir(parents=True)
            (message / "example.js").write_text("process.stderr.write('x\\n');\n", encoding="utf-8")
            (message / "example.out").write_text("x\n", encoding="utf-8")
            (pseudo_tty / "test-input.js").write_text("process.stdin.resume();\n", encoding="utf-8")
            (pseudo_tty / "test-input.in").write_text("hello\n", encoding="utf-8")
            (pseudo_tty / "test-input.out").write_text("hello\n", encoding="utf-8")
            config = DiscoveryConfig(include=("test/message/*.js", "test/pseudo-tty/*.js"))

            tests = discover_tests(root, config)

            by_path = {test.path: test for test in tests}
            self.assertEqual(by_path["test/message/example.js"].expected_output, "x\n")
            self.assertEqual(by_path["test/pseudo-tty/test-input.js"].expected_input, "hello\n")
            self.assertEqual(by_path["test/pseudo-tty/test-input.js"].expected_output, "hello\n")
            message_test = by_path["test/message/example.js"]
            self.assertEqual(message_test.scope, "message_expected_output")
            self.assertEqual(message_test.scope_requirement.runner, "playwright-browser-message")
            self.assertEqual(message_test.scope_requirement.proof, "exact_message_output")


if __name__ == "__main__":
    unittest.main()
