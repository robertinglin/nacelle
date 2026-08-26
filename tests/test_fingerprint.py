from __future__ import annotations

import unittest
from pathlib import Path

from browser_node_harness.fingerprint import failure_fingerprint, normalize_failure


class FingerprintTests(unittest.TestCase):
    def test_normalizes_paths_lines_ports_and_durations(self) -> None:
        first = "Error at /tmp/a/test.js:123:9 on localhost:43122 after 12.4ms pid 99881"
        second = "Error at /tmp/b/test.js:998:2 on localhost:51234 after 87ms pid 10002"
        one = failure_fingerprint(first, roots=(Path("/tmp/a"),))
        two = failure_fingerprint(second, roots=(Path("/tmp/b"),))
        self.assertEqual(one, two)
        normalized = normalize_failure(first, roots=(Path("/tmp/a"),))
        self.assertIn("<ROOT>", normalized)
        self.assertIn("<TIME>", normalized)


if __name__ == "__main__":
    unittest.main()
