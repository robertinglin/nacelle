"""Persistent model ranking and health state for coding-agent selection."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Mapping


CATALOG_VERSION = 1


def make_cache_key(values: Mapping[str, Any]) -> str:
    payload = json.dumps(values, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_catalog(path: Path | None, cache_key: str) -> dict[str, Any] | None:
    if path is None:
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, Mapping):
        return None
    if payload.get("version") != CATALOG_VERSION or payload.get("cache_key") != cache_key:
        return None
    return dict(payload)


def save_catalog(path: Path | None, cache_key: str, catalog: Mapping[str, Any]) -> None:
    if path is None:
        return
    payload = {
        "version": CATALOG_VERSION,
        "cache_key": cache_key,
        "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        **catalog,
    }
    _atomic_write(path, payload)


def _atomic_write(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    temporary.replace(path)
