#!/usr/bin/env python3
"""Link the active integration worktree to the shared adapter runtime."""

from __future__ import annotations

import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from browser_node_harness.runtime_links import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main(project_root=PROJECT_ROOT))
