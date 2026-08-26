from __future__ import annotations

import hashlib
import unittest

from browser_node_harness.primitive_suites.system_platform import (
    SYSTEM_PLATFORM_SPECS,
    system_platform_boundaries,
    system_platform_goal,
    system_platform_specs,
    system_platform_tests,
)


class SystemPlatformPrimitiveTests(unittest.TestCase):
    def test_suite_has_one_contract_for_each_requested_area(self) -> None:
        names = {spec.name for spec in system_platform_specs()}
        self.assertEqual(len(names), 8)
        for area in ('process', 'module-loading', 'crypto', 'os-platform', 'diagnostics', 'compression', 'wasm'):
            self.assertIn(f'system-platform-{area}', names)
        self.assertIn('system-platform-unsupported-boundaries', names)

    def test_every_contract_is_a_self_contained_source_override(self) -> None:
        specs = system_platform_specs()
        tests = system_platform_tests()
        self.assertEqual(len(specs), len(tests))
        for spec, test in zip(specs, tests):
            self.assertEqual(test.source_override, spec.source)
            self.assertEqual(test.source_sha256, hashlib.sha256(spec.source.encode()).hexdigest())
            self.assertTrue(test.path.startswith('.bnh/primitives/system-platform-'))
            self.assertEqual(test.suite, 'bnh-primitives-system-platform')
            self.assertNotIn('child_process', spec.source)
            self.assertNotIn('execFile', spec.source)
            self.assertNotIn('spawn(', spec.source)

    def test_unsupported_host_capabilities_are_explicit_boundaries(self) -> None:
        boundaries = system_platform_boundaries()
        self.assertEqual([spec.name for spec in boundaries], ['system-platform-unsupported-boundaries'])
        source = boundaries[0].source
        self.assertIn('native-addons', source)
        self.assertIn('privileged-os-apis', source)
        self.assertIn('real-subprocesses', source)
        self.assertTrue(boundaries[0].boundary)

    def test_goals_resolve_only_for_suite_paths(self) -> None:
        self.assertIn('AsyncLocalStorage', system_platform_goal('.bnh/primitives/system-platform-diagnostics.js'))
        self.assertIsNone(system_platform_goal('test/parallel/test-os.js'))
        self.assertIsNone(system_platform_goal('.bnh/primitives/unknown.js'))

    def test_registry_is_immutable_and_matches_exported_specs(self) -> None:
        self.assertIs(system_platform_specs(), SYSTEM_PLATFORM_SPECS)
        with self.assertRaises(TypeError):
            SYSTEM_PLATFORM_SPECS[0] = SYSTEM_PLATFORM_SPECS[1]  # type: ignore[index]


if __name__ == '__main__':
    unittest.main()
