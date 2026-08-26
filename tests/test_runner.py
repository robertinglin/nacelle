from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from browser_node_harness.config import CommandConfig
from browser_node_harness.models import TestCase
from browser_node_harness.runner import (
    TestRunner,
    classify_adapter_payload,
    is_retryable_infrastructure,
    mutated_test,
    structured_failure_text,
)


class RunnerTests(unittest.TestCase):
    def test_browser_failure_does_not_remain_passed_when_payload_is_stale(self) -> None:
        payload = {
            "status": "pass",
            "details": {
                "run_result": {
                    "outcome": "passed",
                    "exit": {"code": 0},
                    "error": None,
                },
                "test_output": {
                    "stdout": "",
                    "stderr": (
                        "TypeError: Cannot read properties of undefined\n"
                        "    at globalThis.__bnhRun (http://127.0.0.1:3000/runtime/process-entry.js:18:30)\n"
                    ),
                },
            },
        }

        self.assertEqual(classify_adapter_payload(payload), "fail")

    def test_browser_infrastructure_remains_infra_error(self) -> None:
        payload = {
            "status": "pass",
            "details": {
                "run_result": {
                    "outcome": "unsupported",
                    "exit": {"code": None},
                    "error": {"code": "ERR_NOT_SUPPORTED"},
                }
            },
        }

        self.assertEqual(classify_adapter_payload(payload), "infra_error")

    def test_browser_warning_stderr_does_not_override_pass(self) -> None:
        payload = {
            "status": "pass",
            "details": {
                "run_result": {"outcome": "passed", "exit": {"code": 0}, "error": None},
                "test_output": {
                    "stdout": "",
                    "stderr": "[DEP0005] DeprecationWarning: Buffer() is deprecated\n",
                },
            },
        }

        self.assertEqual(classify_adapter_payload(payload), "pass")

    def test_browser_test_stack_does_not_remain_passed_without_entry_frame(self) -> None:
        payload = {
            "status": "pass",
            "details": {
                "test_output": {
                    "stderr": (
                        "TypeError: missing primitive\n"
                        "    at test (http://127.0.0.1:3000/node/test.js:4:1)\n"
                    )
                },
                "run_result": {
                    "outcome": "passed",
                    "exit": {"code": 0},
                    "error": None,
                },
            },
        }

        self.assertEqual(classify_adapter_payload(payload), "fail")

    def test_structured_browser_error_is_available_for_failure_diagnostics(self) -> None:
        payload = {
            "status": "fail",
            "details": {
                "run_result": {
                    "outcome": "failed",
                    "error": {"message": "virtual socket contract failed"},
                }
            },
        }

        self.assertEqual(classify_adapter_payload(payload), "fail")
        self.assertEqual(
            structured_failure_text(payload["details"]),
            "virtual socket contract failed",
        )

    def test_browser_output_is_available_when_structured_error_is_empty(self) -> None:
        details = {
            "run_result": {"outcome": "failed", "error": None},
            "test_output": {"stdout": "mustCall actual 0", "stderr": ""},
        }

        self.assertEqual(structured_failure_text(details), "failed\nmustCall actual 0")

    def test_dead_browser_server_is_retryable_infrastructure(self) -> None:
        from browser_node_harness.models import TestResult

        self.assertTrue(
            is_retryable_infrastructure(
                TestResult(
                    "test.js",
                    "infra_error",
                    None,
                    1,
                    stderr="page.goto: net::ERR_CONNECTION_REFUSED",
                )
            )
        )
        self.assertFalse(
            is_retryable_infrastructure(
                TestResult(
                    "test.js",
                    "infra_error",
                    None,
                    1,
                    stderr="ERR_NOT_SUPPORTED: pseudo-tty",
                )
            )
        )

    def test_oneshot_adapter_without_result_is_infrastructure_error(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            config = SimpleNamespace(
                path=root / "harness.toml",
                root=root,
                project=SimpleNamespace(
                    node_repo=root,
                    target_repo=root,
                    state_dir=root / "state",
                    node_binary=sys.executable,
                ),
            )
            runner = TestRunner(config)
            try:
                result = runner.run_one(
                    TestCase("test.js", "parallel", "source"),
                    spec=CommandConfig(
                        command=(sys.executable, "-c", "pass"),
                        cwd="{worktree}",
                        timeout_seconds=2,
                        max_output_chars=1000,
                    ),
                    worktree=root,
                    phase="test",
                )
            finally:
                runner.close()

        self.assertEqual(result.status, "infra_error")
        self.assertIn("adapter produced no result", result.stderr)

    def test_mutation_supports_synthetic_source(self) -> None:
        original = TestCase(
            path=".bnh/canary/source.js",
            suite="bnh-canary",
            source_sha256="original",
            source_override="console.log('original');\n",
        )
        mutant = mutated_test(Path("/does/not/exist"), original, "fixed-token")
        self.assertIn("BNH_MUTATION_fixed-token", mutant.source_override or "")
        self.assertIn("console.log('original')", mutant.source_override or "")


if __name__ == "__main__":
    unittest.main()
