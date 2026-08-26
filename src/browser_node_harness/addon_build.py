"""Host-side wasm32 build pipeline for Node native addons.

The browser runtime cannot dlopen native binaries. This module compiles the
Node-API addon sources of failing native tests to wasm32 with Emscripten and
writes a manifest mapping each expected ``build/Release/*.node`` path to its
wasm artifact. The Playwright adapter serves those artifacts at the virtual
.node paths (``BNH_ADDON_MANIFEST`` or ``<state_dir>/addon-manifest.json``)
and the runtime's WASM N-API layer instantiates them.
"""

from __future__ import annotations

import ast
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from .process import run_process
from .scope import classify_test_path

EMSDK_URL = "https://github.com/emscripten-core/emsdk.git"
NATIVE_SOURCE_SUFFIXES = (".cc", ".c", ".cpp")
CXX_SOURCE_SUFFIXES = (".cc", ".cpp")
_TARGET_NAME_RE = re.compile(r"target_name['\"]?\s*:\s*['\"]([\w.-]+)")
_LIBNODE_SHIM = Path(__file__).parent / "addon_shims" / "node_rtti_shim.cc"

# Emscripten resolves undefined napi_*/helpers as wasm imports; the runtime
# import layer implements them. The table export is what lets JS call addon
# callback pointers (Emscripten function pointers are table indices).
#
# v8config.h has no wasm32 branch and #errors out on unknown host arches; the
# IA32 macros are the accurate passthrough for wasm32 (32-bit pointers,
# little-endian) and only steer header-level feature detection.
#
# node_api.h gates newer functions (node_api_create_buffer_from_arraybuffer,
# node_api_post_finalizer, …) behind NAPI_VERSION >= 10.
_V8_WASM32_FLAGS = ("-D_M_IX86", "-DV8_TARGET_ARCH_IA32=1")
_EMCC_FLAGS = (
    "--no-entry",
    "-O1",
    "-DNAPI_VERSION=10",
    *_V8_WASM32_FLAGS,
    "-sALLOW_MEMORY_GROWTH=1",
    "-sERROR_ON_UNDEFINED_SYMBOLS=0",
    "-Wl,--export-table",
)
# node_api.h names its registration entry napi_register_wasm_v1 under
# __wasm__; older or manual sources may still use napi_register_module_v1.
# C++ node.h addons register through a constructor instead (exported as
# `_initialize`), so the last candidate exports no registration symbol.
_EMCC_EXPORT_CANDIDATES = (
    ("_napi_register_wasm_v1",),
    ("_napi_register_module_v1",),
    (),  # ctor-based registration via node_module_register
)
_REGISTRATION_EXPORTS = {"_napi_register_wasm_v1", "_napi_register_module_v1"}
# Reactor mode links a minimal runtime; C++ addons need RTTI and the libc++
# ABI for typeinfo identity.
_RTTI_FLAGS = ("-frtti", "-lc++abi", "-lc++")

Runner = Callable[..., object]


class AddonBuildError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class AddonArtifact:
    node: str  # repo-relative posix path the test requires
    wasm: Path  # compiled artifact
    entry: str = "napi"  # registration style: "napi" symbol or ctor-based


def toolchain_root(state_dir: Path) -> Path:
    return state_dir / "toolchains" / "emsdk"


def emcc_path(state_dir: Path) -> Path | None:
    candidate = toolchain_root(state_dir) / "upstream" / "emscripten" / "emcc"
    return candidate if candidate.is_file() else None


def _run(argv: Sequence[str], cwd: Path, env: dict[str, str] | None = None) -> object:
    merged = os.environ.copy()
    if env:
        merged.update(env)
    result = run_process(
        [str(item) for item in argv],
        cwd=cwd,
        env=merged,
        timeout_seconds=900,
        max_output_chars=200_000,
    )
    if result.exit_code != 0:
        tail = result.stderr[-2000:]
        raise AddonBuildError(f"{argv[0]} {argv[1] if len(argv) > 1 else ''} failed ({result.exit_code}): {tail}")
    return result


def bootstrap_emsdk(state_dir: Path, *, runner: Runner = _run) -> Path:
    """Clone, install, and activate emsdk once; return the emcc path."""

    # Absolute paths: emsdk runs with its own working directory, so a
    # relative state dir would nest the clone inside itself.
    state_dir = state_dir.resolve()
    root = toolchain_root(state_dir)
    if not (root / "emsdk").exists():
        root.parent.mkdir(parents=True, exist_ok=True)
        runner(["git", "clone", "--depth", "1", EMSDK_URL, str(root)], root.parent)
    # The repo ships a bash driver (`emsdk`) and a Python entry (`emsdk.py`);
    # prefer the Python one so the invocation does not depend on the shebang.
    emsdk_py = root / "emsdk.py"
    emsdk = [sys.executable, str(emsdk_py)] if emsdk_py.is_file() else [str(root / "emsdk")]
    runner([*emsdk, "install", "latest"], root)
    runner([*emsdk, "activate", "latest"], root)
    emcc = emcc_path(state_dir)
    if emcc is None:
        raise AddonBuildError(f"emsdk bootstrap finished but {toolchain_root(state_dir)}/upstream/emscripten/emcc is missing")
    return emcc


def addon_dir_for(node_repo: Path, test_path: str) -> Path | None:
    """The directory holding the addon sources for one native test.

    Node lays addons out as ``test/<suite>/<addon>/binding.gyp`` with the JS
    entry either inside that directory or one level below it.
    """

    test_dir = (node_repo / test_path).parent
    for directory in (test_dir, test_dir.parent):
        if directory == node_repo or node_repo not in directory.parents:
            break
        if (directory / "binding.gyp").is_file():
            return directory
    return None


def target_name(addon_dir: Path) -> str:
    match = _TARGET_NAME_RE.search((addon_dir / "binding.gyp").read_text(encoding="utf-8", errors="replace"))
    return match.group(1) if match else "binding"


def gyp_targets(addon_dir: Path) -> list[tuple[str, list[Path]]]:
    """One (target_name, sources) pair per gyp target.

    Some addon directories host several modules (js-native-api colocates
    test_null with test_string); compiling them together collides on the
    registration symbol, so each gyp target becomes its own wasm module.
    """

    gyp_path = addon_dir / "binding.gyp"
    if not gyp_path.is_file():
        return []
    try:
        # GYP files are Python-ish literals with # comments.
        stripped = "\n".join(
            line.split("#", 1)[0] for line in gyp_path.read_text(encoding="utf-8", errors="replace").splitlines()
        )
        data = ast.literal_eval(stripped)
        raw_targets = data.get("targets", []) if isinstance(data, dict) else []
    except (ValueError, SyntaxError):
        raw_targets = None
    if raw_targets is None:
        name = target_name(addon_dir)
        sources = sorted(
            path for path in addon_dir.rglob("*") if path.suffix in NATIVE_SOURCE_SUFFIXES and path.is_file()
        )
        return [(name, sources)] if sources else []
    targets: list[tuple[str, list[Path]]] = []
    for raw in raw_targets:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("target_name") or "binding")
        sources = [
            addon_dir / str(source)
            for source in raw.get("sources", [])
            if Path(str(source)).suffix in NATIVE_SOURCE_SUFFIXES
        ]
        sources = [path for path in sources if path.is_file()]
        if not sources:
            # Gyp files commonly place sources behind conditions
            # (node_use_openssl, OS checks, …). Fall back to every native
            # source in the directory for that target name.
            sources = sorted(
                path for path in addon_dir.rglob("*") if path.suffix in NATIVE_SOURCE_SUFFIXES and path.is_file()
            )
        if sources:
            targets.append((name, sorted(sources)))
    return targets


def expected_node_path(node_repo: Path, addon_dir: Path, name: str | None = None) -> str:
    module_name = name or target_name(addon_dir)
    return (addon_dir / "build" / "Release" / f"{module_name}.node").relative_to(
        node_repo
    ).as_posix()


def include_dirs(node_repo: Path) -> list[Path]:
    dirs = []
    for candidate in (
        node_repo / "deps" / "node_api" / "include",
        node_repo / "src",
        node_repo / "deps" / "v8" / "include",
        node_repo / "deps" / "uv" / "include",
        node_repo / "deps" / "sqlite",
        node_repo / "deps" / "openssl" / "openssl" / "include",
        node_repo / "deps" / "zlib",
    ):
        if candidate.is_dir():
            dirs.append(candidate)
    return dirs


def artifact_name(node_repo: Path, addon_dir: Path, target: str) -> str:
    return f"{addon_dir.relative_to(node_repo).as_posix().replace('/', '_')}_{target}"


def build_addon(
    emcc: Path,
    node_repo: Path,
    addon_dir: Path,
    out_dir: Path,
    *,
    name: str | None = None,
    sources: Sequence[Path] | None = None,
    runner: Runner = _run,
) -> AddonArtifact:
    """Compile one gyp target to a wasm32 module.

    Registration is attempted in three styles: the wasm-named N-API symbol,
    the classic N-API symbol, and finally no exported symbol at all — the
    C++ node.h addons register through a constructor instead.
    """

    if sources is None:
        sources = sorted(
            path for path in addon_dir.rglob("*") if path.suffix in NATIVE_SOURCE_SUFFIXES and path.is_file()
        )
    if not sources:
        raise AddonBuildError(f"no C/C++ sources under {addon_dir}")
    is_cxx = any(path.suffix in CXX_SOURCE_SUFFIXES for path in sources)
    if is_cxx:
        # C++ addons reference libnode RTTI and the libc++ runtime; reactor
        # mode links a minimal set by default.
        sources = [*sources, _LIBNODE_SHIM]
    target = name or target_name(addon_dir)
    out_path = out_dir / f"{artifact_name(node_repo, addon_dir, target)}.wasm"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    # Keep the toolchain self-contained: emsdk activate writes .emscripten
    # inside the emsdk tree, and emcc honors EM_CONFIG.
    state_hint = out_dir.parent / "toolchains" / "emsdk" / ".emscripten"
    if state_hint.is_file():
        env["EM_CONFIG"] = str(state_hint)
    extra_flags = _RTTI_FLAGS if is_cxx else ()
    last_error: AddonBuildError | None = None
    last_entry = "napi"
    for exported in _EMCC_EXPORT_CANDIDATES:
        for experimental in ((), ("-DNAPI_EXPERIMENTAL",)):
            argv = [
                str(emcc),
                *[str(source) for source in sources],
                *[f"-I{directory}" for directory in include_dirs(node_repo)],
                f"-DNODE_GYP_MODULE_NAME={target}",
                *_EMCC_FLAGS,
                *extra_flags,
                *experimental,
                *( [f"-sEXPORTED_FUNCTIONS={','.join((*exported, '_malloc', '_free'))}"] if exported else [] ),
                f"-o{out_path}",
            ]
            last_entry = "napi" if exported else "ctor"
            try:
                runner(argv, addon_dir, env)
            except AddonBuildError as exc:
                text = str(exc)
                if "undefined exported symbol" in text:
                    last_error = exc
                    break  # wrong registration style: try the next candidate
                if "undeclared function 'node_api_" in text and not experimental:
                    last_error = exc
                    continue  # experimental APIs: retry with NAPI_EXPERIMENTAL
                raise
            if not out_path.is_file():
                raise AddonBuildError(f"emcc reported success but {out_path} was not written")
            return AddonArtifact(
                node=expected_node_path(node_repo, addon_dir, target),
                wasm=out_path,
                entry=last_entry,
            )
    raise last_error or AddonBuildError(f"emcc failed for {addon_dir}")


def build_addon_artifacts(
    emcc: Path,
    node_repo: Path,
    addon_dir: Path,
    out_dir: Path,
    *,
    runner: Runner = _run,
) -> list[AddonArtifact]:
    targets = gyp_targets(addon_dir)
    if not targets:
        return []
    artifacts: list[AddonArtifact] = []
    for name, sources in targets:
        artifacts.append(
            build_addon(emcc, node_repo, addon_dir, out_dir, name=name, sources=sources, runner=runner)
        )
    return artifacts


def native_failing_tests(db) -> list[str]:
    paths = []
    for test in db.list_tests(target_statuses=("fail", "timeout", "infra_error")):
        if classify_test_path(test.path, test.suite).kind in {"native_addon", "native_api"}:
            paths.append(test.path)
    return paths


def build_addon_manifest(
    *,
    node_repo: Path,
    state_dir: Path,
    test_paths: Sequence[str] | None = None,
    bootstrap: bool = False,
    runner: Runner = _run,
) -> dict:
    node_repo = node_repo.resolve()
    state_dir = state_dir.resolve()
    emcc = emcc_path(state_dir)
    if emcc is None:
        if not bootstrap:
            raise AddonBuildError(
                "no Emscripten toolchain found; run `bnh addon-build --bootstrap` once "
                f"(installs under {toolchain_root(state_dir)})"
            )
        emcc = bootstrap_emsdk(state_dir, runner=runner)

    out_dir = state_dir / "addon-wasm"
    addon_dirs: dict[Path, None] = {}
    failures: list[dict[str, str]] = []
    skipped: list[str] = []
    artifacts: list[AddonArtifact] = []
    for test_path in test_paths or []:
        addon_dir = addon_dir_for(node_repo, test_path)
        if addon_dir is not None:
            addon_dirs[addon_dir] = None
    for addon_dir in sorted(addon_dirs):
        rel = addon_dir.relative_to(node_repo).as_posix()
        try:
            built = build_addon_artifacts(emcc, node_repo, addon_dir, out_dir, runner=runner)
        except AddonBuildError as exc:
            failures.append({"addon": rel, "error": str(exc)})
            continue
        if not built:
            # No gyp target with sources (e.g. test/addons/no-addons): the
            # test deliberately has nothing to compile.
            skipped.append(rel)
            continue
        artifacts.extend(built)
    manifest = {
        "version": 1,
        "artifacts": [
            {"node": artifact.node, "wasm": str(artifact.wasm), "entry": artifact.entry}
            for artifact in artifacts
        ],
        "failures": failures,
        "skipped": skipped,
    }
    (state_dir / "addon-manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest
