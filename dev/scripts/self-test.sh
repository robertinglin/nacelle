#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHONPATH=harness python -m unittest discover -s tests/python -v
for file in adapters/playwright/*.mjs adapters/playwright/*.js; do
  if [ -f "$file" ]; then
    node --check "$file"
  fi
done
