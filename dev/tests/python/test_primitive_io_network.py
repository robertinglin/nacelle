from __future__ import annotations

import hashlib
import unittest

from browser_node_harness.primitive_suites.io_network import (
    DEFAULT_NAMES,
    expanded_boundaries,
    expanded_goal,
    expanded_specs,
    expanded_tests,
)


class ExpandedPrimitiveSuiteTests(unittest.TestCase):
    def test_definitions_are_ordered_and_self_contained(self) -> None:
        specs = expanded_specs()

        self.assertEqual(tuple(spec.name for spec in specs), DEFAULT_NAMES)
        self.assertEqual(len(specs), 5)
        self.assertTrue(all(spec.goal and spec.source for spec in specs))
        self.assertTrue(all("node:assert" in spec.source for spec in specs))

    def test_source_overrides_have_stable_test_identity(self) -> None:
        tests = expanded_tests(("data-encoding-serialization", "vfs-io"))

        self.assertEqual(
            [test.path for test in tests],
            [
                ".bnh/primitives/data-encoding-serialization.js",
                ".bnh/primitives/vfs-io.js",
            ],
        )
        self.assertTrue(all(test.is_synthetic for test in tests))
        self.assertTrue(all(test.source_override for test in tests))
        for test in tests:
            self.assertEqual(
                test.source_sha256,
                hashlib.sha256(test.source_override.encode("utf-8")).hexdigest(),
            )

    def test_contracts_cover_requested_browser_boundaries(self) -> None:
        source = "\n".join(spec.source for spec in expanded_specs())
        boundaries = expanded_boundaries()

        for marker in ("Buffer", "structuredClone", "fileURLToPath", "fs.watch", "fetch", "AbortController", "Readable", "Worker", "BroadcastChannel", "Atomics"):
            self.assertIn(marker, source)
        self.assertTrue(any("host filesystem" in boundary for boundary in boundaries))
        self.assertTrue(any("Raw TCP" in boundary for boundary in boundaries))
        self.assertTrue(any("host IPC" in boundary for boundary in boundaries))
        self.assertTrue(any("browser transport boundary" in boundary for boundary in boundaries))

    def test_unknown_names_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown expanded primitive"):
            expanded_specs(("not-a-suite",))

    def test_non_contract_paths_have_no_goal(self) -> None:
        self.assertIsNone(expanded_goal("test/parallel/example.js"))
        self.assertIsNone(expanded_goal(".bnh/primitives/missing.js"))


if __name__ == "__main__":
    unittest.main()
