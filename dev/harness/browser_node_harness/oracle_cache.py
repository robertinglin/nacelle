from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any, Sequence

from .config import HarnessConfig
from .models import TestCase


_CACHE_SCHEMA_VERSION = 1
_COMMAND_TIMEOUT_SECONDS = 10
_SENSITIVE_ENV_MARKERS = (
    "API_KEY",
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "PRIVATE_KEY",
    "AUTH",
    "COOKIE",
    "CREDENTIAL",
)


def _run_command(argv: Sequence[str], *, cwd: Path) -> tuple[bool, str]:
    try:
        result = subprocess.run(
            list(argv),
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=_COMMAND_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False, ""
    output = (result.stdout or result.stderr).strip()
    return result.returncode == 0, output


def _binary_path(config: HarnessConfig) -> Path | None:
    configured = Path(config.project.node_binary)
    if configured.is_absolute():
        return configured
    if configured.parent != Path("."):
        return (config.project.node_repo / configured).resolve()
    found = shutil.which(config.project.node_binary)
    return None if found is None else Path(found).resolve()


def _file_sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    try:
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _node_identity(config: HarnessConfig) -> tuple[dict[str, Any], bool]:
    source_repo = config.project.node_repo.resolve()
    revision_ok, source_revision = _run_command(
        ["git", "rev-parse", "HEAD"],
        cwd=source_repo,
    )
    dirty_ok, source_dirty = _run_command(
        ["git", "status", "--porcelain"],
        cwd=source_repo,
    )
    binary = _binary_path(config)
    version_ok = False
    version = ""
    if binary is not None:
        version_ok, version = _run_command([str(binary), "--version"], cwd=source_repo)
    else:
        version_ok, version = _run_command([config.project.node_binary, "--version"], cwd=source_repo)

    binary_sha256 = _file_sha256(binary) if binary is not None else None
    identity = {
        "version": version,
        "source_revision": source_revision,
        "source_dirty": source_dirty,
        "binary_path": str(binary) if binary is not None else config.project.node_binary,
        "binary_sha256": binary_sha256,
    }
    cacheable = (
        revision_ok
        and dirty_ok
        and not source_dirty
        and version_ok
        and bool(version)
        and binary_sha256 is not None
    )
    return identity, cacheable


def _oracle_inputs(config: HarnessConfig, tests: Sequence[TestCase]) -> tuple[dict[str, Any], bool]:
    if config.oracle is None:
        raise ValueError("oracle cache requires an enabled oracle")
    node_identity, cacheable = _node_identity(config)
    oracle = config.oracle
    oracle_env = {}
    for key, value in sorted(oracle.env.items()):
        if any(marker in key.upper() for marker in _SENSITIVE_ENV_MARKERS):
            oracle_env[key] = {
                "sha256": hashlib.sha256(value.encode("utf-8")).hexdigest(),
                "length": len(value),
            }
        else:
            oracle_env[key] = value
    inputs: dict[str, Any] = {
        "schema_version": _CACHE_SCHEMA_VERSION,
        "node": node_identity,
        "oracle": {
            "command": list(oracle.command),
            "cwd": oracle.cwd,
            "timeout_seconds": oracle.timeout_seconds,
            "env": oracle_env,
            "inherit_env": oracle.inherit_env,
            "max_output_chars": oracle.max_output_chars,
            "protocol": oracle.protocol,
        },
        "discovery": {
            "include": list(config.discovery.include),
            "exclude": list(config.discovery.exclude),
            "limit": config.discovery.limit,
            "tests": [
                {
                    "path": test.path,
                    "source_sha256": test.source_sha256,
                    "flags": list(test.flags),
                    "modules": list(test.modules),
                    "size_bytes": test.size_bytes,
                    "source_override": test.source_override is not None,
                }
                for test in sorted(tests, key=lambda item: item.path)
            ],
        },
    }
    return inputs, cacheable


def build_oracle_cache_entry(config: HarnessConfig, tests: Sequence[TestCase]) -> dict[str, Any]:
    inputs, cacheable = _oracle_inputs(config, tests)
    encoded = json.dumps(inputs, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "schema_version": _CACHE_SCHEMA_VERSION,
        "key": hashlib.sha256(encoded).hexdigest(),
        "cacheable": cacheable,
        "inputs": inputs,
    }


def oracle_cache_path(config: HarnessConfig) -> Path:
    return config.project.state_dir / "oracle-cache.json"


def load_oracle_cache(config: HarnessConfig) -> dict[str, Any] | None:
    path = oracle_cache_path(config)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def oracle_cache_matches(config: HarnessConfig, entry: dict[str, Any]) -> bool:
    if not entry.get("cacheable"):
        return False
    cached = load_oracle_cache(config)
    return bool(
        cached
        and cached.get("schema_version") == _CACHE_SCHEMA_VERSION
        and cached.get("cacheable") is True
        and cached.get("key") == entry.get("key")
    )


def oracle_cache_statuses(config: HarnessConfig) -> dict[str, str]:
    cached = load_oracle_cache(config)
    if not cached:
        return {}
    statuses = cached.get("statuses")
    if not isinstance(statuses, dict):
        return {}
    return {
        str(path): str(status)
        for path, status in statuses.items()
        if isinstance(path, str) and isinstance(status, str)
    }


def save_oracle_cache(
    config: HarnessConfig,
    entry: dict[str, Any],
    statuses: dict[str, str] | None = None,
) -> None:
    if not entry.get("cacheable"):
        return
    path = oracle_cache_path(config)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    payload = dict(entry)
    if statuses is not None:
        payload["statuses"] = dict(sorted(statuses.items()))
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)
