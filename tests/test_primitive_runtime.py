from __future__ import annotations

import hashlib
import unittest

from browser_node_harness.primitive_suites.runtime import runtime_goal, runtime_specs, runtime_tests


class RuntimePrimitiveSuiteTests(unittest.TestCase):
    def test_suite_covers_requested_runtime_capabilities(self) -> None:
        names = {spec.name for spec in runtime_specs()}

        self.assertEqual(
            names,
            {
                "globals",
                "console",
                "buffer-encoding",
                "assert",
                "structured-clone",
                "promise-microtasks",
                "abort-signal",
                "event-emitter",
                "uncaught-exception",
                "unhandled-rejection",
                "exit-behavior",
            },
        )

    def test_runtime_tests_are_source_overrides_with_stable_identity(self) -> None:
        specs = runtime_specs(("globals", "promise-microtasks", "exit-behavior"))
        tests = runtime_tests(("globals", "promise-microtasks", "exit-behavior"))

        self.assertEqual(
            [test.path for test in tests],
            [
                ".bnh/primitives/runtime/globals.js",
                ".bnh/primitives/runtime/promise-microtasks.js",
                ".bnh/primitives/runtime/exit-behavior.js",
            ],
        )
        for spec, test in zip(specs, tests):
            self.assertEqual(test.suite, "bnh-primitives-runtime")
            self.assertEqual(test.source_override, spec.source)
            self.assertEqual(test.source_sha256, hashlib.sha256(spec.source.encode()).hexdigest())
            self.assertTrue(test.is_synthetic)

    def test_contracts_are_browser_native_and_do_not_proxy_to_host_node(self) -> None:
        forbidden = ("child_process", "subprocess", "execSync", "spawnSync", "BNH_NODE_BINARY")

        for spec in runtime_specs():
            self.assertTrue(spec.source.strip())
            self.assertFalse(any(marker in spec.source for marker in forbidden), spec.name)

    def test_goals_and_unknown_names_are_explicit(self) -> None:
        self.assertIn("globals", runtime_goal(".bnh/primitives/runtime/globals.js"))
        self.assertIsNone(runtime_goal(".bnh/primitives/runtime/missing.js"))
        self.assertIsNone(runtime_goal("node/test/parallel/test-runtime.js"))
        with self.assertRaisesRegex(ValueError, "unknown runtime primitive"):
            runtime_tests(("missing",))


if __name__ == "__main__":
    unittest.main()
