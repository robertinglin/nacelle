from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

from browser_node_harness.process import run_process


class ProcessTests(unittest.TestCase):
    def test_streams_output_and_honors_stop_request(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            output: list[tuple[str, str]] = []
            requested = False

            def on_output(stream: str, text: str) -> None:
                nonlocal requested
                output.append((stream, text))
                requested = True

            def stop_requested() -> str | None:
                return "stop" if requested else None

            result = run_process(
                [sys.executable, "-c", "import time; print('live', flush=True); time.sleep(30)"],
                cwd=Path(raw),
                env=os.environ,
                timeout_seconds=10,
                on_output=on_output,
                stop_requested=stop_requested,
            )

            self.assertEqual(result.termination_reason, "stop")
            self.assertTrue(any(stream == "stdout" and "live" in text for stream, text in output))
            self.assertLess(result.duration_ms, 10_000)


if __name__ == "__main__":
    unittest.main()
