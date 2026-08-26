#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_path="${1:-harness.toml}"
variant="${2:-${BNH_VARIANT:-v22}}"

export PYTHONPATH="$project_dir/src${PYTHONPATH:+:$PYTHONPATH}"

# The harness owns the 64-test target batches. Five target workers keep the
# suite moving without creating one browser process per test.
exec python3 -m browser_node_harness \
  --config "$config_path" \
  --variant "$variant" \
  scan \
  --browser-only \
  --no-oracle \
  --refresh \
  --target-concurrency 5 \
  --timeout-seconds 10 \
  --failure-limit 0
