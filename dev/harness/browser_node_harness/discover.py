from __future__ import annotations

import fnmatch
import hashlib
import re
import shlex
from pathlib import Path

from .config import DiscoveryConfig
from .models import TestCase
from .scope import classify_test_path

_FLAGS_RE = re.compile(r"^\s*//\s*Flags:\s*(.*?)\s*$", re.MULTILINE)
_REQUIRE_RE = re.compile(r"(?:require\s*\(\s*|from\s+|import\s*\(\s*)['\"]([^'\"]+)['\"]")
_NODE_SCHEME_RE = re.compile(r"\bnode:([a-zA-Z0-9_./-]+)")


def _parse_flags(source: str) -> tuple[str, ...]:
    flags: list[str] = []
    for match in _FLAGS_RE.finditer(source[:16_000]):
        try:
            flags.extend(shlex.split(match.group(1), posix=True))
        except ValueError:
            flags.extend(match.group(1).split())
    return tuple(dict.fromkeys(flags))


def _parse_modules(source: str) -> tuple[str, ...]:
    modules: set[str] = set()
    for match in _REQUIRE_RE.finditer(source):
        value = match.group(1)
        if value.startswith("node:"):
            modules.add(value[5:].split("/", 1)[0])
        elif not value.startswith((".", "/")):
            modules.add(value.split("/", 1)[0])
    modules.update(match.group(1).split("/", 1)[0] for match in _NODE_SCHEME_RE.finditer(source))
    return tuple(sorted(modules))


def _suite(path: str) -> str:
    parts = Path(path).parts
    if len(parts) >= 2 and parts[0] == "test":
        return parts[1]
    return parts[0] if parts else "unknown"


def test_case_from_path(node_repo: Path, relative: str) -> TestCase:
    path = node_repo / relative
    if not path.is_file():
        raise FileNotFoundError(f"upstream test does not exist: {path}")
    raw = path.read_bytes()
    source = raw.decode("utf-8", errors="replace")
    suite = _suite(relative)
    expected_output_path = None
    expected_output = None
    expected_input_path = None
    expected_input = None
    if suite in {"message", "pseudo-tty"}:
        output_path = path.with_suffix(".out")
        expected_output_path = output_path.relative_to(node_repo).as_posix()
        if output_path.is_file():
            expected_output = output_path.read_text(encoding="utf-8", errors="replace")
        if suite == "pseudo-tty":
            input_path = path.with_suffix(".in")
            if input_path.is_file():
                expected_input_path = input_path.relative_to(node_repo).as_posix()
                expected_input = input_path.read_text(encoding="utf-8", errors="replace")
    requirement = classify_test_path(relative, suite)
    if not (requirement.kind and requirement.runner and requirement.proof):
        raise ValueError(f"discovered test has no proof requirement: {relative}")
    return TestCase(
        path=relative,
        suite=suite,
        source_sha256=hashlib.sha256(raw).hexdigest(),
        flags=_parse_flags(source),
        modules=_parse_modules(source),
        size_bytes=len(raw),
        scope=requirement.kind,
        expected_output_path=expected_output_path,
        expected_output=expected_output,
        expected_input_path=expected_input_path,
        expected_input=expected_input,
    )


def discover_tests(node_repo: Path, config: DiscoveryConfig) -> list[TestCase]:
    found: dict[str, Path] = {}
    for pattern in config.include:
        for path in node_repo.glob(pattern):
            if path.is_file():
                relative = path.relative_to(node_repo).as_posix()
                found[relative] = path

    tests: list[TestCase] = []
    for relative, path in sorted(found.items()):
        if any(fnmatch.fnmatch(relative, pattern) for pattern in config.exclude):
            continue
        tests.append(test_case_from_path(node_repo, relative))
        if config.limit > 0 and len(tests) >= config.limit:
            break
    return tests


def read_source(node_repo: Path, test: TestCase, limit: int = 0) -> str:
    if test.source_override is not None:
        source = test.source_override
    else:
        source = (node_repo / test.path).read_text(encoding="utf-8", errors="replace")
    if limit > 0 and len(source) > limit:
        omitted = len(source) - limit
        return f"{source[:limit]}\n\n/* ... {omitted} characters omitted by harness ... */\n"
    return source
