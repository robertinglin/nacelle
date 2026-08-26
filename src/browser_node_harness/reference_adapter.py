from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from .output_contract import compare_expected_output
from .process import run_process

_SKIP_MARKERS = (
    "1..0 # Skipped",
    "1..0 # SKIP",
    "Skipping test",
)


def run_reference_request(request_path: Path) -> int:
    request = json.loads(request_path.read_text(encoding="utf-8"))
    test = request["test"]
    paths = request["paths"]
    limits = request.get("limits", {})
    node_repo = Path(paths["node_repo"])
    result_path = Path(paths["result"])
    node_binary = os.environ.get("BNH_NODE_BINARY", "node")
    flags = [str(flag) for flag in test.get("flags", [])]
    source_override = test.get("source_override")
    expected = request.get("expected") or {}
    if not isinstance(expected, dict):
        expected = {}

    temporary: tempfile.TemporaryDirectory[str] | None = None
    try:
        if source_override is None:
            script = Path(test["absolute_path"])
        else:
            temporary = tempfile.TemporaryDirectory(prefix="bnh-reference-")
            script = Path(temporary.name) / Path(str(test["path"])).name
            script.write_text(str(source_override), encoding="utf-8")

        command = [node_binary, *flags, str(script)]
        tty_supported = False
        if expected.get("requires_tty"):
            command = [sys.executable, str(node_repo / "tools" / "pseudo-tty.py"), *command]
            tty_supported = True
        result = run_process(
            command,
            cwd=node_repo,
            env=os.environ,
            timeout_seconds=float(limits.get("timeout_seconds", 120)),
            stdin_text=expected.get("input") if isinstance(expected.get("input"), str) else None,
            max_output_chars=500_000,
        )
        if result.timed_out:
            status = "timeout"
        elif result.exit_code == 0 and any(marker in (result.stdout + result.stderr) for marker in _SKIP_MARKERS):
            status = "skip"
        elif expected.get("required") and not isinstance(expected.get("output"), str):
            status = "infra_error"
        elif isinstance(expected.get("output"), str):
            comparison = compare_expected_output(
                str(test["path"]), expected["output"], result.stdout, result.stderr
            )
            status = "pass" if comparison["matched"] else "fail"
        elif result.exit_code == 0:
            status = "pass"
        else:
            status = "fail"
        payload = {
            "status": status,
            "exit_code": result.exit_code,
            "duration_ms": result.duration_ms,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "details": {
                "node_binary": node_binary,
                "flags": flags,
                "tty_supported": tty_supported,
                "expected_output": (
                    compare_expected_output(
                        str(test["path"]), expected["output"], result.stdout, result.stderr
                    )
                    if isinstance(expected.get("output"), str)
                    else {"matched": False, "mismatch": {"reason": "missing-output-file"}}
                    if expected.get("required")
                    else None
                ),
            },
        }
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(json.dumps(payload), encoding="utf-8")
        return 0
    except Exception as exc:
        result_path.parent.mkdir(parents=True, exist_ok=True)
        result_path.write_text(
            json.dumps(
                {
                    "status": "infra_error",
                    "exit_code": None,
                    "duration_ms": 0,
                    "stdout": "",
                    "stderr": f"reference adapter error: {type(exc).__name__}: {exc}",
                }
            ),
            encoding="utf-8",
        )
        return 1
    finally:
        if temporary is not None:
            temporary.cleanup()
