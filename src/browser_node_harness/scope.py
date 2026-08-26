from __future__ import annotations

from collections import Counter
from dataclasses import asdict, dataclass
from pathlib import Path
from pathlib import PurePosixPath
from typing import Iterable, Literal


ScopeKind = Literal[
    "browser_js",
    "message_expected_output",
    "pseudo_tty_expected_output",
    "native_addon",
    "native_api",
    "wpt",
    "other_special",
]


@dataclass(frozen=True, slots=True)
class ScopeRequirement:
    """The runner and proof needed before a discovered entry can be green."""

    kind: ScopeKind
    runner: str
    proof: str


_REQUIREMENTS: dict[ScopeKind, ScopeRequirement] = {
    "browser_js": ScopeRequirement(
        "browser_js", "playwright-browser", "oracle_pass_and_browser_target_pass"
    ),
    "message_expected_output": ScopeRequirement(
        "message_expected_output", "playwright-browser-message", "exact_message_output"
    ),
    "pseudo_tty_expected_output": ScopeRequirement(
        "pseudo_tty_expected_output", "playwright-browser-pseudo-tty", "expected_pseudo_tty_output"
    ),
    "native_addon": ScopeRequirement(
        "native_addon", "native-addon-adapter", "native_addon_build_and_execution"
    ),
    "native_api": ScopeRequirement(
        "native_api", "native-api-adapter", "native_api_build_and_execution"
    ),
    "wpt": ScopeRequirement("wpt", "playwright-wpt", "web_platform_test_report"),
    "other_special": ScopeRequirement(
        "other_special", "specialized-suite-adapter", "explicit_suite_proof"
    ),
}

_JS_SUFFIXES = {".cjs", ".js", ".mjs"}
_NATIVE_API_SUITES = {"js-native-api", "node-api", "node-api-tests", "native-api"}
_NATIVE_ADDON_SUITES = {"addons", "addon", "native-addons", "sqlite"}
_BROWSER_JS_SUITES = {
    "abort",
    "async-hooks",
    "client-proxy",
    "es-module",
    "module-hooks",
    "parallel",
    "report",
    "sequential",
    "test426",
    "v8-updates",
    "wasi",
    "wasm-allocation",
}
_SPECIAL_SUITES = {
    "benchmark",
    "doctool",
    "embedding",
    "fixtures",
    "inspector",
    "internet",
    "pummel",
    "sea",
    "system-ca",
    "tap",
    "tick-processor",
}


def _normalized_parts(path: str) -> tuple[str, ...]:
    normalized = path.replace("\\", "/").removeprefix("./")
    return tuple(part.lower() for part in PurePosixPath(normalized).parts)


def classify_test_path(path: str, suite: str | None = None) -> ScopeRequirement:
    """Classify a Node test path without inspecting source or filesystem state."""

    parts = _normalized_parts(path)
    suite_name = (suite or (parts[1] if len(parts) > 1 and parts[0] == "test" else "")).lower()
    suffix = PurePosixPath(path).suffix.lower()
    if "wpt" in parts or "web-platform-tests" in parts or suite_name in {"wpt", "web-platform"}:
        return _REQUIREMENTS["wpt"]
    if suite_name == "message" or "message" in parts and parts[0] == "test":
        return _REQUIREMENTS["message_expected_output"]
    if suite_name in {"pseudo-tty", "pseudo_tty", "pty"}:
        return _REQUIREMENTS["pseudo_tty_expected_output"]
    if suite_name in _NATIVE_API_SUITES or "node-api" in parts or "js-native-api" in parts:
        return _REQUIREMENTS["native_api"]
    if suite_name in _NATIVE_ADDON_SUITES or "addons" in parts:
        return _REQUIREMENTS["native_addon"]
    if suite_name in _SPECIAL_SUITES:
        return _REQUIREMENTS["other_special"]
    if suite_name in _BROWSER_JS_SUITES and suffix in _JS_SUFFIXES:
        return _REQUIREMENTS["browser_js"]
    return _REQUIREMENTS["other_special"]


def scope_requirement(path: str, suite: str | None = None) -> ScopeRequirement:
    """Short alias for callers that need the runner/proof contract."""

    return classify_test_path(path, suite)


def _is_source_test_file(path: str) -> bool:
    return PurePosixPath(path).name.startswith("test-")


def _is_standard_node_test_entry(path: str) -> bool:
    parts = _normalized_parts(path)
    return len(parts) == 3 and parts[0] == "test" and parts[2].startswith("test-")


def _entry_report(path: str, suite: str, requirement: ScopeRequirement) -> dict[str, object]:
    return {
        "path": path,
        "suite": suite,
        "source_file": _is_source_test_file(path),
        "runnable_layout": (
            "node_test_file" if _is_standard_node_test_entry(path) else "special_layout"
        ),
        "proof_category": requirement.kind,
        "runner": requirement.runner,
        "proof": requirement.proof,
    }


def summarize_scope(entries: Iterable[tuple[str, str]]) -> dict[str, object]:
    """Return counts and per-entry proof contracts for runnable paths."""

    entries = list(entries)
    requirements = [classify_test_path(path, suite) for path, suite in entries]
    counts = Counter(requirement.kind for requirement in requirements)
    ordered_counts = {kind: counts.get(kind, 0) for kind in _REQUIREMENTS}
    test_file_entries = sum(_is_standard_node_test_entry(path) for path, _ in entries)
    javascript_test_file_entries = sum(
        _is_standard_node_test_entry(path)
        and PurePosixPath(path).suffix.lower() in _JS_SUFFIXES
        for path, _ in entries
    )
    entry_reports = [
        _entry_report(path, suite, requirement)
        for (path, suite), requirement in zip(entries, requirements)
    ]
    runnable_inventory = {
        "total": len(requirements),
        "node_test_file_entries": test_file_entries,
        "javascript_test_file_entries": javascript_test_file_entries,
        "special_layout_entries": len(requirements) - test_file_entries,
        "entries": entry_reports,
    }
    return {
        "total": len(requirements),
        "test_file_entries": test_file_entries,
        "javascript_test_file_entries": javascript_test_file_entries,
        "special_layout_entries": len(requirements) - test_file_entries,
        "counts": ordered_counts,
        "requirements": [
            {
                **asdict(requirement),
                "proof_category": requirement.kind,
            }
            for requirement in _REQUIREMENTS.values()
        ],
        "runnable_inventory": runnable_inventory,
        "proof_coverage": {
            "categorized_entries": sum(
                bool(entry["proof_category"] and entry["runner"] and entry["proof"])
                for entry in entry_reports
            ),
            "entries_without_proof": sum(
                not (entry["proof_category"] and entry["runner"] and entry["proof"])
                for entry in entry_reports
            ),
        },
    }


def source_test_inventory(node_repo: Path) -> dict[str, int]:
    """Count Node's source test-file convention, including excluded support files."""

    test_root = node_repo / "test"
    files = [path for path in test_root.rglob("*") if path.is_file()]
    test_files = [path for path in files if path.name.startswith("test-")]
    javascript = [path for path in test_files if path.suffix.lower() in _JS_SUFFIXES]
    return {
        "test_files": len(test_files),
        "javascript_test_files": len(javascript),
        "source_test_files": len(test_files),
        "source_javascript_test_files": len(javascript),
    }
