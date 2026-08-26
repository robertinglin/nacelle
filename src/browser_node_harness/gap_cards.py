"""Emission of gap task cards: finite, spec-first work for coding agents.

Each card is a self-contained directory: the prompt names the capability to
build, copies Node's own implementation as the reference spec, and lists a
bounded acceptance set drawn from the affected failing tests. Agents build the
capability; the tests verify it, not define it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Sequence

from .gaps import Gap, MISSING_VALIDATION, NATIVE_ADDON_WASM

_CONSTRAINTS = """\
## Constraints

- Do not modify, weaken, skip, or special-case the upstream tests.
- Do not hard-code test filenames, expected outputs, or harness markers.
- The implementation stays browser-native: no host-Node fallback, no remote execution.
- Extend the shared runtime in `runtime.js` / `runtime/` rather than adding a parallel layer.
- Keep unrelated passing behavior unchanged.
"""


def _reference_files(gap: Gap, node_repo: Path) -> list[Path]:
    if gap.kind == NATIVE_ADDON_WASM:
        files: list[Path] = []
        for test_path in gap.acceptance_paths:
            addon_dir = node_repo / Path(test_path).parent
            if not addon_dir.is_dir():
                continue
            for candidate in sorted(addon_dir.rglob("*")):
                if candidate.suffix in {".cc", ".c", ".cpp", ".h", ".gyp"} and candidate.is_file():
                    files.append(candidate)
        return files[:40]
    files = []
    lib = node_repo / "lib" / f"{gap.module}.js"
    if lib.is_file():
        files.append(lib)
    if gap.kind == MISSING_VALIDATION:
        validators = node_repo / "lib" / "internal" / "validators.js"
        if validators.is_file():
            files.append(validators)
    return files


def _acceptance_files(gap: Gap, node_repo: Path) -> list[tuple[Path, Path]]:
    """Return (source, destination) pairs for the acceptance test copies."""

    copies: list[tuple[Path, Path]] = []
    for test_path in gap.acceptance_paths:
        source = node_repo / test_path
        if source.is_file():
            copies.append((source, Path("acceptance") / Path(test_path).name))
    return copies


def _prompt_for(gap: Gap, *, config_path: Path, repro_paths: Sequence[str]) -> str:
    symbols = "\n".join(f"- {symbol}" for symbol in gap.symbols) or "- (see evidence)"
    acceptance = "\n".join(f"- {path}" for path in gap.acceptance_paths) or "- (none selected)"
    repro = " ".join(repro_paths)
    objective = {
        "missing-api": (
            f"Implement the missing `{gap.module}` API surface in the browser runtime. "
            "Node's own implementation (copied under `reference/`) is the specification: "
            "match observable behavior, error codes, and argument validation."
        ),
        "missing-validation": (
            f"Add Node-accurate argument validation to `{gap.module}` in the browser runtime. "
            "Mirror `lib/internal/validators.js` (copied under `reference/`) so invalid "
            "arguments raise the same error codes, messages, and order as Node."
        ),
        "native-addon-wasm": (
            "Replace native addon code with a WASM equivalent. Build the host-side wasm32 "
            "compile pipeline (emsdk under .bnh-state/toolchains) and/or extend the runtime's "
            "WASM N-API import layer (`runtime/addon-napi.js`) for this API family. The "
            "usage histogram in `task.json` shows which symbols failing addons actually use."
        ),
        "host-network": (
            "Route this module's network egress through the harness proxy capability "
            "(`runtime/proxy.js` contract, host daemon relay) instead of relying on "
            "host sockets the browser cannot open."
        ),
    }.get(gap.kind, f"Close the {gap.kind} gap in module `{gap.module}`.")

    evidence_block = ""
    exemplar = str(gap.evidence.get("exemplar_stderr") or "")
    if exemplar:
        evidence_block = f"""\
## Evidence: representative failing stderr

```text
{exemplar}
```
"""
    usage = gap.evidence.get("usage")
    usage_block = ""
    if isinstance(usage, dict) and usage:
        usage_lines = "\n".join(
            f"- {symbol}: used by {count} failing addon(s)"
            for symbol, count in sorted(usage.items(), key=lambda item: -item[1])
        )
        usage_block = f"""\
## Symbol usage across failing addons

{usage_lines}
"""
    load_error = str(gap.evidence.get("load_error") or "")
    load_block = (
        f"\nThe target currently fails to load this module at all: `{load_error}`\n"
        if load_error
        else ""
    )

    return f"""\
# Build task: {gap.kind} — {gap.module} (gap {gap.gap_id})

## Objective

{objective}
{load_block}
## Symbols ({len(gap.symbols)})

{symbols}

## Reference specification

Node's implementation is copied under `reference/` in this card when it exists
in the Node checkout (`lib/{gap.module}.js`). Where the file is missing, treat
the acceptance tests' usage as the behavioral contract.

## Acceptance tests ({len(gap.acceptance_paths)} of {gap.affected_count} affected)

These are downstream evidence, not the spec. They are copied under `acceptance/`.

{acceptance}

Reproduce from the harness repository:

```bash
bnh --config {config_path} test {repro}
```

Run them against your candidate worktree with `--worktree <path>`.

{_CONSTRAINTS}
{usage_block}{evidence_block}
## Finish condition

State the root cause, the subsystem changed, and the exact acceptance tests you
ran with their before/after status.
"""


def emit_gap_cards(
    gaps: Sequence[Gap],
    out_dir: Path,
    *,
    node_repo: Path,
    config_path: Path,
) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    emitted: list[Path] = []
    for gap in gaps:
        card_dir = out_dir / f"gap-{gap.gap_id}"
        card_dir.mkdir(parents=True, exist_ok=True)
        repro_paths = list(gap.acceptance_paths) or list(gap.affected_paths[:3])
        (card_dir / "prompt.md").write_text(
            _prompt_for(gap, config_path=config_path, repro_paths=repro_paths),
            encoding="utf-8",
        )
        (card_dir / "task.json").write_text(
            json.dumps({**gap.to_row(), "config": str(config_path)}, indent=2, default=str),
            encoding="utf-8",
        )
        reference_dir = card_dir / "reference"
        for source in _reference_files(gap, node_repo):
            destination = reference_dir / source.relative_to(node_repo)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(source.read_bytes())
        for source, relative in _acceptance_files(gap, node_repo):
            destination = card_dir / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(source.read_bytes())
        emitted.append(card_dir)
    return emitted


def emit_worklist_index(
    gaps: Sequence[Gap],
    out_dir: Path,
) -> Path:
    """Write WORKLIST.md: the ranked entry point for the emitted cards."""

    out_dir.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Gap worklist",
        "",
        "Finite, spec-first build tasks derived from the surface diff and failure",
        "evidence. Work top-down; each card is self-contained.",
        "",
        "| rank | gap | kind | module | symbols | affected tests |",
        "|---|---|---|---|---|---|",
    ]
    for rank, gap in enumerate(gaps, start=1):
        lines.append(
            f"| {rank} | gap-{gap.gap_id} | {gap.kind} | {gap.module} "
            f"| {len(gap.symbols)} | {gap.affected_count} |"
        )
    native = [gap for gap in gaps if gap.kind == NATIVE_ADDON_WASM]
    if native:
        lines += [
            "",
            "## Native → WASM bootstrap",
            "",
            "Before the native cards can land, the toolchain must exist once:",
            "",
            "1. `git clone https://github.com/emscripten-core/emsdk.git .bnh-state/toolchains/emsdk`",
            "2. `.bnh-state/toolchains/emsdk/emsdk install latest && .bnh-state/toolchains/emsdk/emsdk activate latest`",
            "3. Compile one failing addon to wasm32 and load it through `runtime/addon-napi.js`.",
            "",
        ]
    index_path = out_dir / "WORKLIST.md"
    index_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return index_path
