from __future__ import annotations

import unittest

from browser_node_harness.primitives import primitive_goal, primitive_specs, primitive_tests


class PrimitiveTests(unittest.TestCase):
    def test_default_primitive_contracts_are_real_source_overrides(self) -> None:
        names = ("stdout-stderr", "vfs", "network", "ipc")
        specs = primitive_specs(names)
        tests = primitive_tests(names)

        self.assertEqual([spec.name for spec in specs], list(names))
        self.assertEqual([test.path for test in tests], [f".bnh/primitives/{name}.js" for name in names])
        self.assertTrue(all(test.source_override for test in tests))
        self.assertIn("virtual filesystem", primitive_goal(".bnh/primitives/vfs.js"))

    def test_unknown_primitive_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown primitive"):
            primitive_specs(("not-a-primitive",))

    def test_shell_is_a_base_primitive(self) -> None:
        spec = primitive_specs(("shell",))[0]
        test = primitive_tests(("shell",))[0]

        self.assertIn("base shell primitive", spec.goal)
        self.assertEqual(test.path, ".bnh/primitives/shell.js")
        self.assertIn("spawnSync", test.source_override)

    def test_expanded_contracts_are_registered_for_the_loop(self) -> None:
        names = ("globals", "data-encoding-serialization", "system-platform-crypto")
        tests = primitive_tests(names)

        self.assertEqual(
            [test.path for test in tests],
            [
                ".bnh/primitives/runtime/globals.js",
                ".bnh/primitives/data-encoding-serialization.js",
                ".bnh/primitives/system-platform-crypto.js",
            ],
        )
        self.assertTrue(all(test.is_synthetic and test.source_override for test in tests))
        self.assertIn("browser-native runtime globals", primitive_goal(tests[0].path))
        self.assertIn("randomness", primitive_goal(tests[2].path))

    def test_expanded_primitive_names_reject_unknown_items(self) -> None:
        with self.assertRaisesRegex(ValueError, "unknown primitive"):
            primitive_tests(("not-a-primitive",))


if __name__ == "__main__":
    unittest.main()
