from __future__ import annotations

import os
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

from browser_node_harness.jsonl_adapter import JsonlWorker


_DAEMON = textwrap.dedent(
    r"""
    import json
    import sys
    import time

    for line in sys.stdin:
        request = json.loads(line)
        mode = request.get("mode", "pass")
        if mode == "progress":
            print("BNH_PROGRESS " + json.dumps({
                "schemaVersion": 1,
                "type": "progress",
                "runId": "external-run",
                "sequence": 1,
                "phase": "execution",
                "event": "output-activity",
                "stream": "stdout",
                "bytes": 12,
                "chunks": 1,
            }), file=sys.stderr, flush=True)
            time.sleep(0.05)
        if mode == "hang":
            time.sleep(60)
            continue
        if mode == "exit":
            raise SystemExit(23)
        if mode == "noise":
            print("not-json", flush=True)
        print(json.dumps({
            "request_id": request.get("request_id"),
            "status": "pass",
            "exit_code": 0,
            "duration_ms": 1,
            "stdout": mode,
            "stderr": "",
        }), flush=True)
    """
).strip()


class JsonlWorkerTests(unittest.TestCase):
    def test_worker_delivers_external_progress_before_final_response(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            worker = JsonlWorker(
                [sys.executable, "-u", "-c", _DAEMON],
                Path(raw),
                os.environ,
                index=2,
            )
            progress: list[dict[str, object]] = []
            try:
                payload, error, _, timed_out = worker.call(
                    {"mode": "progress"},
                    2,
                    on_progress=progress.append,
                )
                self.assertFalse(timed_out, error)
                self.assertEqual(payload and payload["status"], "pass")
                self.assertEqual(progress[0]["event"], "output-activity")
                self.assertNotIn("BNH_PROGRESS", error)
            finally:
                worker.close()

    def test_worker_recovers_after_timeout_without_stale_stdout(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            worker = JsonlWorker(
                [sys.executable, "-u", "-c", _DAEMON],
                Path(raw),
                os.environ,
                index=0,
            )
            try:
                first, noise, _, timed_out = worker.call({"mode": "noise"}, 2)
                self.assertFalse(timed_out)
                self.assertEqual(first and first["status"], "pass")
                self.assertIn("not-json", noise)

                timed, _, _, did_timeout = worker.call({"mode": "hang"}, 0.05)
                self.assertIsNone(timed)
                self.assertTrue(did_timeout)

                recovered, _, _, recovered_timeout = worker.call({"mode": "recovered"}, 2)
                self.assertFalse(recovered_timeout)
                self.assertEqual(recovered and recovered["stdout"], "recovered")
            finally:
                worker.close()

    def test_worker_restarts_after_adapter_exit(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            worker = JsonlWorker(
                [sys.executable, "-u", "-c", _DAEMON],
                Path(raw),
                os.environ,
                index=1,
            )
            try:
                payload, error, _, timed_out = worker.call({"mode": "exit"}, 2)
                self.assertIsNone(payload)
                self.assertFalse(timed_out)
                self.assertIn("exited before a response", error)

                recovered, _, _, _ = worker.call({"mode": "pass"}, 2)
                self.assertEqual(recovered and recovered["status"], "pass")
            finally:
                worker.close()


if __name__ == "__main__":
    unittest.main()
