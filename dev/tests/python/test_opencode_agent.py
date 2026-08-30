from __future__ import annotations

import importlib
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch


opencode_agent = importlib.import_module("browser_node_harness.opencode_agent")
model_catalog = importlib.import_module("browser_node_harness.model_catalog")


class OpenCodeAgentTests(unittest.TestCase):
    def test_default_model_order_excludes_big_pickle(self) -> None:
        self.assertNotIn("opencode/big-pickle", opencode_agent.DEFAULT_FREE_MODEL_ORDER)

    def test_worktree_change_detection_ignores_clean_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            self.assertFalse(opencode_agent._worktree_has_changes(root))
            (root / "runtime.js").write_text("changed\n", encoding="utf-8")
            self.assertTrue(opencode_agent._worktree_has_changes(root))

    def test_worktree_change_detection_does_not_hide_git_inspection_failure(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            self.assertTrue(opencode_agent._worktree_has_changes(Path(raw)))

    def test_select_free_models_preserves_quality_order_and_availability(self) -> None:
        selected = opencode_agent.select_free_models(
            (
                "opencode/hy3-free",
                "opencode/big-pickle",
                "opencode/mimo-v2.5-free",
            ),
            frozenset({"big-pickle", "mimo-v2.5-free"}),
        )
        self.assertEqual(selected, ("opencode/big-pickle", "opencode/mimo-v2.5-free"))

    def test_select_free_models_rejects_paid_models(self) -> None:
        with self.assertRaisesRegex(ValueError, "refusing non-free"):
            opencode_agent.select_free_models(("opencode/gpt-5.6-sol",), None)

    def test_model_endpoint_parser_accepts_provider_prefixed_ids(self) -> None:
        payload = {"data": [{"id": "opencode/big-pickle"}, {"id": "hy3-free"}, {"id": 7}]}
        self.assertEqual(
            opencode_agent.parse_advertised_model_ids(payload),
            frozenset({"big-pickle", "hy3-free"}),
        )

    def test_openrouter_parser_requires_free_suffix_and_zero_prices(self) -> None:
        payload = {
            "data": [
                {
                    "id": "qwen/qwen3-coder:free",
                    "name": "Qwen Coder",
                    "pricing": {"prompt": "0", "completion": "0"},
                    "supported_parameters": ["tools", "tool_choice", "reasoning"],
                    "context_length": 200000,
                },
                {
                    "id": "paid/model:free",
                    "pricing": {"prompt": "0.000001", "completion": "0"},
                },
                {
                    "id": "tool-paid/model:free",
                    "pricing": {"prompt": "0", "completion": "0", "web_search": "0.01"},
                },
                {
                    "id": "not-free/model",
                    "pricing": {"prompt": "0", "completion": "0"},
                },
            ]
        }
        self.assertEqual(
            opencode_agent.parse_openrouter_free_models(payload),
            ("openrouter/qwen/qwen3-coder:free",),
        )

    def test_openrouter_catalog_provides_cross_provider_benchmark_scores(self) -> None:
        payload = {
            "data": [
                {
                    "id": "openai/gpt-oss-120b:free",
                    "pricing": {"prompt": "0", "completion": "0"},
                    "benchmarks": {
                        "artificial_analysis": {
                            "coding_index": 80,
                            "agentic_index": 70,
                            "intelligence_index": 60,
                        }
                    },
                },
            ]
        }
        models, scores = opencode_agent.parse_openrouter_free_catalog(payload)
        self.assertEqual(models, ("openrouter/openai/gpt-oss-120b:free",))
        self.assertEqual(scores["openai-gpt-oss-120b"], 365.0)

    def test_openrouter_catalog_uses_direct_agentic_index_fields(self) -> None:
        payload = {
            "data": [
                {
                    "id": "provider/agentic:free",
                    "pricing": {"prompt": "0", "completion": "0"},
                    "agentic_index": 90,
                },
                {
                    "id": "provider/coding:free",
                    "pricing": {"prompt": "0", "completion": "0"},
                    "coding_index": 90,
                },
            ]
        }
        models, scores = opencode_agent.parse_openrouter_free_catalog(payload)
        self.assertEqual(models[0], "openrouter/provider/agentic:free")
        self.assertGreater(scores["provider-agentic"], scores["provider-coding"])

    def test_model_catalog_cache_requires_the_same_key(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = Path(raw) / "catalog.json"
            key = model_catalog.make_cache_key({"models_url": "one"})
            model_catalog.save_catalog(
                path,
                key,
                {"openrouter_models": ["openrouter/provider/model:free"]},
            )
            self.assertIsNotNone(model_catalog.load_catalog(path, key))
            self.assertIsNone(
                model_catalog.load_catalog(
                    path,
                    model_catalog.make_cache_key({"models_url": "two"}),
                )
            )

    def test_nim_parser_requires_live_allowlisted_free_models(self) -> None:
        payload = {
            "data": [
                {"id": "deepseek-ai/deepseek-v4-flash-0731", "free_endpoint": True},
                {"id": "meta/llama-3.3-70b-instruct", "pricing": {"prompt": "0.01", "completion": "0"}},
                {"id": "some/paid-model", "pricing": {"prompt": "0", "completion": "0"}},
            ]
        }
        self.assertEqual(
            opencode_agent.parse_nim_free_models(payload),
            ("nvidia/deepseek-ai/deepseek-v4-flash-0731",),
        )

    def test_artificial_analysis_scores_rank_coding_models(self) -> None:
        payload = {
            "data": [
                {
                    "slug": "gpt-oss-20b",
                    "evaluations": {
                        "artificial_analysis_coding_index": 20,
                        "artificial_analysis_agentic_index": 30,
                    },
                },
                {
                    "slug": "gpt-oss-120b",
                    "evaluations": {
                        "artificial_analysis_coding_index": 80,
                        "artificial_analysis_agentic_index": 70,
                    },
                },
            ]
        }
        scores = opencode_agent.parse_artificial_analysis_scores(payload)
        self.assertEqual(
            opencode_agent.rank_models_by_artificial_analysis(
                ("nvidia/openai/gpt-oss-20b", "nvidia/openai/gpt-oss-120b"),
                scores,
            ),
            ("nvidia/openai/gpt-oss-120b", "nvidia/openai/gpt-oss-20b"),
        )

    def test_artificial_analysis_fetch_uses_api_key_header(self) -> None:
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        response.read.return_value = b'{"data": []}'
        opener = Mock(return_value=response)
        self.assertEqual(
            opencode_agent.fetch_artificial_analysis_scores(
                "https://analysis.invalid/api/v2/language/models/free",
                api_key="analysis-secret",
                opener=opener,
            ),
            {},
        )
        request = opener.call_args.args[0]
        self.assertEqual(request.get_header("X-api-key"), "analysis-secret")

    def test_fetch_nim_free_models_verifies_live_catalog_and_api_key(self) -> None:
        response = MagicMock()
        response.__enter__.return_value = response
        response.__exit__.return_value = False
        response.read.return_value = (
            b'{"data": ['
            b'{"id": "deepseek-ai/deepseek-v4-flash-0731", "free_endpoint": true},'
            b'{"id": "meta/llama-3.3-70b-instruct", "free_endpoint": false},'
            b'{"id": "provider/paid-model", "pricing": {"prompt": "0", "completion": "1"}}'
            b']}'
        )
        opener = Mock(return_value=response)

        selected = opencode_agent.fetch_nim_free_models(
            "https://nim.invalid/v1/models",
            api_key="nim-secret",
            opener=opener,
        )

        self.assertEqual(selected, ("nvidia/deepseek-ai/deepseek-v4-flash-0731",))
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, "https://nim.invalid/v1/models")
        self.assertEqual(request.get_header("Authorization"), "Bearer nim-secret")

    def test_load_opencode_provider_key_reads_nvidia_credential_without_exposing_it(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            auth_path = Path(raw) / "auth.json"
            auth_path.write_text(
                json.dumps({"nvidia": {"type": "api", "key": "nim-secret"}}),
                encoding="utf-8",
            )
            self.assertEqual(
                opencode_agent.load_opencode_provider_key("nvidia", auth_path=auth_path),
                "nim-secret",
            )
            self.assertIsNone(
                opencode_agent.load_opencode_provider_key("openrouter", auth_path=auth_path)
            )

    def test_main_skips_nim_when_no_api_key_is_configured(self) -> None:
        success = subprocess.CompletedProcess(
            args=["opencode"], returncode=0, stdout="implemented", stderr=""
        )
        stderr = StringIO()
        with patch.dict(
            os.environ,
            {
                "BNH_OPENCODE_MODELS_URL": "https://models.invalid",
                "BNH_OPENCODE_INCLUDE_OPENROUTER": "false",
                "BNH_OPENCODE_INCLUDE_NIM": "true",
            },
            clear=True,
        ), patch.object(
            opencode_agent,
            "fetch_advertised_model_ids",
            return_value=frozenset({"mimo-v2.5-free"}),
        ), patch.object(opencode_agent, "load_opencode_provider_key", return_value=None), patch.object(
            opencode_agent, "fetch_nim_free_models"
        ) as fetch_nim, patch.object(
            opencode_agent, "_run_model", return_value=success
        ), redirect_stderr(stderr):
            with patch.object(opencode_agent.sys, "stdin", StringIO("fix the assigned tests")):
                self.assertEqual(opencode_agent.main(), 0)

        fetch_nim.assert_not_called()
        self.assertIn("no NVIDIA NIM credential is available; skipping NIM", stderr.getvalue())

    def test_main_reuses_nvidia_credential_from_opencode_auth(self) -> None:
        success = subprocess.CompletedProcess(
            args=["opencode"], returncode=0, stdout="implemented", stderr=""
        )
        with patch.dict(
            os.environ,
            {
                "BNH_OPENCODE_MODEL_ORDER": "big-pickle,nvidia/openai/gpt-oss-20b",
                "BNH_OPENCODE_MODELS_URL": "https://models.invalid",
                "BNH_OPENCODE_INCLUDE_OPENROUTER": "false",
                "BNH_NIM_MODELS_URL": "https://nim.invalid/v1/models",
            },
            clear=True,
        ), patch.object(
            opencode_agent,
            "fetch_advertised_model_ids",
            return_value=frozenset({"big-pickle"}),
        ), patch.object(
            opencode_agent,
            "load_opencode_provider_key",
            return_value="stored-nim-secret",
        ), patch.object(
            opencode_agent,
            "fetch_nim_free_models",
            return_value=("nvidia/openai/gpt-oss-20b",),
        ), patch.object(opencode_agent, "_run_model", return_value=success) as run_model:
            with patch.object(opencode_agent.sys, "stdin", StringIO("fix the assigned tests")):
                self.assertEqual(opencode_agent.main(), 0)

        self.assertEqual(run_model.call_args.kwargs["model"], "opencode/big-pickle")
        self.assertEqual(run_model.call_args.kwargs["nim_api_key"], "stored-nim-secret")

    def test_main_uses_nvidia_api_key_alias_and_adds_live_nim_fallback(self) -> None:
        quota = subprocess.CompletedProcess(
            args=["opencode"], returncode=1, stdout="free usage exceeded", stderr=""
        )
        success = subprocess.CompletedProcess(
            args=["opencode"], returncode=0, stdout="implemented", stderr=""
        )
        with patch.dict(
            os.environ,
            {
                "BNH_OPENCODE_MODEL_ORDER": "big-pickle,nvidia/openai/gpt-oss-20b",
                "BNH_OPENCODE_MODELS_URL": "https://models.invalid",
                "BNH_OPENCODE_INCLUDE_OPENROUTER": "false",
                "BNH_NIM_MODELS_URL": "https://nim.invalid/v1/models",
                "NVIDIA_API_KEY": "nvidia-secret",
            },
            clear=True,
        ), patch.object(
            opencode_agent,
            "fetch_advertised_model_ids",
            return_value=frozenset({"big-pickle"}),
        ), patch.object(
            opencode_agent,
            "fetch_nim_free_models",
            return_value=("nvidia/openai/gpt-oss-20b",),
        ) as fetch_nim, patch.object(
            opencode_agent, "_run_model", side_effect=[quota, success]
        ) as run_model:
            with patch.object(opencode_agent.sys, "stdin", StringIO("fix the assigned tests")):
                self.assertEqual(opencode_agent.main(), 0)

        self.assertEqual(fetch_nim.call_args.kwargs["api_key"], "nvidia-secret")
        self.assertEqual(
            [call.kwargs["model"] for call in run_model.call_args_list],
            ["opencode/big-pickle", "nvidia/openai/gpt-oss-20b"],
        )

    def test_nim_config_stays_under_the_attempt_state_directory(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            metadata = Path(raw) / "attempt" / "agent-metadata.json"
            metadata.parent.mkdir()
            with patch.dict(
                os.environ,
                {"BNH_AGENT_METADATA_FILE": str(metadata)},
                clear=True,
            ):
                config_path = opencode_agent._write_nim_opencode_config(
                    "http://127.0.0.1:8000/v1"
                )

            self.assertEqual(config_path, metadata.parent / "opencode-nim.json")
            self.assertEqual(
                json.loads(config_path.read_text(encoding="utf-8")),
                {
                    "$schema": "https://opencode.ai/config.json",
                    "provider": {
                        "nvidia": {
                            "options": {"baseURL": "http://127.0.0.1:8000/v1"}
                        }
                    },
                },
            )

    def test_main_falls_back_across_all_three_free_providers(self) -> None:
        quota = subprocess.CompletedProcess(
            args=["opencode"], returncode=1, stdout="HTTP 429 too many requests", stderr=""
        )
        success = subprocess.CompletedProcess(
            args=["opencode"], returncode=0, stdout="implemented", stderr=""
        )
        with patch.dict(
            os.environ,
            {
                "BNH_OPENCODE_MODEL_ORDER": (
                    "big-pickle,openrouter/qwen/qwen3-coder:free,nvidia/openai/gpt-oss-20b"
                ),
                "BNH_OPENCODE_MODELS_URL": "https://models.invalid",
                "BNH_OPENCODE_INCLUDE_OPENROUTER": "true",
                "BNH_NIM_API_KEY": "nim-secret",
            },
            clear=True,
        ), patch.object(
            opencode_agent,
            "fetch_advertised_model_ids",
            return_value=frozenset({"big-pickle"}),
        ), patch.object(
            opencode_agent,
            "fetch_openrouter_free_catalog",
            return_value=(("openrouter/qwen/qwen3-coder:free",), {}),
        ), patch.object(
            opencode_agent,
            "fetch_nim_free_models",
            return_value=("nvidia/openai/gpt-oss-20b",),
        ), patch.object(
            opencode_agent, "_run_model", side_effect=[quota, quota, success]
        ) as run_model:
            with patch.object(opencode_agent.sys, "stdin", StringIO("fix the assigned tests")):
                self.assertEqual(opencode_agent.main(), 0)

        self.assertEqual(
            [call.kwargs["model"] for call in run_model.call_args_list],
            [
                "opencode/big-pickle",
                "openrouter/qwen/qwen3-coder:free",
                "nvidia/openai/gpt-oss-20b",
            ],
        )

    def test_mixed_model_chain_verifies_each_provider(self) -> None:
        selected = opencode_agent.select_model_chain(
            ("opencode/big-pickle", "openrouter/qwen/qwen3-coder:free"),
            frozenset({"big-pickle"}),
            frozenset({"openrouter/qwen/qwen3-coder:free"}),
        )
        self.assertEqual(selected, ("opencode/big-pickle", "openrouter/qwen/qwen3-coder:free"))

    def test_nim_model_requires_verified_free_catalog_entry(self) -> None:
        model = "nvidia/openai/gpt-oss-20b"
        self.assertEqual(
            opencode_agent.select_model_chain(
                (model,), None, None, frozenset({model})
            ),
            (model,),
        )
        with self.assertRaisesRegex(ValueError, "verified zero pricing"):
            opencode_agent.select_model_chain((model,), None, None, None)

    def test_model_slots_alternate_provider_starts(self) -> None:
        models = ("opencode/big-pickle", "opencode/mimo-v2.5-free", "openrouter/qwen/qwen3-coder:free")
        self.assertEqual(opencode_agent.order_model_chain_for_slot(models, 0), models)
        self.assertEqual(
            opencode_agent.order_model_chain_for_slot(models, 1),
            ("openrouter/qwen/qwen3-coder:free", "opencode/big-pickle", "opencode/mimo-v2.5-free"),
        )

    def test_model_slots_rotate_three_provider_starts(self) -> None:
        models = (
            "opencode/big-pickle",
            "opencode/mimo-v2.5-free",
            "openrouter/qwen/qwen3-coder:free",
            "nvidia/openai/gpt-oss-20b",
        )
        self.assertEqual(
            opencode_agent.order_model_chain_for_slot(models, 0),
            (
                "opencode/big-pickle",
                "opencode/mimo-v2.5-free",
                "openrouter/qwen/qwen3-coder:free",
                "nvidia/openai/gpt-oss-20b",
            ),
        )
        self.assertEqual(
            opencode_agent.order_model_chain_for_slot(models, 1),
            (
                "openrouter/qwen/qwen3-coder:free",
                "opencode/big-pickle",
                "opencode/mimo-v2.5-free",
                "nvidia/openai/gpt-oss-20b",
            ),
        )
        self.assertEqual(
            opencode_agent.order_model_chain_for_slot(models, 2),
            (
                "nvidia/openai/gpt-oss-20b",
                "opencode/big-pickle",
                "opencode/mimo-v2.5-free",
                "openrouter/qwen/qwen3-coder:free",
            ),
        )

    def test_quota_detection_does_not_retry_normal_agent_failures(self) -> None:
        self.assertTrue(opencode_agent.is_quota_error("Error: free usage exceeded; retry later"))
        self.assertTrue(opencode_agent.is_quota_error("HTTP 429 too many requests"))
        self.assertFalse(opencode_agent.is_quota_error("SyntaxError: unexpected token"))

    def test_idle_model_timeout_is_retryable(self) -> None:
        self.assertTrue(
            opencode_agent.is_model_unavailable_error(
                "bnh-opencode: model idle timeout after 600 seconds"
            )
        )

    def test_network_error_is_retryable(self) -> None:
        self.assertTrue(opencode_agent.is_model_unavailable_error("Provider finish_reason: network_error"))

    def test_main_reuses_cached_catalog(self) -> None:
        success = subprocess.CompletedProcess(
            args=["opencode"], returncode=0, stdout="implemented", stderr=""
        )
        with tempfile.TemporaryDirectory() as raw:
            cache_path = Path(raw) / "catalog.json"
            environment = {
                "BNH_OPENCODE_MODEL_ORDER": "openrouter/qwen/qwen3-coder:free",
                "BNH_OPENCODE_MODELS_URL": "https://models.invalid",
                "BNH_OPENROUTER_MODELS_URL": "https://router.invalid",
                "BNH_OPENCODE_INCLUDE_NIM": "false",
                "BNH_OPENCODE_CATALOG_CACHE": str(cache_path),
            }
            with patch.dict(os.environ, environment, clear=True), patch.object(
                opencode_agent,
                "fetch_advertised_model_ids",
                return_value=frozenset(),
            ) as fetch_zen, patch.object(
                opencode_agent,
                "fetch_openrouter_free_catalog",
                return_value=(("openrouter/qwen/qwen3-coder:free",), {"qwen-qwen3-coder": 10.0}),
            ) as fetch_router, patch.object(
                opencode_agent, "_run_model", return_value=success
            ):
                with patch.object(opencode_agent.sys, "stdin", StringIO("fix the assigned tests")):
                    self.assertEqual(opencode_agent.main(), 0)
            self.assertTrue(cache_path.exists())

            with patch.dict(os.environ, environment, clear=True), patch.object(
                opencode_agent,
                "fetch_advertised_model_ids",
                side_effect=AssertionError("Zen catalog was refreshed"),
            ) as fetch_zen_cached, patch.object(
                opencode_agent,
                "fetch_openrouter_free_catalog",
                side_effect=AssertionError("OpenRouter catalog was refreshed"),
            ) as fetch_router_cached, patch.object(
                opencode_agent, "_run_model", return_value=success
            ):
                with patch.object(opencode_agent.sys, "stdin", StringIO("fix the assigned tests")):
                    self.assertEqual(opencode_agent.main(), 0)

            fetch_zen.assert_called_once()
            fetch_router.assert_called_once()
            fetch_zen_cached.assert_not_called()
            fetch_router_cached.assert_not_called()

    def test_main_falls_through_network_error_to_next_model(self) -> None:
        failure = subprocess.CompletedProcess(
            args=["opencode"], returncode=1, stdout="", stderr="Provider finish_reason: network_error"
        )
        success = subprocess.CompletedProcess(
            args=["opencode"], returncode=0, stdout="implemented", stderr=""
        )
        with patch.dict(
            os.environ,
            {
                "BNH_OPENCODE_MODEL_ORDER": "opencode/mimo-v2.5-free,openrouter/qwen/qwen3-coder:free",
                "BNH_OPENCODE_MODELS_URL": "https://models.invalid",
                "BNH_OPENCODE_INCLUDE_NIM": "false",
            },
            clear=True,
        ), patch.object(
            opencode_agent,
            "fetch_advertised_model_ids",
            return_value=frozenset({"mimo-v2.5-free"}),
        ), patch.object(
            opencode_agent,
            "fetch_openrouter_free_catalog",
            return_value=(("openrouter/qwen/qwen3-coder:free",), {}),
        ), patch.object(
            opencode_agent,
            "_run_model",
            side_effect=(failure, success),
        ) as run_model:
            with patch.object(opencode_agent.sys, "stdin", StringIO("fix the assigned tests")):
                self.assertEqual(opencode_agent.main(), 0)
        self.assertEqual(
            [call.kwargs["model"] for call in run_model.call_args_list],
            ["opencode/mimo-v2.5-free", "openrouter/qwen/qwen3-coder:free"],
        )

    def test_main_switches_models_after_quota_error(self) -> None:
        quota = subprocess.CompletedProcess(
            args=["opencode"], returncode=1, stdout="free usage exceeded", stderr=""
        )
        success = subprocess.CompletedProcess(
            args=["opencode"], returncode=0, stdout="implemented", stderr=""
        )
        stdout = StringIO()
        stderr = StringIO()
        with patch.dict(
            os.environ,
            {
                "BNH_OPENCODE_MODEL_ORDER": "big-pickle,mimo-v2.5-free",
                "BNH_OPENCODE_MODELS_URL": "https://models.invalid",
            },
            clear=False,
        ), patch.object(
            opencode_agent,
            "fetch_advertised_model_ids",
            return_value=frozenset({"big-pickle", "mimo-v2.5-free"}),
        ), patch.object(
            opencode_agent,
            "fetch_openrouter_free_catalog",
            return_value=((), {}),
        ), patch.object(opencode_agent, "_run_model", side_effect=[quota, success]) as run_model, redirect_stdout(stdout), redirect_stderr(stderr):
            with patch.object(opencode_agent.sys, "stdin", StringIO("fix the assigned tests")):
                exit_code = opencode_agent.main()

        self.assertEqual(exit_code, 0)
        self.assertEqual(stdout.getvalue(), "implemented")
        self.assertEqual([call.kwargs["model"] for call in run_model.call_args_list], [
            "opencode/big-pickle",
            "opencode/mimo-v2.5-free",
        ])
        self.assertIn("switching to the next free model", stderr.getvalue())

    def test_main_switches_models_when_first_model_exits_without_a_patch(self) -> None:
        success = subprocess.CompletedProcess(
            args=["opencode"], returncode=0, stdout="finished without edits", stderr=""
        )
        with patch.dict(
            os.environ,
            {
                "BNH_OPENCODE_MODEL_ORDER": "big-pickle,mimo-v2.5-free",
                "BNH_OPENCODE_MODELS_URL": "https://models.invalid",
            },
            clear=False,
        ), patch.object(
            opencode_agent,
            "fetch_advertised_model_ids",
            return_value=frozenset({"big-pickle", "mimo-v2.5-free"}),
        ), patch.object(
            opencode_agent,
            "fetch_openrouter_free_catalog",
            return_value=((), {}),
        ), patch.object(
            opencode_agent,
            "_worktree_has_changes",
            side_effect=(False, True),
        ), patch.object(
            opencode_agent,
            "_run_model",
            side_effect=(success, success),
        ) as run_model, redirect_stderr(StringIO()) as stderr:
            with patch.object(opencode_agent.sys, "stdin", StringIO("fix the assigned tests")):
                self.assertEqual(opencode_agent.main(), 0)

        self.assertEqual(
            [call.kwargs["model"] for call in run_model.call_args_list],
            ["opencode/big-pickle", "opencode/mimo-v2.5-free"],
        )
        self.assertIn("working-tree change", stderr.getvalue())

    def test_main_starts_parallel_slot_on_rotated_model(self) -> None:
        success = subprocess.CompletedProcess(
            args=["opencode"], returncode=0, stdout="implemented", stderr=""
        )
        with patch.dict(
            os.environ,
            {
                "BNH_OPENCODE_MODEL_ORDER": "big-pickle,openrouter/qwen/qwen3-coder:free",
                "BNH_OPENCODE_MODEL_OFFSET": "1",
            },
            clear=False,
        ), patch.object(
            opencode_agent,
            "fetch_advertised_model_ids",
            return_value=frozenset({"big-pickle", "mimo-v2.5-free"}),
        ), patch.object(
            opencode_agent,
            "fetch_openrouter_free_catalog",
            return_value=(("openrouter/qwen/qwen3-coder:free",), {}),
        ), patch.object(opencode_agent, "_run_model", return_value=success) as run_model:
            with patch.object(opencode_agent.sys, "stdin", StringIO("fix the assigned tests")):
                self.assertEqual(opencode_agent.main(), 0)

        self.assertEqual(run_model.call_args.kwargs["model"], "openrouter/qwen/qwen3-coder:free")

    def test_main_limits_large_live_fallback_catalog(self) -> None:
        quota = subprocess.CompletedProcess(
            args=["opencode"], returncode=1, stdout="HTTP 429 too many requests", stderr=""
        )
        catalog = tuple(f"openrouter/provider/model-{index}:free" for index in range(8))
        with patch.dict(
            os.environ,
            {
                "BNH_OPENCODE_MODELS_URL": "https://models.invalid",
                "BNH_OPENCODE_MAX_MODELS": "3",
            },
            clear=False,
        ), patch.object(
            opencode_agent,
            "fetch_advertised_model_ids",
            return_value=frozenset({"big-pickle"}),
        ), patch.object(
            opencode_agent,
            "fetch_openrouter_free_catalog",
            return_value=(catalog, {}),
        ), patch.object(opencode_agent, "_run_model", return_value=quota) as run_model, patch.object(
            opencode_agent, "_worktree_has_changes", return_value=True
        ):
            with patch.object(opencode_agent.sys, "stdin", StringIO("fix the assigned tests")):
                self.assertEqual(opencode_agent.main(), 1)

        self.assertEqual(len(run_model.call_args_list), 3)


if __name__ == "__main__":
    unittest.main()
