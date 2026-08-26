#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
PYTHONPATH=src python -m unittest discover -s tests -v
for file in adapters/playwright/*.mjs adapters/playwright/*.js; do
  node --check "$file"
done
