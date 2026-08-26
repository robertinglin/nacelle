#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_path="${1:-harness.toml}"
if [[ "$#" -gt 0 ]]; then
  shift
fi

export PYTHONPATH="$project_dir/src${PYTHONPATH:+:$PYTHONPATH}"
exec python3 -m browser_node_harness --config "$config_path" start "$@"
