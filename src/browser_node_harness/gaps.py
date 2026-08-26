"""Gap formation: translate failure evidence into finite, buildable work cards.

The scheduler hands agents failing tests and asks them to infer the feature
behind the failure. This module inverts that: it derives named capability
gaps (missing API symbols, missing argument validation, native addons that
need a WASM replacement, network egress that needs the proxy) and splits them
into bounded cards whose acceptance set is a sample of the affected tests.
"""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

from .scope import classify_test_path
from .surface import SurfaceGap

MISSING_API = "missing-api"
MISSING_VALIDATION = "missing-validation"
NATIVE_ADDON_WASM = "native-addon-wasm"
HOST_NETWORK = "host-network"
GAP_KINDS = (MISSING_API, MISSING_VALIDATION, NATIVE_ADDON_WASM, HOST_NETWORK)

_MAX_SYMBOLS_PER_CARD = 8
_MAX_ACCEPTANCE_TESTS = 10
_MAX_AFFECTED_STORED = 50
_MAX_EXEMPLAR_LINES = 40

_NOT_A_FUNCTION_RE = re.compile(r"([\w$.]+) is not a function")
_UNDEFINED_MEMBER_RE = re.compile(r"Cannot read propert(?:y|ies) of undefined \(reading '(\w+)'\)")
_VALIDATION_CODE_RE = re.compile(r"\b(ERR_INVALID_ARG_TYPE|ERR_MISSING_ARGS|ERR_OUT_OF_RANGE|ERR_INVALID_ARG_VALUE)\b")

# Modules that almost every test imports; they never identify a failure domain.
_GENERIC_MODULES = frozenset({"assert", "internal", "test", "util"})

_NETWORK_MODULES = frozenset({"http", "https", "net", "tls", "dns", "http2", "dgram", "fetch"})

_NATIVE_SOURCE_SUFFIXES = (".cc", ".c", ".cpp", ".h")
_NAPI_SYMBOL_RE = re.compile(r"\b(napi_\w+)\b")
_NODE_SYMBOL_RE = re.compile(r"\bnode::(\w+)")
_V8_SYMBOL_RE = re.compile(r"\bv8::(\w+)")

# Ordered prefix table mapping N-API symbols to the family an agent can
# implement as one bounded card. The last match wins via first-match on the
# ordered list below; unmatched symbols land in "misc".
_NAPI_FAMILIES: tuple[tuple[str, tuple[str, ...]], ...] = (
    # strings must precede values: napi_get_value_string_* would otherwise be
    # claimed by the broader napi_get_value_ prefix.
    (
        "strings",
        ("napi_create_string_", "napi_get_value_string_"),
    ),
    (
        "values",
        (
            "napi_get_boolean", "napi_get_value_", "napi_create_double", "napi_create_int32",
            "napi_create_uint32", "napi_create_int64", "napi_create_uint64", "napi_create_bigint_",
            "napi_get_undefined", "napi_get_null", "napi_get_global", "napi_get_version",
            "napi_typeof", "napi_is_array", "napi_instanceof", "napi_strict_equals",
            "napi_get_last_error", "napi_get_uv_event_loop",
        ),
    ),
    (
        "objects",
        (
            "napi_create_object", "napi_set_named_property", "napi_get_named_property",
            "napi_has_named_property", "napi_delete_property", "napi_set_property",
            "napi_get_property", "napi_has_property", "napi_get_property_names",
            "napi_define_properties", "napi_object_freeze", "napi_object_seal",
            "napi_get_prototype", "napi_set_element", "napi_get_element",
            "napi_has_element", "napi_delete_element",
        ),
    ),
    (
        "arrays-buffers",
        (
            "napi_create_array", "napi_get_array_length", "napi_create_typedarray",
            "napi_get_typedarray_info", "napi_create_dataview", "napi_get_dataview_info",
            "napi_is_typedarray", "napi_is_dataview", "napi_get_arraybuffer_info",
            "napi_create_arraybuffer", "napi_detach_arraybuffer", "napi_is_detached_arraybuffer",
            "napi_create_buffer", "napi_create_external_buffer", "napi_create_buffer_copy",
            "napi_get_buffer_info", "napi_is_buffer",
        ),
    ),
    (
        "functions",
        (
            "napi_create_function", "napi_get_cb_info", "napi_call_function",
            "napi_get_new_target", "napi_new_instance",
        ),
    ),
    (
        "errors",
        (
            "napi_throw", "napi_create_error", "napi_create_type_error",
            "napi_create_range_error", "napi_is_error", "napi_fatal_error",
            "napi_fatal_exception",
        ),
    ),
    (
        "references-lifetimes",
        (
            "napi_create_reference", "napi_delete_reference", "napi_ref", "napi_unref",
            "napi_get_reference_value", "napi_add_finalizer", "napi_wrap", "napi_unwrap",
            "napi_remove_wrap", "napi_type_tag_object", "napi_check_object_type_tag",
        ),
    ),
    (
        "promises-async",
        (
            "napi_create_promise", "napi_resolve_deferred", "napi_reject_deferred",
            "napi_is_promise", "napi_create_async_work", "napi_delete_async_work",
            "napi_queue_async_work", "napi_async_init", "napi_async_destroy",
            "napi_make_callback", "napi_open_callback_scope", "napi_close_callback_scope",
        ),
    ),
    (
        "env-scopes",
        (
            "napi_open_handle_scope", "napi_close_handle_scope",
            "napi_open_escapable_handle_scope", "napi_close_escapable_handle_scope",
            "napi_escape_handle", "napi_get_instance_data", "napi_set_instance_data",
            "napi_adjust_external_memory", "napi_run_script", "napi_get_date_value",
            "napi_create_date", "napi_is_date", "napi_create_external",
            "napi_get_value_external",
        ),
    ),
)


def napi_family(symbol: str) -> str:
    for family, prefixes in _NAPI_FAMILIES:
        if symbol.startswith(prefixes):
            return family
    return "misc"


def normalize_module(name: str) -> str:
    return name.removeprefix("node:").split("/", 1)[0]


def gap_id_for(kind: str, module: str, symbols: Sequence[str]) -> str:
    digest = hashlib.sha256(
        f"{kind}:{module}:{'|'.join(symbols)}".encode()
    ).hexdigest()
    return digest[:12]


@dataclass(slots=True)
class FailureEvidence:
    """One non-passing test with its latest canonical target output."""

    path: str
    suite: str
    modules: tuple[str, ...]
    status: str
    size_bytes: int
    stderr: str

    @property
    def normalized_modules(self) -> tuple[str, ...]:
        return tuple(normalize_module(name) for name in self.modules)

    @property
    def specific_module(self) -> str | None:
        return next(
            (name for name in self.normalized_modules if name not in _GENERIC_MODULES),
            None,
        )

    @property
    def is_native(self) -> bool:
        return classify_test_path(self.path, self.suite).kind in {"native_addon", "native_api"}

    @property
    def is_internet(self) -> bool:
        return self.suite == "internet"


def classify_stderr(stderr: str) -> dict[str, tuple[str, ...]]:
    """Extract symbol-shaped evidence from one failure's stderr."""

    missing_calls = tuple(
        dict.fromkeys(match.group(1) for match in _NOT_A_FUNCTION_RE.finditer(stderr))
    )
    undefined_members = tuple(
        dict.fromkeys(_UNDEFINED_MEMBER_RE.findall(stderr))
    )
    validation_codes = tuple(
        dict.fromkeys(_VALIDATION_CODE_RE.findall(stderr))
    )
    return {
        "missing_calls": missing_calls,
        "undefined_members": undefined_members,
        "validation_codes": validation_codes,
    }


@dataclass(slots=True)
class Gap:
    gap_id: str
    kind: str
    module: str
    symbols: tuple[str, ...]
    affected_count: int
    affected_paths: tuple[str, ...] = ()
    acceptance_paths: tuple[str, ...] = ()
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_row(self) -> dict[str, Any]:
        return {
            "id": self.gap_id,
            "kind": self.kind,
            "module": self.module,
            "symbols": list(self.symbols),
            "affected_count": self.affected_count,
            "affected_paths": list(self.affected_paths),
            "acceptance_paths": list(self.acceptance_paths),
            "evidence": self.evidence,
        }

    @staticmethod
    def from_row(row: dict[str, Any]) -> "Gap":
        return Gap(
            gap_id=str(row["id"]),
            kind=str(row["kind"]),
            module=str(row["module"]),
            symbols=tuple(row.get("symbols", ())),
            affected_count=int(row.get("affected_count", 0)),
            affected_paths=tuple(row.get("affected_paths", ())),
            acceptance_paths=tuple(row.get("acceptance_paths", ())),
            evidence=dict(row.get("evidence", {})),
        )


def _chunk(items: Sequence[str], limit: int) -> list[tuple[str, ...]]:
    return [tuple(items[i : i + limit]) for i in range(0, len(items), limit)]


def _acceptance(rows: Sequence[FailureEvidence]) -> tuple[str, ...]:
    # pseudo-tty/message suites need different runners entirely; a module
    # import alone must not place them in another module's acceptance set.
    eligible = [
        row
        for row in rows
        if row.suite not in {"pseudo-tty", "message"}
    ]
    smallest = sorted(eligible, key=lambda row: (row.size_bytes, row.path))
    return tuple(row.path for row in smallest[:_MAX_ACCEPTANCE_TESTS])


def _exemplar_stderr(rows: Sequence[FailureEvidence]) -> str:
    smallest = min(rows, key=lambda row: (row.size_bytes, row.path), default=None)
    if smallest is None or not smallest.stderr:
        return ""
    lines = smallest.stderr.splitlines()
    if len(lines) > _MAX_EXEMPLAR_LINES:
        half = _MAX_EXEMPLAR_LINES // 2
        lines = lines[:half] + [f"... <{len(lines) - 2 * half} lines omitted> ..."] + lines[-half:]
    return "\n".join(lines)


def _split_symbols(symbols: Iterable[str]) -> list[tuple[str, ...]]:
    unique = tuple(dict.fromkeys(symbols))
    return _chunk(unique, _MAX_SYMBOLS_PER_CARD)


def form_missing_api_gaps(
    surface_gaps: Sequence[SurfaceGap],
    rows: Sequence[FailureEvidence],
) -> list[Gap]:
    # Generic modules (assert, util, …) are imported by nearly every test, so
    # module membership cannot attribute failures to them; only stderr symbol
    # evidence claims rows there. Everything else may use module membership.
    by_module: dict[str, list[FailureEvidence]] = defaultdict(list)
    for row in rows:
        for module in row.normalized_modules:
            if module not in _GENERIC_MODULES:
                by_module[module].append(row)

    gaps: list[Gap] = []
    # Deterministic module ordering keeps gap ids and emission stable.
    for surface_gap in sorted(surface_gaps, key=lambda gap: gap.module):
        # Gap identity keeps the subpath builtin (fs/promises); evidence
        # attribution collapses subpaths, so join via the root module name.
        module = surface_gap.module
        affected = list(by_module.get(normalize_module(module), []))
        affected_paths = {row.path for row in affected}
        # Tests that never imported the module by name can still surface its
        # absence through helpers; a stderr symbol match claims them.
        missing_names = {symbol.rsplit(".", 1)[-1] for symbol in surface_gap.missing}
        for row in rows:
            if row.path in affected_paths:
                continue
            evidence = classify_stderr(row.stderr)
            # stderr reports qualified chains ("fs.chmodSync is not a
            # function"); surface symbols are bare exports ("chmodSync").
            call_leafs = {call.rsplit(".", 1)[-1] for call in evidence["missing_calls"]}
            touched = (call_leafs & missing_names) | (
                set(evidence["undefined_members"]) & missing_names
            )
            if touched:
                affected.append(row)
        if not affected:
            # Surface hole without failing-test evidence yet: still a real
            # gap, ranked at the bottom by its zero affected count.
            for family in _split_symbols(surface_gap.missing):
                gaps.append(
                    Gap(
                        gap_id=gap_id_for(MISSING_API, module, family),
                        kind=MISSING_API,
                        module=module,
                        symbols=family,
                        affected_count=0,
                        evidence={"load_error": surface_gap.load_error},
                    )
                )
            continue
        for family in _split_symbols(surface_gap.missing):
            gaps.append(
                Gap(
                    gap_id=gap_id_for(MISSING_API, module, family),
                    kind=MISSING_API,
                    module=module,
                    symbols=family,
                    affected_count=len(affected),
                    affected_paths=tuple(row.path for row in affected[:_MAX_AFFECTED_STORED]),
                    acceptance_paths=_acceptance(affected),
                    evidence={
                        "load_error": surface_gap.load_error,
                        "exemplar_stderr": _exemplar_stderr(affected),
                    },
                )
            )
    return gaps


def form_missing_validation_gaps(
    rows: Sequence[FailureEvidence],
    missing_api_gaps: Sequence[Gap],
) -> list[Gap]:
    # A module whose symbols are outright missing reports validation failures
    # too once partially implemented; do not double-book those tests.
    missing_symbols_by_module: dict[str, set[str]] = defaultdict(set)
    for gap in missing_api_gaps:
        for symbol in gap.symbols:
            missing_symbols_by_module[gap.module].add(symbol.rsplit(".", 1)[-1])

    by_module: dict[str, list[tuple[FailureEvidence, tuple[str, ...]]]] = defaultdict(list)
    for row in rows:
        if row.is_native or row.is_internet:
            continue
        evidence = classify_stderr(row.stderr)
        if not evidence["validation_codes"]:
            continue
        module = row.specific_module
        if module is None:
            continue
        blocked = missing_symbols_by_module.get(module, set())
        if set(evidence["missing_calls"]) & blocked:
            continue
        by_module[module].append((row, evidence["validation_codes"]))

    gaps: list[Gap] = []
    for module, entries in sorted(by_module.items()):
        affected = [row for row, _ in entries]
        codes = tuple(sorted({code for _, found in entries for code in found}))
        gaps.append(
            Gap(
                gap_id=gap_id_for(MISSING_VALIDATION, module, codes),
                kind=MISSING_VALIDATION,
                module=module,
                symbols=codes,
                affected_count=len(affected),
                affected_paths=tuple(row.path for row in affected[:_MAX_AFFECTED_STORED]),
                acceptance_paths=_acceptance(affected),
                evidence={"exemplar_stderr": _exemplar_stderr(affected)},
            )
        )
    return gaps


def _scan_native_symbols(node_repo: Path, rows: Sequence[FailureEvidence]) -> dict[str, dict[str, int]]:
    """Histogram napi/node/v8 symbols across the addon sources of failing tests.

    Counts are per addon directory (a symbol used by five addons counts five
    times) so heavily shared API families surface first.
    """

    histogram: dict[str, defaultdict[str, int]] = {
        "napi": defaultdict(int),
        "node": defaultdict(int),
        "v8": defaultdict(int),
    }
    scanned_dirs: set[Path] = set()
    for row in rows:
        addon_dir = node_repo / Path(row.path).parent
        if addon_dir in scanned_dirs or not addon_dir.is_dir():
            continue
        scanned_dirs.add(addon_dir)
        per_addon: dict[str, set[str]] = {"napi": set(), "node": set(), "v8": set()}
        for source_path in sorted(addon_dir.rglob("*")):
            if source_path.suffix not in _NATIVE_SOURCE_SUFFIXES or not source_path.is_file():
                continue
            text = source_path.read_text(encoding="utf-8", errors="replace")
            per_addon["napi"].update(_NAPI_SYMBOL_RE.findall(text))
            per_addon["node"].update(f"node::{name}" for name in _NODE_SYMBOL_RE.findall(text))
            per_addon["v8"].update(f"v8::{name}" for name in _V8_SYMBOL_RE.findall(text))
        for family, symbols in per_addon.items():
            for symbol in symbols:
                histogram[family][symbol] += 1
    return histogram


def form_native_gaps(
    rows: Sequence[FailureEvidence],
    node_repo: Path,
) -> list[Gap]:
    native_rows = [row for row in rows if row.is_native]
    if not native_rows:
        return []
    histogram = _scan_native_symbols(node_repo, native_rows)

    gaps: list[Gap] = []
    for api, symbols in histogram.items():
        by_family: dict[str, list[str]] = defaultdict(list)
        for symbol, usage in symbols.items():
            family = napi_family(symbol) if api == "napi" else api
            by_family[family].append((symbol, usage))
        for family, entries in sorted(by_family.items()):
            entries.sort(key=lambda item: (-item[1], item[0]))
            family_symbols = tuple(symbol for symbol, _ in entries)
            usage = {symbol: count for symbol, count in entries}
            # Per-test family attribution needs per-addon symbol sets in the
            # histogram; v1 books every native failure against each family it
            # still needs overall, which is honest for ranking.
            gaps.append(
                Gap(
                    gap_id=gap_id_for(NATIVE_ADDON_WASM, f"{api}:{family}", family_symbols),
                    kind=NATIVE_ADDON_WASM,
                    module=f"{api}:{family}",
                    symbols=family_symbols,
                    affected_count=len(native_rows),
                    affected_paths=tuple(row.path for row in native_rows[:_MAX_AFFECTED_STORED]),
                    acceptance_paths=_acceptance(native_rows),
                    evidence={
                        "usage": usage,
                        "addon_count": len({Path(row.path).parent for row in native_rows}),
                    },
                )
            )
    return gaps


def form_host_network_gaps(rows: Sequence[FailureEvidence]) -> list[Gap]:
    gaps: list[Gap] = []
    internet_rows = [row for row in rows if row.is_internet]
    if internet_rows:
        gaps.append(
            Gap(
                gap_id=gap_id_for(HOST_NETWORK, "internet", ("proxy-egress",)),
                kind=HOST_NETWORK,
                module="internet",
                symbols=("proxy-egress",),
                affected_count=len(internet_rows),
                affected_paths=tuple(row.path for row in internet_rows[:_MAX_AFFECTED_STORED]),
                acceptance_paths=_acceptance(internet_rows),
                evidence={"exemplar_stderr": _exemplar_stderr(internet_rows)},
            )
        )
    timeouts_by_module: dict[str, list[FailureEvidence]] = defaultdict(list)
    for row in rows:
        if row.status != "timeout" or row.is_native:
            continue
        for module in row.normalized_modules:
            if module in _NETWORK_MODULES:
                timeouts_by_module[module].append(row)
    for module, module_rows in sorted(timeouts_by_module.items()):
        gaps.append(
            Gap(
                gap_id=gap_id_for(HOST_NETWORK, module, ("egress-timeout",)),
                kind=HOST_NETWORK,
                module=module,
                symbols=("egress-timeout",),
                affected_count=len(module_rows),
                affected_paths=tuple(row.path for row in module_rows[:_MAX_AFFECTED_STORED]),
                acceptance_paths=_acceptance(module_rows),
            )
        )
    return gaps


def rank_gaps(gaps: Iterable[Gap]) -> list[Gap]:
    return sorted(
        gaps,
        key=lambda gap: (-gap.affected_count, gap.kind, gap.module, gap.gap_id),
    )


def form_gaps(
    surface_gaps: Sequence[SurfaceGap],
    rows: Sequence[FailureEvidence],
    node_repo: Path,
) -> list[Gap]:
    missing_api = form_missing_api_gaps(surface_gaps, rows)
    validation = form_missing_validation_gaps(rows, missing_api)
    native = form_native_gaps(rows, node_repo)
    network = form_host_network_gaps(rows)
    return rank_gaps([*missing_api, *validation, *native, *network])
