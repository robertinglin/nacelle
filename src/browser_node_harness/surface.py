"""API surface probing: what the oracle Node exports versus the browser runtime.

A failing upstream test is a symptom, not a specification. The surface diff
turns "many tests fail in module X" into a named, buildable gap: the exact
symbols the oracle exports that the browser runtime does not. The same probe
source runs through the oracle adapter (host Node) and the target adapter
(browser runtime), so both sides report identical evidence.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .config import CommandConfig
from .models import TestCase
from .runner import TestRunner

# The marker survives adapter noise around stdout and is unique enough that a
# test bundle cannot produce it accidentally.
_MARKER = "__BNH_SURFACE_JSON__"
_MARKER_RE = re.compile(
    re.escape(_MARKER) + r"(\[.*?\])" + re.escape(_MARKER),
    re.DOTALL,
)

# Chunking keeps one probe's JSON well below the adapter output cap even for
# symbol-heavy modules such as http or fs.
_CHUNK_SIZE = 6


class SurfaceProbeError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class ModuleSurface:
    symbols: tuple[str, ...] = ()
    load_error: str = ""


@dataclass(frozen=True, slots=True)
class SurfaceGap:
    module: str
    missing: tuple[str, ...]
    # Set when the target fails to load the module at all; then `missing` is
    # the complete oracle surface for that module.
    load_error: str = ""


def _probe_body(payload_expression: str) -> str:
    return (
        "process.stdout.write("
        + json.dumps(_MARKER)
        + " + "
        + payload_expression
        + " + "
        + json.dumps(_MARKER)
        + ' + "\\n");\n'
    )


def module_list_source() -> str:
    """Probe that reports the builtin module list exactly as the runtime sees it."""

    # builtinModules is frozen on modern Node; copy before sorting.
    return _probe_body(
        'JSON.stringify(Array.from(require("module").builtinModules).sort())'
    )


def surface_probe_source(modules: Sequence[str]) -> str:
    """Probe that reports every exported symbol of each given module.

    For each export the probe records own property names, plus the complete
    prototype chain for exported constructors so subclassed implementations
    (`fs.ReadStream.prototype.read`) count as part of the surface.
    """

    module_list = json.dumps(list(modules))
    return (
        "const modules = " + module_list + ";\n"
        "const out = [];\n"
        "const symbolLabel = (symbol) => {\n"
        "  const globalKey = Symbol.keyFor(symbol);\n"
        "  if (globalKey !== undefined) return '[Symbol.for(' + JSON.stringify(globalKey) + ')]';\n"
        "  return '[Symbol(' + String(symbol.description || '') + ')]';\n"
        "};\n"
        "const publicSymbols = new Set(Object.getOwnPropertyNames(Symbol)\n"
        "  .filter((name) => !['length', 'name', 'prototype', 'for', 'keyFor'].includes(name))\n"
        "  .map((name) => Symbol[name]).filter((value) => typeof value === 'symbol'));\n"
        "const isPublicSymbol = (symbol) => publicSymbols.has(symbol)\n"
        "  || new Set(['nodejs.dispose', 'nodejs.asyncDispose', 'nodejs.util.inspect.custom'])\n"
        "    .has(Symbol.keyFor(symbol));\n"
        "for (const name of modules) {\n"
        "  const entry = { module: name, symbols: [], load_error: \"\" };\n"
        "  try {\n"
        "    const mod = require(name.startsWith(\"node:\") ? name : \"node:\" + name);\n"
        "    const own = Object.getOwnPropertyNames(mod).sort();\n"
        "    for (const key of own) {\n"
        "      entry.symbols.push(key);\n"
        "      let value;\n"
        "      try { value = mod[key]; } catch { continue; }\n"
        "      if (value && (typeof value === \"function\" || typeof value === \"object\")) {\n"
        "        const seenMembers = new Set();\n"
        "        let prototype = typeof value === \"function\" ? value.prototype : Object.getPrototypeOf(value);\n"
        "        while (prototype && prototype !== Object.prototype) {\n"
        "          for (const member of [\n"
        "            ...Object.getOwnPropertyNames(prototype),\n"
        "            ...Object.getOwnPropertySymbols(prototype).filter(isPublicSymbol),\n"
        "          ]) {\n"
        "            const memberName = typeof member === \"symbol\" ? symbolLabel(member) : member;\n"
        "            if (memberName !== \"constructor\" && !seenMembers.has(memberName)) {\n"
        "              seenMembers.add(memberName);\n"
        "              entry.symbols.push(key + \".\" + memberName);\n"
        "            }\n"
        "          }\n"
        "          prototype = Object.getPrototypeOf(prototype);\n"
        "        }\n"
        "      }\n"
        "    }\n"
        "    for (const symbol of Object.getOwnPropertySymbols(mod).filter(isPublicSymbol).sort((a, b) => symbolLabel(a).localeCompare(symbolLabel(b)))) {\n"
        "      entry.symbols.push(symbolLabel(symbol));\n"
        "    }\n"
        "  } catch (error) {\n"
        "    entry.load_error = String((error && error.code) || (error && error.message) || error);\n"
        "  }\n"
        "  out.push(entry);\n"
        "}\n"
        + _probe_body("JSON.stringify(out)")
    )


def parse_probe_payload(stdout: str) -> list:
    match = _MARKER_RE.search(stdout)
    if match is None:
        raise SurfaceProbeError("surface probe output has no JSON marker")
    try:
        payload = json.loads(match.group(1))
    except json.JSONDecodeError as exc:
        raise SurfaceProbeError(f"surface probe JSON is truncated or invalid: {exc}") from exc
    if not isinstance(payload, list):
        raise SurfaceProbeError("surface probe payload is not a list")
    return payload


def _run_probe(
    runner: TestRunner,
    *,
    spec: CommandConfig,
    worktree: Path,
    source: str,
    probe_name: str,
    run_id: str,
):
    case = TestCase(
        path=f".bnh/surface/{probe_name}.js",
        suite="bnh-surface",
        source_sha256=hashlib.sha256(source.encode()).hexdigest(),
        modules=("module",),
        source_override=source,
    )
    return runner.run_one(
        case,
        spec=spec,
        worktree=worktree,
        phase="surface-probe",
        run_id=run_id,
    )


def list_builtin_modules(
    runner: TestRunner,
    *,
    spec: CommandConfig,
    worktree: Path,
    run_id: str,
) -> tuple[str, ...]:
    result = _run_probe(
        runner,
        spec=spec,
        worktree=worktree,
        source=module_list_source(),
        probe_name="module-list",
        run_id=run_id,
    )
    if result.status != "pass":
        raise SurfaceProbeError(
            f"builtin-module list probe failed ({result.status}): {result.stderr[-800:]}"
        )
    payload = parse_probe_payload(result.stdout)
    if not payload or not all(isinstance(name, str) for name in payload):
        raise SurfaceProbeError("builtin-module list probe returned malformed data")
    return tuple(payload)


def _probe_chunk(
    runner: TestRunner,
    *,
    spec: CommandConfig,
    worktree: Path,
    chunk: tuple[str, ...],
    probe_name: str,
    run_id: str,
) -> dict[str, ModuleSurface]:
    source = surface_probe_source(chunk)
    result = _run_probe(
        runner,
        spec=spec,
        worktree=worktree,
        source=source,
        probe_name=probe_name,
        run_id=run_id,
    )
    if result.status != "pass":
        raise SurfaceProbeError(
            f"surface probe for {list(chunk)} failed ({result.status}): {result.stderr[-800:]}"
        )
    entries = parse_probe_payload(result.stdout)
    reported = {str(entry.get("module", "")) for entry in entries}
    missing_from_chunk = [name for name in chunk if name not in reported]
    if missing_from_chunk:
        raise SurfaceProbeError(
            f"surface probe for {list(chunk)} omitted modules: {missing_from_chunk}"
        )
    return {
        str(entry["module"]): ModuleSurface(
            symbols=tuple(str(symbol) for symbol in entry.get("symbols", [])),
            load_error=str(entry.get("load_error") or ""),
        )
        for entry in entries
    }


def run_surface_probe(
    runner: TestRunner,
    *,
    spec: CommandConfig,
    worktree: Path,
    modules: Sequence[str],
    run_id: str,
) -> dict[str, ModuleSurface]:
    surfaces: dict[str, ModuleSurface] = {}
    for index in range(0, len(modules), _CHUNK_SIZE):
        chunk = tuple(sorted(modules[index : index + _CHUNK_SIZE]))
        try:
            surfaces.update(
                _probe_chunk(
                    runner,
                    spec=spec,
                    worktree=worktree,
                    chunk=chunk,
                    probe_name=f"symbols-{index // _CHUNK_SIZE}",
                    run_id=run_id,
                )
            )
            continue
        except SurfaceProbeError:
            # One hanging or crashing module must not sink the whole
            # worklist; retry the chunk's modules one at a time and record
            # persistent failures as load errors.
            pass
        for name in chunk:
            try:
                surfaces.update(
                    _probe_chunk(
                        runner,
                        spec=spec,
                        worktree=worktree,
                        chunk=(name,),
                        probe_name=f"single-{name.replace('/', '_')}",
                        run_id=run_id,
                    )
                )
            except SurfaceProbeError as exc:
                surfaces[name] = ModuleSurface(load_error=f"probe failed: {exc}"[:300])
    return surfaces


def diff_surfaces(
    expected: dict[str, ModuleSurface],
    actual: dict[str, ModuleSurface],
) -> list[SurfaceGap]:
    """Report oracle symbols the target surface lacks, module by module."""

    gaps: list[SurfaceGap] = []
    for module in sorted(expected):
        oracle_surface = expected[module]
        target_surface = actual.get(module)
        if target_surface is None:
            continue
        if target_surface.load_error and not oracle_surface.load_error:
            gaps.append(
                SurfaceGap(
                    module=module,
                    missing=oracle_surface.symbols,
                    load_error=target_surface.load_error,
                )
            )
            continue
        target_symbols = set(target_surface.symbols)
        missing = tuple(
            symbol for symbol in oracle_surface.symbols if symbol not in target_symbols
        )
        if missing:
            gaps.append(SurfaceGap(module=module, missing=missing))
    return gaps


def surfaces_to_json(surfaces: dict[str, ModuleSurface]) -> str:
    return json.dumps(
        {
            name: {"symbols": list(surface.symbols), "load_error": surface.load_error}
            for name, surface in sorted(surfaces.items())
        }
    )


def surfaces_from_json(raw: str) -> dict[str, ModuleSurface]:
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise SurfaceProbeError("stored surface JSON is not an object")
    return {
        str(name): ModuleSurface(
            symbols=tuple(entry.get("symbols", [])),
            load_error=str(entry.get("load_error") or ""),
        )
        for name, entry in data.items()
    }
