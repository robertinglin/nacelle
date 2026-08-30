from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from .models import TestCase

_OUTPUT_SUITES = frozenset({"message", "pseudo-tty"})


def _suite_for(path: str) -> str:
    parts = Path(path).parts
    return parts[1] if len(parts) >= 2 and parts[0] == "test" else ""


def load_expected_contract(node_repo: Path, test: TestCase) -> dict[str, Any] | None:
    """Load Node's sidecar output contract for message and pseudo-tty tests."""

    suite = _suite_for(test.path)
    if suite not in _OUTPUT_SUITES:
        return None

    source = node_repo / test.path
    output_path = source.with_suffix(".out")
    input_path = source.with_suffix(".in") if suite == "pseudo-tty" else None
    output_text = test.expected_output
    input_text = test.expected_input
    if output_text is None and output_path.is_file():
        output_text = output_path.read_text(encoding="utf-8", errors="replace")
    if input_path is not None and input_text is None and input_path.is_file():
        input_text = input_path.read_text(encoding="utf-8", errors="replace")

    return {
        "suite": suite,
        "output_path": test.expected_output_path or output_path.relative_to(node_repo).as_posix(),
        "output": output_text,
        "input_path": test.expected_input_path or (
            input_path.relative_to(node_repo).as_posix()
            if input_path is not None and input_path.is_file()
            else None
        ),
        "input": input_text,
        "required": True,
        "requires_tty": suite == "pseudo-tty",
    }


def _expected_lines(expected: str, *, basename: str) -> list[re.Pattern[str]]:
    patterns: list[re.Pattern[str]] = []
    for raw_line in expected.splitlines():
        if not raw_line.strip():
            continue
        line = raw_line.rstrip()
        try:
            line = line % {"basename": basename}
        except (KeyError, TypeError, ValueError):
            pass
        expression = re.escape(line).replace(r"\*", ".*")
        patterns.append(re.compile(f"^{expression}$"))
    return patterns


def compare_expected_output(test_path: str, expected: str, stdout: str, stderr: str) -> dict[str, Any]:
    """Apply Node's message/TTY `.out` comparison rules to browser output."""

    strip_trailing = _suite_for(test_path) == "pseudo-tty"
    actual_lines = []
    for line in (stdout + stderr).split("\n"):
        if not line.strip() or line.startswith("==") or line.startswith("**"):
            continue
        actual_lines.append(line.rstrip() if strip_trailing else line)
    patterns = _expected_lines(expected, basename=Path(test_path).name)
    mismatch: dict[str, Any] | None = None
    if len(actual_lines) != len(patterns):
        mismatch = {"reason": "line-count", "expected": len(patterns), "actual": len(actual_lines)}
    else:
        for index, (pattern, actual) in enumerate(zip(patterns, actual_lines)):
            if pattern.fullmatch(actual) is None:
                mismatch = {
                    "reason": "line-mismatch",
                    "line": index,
                    "expected": pattern.pattern,
                    "actual": actual,
                }
                break
    return {"matched": mismatch is None, "actual_lines": actual_lines, "mismatch": mismatch}
