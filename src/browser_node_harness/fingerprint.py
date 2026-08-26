from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Iterable

_ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
_HEX_RE = re.compile(r"\b0x[0-9a-fA-F]+\b")
_UUID_RE = re.compile(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}\b")
_DURATION_RE = re.compile(r"\b\d+(?:\.\d+)?\s*(?:ms|s|sec|seconds|minutes)\b", re.IGNORECASE)
_PORT_RE = re.compile(r"(?<=:)\d{2,5}\b")
_PID_RE = re.compile(r"\b(?:pid|process)\s*[=:]?\s*\d+\b", re.IGNORECASE)
_LINE_COL_RE = re.compile(r":\d+(?::\d+)?\b")
_LONG_NUMBER_RE = re.compile(r"\b\d{4,}\b")
_WHITESPACE_RE = re.compile(r"[ \t]+")


def normalize_failure(text: str, roots: Iterable[Path] = ()) -> str:
    value = _ANSI_RE.sub("", text.replace("\r\n", "\n"))
    for root in roots:
        try:
            root_text = str(root.resolve())
        except OSError:
            root_text = str(root)
        if root_text:
            value = value.replace(root_text, "<ROOT>")
    value = _UUID_RE.sub("<UUID>", value)
    value = _HEX_RE.sub("<HEX>", value)
    value = _DURATION_RE.sub("<TIME>", value)
    value = _PID_RE.sub("pid=<N>", value)
    value = _PORT_RE.sub("<PORT>", value)
    value = _LINE_COL_RE.sub(":<LINE>", value)
    value = _LONG_NUMBER_RE.sub("<N>", value)
    lines = []
    for line in value.splitlines():
        line = _WHITESPACE_RE.sub(" ", line).strip()
        if not line:
            continue
        if line.startswith(("at ", "node:internal/")) and len(lines) >= 12:
            continue
        lines.append(line)
        if len(lines) >= 40:
            break
    return "\n".join(lines)


def failure_fingerprint(stderr: str, stdout: str = "", roots: Iterable[Path] = ()) -> str:
    normalized = normalize_failure(f"{stderr}\n{stdout}", roots)
    if not normalized:
        normalized = "<no-output>"
    return hashlib.sha256(normalized.encode("utf-8", errors="replace")).hexdigest()[:20]


def cluster_key(test_suite: str, modules: tuple[str, ...], fingerprint: str) -> str:
    module_key = ",".join(modules[:4]) or "no-module"
    return f"{test_suite}:{module_key}:{fingerprint or 'unknown'}"
