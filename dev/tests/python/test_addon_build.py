from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from browser_node_harness.addon_build import (
    AddonBuildError,
    addon_dir_for,
    build_addon,
    build_addon_manifest,
    emcc_path,
    expected_node_path,
    native_failing_tests,
    target_name,
    toolchain_root,
)


class FakeRunner:
    """Records invocations and writes wasm-magic bytes to -o targets."""

    def __init__(self) -> None:
        self.calls: list[tuple[tuple[str, ...], Path]] = []

    def __call__(self, argv, cwd, env=None):
        argv = tuple(str(item) for item in argv)
        self.calls.append((argv, cwd))
        for item in argv:
            if item.startswith("-o"):
                Path(item[2:]).write_bytes(b"\x00asm\x01\x00\x00\x00")
        return SimpleNamespace(exit_code=0, stdout="", stderr="")


def node_repo_with_addon(root: Path) -> Path:
    node_repo = root / "node"
    addon = node_repo / "test" / "node-api" / "test_napi_thing"
    addon.mkdir(parents=True)
    # The include search only proposes directories that exist.
    (node_repo / "src").mkdir()
    (addon / "test.js").write_text("require('../build/Release/binding.node');\n")
    (addon / "binding.cc").write_text("#include <node_api.h>\n")
    (addon / "binding.gyp").write_text(
        "# comment gyp allows\n{\n 'targets': [\n  {\n   'target_name': 'binding',\n"
        "   'sources': ['binding.cc'],\n  },\n ],\n}\n"
    )
    return node_repo


class AddonDirTests(unittest.TestCase):
    def test_addon_dir_is_found_from_test_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            node_repo = node_repo_with_addon(Path(tmp))
            addon = addon_dir_for(node_repo, "test/node-api/test_napi_thing/test.js")
            self.assertIsNotNone(addon)
            self.assertEqual(addon.name, "test_napi_thing")

    def test_addon_dir_returns_none_without_gyp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            node_repo = Path(tmp) / "node"
            (node_repo / "test" / "node-api" / "plain").mkdir(parents=True)
            self.assertIsNone(addon_dir_for(node_repo, "test/node-api/plain/test.js"))

    def test_target_name_falls_back_to_binding(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            addon = Path(tmp)
            (addon / "binding.gyp").write_text("{ 'targets': [ { 'sources': [] } ] }\n")
            self.assertEqual(target_name(addon), "binding")

    def test_expected_node_path_uses_target_name(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            node_repo = node_repo_with_addon(root)
            addon = addon_dir_for(node_repo, "test/node-api/test_napi_thing/test.js")
            self.assertEqual(
                expected_node_path(node_repo, addon),
                "test/node-api/test_napi_thing/build/Release/binding.node",
            )


class BuildAddonTests(unittest.TestCase):
    def test_build_addon_invokes_emcc_with_expected_flags(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            node_repo = node_repo_with_addon(root)
            addon = addon_dir_for(node_repo, "test/node-api/test_napi_thing/test.js")
            runner = FakeRunner()
            artifact = build_addon(
                Path("/fake/emcc"), node_repo, addon, root / "state" / "addon-wasm", runner=runner
            )
            argv, cwd = runner.calls[0]
            self.assertEqual(cwd, addon)
            self.assertEqual(argv[0], "/fake/emcc")
            self.assertIn("--no-entry", argv)
            self.assertIn("-Wl,--export-table", argv)
            self.assertIn("-DNAPI_VERSION=10", argv)
            self.assertIn("-DNODE_GYP_MODULE_NAME=binding", argv)
            # wasm32 passthrough for v8config.h and libnode RTTI shimming.
            self.assertIn("-D_M_IX86", argv)
            self.assertIn("-DV8_TARGET_ARCH_IA32=1", argv)
            self.assertIn("-frtti", argv)
            self.assertIn(str(Path(__file__).resolve().parents[2] / "harness/browser_node_harness/addon_shims/node_rtti_shim.cc"), argv)
            self.assertTrue(any(item.startswith("-I") for item in argv))
            self.assertTrue(Path(artifact.wasm).is_file())
            self.assertEqual(artifact.entry, "napi")

    def test_build_addon_without_sources_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            node_repo = node_repo_with_addon(root)
            addon = addon_dir_for(node_repo, "test/node-api/test_napi_thing/test.js")
            for source in addon.glob("*.cc"):
                source.unlink()
            with self.assertRaises(AddonBuildError):
                build_addon(Path("/fake/emcc"), node_repo, addon, root / "out", runner=FakeRunner())


class ManifestTests(unittest.TestCase):
    def _prepared(self, root: Path) -> tuple[Path, Path]:
        node_repo = node_repo_with_addon(root)
        state = root / "state"
        state.mkdir(parents=True, exist_ok=True)
        # Pretend the toolchain exists so no bootstrap is attempted.
        emcc = toolchain_root(state) / "upstream" / "emscripten" / "emcc"
        emcc.parent.mkdir(parents=True, exist_ok=True)
        emcc.write_text("#!/bin/sh\n")
        return node_repo, state

    def test_manifest_maps_node_paths_to_wasm_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            node_repo, state = self._prepared(root)
            self.assertIsNotNone(emcc_path(state))
            manifest = build_addon_manifest(
                node_repo=node_repo,
                state_dir=state,
                test_paths=["test/node-api/test_napi_thing/test.js"],
                runner=FakeRunner(),
            )
            self.assertEqual(len(manifest["artifacts"]), 1)
            entry = manifest["artifacts"][0]
            self.assertEqual(entry["node"], "test/node-api/test_napi_thing/build/Release/binding.node")
            self.assertTrue(Path(entry["wasm"]).is_file())
            self.assertEqual(manifest["failures"], [])
            written = json.loads((state / "addon-manifest.json").read_text())
            self.assertEqual(written["version"], 1)

    def test_build_failure_is_recorded_not_raised(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            node_repo, state = self._prepared(root)

            def failing_runner(argv, cwd, env=None):
                raise AddonBuildError("boom")

            manifest = build_addon_manifest(
                node_repo=node_repo,
                state_dir=state,
                test_paths=["test/node-api/test_napi_thing/test.js"],
                runner=failing_runner,
            )
            self.assertEqual(manifest["artifacts"], [])
            self.assertEqual(len(manifest["failures"]), 1)
            self.assertIn("boom", manifest["failures"][0]["error"])

    def test_missing_toolchain_without_bootstrap_gives_actionable_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            node_repo = node_repo_with_addon(root)
            state = root / "state"
            state.mkdir()
            with self.assertRaises(AddonBuildError) as ctx:
                build_addon_manifest(
                    node_repo=node_repo,
                    state_dir=state,
                    test_paths=["test/node-api/test_napi_thing/test.js"],
                )
            self.assertIn("--bootstrap", str(ctx.exception))


class NativeFailingTestsQuery(unittest.TestCase):
    def test_only_native_scope_failures_are_selected(self) -> None:
        from browser_node_harness.db import Database
        from browser_node_harness.models import TestCase, TestResult

        with tempfile.TemporaryDirectory() as tmp:
            db = Database(Path(tmp) / "state.sqlite3")
            tests = [
                TestCase(
                    path="test/node-api/test_x/test.js",
                    suite="node-api",
                    source_sha256="a" * 64,
                    modules=(),
                ),
                TestCase(
                    path="test/parallel/test-fs.js",
                    suite="parallel",
                    source_sha256="b" * 64,
                    modules=("fs",),
                ),
            ]
            db.upsert_tests(tests)
            db.start_run("run-1", "commit")
            for test in tests:
                db.record_result(
                    TestResult(
                        test_path=test.path,
                        status="fail",
                        exit_code=1,
                        duration_ms=1,
                    ),
                    run_id="run-1",
                    iteration=0,
                    phase="canonical-target",
                    canonical="target",
                )
            self.assertEqual(native_failing_tests(db), ["test/node-api/test_x/test.js"])


if __name__ == "__main__":
    unittest.main()
