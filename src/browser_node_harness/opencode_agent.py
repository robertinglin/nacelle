"""Run OpenCode with a quota-aware free-model fallback chain."""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

from .model_catalog import load_catalog, make_cache_key, save_catalog

DEFAULT_MODELS_URL = "https://opencode.ai/zen/v1/models"
DEFAULT_OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
DEFAULT_NIM_MODELS_URL = "https://integrate.api.nvidia.com/v1/models"
DEFAULT_ARTIFICIAL_ANALYSIS_MODELS_URL = "https://artificialanalysis.ai/api/v2/language/models/free"

# The hosted NIM catalog does not always include pricing fields. Keep the
# default lane is a current coding/agentic model; the live catalog must still
# advertise it before it can be selected.
DEFAULT_NIM_FREE_MODEL_ORDER = (
    "deepseek-ai/deepseek-v4-flash-0731",
)
DEFAULT_NIM_FREE_MODEL_IDS = frozenset(DEFAULT_NIM_FREE_MODEL_ORDER)

# This is the quality-first order for the free models listed by OpenCode Zen.
# Availability is checked at runtime, so temporary removals do not stop the
# chain from using the remaining models.
DEFAULT_FREE_MODEL_ORDER = (
    "opencode/mimo-v2.5-free",
    "opencode/hy3-free",
    "opencode/nemotron-3-ultra-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/x-preview-f-free",
    "opencode/muse-spark-1.2-contributor-free",
)

# Keep explicit configuration compatible with older harness files, while not
# selecting Big Pickle by default after its repeated protocol failures.
FREE_MODEL_IDS = frozenset(
    model.split("/", 1)[1]
    for model in (*DEFAULT_FREE_MODEL_ORDER, "opencode/big-pickle")
)

_QUOTA_ERROR = re.compile(
    r"(?:"
    r"\b429\b|"
    r"rate[\s_-]*limit|"
    r"too many requests|"
    r"free usage[^\n]*exceed|"
    r"usage[^\n]*(?:limit|quota)[^\n]*(?:exceed|reach)|"
    r"quota[^\n]*(?:exceed|reach|exhaust)|"
    r"credits?[^\n]*(?:exhaust|deplet|reach)|"
    r"insufficient balance|"
    r"limit reached|"
    r"capacity[^\n]*(?:exceed|unavailable|full)|"
    r"temporarily unavailable|"
    r"try again later"
    r")",
    re.IGNORECASE,
)

_MODEL_UNAVAILABLE_ERROR = re.compile(
    r"(?:"
    r"no api key|"
    r"unauthori[sz]ed|"
    r"authentication failed|"
    r"model[^\n]*(?:not found|does not exist|unavailable)|"
    r"provider[^\n]*unavailable|"
    r"no endpoints|"
    r"no matching providers|"
    r"forbidden|"
    r"model[ -]idle[ -]timeout|"
    r"network[_ -]?error|"
    r"provider finish_reason|"
    r"invalid tool call|"
    r"tool protocol"
    r")",
    re.IGNORECASE,
)


def _model_id(model: str) -> str:
    provider, separator, model_id = model.partition("/")
    if not separator or provider != "opencode" or not model_id:
        raise ValueError(f"model must be an OpenCode model reference: {model!r}")
    return model_id


def _provider_model_id(model: str) -> tuple[str, str]:
    provider, separator, model_id = model.partition("/")
    if not separator or provider not in {"opencode", "openrouter", "nvidia"} or not model_id:
        raise ValueError(f"model must use the opencode/, openrouter/, or nvidia/ provider: {model!r}")
    return provider, model_id


def parse_model_order(value: str | None) -> tuple[str, ...]:
    """Parse comma-separated model IDs for the supported free providers."""

    if not value:
        return DEFAULT_FREE_MODEL_ORDER

    models: list[str] = []
    seen: set[str] = set()
    for item in value.split(","):
        raw = item.strip()
        if not raw:
            continue
        model = raw if "/" in raw else f"opencode/{raw}"
        _provider_model_id(model)
        if model not in seen:
            models.append(model)
            seen.add(model)
    if not models:
        raise ValueError("BNH_OPENCODE_MODEL_ORDER must contain at least one model")
    return tuple(models)


def parse_advertised_model_ids(payload: Mapping[str, Any]) -> frozenset[str]:
    """Extract model IDs from the OpenAI-compatible Zen models response."""

    raw_models = payload.get("data")
    if not isinstance(raw_models, list):
        raise ValueError("model endpoint response has no data list")

    model_ids: set[str] = set()
    for item in raw_models:
        if not isinstance(item, Mapping) or not isinstance(item.get("id"), str):
            continue
        model = item["id"]
        model_ids.add(model.split("/", 1)[1] if model.startswith("opencode/") else model)
    return frozenset(model_ids)


def fetch_advertised_model_ids(
    url: str,
    *,
    timeout_seconds: float = 5.0,
    opener: Callable[..., Any] = urlopen,
) -> frozenset[str]:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "browser-node-harness"})
    with opener(request, timeout=timeout_seconds) as response:
        payload = json.load(response)
    if not isinstance(payload, Mapping):
        raise ValueError("model endpoint response must be a JSON object")
    return parse_advertised_model_ids(payload)


def _is_zero_price(value: Any) -> bool:
    try:
        return Decimal(str(value)) == 0
    except (InvalidOperation, ValueError):
        return False


def _all_prices_are_zero(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, Mapping):
        return all(_all_prices_are_zero(item) for item in value.values())
    if isinstance(value, list):
        return all(_all_prices_are_zero(item) for item in value)
    return _is_zero_price(value)


def _openrouter_model_score(model: Mapping[str, Any]) -> float:
    model_id = str(model.get("id", "")).lower()
    name = str(model.get("name", "")).lower()
    description = str(model.get("description", "")).lower()
    searchable = f"{model_id} {name} {description}"
    score = 0.0

    supported_parameters = model.get("supported_parameters", ())
    if isinstance(supported_parameters, list):
        if "tools" in supported_parameters:
            score += 100
        if "tool_choice" in supported_parameters:
            score += 25
        if "reasoning" in supported_parameters or "include_reasoning" in supported_parameters:
            score += 15

    if "coder" in searchable or "coding" in searchable:
        score += 35
    if "agent" in searchable:
        score += 20
    if "router" in searchable:
        score -= 100

    benchmark_sources: list[Mapping[str, Any]] = [model]
    for field in ("benchmarks", "evaluations"):
        value = model.get(field)
        if isinstance(value, Mapping):
            benchmark_sources.append(value)
            artificial = value.get("artificial_analysis")
            if isinstance(artificial, Mapping):
                benchmark_sources.append(artificial)
    for key, weight in (
        ("coding_index", 2.0),
        ("agentic_index", 2.5),
        ("intelligence_index", 0.5),
        ("artificial_analysis_coding_index", 2.0),
        ("artificial_analysis_agentic_index", 2.5),
        ("artificial_analysis_intelligence_index", 0.5),
    ):
        for source in benchmark_sources:
            try:
                score += float(source[key]) * weight
                break
            except (KeyError, TypeError, ValueError):
                continue

    try:
        score += min(float(model.get("context_length", 0)) / 100_000, 10)
    except (TypeError, ValueError):
        pass
    return score


def parse_openrouter_free_models(payload: Mapping[str, Any]) -> tuple[str, ...]:
    """Return OpenRouter models whose catalog lists no non-zero price."""

    return parse_openrouter_free_catalog(payload)[0]


def parse_openrouter_free_catalog(
    payload: Mapping[str, Any],
) -> tuple[tuple[str, ...], dict[str, float]]:
    """Return free models and benchmark scores from one OpenRouter response."""

    raw_models = payload.get("data")
    if not isinstance(raw_models, list):
        raise ValueError("OpenRouter response has no data list")

    candidates: list[tuple[float, str]] = []
    scores: dict[str, float] = {}
    for item in raw_models:
        if not isinstance(item, Mapping) or not isinstance(item.get("id"), str):
            continue
        model_id = item["id"]
        is_free_reference = model_id == "openrouter/free" or model_id.endswith(":free")
        pricing = item.get("pricing")
        if not is_free_reference or not isinstance(pricing, Mapping):
            continue
        if "prompt" not in pricing or "completion" not in pricing:
            continue
        if not _all_prices_are_zero(pricing):
            continue
        score = _openrouter_model_score(item)
        model = f"openrouter/{model_id}"
        candidates.append((score, model))
        for alias in (model_id, model_id.rsplit("/", 1)[-1]):
            scores[_normalized_model_name(alias)] = score

    candidates.sort(key=lambda item: (-item[0], item[1]))
    return tuple(model for _, model in candidates), scores


def fetch_openrouter_free_models(
    url: str,
    *,
    timeout_seconds: float = 5.0,
    opener: Callable[..., Any] = urlopen,
) -> tuple[str, ...]:
    return fetch_openrouter_free_catalog(url, timeout_seconds=timeout_seconds, opener=opener)[0]


def fetch_openrouter_free_catalog(
    url: str,
    *,
    timeout_seconds: float = 5.0,
    opener: Callable[..., Any] = urlopen,
) -> tuple[tuple[str, ...], dict[str, float]]:
    request = Request(url, headers={"Accept": "application/json", "User-Agent": "browser-node-harness"})
    with opener(request, timeout=timeout_seconds) as response:
        payload = json.load(response)
    if not isinstance(payload, Mapping):
        raise ValueError("OpenRouter response must be a JSON object")
    return parse_openrouter_free_catalog(payload)


def parse_nim_free_models(
    payload: Mapping[str, Any],
    free_model_ids: Iterable[str] = DEFAULT_NIM_FREE_MODEL_ORDER,
) -> tuple[str, ...]:
    """Return live NIM models from the explicit hosted-free allowlist."""

    raw_models = payload.get("data")
    if not isinstance(raw_models, list):
        raise ValueError("NIM response has no data list")

    configured = tuple(dict.fromkeys(str(item) for item in free_model_ids))
    allowed = set(configured) & DEFAULT_NIM_FREE_MODEL_IDS
    advertised: set[str] = set()
    for item in raw_models:
        if not isinstance(item, Mapping) or not isinstance(item.get("id"), str):
            continue
        model_id = item["id"]
        if model_id.startswith("nvidia/"):
            model_id = model_id.split("/", 1)[1]
        if model_id not in allowed:
            continue
        if item.get("free") is False or item.get("free_endpoint") is False:
            continue
        pricing = item.get("pricing")
        if pricing is not None and not _all_prices_are_zero(pricing):
            continue
        advertised.add(model_id)
    return tuple(f"nvidia/{model_id}" for model_id in configured if model_id in advertised)


def _normalized_model_name(value: str) -> str:
    value = value.lower().split(":", 1)[0]
    return re.sub(r"[^a-z0-9]+", "-", value).strip("-")


def parse_artificial_analysis_scores(payload: Mapping[str, Any]) -> dict[str, float]:
    """Extract coding/agentic scores keyed by stable model-name aliases."""

    raw_models = payload.get("data")
    if not isinstance(raw_models, list):
        raise ValueError("Artificial Analysis response has no data list")

    scores: dict[str, float] = {}
    for item in raw_models:
        if not isinstance(item, Mapping):
            continue
        evaluations = item.get("evaluations")
        if not isinstance(evaluations, Mapping):
            continue
        values: list[float] = []
        for key, weight in (
            ("artificial_analysis_coding_index", 0.6),
            ("artificial_analysis_agentic_index", 0.3),
            ("artificial_analysis_intelligence_index", 0.1),
        ):
            try:
                values.append(float(evaluations[key]) * weight)
            except (KeyError, TypeError, ValueError):
                continue
        if not values:
            continue
        score = sum(values)
        for field in ("slug", "name", "openrouter_api_id"):
            alias = item.get(field)
            if isinstance(alias, str) and alias:
                scores[_normalized_model_name(alias)] = score
    return scores


def fetch_artificial_analysis_scores(
    url: str,
    *,
    api_key: str,
    timeout_seconds: float = 5.0,
    opener: Callable[..., Any] = urlopen,
) -> dict[str, float]:
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "browser-node-harness",
            "x-api-key": api_key,
        },
    )
    with opener(request, timeout=timeout_seconds) as response:
        payload = json.load(response)
    if not isinstance(payload, Mapping):
        raise ValueError("Artificial Analysis response must be a JSON object")
    return parse_artificial_analysis_scores(payload)


def rank_models_by_artificial_analysis(
    models: Iterable[str],
    scores: Mapping[str, float],
) -> tuple[str, ...]:
    """Prefer higher coding/agentic scores while preserving unknown-model order."""

    values = tuple(models)
    if not scores:
        return values

    def score(model: str) -> float:
        _, _, model_id = model.partition("/")
        aliases = (
            _normalized_model_name(model_id),
            _normalized_model_name(model_id.rsplit("/", 1)[-1]),
            _normalized_model_name(model),
        )
        return max((scores.get(alias, float("-inf")) for alias in aliases), default=float("-inf"))

    return tuple(
        model
        for _, model in sorted(
            enumerate(values),
            key=lambda item: (-score(item[1]), item[0]),
        )
    )


def fetch_nim_free_models(
    url: str,
    *,
    api_key: str | None = None,
    free_model_ids: Iterable[str] = DEFAULT_NIM_FREE_MODEL_ORDER,
    timeout_seconds: float = 5.0,
    opener: Callable[..., Any] = urlopen,
) -> tuple[str, ...]:
    request_headers = {"Accept": "application/json", "User-Agent": "browser-node-harness"}
    if api_key:
        request_headers["Authorization"] = f"Bearer {api_key}"
    request = Request(url, headers=request_headers)
    with opener(request, timeout=timeout_seconds) as response:
        payload = json.load(response)
    if not isinstance(payload, Mapping):
        raise ValueError("NIM response must be a JSON object")
    return parse_nim_free_models(payload, free_model_ids)


def select_free_models(
    model_order: Iterable[str],
    advertised_model_ids: frozenset[str] | None,
) -> tuple[str, ...]:
    """Keep only known-free models that are currently advertised by Zen."""

    selected: list[str] = []
    seen: set[str] = set()
    for model in model_order:
        model_id = _model_id(model)
        if model_id not in FREE_MODEL_IDS:
            raise ValueError(f"refusing non-free or unknown OpenCode model: {model}")
        if advertised_model_ids is not None and model_id not in advertised_model_ids:
            continue
        if model not in seen:
            selected.append(model)
            seen.add(model)
    return tuple(selected)


def select_model_chain(
    model_order: Iterable[str],
    advertised_zen_model_ids: frozenset[str] | None,
    advertised_openrouter_models: frozenset[str] | None,
    advertised_nim_models: frozenset[str] | None = None,
) -> tuple[str, ...]:
    """Validate and filter a mixed Zen/OpenRouter/NIM free-model chain."""

    selected: list[str] = []
    seen: set[str] = set()
    for model in model_order:
        provider, model_id = _provider_model_id(model)
        if provider == "opencode":
            if model_id not in FREE_MODEL_IDS:
                raise ValueError(f"refusing non-free or unknown OpenCode model: {model}")
            if advertised_zen_model_ids is not None and model_id not in advertised_zen_model_ids:
                continue
        elif provider == "openrouter":
            if advertised_openrouter_models is not None and model not in advertised_openrouter_models:
                continue
        elif advertised_nim_models is None or model not in advertised_nim_models:
            raise ValueError(f"refusing NIM model without verified zero pricing: {model}")
        if model not in seen:
            selected.append(model)
            seen.add(model)
    return tuple(selected)


def order_model_chain_for_slot(models: tuple[str, ...], slot: int) -> tuple[str, ...]:
    """Give parallel attempts distinct provider starts, preserving quality within each provider."""

    providers = tuple(dict.fromkeys(model.split("/", 1)[0] for model in models))
    if not providers:
        return models
    preferred = providers[slot % len(providers)]
    return tuple(
        model
        for provider in (preferred, *(item for item in providers if item != preferred))
        for model in models
        if model.split("/", 1)[0] == provider
    )


def is_quota_error(*outputs: str) -> bool:
    return bool(_QUOTA_ERROR.search("\n".join(outputs)))


def is_model_unavailable_error(*outputs: str) -> bool:
    return bool(_MODEL_UNAVAILABLE_ERROR.search("\n".join(outputs)))


def _tail(value: str, limit: int = 12_000) -> str:
    return value if len(value) <= limit else f"... <output truncated> ...\n{value[-limit:]}"


def _write_agent_metadata(*, provider: str, model: str, status: str) -> None:
    raw_path = os.environ.get("BNH_AGENT_METADATA_FILE")
    if not raw_path:
        return
    path = Path(raw_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps({"provider": provider, "model": model, "status": status}, indent=2),
        encoding="utf-8",
    )
    temporary.replace(path)


def _opencode_auth_path() -> Path:
    configured = os.environ.get("BNH_OPENCODE_AUTH_FILE")
    if configured:
        return Path(configured).expanduser()
    data_home = os.environ.get("XDG_DATA_HOME")
    if data_home:
        return Path(data_home).expanduser() / "opencode" / "auth.json"
    return Path.home() / ".local" / "share" / "opencode" / "auth.json"


def load_opencode_provider_key(provider: str, *, auth_path: Path | None = None) -> str | None:
    """Reuse a provider credential already stored by OpenCode."""

    try:
        payload = json.loads((auth_path or _opencode_auth_path()).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, Mapping):
        return None
    credentials = payload.get(provider)
    if not isinstance(credentials, Mapping):
        return None
    key = credentials.get("key")
    return key.strip() if isinstance(key, str) and key.strip() else None


def _write_attempt_output(stdout: str, stderr: str) -> None:
    if stdout:
        sys.stdout.write(stdout)
        sys.stdout.flush()
    if stderr:
        sys.stderr.write(stderr)
        sys.stderr.flush()


def _worktree_has_changes(cwd: Path, *, timeout_seconds: float = 10.0) -> bool:
    """Return whether the agent left a reviewable change in its worktree.

    An inspection failure is treated as changed so a broken Git checkout does
    not silently trigger another model and hide the real infrastructure error.
    """

    try:
        result = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all"],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
            timeout=timeout_seconds,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return True
    if result.returncode != 0:
        return True
    return bool(result.stdout.strip())


def _run_model(
    *,
    model: str,
    prompt: str,
    cwd: Path,
    agent_name: str,
    opencode_binary: str,
    opencode_config_path: Path | None = None,
    nim_api_key: str | None = None,
) -> subprocess.CompletedProcess[str]:
    command = [opencode_binary, "run", "--model", model, "--auto", "--dir", str(cwd)]
    if agent_name:
        command.extend(("--agent", agent_name))
    child_environment = os.environ.copy()
    configured_nim_api_key = (
        child_environment.get("BNH_NIM_API_KEY")
        or child_environment.get("NVIDIA_API_KEY")
        or nim_api_key
    )
    if configured_nim_api_key:
        child_environment["NVIDIA_API_KEY"] = configured_nim_api_key
    if opencode_config_path is not None:
        child_environment["OPENCODE_CONFIG"] = str(opencode_config_path)
    process = subprocess.Popen(
        command,
        cwd=cwd,
        env=child_environment,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        errors="replace",
        bufsize=1,
        start_new_session=(os.name != "nt"),
    )
    stdout: list[str] = []
    stderr: list[str] = []
    output_lock = threading.Lock()
    last_output_at = time.monotonic()

    def pump(pipe: Any, chunks: list[str], stream: Any) -> None:
        nonlocal last_output_at
        for line in iter(pipe.readline, ""):
            chunks.append(line)
            with output_lock:
                last_output_at = time.monotonic()
            stream.write(line)
            stream.flush()
        pipe.close()

    stdout_thread = threading.Thread(target=pump, args=(process.stdout, stdout, sys.stdout), daemon=True)
    stderr_thread = threading.Thread(target=pump, args=(process.stderr, stderr, sys.stderr), daemon=True)
    stdout_thread.start()
    stderr_thread.start()
    try:
        assert process.stdin is not None
        process.stdin.write(prompt)
        process.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    try:
        idle_timeout = max(
            0.0,
            float(os.environ.get("BNH_OPENCODE_MODEL_IDLE_TIMEOUT_SECONDS", "600")),
        )
    except ValueError:
        idle_timeout = 600.0
    idle_timed_out = False
    while process.poll() is None:
        if idle_timeout and time.monotonic() - last_output_at >= idle_timeout:
            marker = f"bnh-opencode: model idle timeout after {int(idle_timeout)} seconds"
            print(marker, file=sys.stderr)
            stderr.append(marker + "\n")
            idle_timed_out = True
            if os.name == "nt":
                process.terminate()
            else:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            break
        time.sleep(0.25)
    process.wait()
    if idle_timed_out and process.returncode == 0:
        process.returncode = 1
    stdout_thread.join(timeout=3)
    stderr_thread.join(timeout=3)
    completed = subprocess.CompletedProcess(command, process.returncode, "".join(stdout), "".join(stderr))
    completed._bnh_streamed = True
    return completed


def _write_nim_opencode_config(base_url: str | None) -> Path | None:
    """Point OpenCode's native NVIDIA provider at a configured NIM endpoint."""

    if not base_url:
        return None
    metadata_path = os.environ.get("BNH_AGENT_METADATA_FILE")
    if not metadata_path:
        return None
    path = Path(metadata_path).parent / "opencode-nim.json"
    path.write_text(
        json.dumps({
            "$schema": "https://opencode.ai/config.json",
            "provider": {"nvidia": {"options": {"baseURL": base_url}}},
        }, indent=2),
        encoding="utf-8",
    )
    return path


def _catalog_path() -> Path | None:
    raw_path = os.environ.get("BNH_OPENCODE_CATALOG_CACHE", "").strip()
    return Path(raw_path) if raw_path else None


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").lower() in {"1", "true", "yes", "on"}


def _cached_strings(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(str(item) for item in value if isinstance(item, str) and item)


def _cached_scores(value: Any) -> dict[str, float]:
    if not isinstance(value, Mapping):
        return {}
    return {
        str(key): float(item)
        for key, item in value.items()
        if isinstance(item, (int, float))
    }


def main() -> int:
    prompt = sys.stdin.read()
    try:
        model_order = parse_model_order(os.environ.get("BNH_OPENCODE_MODEL_ORDER"))
    except ValueError as exc:
        print(f"bnh-opencode: {exc}", file=sys.stderr)
        return 2
    models_url = os.environ.get("BNH_OPENCODE_MODELS_URL", DEFAULT_MODELS_URL)
    openrouter_url = os.environ.get("BNH_OPENROUTER_MODELS_URL", DEFAULT_OPENROUTER_MODELS_URL)
    nim_base_url = os.environ.get("BNH_NIM_BASE_URL") or os.environ.get("NVIDIA_BASE_URL")
    nim_models_url = os.environ.get("BNH_NIM_MODELS_URL")
    if not nim_models_url:
        nim_models_url = (
            f"{nim_base_url.rstrip('/')}/models" if nim_base_url else DEFAULT_NIM_MODELS_URL
        )
    nim_api_key = (
        os.environ.get("BNH_NIM_API_KEY")
        or os.environ.get("NVIDIA_API_KEY")
        or load_opencode_provider_key("nvidia")
    )

    explicit_order = os.environ.get("BNH_OPENCODE_MODEL_ORDER")
    include_openrouter = os.environ.get("BNH_OPENCODE_INCLUDE_OPENROUTER", "true").lower() not in {"0", "false", "no"}
    include_nim = os.environ.get("BNH_OPENCODE_INCLUDE_NIM", "true").lower() not in {"0", "false", "no"}
    wants_nim = explicit_order is None or any(
        item.strip().startswith("nvidia/") for item in (explicit_order or "").split(",")
    )
    configured_free_ids = tuple(
        item.strip()
        for item in os.environ.get(
            "BNH_NIM_FREE_MODELS",
            ",".join(DEFAULT_NIM_FREE_MODEL_ORDER),
        ).split(",")
        if item.strip()
    )
    catalog_path = _catalog_path()
    catalog_key = make_cache_key(
        {
            "ranker": 2,
            "zen_url": models_url,
            "openrouter_url": openrouter_url,
            "nim_url": nim_models_url,
            "artificial_analysis_url": os.environ.get(
                "BNH_ARTIFICIAL_ANALYSIS_MODELS_URL",
                DEFAULT_ARTIFICIAL_ANALYSIS_MODELS_URL,
            ),
            "explicit_order": explicit_order or "",
            "base_order": model_order,
            "include_openrouter": include_openrouter,
            "include_nim": include_nim and wants_nim,
            "nim_models": configured_free_ids,
            "has_nim_credential": bool(nim_api_key or nim_base_url),
            "has_artificial_analysis_key": bool(os.environ.get("BNH_ARTIFICIAL_ANALYSIS_API_KEY")),
        }
    )
    catalog = None
    if not _env_flag("BNH_OPENCODE_REFRESH_CATALOG"):
        catalog = load_catalog(catalog_path, catalog_key)
    if catalog is not None:
        print("bnh-opencode: using cached model ranking", file=sys.stderr)
        advertised_value = catalog.get("advertised_zen")
        advertised = None if advertised_value is None else frozenset(_cached_strings(advertised_value))
        openrouter_models = _cached_strings(catalog.get("openrouter_models"))
        openrouter_scores = _cached_scores(catalog.get("openrouter_scores"))
        nim_value = catalog.get("nim_models")
        nim_models = None if nim_value is None else _cached_strings(nim_value)
        artificial_analysis_scores = _cached_scores(catalog.get("artificial_analysis_scores"))
    else:
        catalog_refresh_ok = True
        try:
            advertised = fetch_advertised_model_ids(
                models_url,
                timeout_seconds=float(os.environ.get("BNH_OPENCODE_MODELS_TIMEOUT_SECONDS", "5")),
            )
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            advertised = None
            catalog_refresh_ok = False
            print(f"bnh-opencode: could not refresh Zen models ({type(exc).__name__}: {exc}); using built-in list", file=sys.stderr)

        openrouter_models = ()
        openrouter_scores = {}
        if include_openrouter:
            try:
                openrouter_models, openrouter_scores = fetch_openrouter_free_catalog(
                    openrouter_url,
                    timeout_seconds=float(os.environ.get("BNH_OPENROUTER_MODELS_TIMEOUT_SECONDS", "5")),
                )
            except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
                catalog_refresh_ok = False
                print(f"bnh-opencode: could not refresh OpenRouter models ({type(exc).__name__}: {exc}); skipping OpenRouter", file=sys.stderr)

        artificial_analysis_scores = {}
        artificial_analysis_key = os.environ.get("BNH_ARTIFICIAL_ANALYSIS_API_KEY")
        if artificial_analysis_key:
            try:
                artificial_analysis_scores = fetch_artificial_analysis_scores(
                    os.environ.get(
                        "BNH_ARTIFICIAL_ANALYSIS_MODELS_URL",
                        DEFAULT_ARTIFICIAL_ANALYSIS_MODELS_URL,
                    ),
                    api_key=artificial_analysis_key,
                    timeout_seconds=float(os.environ.get("BNH_ARTIFICIAL_ANALYSIS_TIMEOUT_SECONDS", "5")),
                )
                openrouter_models = rank_models_by_artificial_analysis(
                    openrouter_models,
                    artificial_analysis_scores,
                )
            except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
                catalog_refresh_ok = False
                print(
                    f"bnh-opencode: could not refresh Artificial Analysis scores ({type(exc).__name__}: {exc}); using provider rankings",
                    file=sys.stderr,
                )

        nim_models = ()
        if include_nim and wants_nim:
            if not nim_api_key and not nim_base_url:
                nim_models = None
                print("bnh-opencode: no NVIDIA NIM credential is available; skipping NIM", file=sys.stderr)
            else:
                try:
                    nim_models = fetch_nim_free_models(
                        nim_models_url,
                        api_key=nim_api_key,
                        free_model_ids=configured_free_ids,
                        timeout_seconds=float(os.environ.get("BNH_NIM_MODELS_TIMEOUT_SECONDS", "5")),
                    )
                except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
                    nim_models = None
                    catalog_refresh_ok = False
                    print(f"bnh-opencode: could not refresh NIM models ({type(exc).__name__}: {exc}); skipping NIM", file=sys.stderr)

        if catalog_refresh_ok:
            save_catalog(
                catalog_path,
                catalog_key,
                {
                    "advertised_zen": None if advertised is None else sorted(advertised),
                    "openrouter_models": list(openrouter_models),
                    "openrouter_scores": openrouter_scores,
                    "artificial_analysis_scores": artificial_analysis_scores,
                    "nim_models": None if nim_models is None else list(nim_models),
                },
            )

    advertised_openrouter = frozenset(openrouter_models) if include_openrouter else frozenset()
    advertised_nim = frozenset(nim_models) if nim_models is not None else None
    if explicit_order is None:
        model_order = model_order + openrouter_models
        if nim_models:
            model_order = model_order + rank_models_by_artificial_analysis(
                nim_models,
                artificial_analysis_scores or openrouter_scores,
            )

    try:
        models = select_model_chain(model_order, advertised, advertised_openrouter, advertised_nim)
    except ValueError as exc:
        print(f"bnh-opencode: {exc}", file=sys.stderr)
        return 2
    if not models:
        print("bnh-opencode: no configured free models are currently advertised", file=sys.stderr)
        return 2

    try:
        model_offset = max(0, int(os.environ.get("BNH_OPENCODE_MODEL_OFFSET", "0")))
    except ValueError:
        model_offset = 0
    models = order_model_chain_for_slot(models, model_offset)
    try:
        max_models = max(1, int(os.environ.get("BNH_OPENCODE_MAX_MODELS", "6")))
    except ValueError:
        max_models = 6
    if len(models) > max_models:
        print(
            f"bnh-opencode: limiting fallback chain to {max_models} verified-free models",
            file=sys.stderr,
        )
        models = models[:max_models]

    cwd = Path.cwd()
    agent_name = os.environ.get("BNH_OPENCODE_AGENT", "build")
    opencode_binary = os.environ.get("BNH_OPENCODE_BINARY", "opencode")
    opencode_config_path = _write_nim_opencode_config(nim_base_url)
    last_return_code = 1

    for index, model in enumerate(models, start=1):
        print(f"bnh-opencode: trying {model} ({index}/{len(models)})", file=sys.stderr)
        provider, model_id = model.split("/", 1)
        _write_agent_metadata(provider=provider, model=model_id, status="running")
        try:
            result = _run_model(
                model=model,
                prompt=prompt,
                cwd=cwd,
                agent_name=agent_name,
                opencode_binary=opencode_binary,
                opencode_config_path=opencode_config_path,
                nim_api_key=nim_api_key,
            )
        except OSError as exc:
            print(f"bnh-opencode: could not start OpenCode: {type(exc).__name__}: {exc}", file=sys.stderr)
            return 127

        last_return_code = result.returncode or 1
        has_changes = _worktree_has_changes(cwd)
        if result.returncode == 0:
            if not has_changes:
                print(
                    f"bnh-opencode: {model} returned without a working-tree change; "
                    "switching to the next free model",
                    file=sys.stderr,
                )
                _write_agent_metadata(provider=provider, model=model_id, status="switching")
                continue
            if not getattr(result, "_bnh_streamed", False):
                _write_attempt_output(result.stdout, result.stderr)
            _write_agent_metadata(provider=provider, model=model_id, status="finished")
            return 0

        retryable_error = is_quota_error(result.stdout, result.stderr) or is_model_unavailable_error(
            result.stdout,
            result.stderr,
        )
        if retryable_error:
            reason = "quota-limited or unavailable"
        elif has_changes:
            if not getattr(result, "_bnh_streamed", False):
                _write_attempt_output(result.stdout, result.stderr)
            _write_agent_metadata(provider=provider, model=model_id, status="failed")
            return last_return_code
        else:
            reason = "failed without a working-tree change"
            if not getattr(result, "_bnh_streamed", False):
                _write_attempt_output(result.stdout, result.stderr)
        print(f"bnh-opencode: {model} {reason}; switching to the next free model", file=sys.stderr)
        _write_agent_metadata(provider=provider, model=model_id, status="switching")

    print("bnh-opencode: every currently available free model was quota-limited or unavailable", file=sys.stderr)
    return last_return_code


if __name__ == "__main__":
    raise SystemExit(main())
