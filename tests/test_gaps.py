from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from browser_node_harness.gap_cards import emit_gap_cards, emit_worklist_index
from browser_node_harness.gaps import (
    HOST_NETWORK,
    MISSING_API,
    MISSING_VALIDATION,
    NATIVE_ADDON_WASM,
    FailureEvidence,
    Gap,
    classify_stderr,
    form_gaps,
    form_host_network_gaps,
    form_missing_api_gaps,
    form_missing_validation_gaps,
    form_native_gaps,
    gap_id_for,
    napi_family,
    rank_gaps,
)
from browser_node_harness.surface import (
    ModuleSurface,
    SurfaceGap,
    SurfaceProbeError,
    diff_surfaces,
    module_list_source,
    parse_probe_payload,
    surface_probe_source,
    surfaces_from_json,
    surfaces_to_json,
)


def evidence(
    path: str,
    *,
    suite: str = "parallel",
    modules: tuple[str, ...] = (),
    status: str = "fail",
    size_bytes: int = 100,
    stderr: str = "",
) -> FailureEvidence:
    return FailureEvidence(
        path=path,
        suite=suite,
        modules=modules,
        status=status,
        size_bytes=size_bytes,
        stderr=stderr,
    )


class SurfaceTests(unittest.TestCase):
    def test_probe_source_embeds_module_list_and_marker(self) -> None:
        source = surface_probe_source(["fs", "http"])
        self.assertIn('"fs"', source)
        self.assertIn('"http"', source)
        self.assertIn("__BNH_SURFACE_JSON__", source)
        # The probe must run as plain CJS through both adapters.
        self.assertIn("require(", source)
        self.assertIn("Object.getPrototypeOf", source)

    def test_module_list_source_uses_the_same_marker(self) -> None:
        self.assertIn("__BNH_SURFACE_JSON__", module_list_source())

    def test_parse_probe_payload_round_trips(self) -> None:
        payload = [{"module": "fs", "symbols": ["chmodSync"], "load_error": ""}]
        stdout = f"noise before\n__BNH_SURFACE_JSON__{json.dumps(payload)}__BNH_SURFACE_JSON__\n"
        self.assertEqual(parse_probe_payload(stdout), payload)

    def test_parse_probe_payload_rejects_missing_marker(self) -> None:
        with self.assertRaises(SurfaceProbeError):
            parse_probe_payload("no marker here")

    def test_parse_probe_payload_rejects_truncated_json(self) -> None:
        with self.assertRaises(SurfaceProbeError):
            parse_probe_payload("__BNH_SURFACE_JSON__[{trunc__BNH_SURFACE_JSON__")

    def test_diff_surfaces_reports_missing_symbols(self) -> None:
        expected = {"fs": ModuleSurface(symbols=("chmodSync", "chownSync", "existsSync"))}
        actual = {"fs": ModuleSurface(symbols=("existsSync",))}
        gaps = diff_surfaces(expected, actual)
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0].module, "fs")
        self.assertEqual(gaps[0].missing, ("chmodSync", "chownSync"))

    def test_diff_surfaces_reports_whole_module_load_failure(self) -> None:
        expected = {"wasi": ModuleSurface(symbols=("WASI",))}
        actual = {"wasi": ModuleSurface(load_error="ERR_UNKNOWN_BUILTIN_MODULE")}
        gaps = diff_surfaces(expected, actual)
        self.assertEqual(gaps[0].missing, ("WASI",))
        self.assertEqual(gaps[0].load_error, "ERR_UNKNOWN_BUILTIN_MODULE")

    def test_diff_surfaces_ignores_extra_target_symbols(self) -> None:
        expected = {"fs": ModuleSurface(symbols=("a",))}
        actual = {"fs": ModuleSurface(symbols=("a", "browserOnly"))}
        self.assertEqual(diff_surfaces(expected, actual), [])

    def test_surfaces_json_round_trip(self) -> None:
        surfaces = {"fs": ModuleSurface(symbols=("a", "b"), load_error="x")}
        restored = surfaces_from_json(surfaces_to_json(surfaces))
        self.assertEqual(restored["fs"].symbols, ("a", "b"))
        self.assertEqual(restored["fs"].load_error, "x")


class StderrClassificationTests(unittest.TestCase):
    def test_not_a_function_chains_are_extracted(self) -> None:
        result = classify_stderr("TypeError: fs.chmodSync is not a function")
        self.assertEqual(result["missing_calls"], ("fs.chmodSync",))

    def test_undefined_member_reads_are_extracted(self) -> None:
        result = classify_stderr(
            "TypeError: Cannot read properties of undefined (reading 'executionAsyncResource')"
        )
        self.assertEqual(result["undefined_members"], ("executionAsyncResource",))

    def test_validation_codes_are_extracted(self) -> None:
        result = classify_stderr(
            "AssertionError [ERR_ASSERTION]: expected ERR_INVALID_ARG_TYPE, got ERR_MISSING_ARGS"
        )
        self.assertEqual(result["validation_codes"], ("ERR_INVALID_ARG_TYPE", "ERR_MISSING_ARGS"))

    def test_napi_family_strings_beats_values(self) -> None:
        self.assertEqual(napi_family("napi_get_value_string_utf8"), "strings")
        self.assertEqual(napi_family("napi_get_value_int32"), "values")
        self.assertEqual(napi_family("napi_create_arraybuffer"), "arrays-buffers")
        self.assertEqual(napi_family("napi_thing_unknown"), "misc")


class MissingApiGapTests(unittest.TestCase):
    def test_missing_symbols_become_ranked_cards_with_acceptance(self) -> None:
        rows = [
            evidence("test/parallel/test-fs-a.js", modules=("fs",), size_bytes=10),
            evidence("test/parallel/test-fs-b.js", modules=("fs",), size_bytes=5),
            evidence("test/parallel/test-http-x.js", modules=("http",)),
        ]
        gaps = form_missing_api_gaps(
            [SurfaceGap(module="fs", missing=("chmodSync", "chownSync"))], rows
        )
        self.assertEqual(len(gaps), 1)
        gap = gaps[0]
        self.assertEqual(gap.kind, MISSING_API)
        self.assertEqual(gap.module, "fs")
        self.assertEqual(gap.symbols, ("chmodSync", "chownSync"))
        self.assertEqual(gap.affected_count, 2)
        # Acceptance prefers the smallest sources: cheapest reproductions.
        self.assertEqual(gap.acceptance_paths, ("test/parallel/test-fs-b.js", "test/parallel/test-fs-a.js"))

    def test_stderr_symbol_match_claims_tests_that_did_not_import_the_module(self) -> None:
        rows = [
            evidence(
                "test/parallel/test-thing.js",
                modules=("assert",),
                stderr="TypeError: fs.chmodSync is not a function",
            )
        ]
        gaps = form_missing_api_gaps([SurfaceGap(module="fs", missing=("fs.chmodSync",))], rows)
        self.assertEqual(gaps[0].affected_count, 1)

    def test_symbols_split_into_bounded_families(self) -> None:
        rows = [evidence("test/parallel/test-fs-a.js", modules=("fs",))]
        missing = tuple(f"fn{i}" for i in range(17))
        gaps = form_missing_api_gaps([SurfaceGap(module="fs", missing=missing)], rows)
        self.assertEqual(len(gaps), 3)
        self.assertEqual([len(gap.symbols) for gap in gaps], [8, 8, 1])

    def test_whole_module_load_error_is_recorded_as_evidence(self) -> None:
        rows = [evidence("test/parallel/test-wasi-a.js", modules=("wasi",))]
        gaps = form_missing_api_gaps(
            [SurfaceGap(module="wasi", missing=("WASI",), load_error="ERR_MODULE_NOT_FOUND")],
            rows,
        )
        self.assertEqual(gaps[0].evidence["load_error"], "ERR_MODULE_NOT_FOUND")

    def test_surface_hole_without_failures_is_still_a_card(self) -> None:
        gaps = form_missing_api_gaps([SurfaceGap(module="trace_events", missing=("getCategories",))], [])
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0].affected_count, 0)


class MissingValidationGapTests(unittest.TestCase):
    def test_validation_failures_group_per_module(self) -> None:
        rows = [
            evidence(
                "test/parallel/test-fs-a.js",
                modules=("fs", "assert"),
                stderr="TypeError [ERR_INVALID_ARG_TYPE]: The \"path\" argument must be of type string",
            ),
            evidence(
                "test/parallel/test-fs-b.js",
                modules=("fs",),
                stderr="Error [ERR_MISSING_ARGS]: callback required",
            ),
        ]
        gaps = form_missing_validation_gaps(rows, [])
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0].kind, MISSING_VALIDATION)
        self.assertEqual(gaps[0].module, "fs")
        self.assertEqual(gaps[0].symbols, ("ERR_INVALID_ARG_TYPE", "ERR_MISSING_ARGS"))
        self.assertEqual(gaps[0].affected_count, 2)

    def test_generic_modules_are_not_gap_domains(self) -> None:
        rows = [
            evidence(
                "test/parallel/test-x.js",
                modules=("assert",),
                stderr="Error [ERR_OUT_OF_RANGE]: invalid value",
            )
        ]
        self.assertEqual(form_missing_validation_gaps(rows, []), [])

    def test_rows_explained_by_missing_api_are_not_double_booked(self) -> None:
        rows = [
            evidence(
                "test/parallel/test-fs-a.js",
                modules=("fs",),
                stderr="TypeError: fs.chmodSync is not a function",
            ),
            evidence(
                "test/parallel/test-fs-b.js",
                modules=("fs",),
                stderr="Error [ERR_INVALID_ARG_TYPE]: bad path",
            ),
        ]
        missing_api = form_missing_api_gaps(
            [SurfaceGap(module="fs", missing=("fs.chmodSync",))], rows
        )
        gaps = form_missing_validation_gaps(rows, missing_api)
        # Only the row whose failure is a validation error, not a missing symbol.
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0].affected_count, 1)


class NativeGapTests(unittest.TestCase):
    def _node_repo(self, root: Path) -> Path:
        addon = root / "test" / "node-api" / "test_napi_thing"
        addon.mkdir(parents=True)
        (addon / "test.js").write_text("require('../build/Release/binding.node');\n")
        (addon / "binding.cc").write_text(
            "#include <node_api.h>\n"
            "napi_value Init(napi_env env, napi_value exports) {\n"
            "  napi_create_function(env, nullptr, 0, nullptr, nullptr, nullptr);\n"
            "  napi_create_string_utf8(env, \"x\", 1, nullptr);\n"
            "  return exports;\n"
            "}\n"
            "NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)\n"
        )
        return root

    def test_native_symbols_histogram_becomes_family_cards(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            node_repo = self._node_repo(Path(tmp))
            rows = [
                evidence("test/node-api/test_napi_thing/test.js", suite="node-api"),
                evidence("test/node-api/test_napi_other/test.js", suite="node-api"),
            ]
            gaps = form_native_gaps(rows, node_repo)
            families = {gap.module for gap in gaps}
            self.assertIn("napi:functions", families)
            self.assertIn("napi:strings", families)
            functions = next(gap for gap in gaps if gap.module == "napi:functions")
            self.assertIn("napi_create_function", functions.symbols)
            self.assertEqual(functions.evidence["usage"]["napi_create_function"], 1)
            self.assertEqual(functions.kind, NATIVE_ADDON_WASM)
            self.assertEqual(functions.affected_count, 2)

    def test_no_native_rows_produce_no_gaps(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            rows = [evidence("test/parallel/test-fs-a.js", modules=("fs",))]
            self.assertEqual(form_native_gaps(rows, Path(tmp)), [])


class HostNetworkGapTests(unittest.TestCase):
    def test_internet_failures_become_proxy_egress_gap(self) -> None:
        rows = [evidence("test/internet/test-x.js", suite="internet", status="fail")]
        gaps = form_host_network_gaps(rows)
        self.assertEqual(len(gaps), 1)
        self.assertEqual(gaps[0].kind, HOST_NETWORK)
        self.assertEqual(gaps[0].module, "internet")

    def test_network_timeouts_group_per_module(self) -> None:
        rows = [
            evidence("test/parallel/test-http-1.js", modules=("http",), status="timeout"),
            evidence("test/parallel/test-http-2.js", modules=("http",), status="timeout"),
            evidence("test/parallel/test-fs-1.js", modules=("fs",), status="timeout"),
        ]
        gaps = form_host_network_gaps(rows)
        self.assertEqual([gap.module for gap in gaps], ["http"])
        self.assertEqual(gaps[0].affected_count, 2)


class GapRankingTests(unittest.TestCase):
    def test_ranking_orders_by_affected_count(self) -> None:
        big = form_missing_api_gaps(
            [SurfaceGap(module="http", missing=("a",))],
            [evidence(f"test/parallel/test-http-{i}.js", modules=("http",)) for i in range(5)],
        )
        small = form_missing_api_gaps(
            [SurfaceGap(module="fs", missing=("b",))],
            [evidence("test/parallel/test-fs-1.js", modules=("fs",))],
        )
        ranked = rank_gaps([*small, *big])
        self.assertEqual(ranked[0].module, "http")

    def test_gap_ids_are_stable_and_symbol_sensitive(self) -> None:
        first = gap_id_for(MISSING_API, "fs", ("chmodSync",))
        self.assertEqual(first, gap_id_for(MISSING_API, "fs", ("chmodSync",)))
        self.assertNotEqual(first, gap_id_for(MISSING_API, "fs", ("chownSync",)))


class FormGapIntegrationTests(unittest.TestCase):
    def test_form_gaps_combines_all_kinds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            node_repo = self._native_repo(Path(tmp))
            rows = [
                evidence("test/parallel/test-fs-a.js", modules=("fs",)),
                evidence(
                    "test/parallel/test-fs-b.js",
                    modules=("fs",),
                    stderr="Error [ERR_INVALID_ARG_TYPE]: bad",
                ),
                evidence("test/node-api/test_napi_thing/test.js", suite="node-api"),
                evidence("test/internet/test-x.js", suite="internet"),
            ]
            gaps = form_gaps(
                [SurfaceGap(module="fs", missing=("chmodSync",))], rows, node_repo
            )
            kinds = {gap.kind for gap in gaps}
            self.assertEqual(
                kinds, {MISSING_API, MISSING_VALIDATION, NATIVE_ADDON_WASM, HOST_NETWORK}
            )

    @staticmethod
    def _native_repo(root: Path) -> Path:
        addon = root / "test" / "node-api" / "test_napi_thing"
        addon.mkdir(parents=True, exist_ok=True)
        (addon / "binding.cc").write_text("napi_create_function(env);\n")
        return root


class GapCardEmissionTests(unittest.TestCase):
    def test_cards_carry_prompt_task_reference_and_acceptance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            node_repo = root / "node"
            (node_repo / "lib").mkdir(parents=True)
            (node_repo / "lib" / "fs.js").write_text("module.exports = {};\n")
            (node_repo / "test" / "parallel").mkdir(parents=True)
            (node_repo / "test" / "parallel" / "test-fs-a.js").write_text(
                "require('node:fs');\n"
            )
            gaps = form_missing_api_gaps(
                [SurfaceGap(module="fs", missing=("chmodSync",))],
                [evidence("test/parallel/test-fs-a.js", modules=("fs",))],
            )
            out_dir = root / "worklist"
            emitted = emit_gap_cards(
                gaps, out_dir, node_repo=node_repo, config_path=Path("harness.toml")
            )
            self.assertEqual(len(emitted), 1)
            card = emitted[0]
            prompt = (card / "prompt.md").read_text()
            self.assertIn("chmodSync", prompt)
            self.assertIn("test/parallel/test-fs-a.js", prompt)
            self.assertIn("bnh --config harness.toml test", prompt)
            task = json.loads((card / "task.json").read_text())
            self.assertEqual(task["kind"], MISSING_API)
            self.assertEqual(task["symbols"], ["chmodSync"])
            self.assertTrue((card / "reference" / "lib" / "fs.js").is_file())
            self.assertTrue((card / "acceptance" / "test-fs-a.js").is_file())
            index = emit_worklist_index(gaps, out_dir)
            self.assertIn("gap-" + gaps[0].gap_id, index.read_text())

    def test_worklist_index_includes_native_bootstrap_when_native_gaps_exist(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "worklist"
            native = Gap(
                gap_id=gap_id_for(NATIVE_ADDON_WASM, "napi:functions", ("napi_create_function",)),
                kind=NATIVE_ADDON_WASM,
                module="napi:functions",
                symbols=("napi_create_function",),
                affected_count=9,
            )
            emit_worklist_index([native], out_dir)
            self.assertIn("emsdk", (out_dir / "WORKLIST.md").read_text())

    def test_worklist_index_reports_family_accounting(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "worklist"
            gaps = [
                Gap(
                    gap_id="http-a",
                    kind=MISSING_API,
                    module="http",
                    symbols=("request", "get"),
                    affected_count=2,
                    affected_paths=("test/http-a.js", "test/http-b.js"),
                ),
                Gap(
                    gap_id="http-b",
                    kind=MISSING_API,
                    module="_http_common",
                    symbols=("HTTPParser",),
                    affected_count=2,
                    affected_paths=("test/http-b.js", "test/http-c.js"),
                ),
            ]
            index = emit_worklist_index(gaps, out_dir)
            text = index.read_text()
            self.assertIn("Implementation families (runtime write surfaces): **1**", text)
            self.assertIn("Evidence/build cards: **2**", text)
            self.assertIn("Distinct missing obligations: **3**", text)
            self.assertIn("| `runtime/http.js` | _http_common, http | 2 | 3 | 3 |", text)


class ProbeResilienceTests(unittest.TestCase):
    """A hanging module must degrade to a load error, not abort the worklist."""

    @staticmethod
    def _payload(names, symbols=("alpha",)):
        entries = [
            {"module": name, "symbols": list(symbols), "load_error": ""}
            for name in names
        ]
        return "__BNH_SURFACE_JSON__" + json.dumps(entries) + "__BNH_SURFACE_JSON__\n"

    def _fake_runner(self, fail_when):
        import re
        from types import SimpleNamespace

        class FakeRunner:
            def __init__(self):
                self.probe_paths = []

            def run_one(self, case, **_):
                self.probe_paths.append(case.path)
                names = re.search(r"const modules = (\[.*?\]);", case.source_override)
                modules = json.loads(names.group(1)) if names else []
                failed = fail_when(case.path, modules)
                if failed:
                    return SimpleNamespace(status="timeout", stdout="", stderr="page never settled")
                return SimpleNamespace(
                    status="pass", stdout=self._payload(modules), stderr=""
                )

        runner = FakeRunner()
        runner._payload = self._payload
        return runner

    def test_chunk_failure_falls_back_to_single_probes(self) -> None:
        from browser_node_harness.surface import run_surface_probe

        runner = self._fake_runner(
            lambda path, modules: "symbols-" in path
        )
        surfaces = run_surface_probe(
            runner, spec=object(), worktree=Path("/w"), modules=("fs", "internal"), run_id="r"
        )
        self.assertEqual(surfaces["fs"].symbols, ("alpha",))
        self.assertEqual(surfaces["internal"].symbols, ("alpha",))

    def test_persistent_single_failure_is_recorded_as_load_error(self) -> None:
        from browser_node_harness.surface import run_surface_probe

        runner = self._fake_runner(
            lambda path, modules: "symbols-" in path or "single-internal" in path
        )
        surfaces = run_surface_probe(
            runner, spec=object(), worktree=Path("/w"), modules=("fs", "internal"), run_id="r"
        )
        self.assertEqual(surfaces["fs"].symbols, ("alpha",))
        self.assertTrue(surfaces["internal"].load_error.startswith("probe failed:"))

    def test_healthy_chunks_never_trigger_single_probes(self) -> None:
        from browser_node_harness.surface import run_surface_probe

        runner = self._fake_runner(lambda path, modules: False)
        run_surface_probe(
            runner, spec=object(), worktree=Path("/w"), modules=("fs", "http"), run_id="r"
        )
        self.assertTrue(all("single-" not in path for path in runner.probe_paths))


class SubpathSurfaceTests(unittest.TestCase):
    """Subpath builtins keep their own surface; attribution joins via the root."""

    def test_subpath_surface_gap_keeps_module_identity(self) -> None:
        gaps = form_missing_api_gaps(
            [
                SurfaceGap(module="fs/promises", missing=("FileHandle", "open")),
            ],
            [evidence("test/parallel/test-fs-a.js", modules=("fs", "fs/promises"))],
        )
        self.assertTrue(gaps)
        self.assertEqual(gaps[0].module, "fs/promises")
        self.assertGreaterEqual(gaps[0].affected_count, 1)
        self.assertIn("FileHandle", gaps[0].symbols)


if __name__ == "__main__":
    unittest.main()
