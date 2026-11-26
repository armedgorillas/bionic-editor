#!/usr/bin/env bash
# Portable end-to-end reproducible analysis entrypoint.
# Executed both by Bionic Hub's reproducible module runner AND directly by coders locally.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 1. Ensure isolated virtual environment exists
if [[ ! -x ".venv/bin/python" ]]; then
  if command -v uv >/dev/null 2>&1 && [[ -f "uv.lock" ]]; then
    uv sync --locked
  else
    python3 -m venv .venv
    if [[ -f "requirements.txt" ]]; then
      .venv/bin/pip install -q -r requirements.txt
    fi
  fi
fi

# 2. Ensure raw datasets listed in data/manifest.json are present & verified
if [[ -x "scripts/data-pull.sh" ]]; then
  ./scripts/data-pull.sh
fi

# 3. Run primary analysis pipeline if present
if [[ -f "code/run_pipeline.py" ]]; then
  .venv/bin/python code/run_pipeline.py
elif [[ -f "code/analyze.py" ]]; then
  .venv/bin/python code/analyze.py
else
  echo "No code/run_pipeline.py or code/analyze.py found yet."
fi

# 4. Run scientific validation tests if present, then refresh report if pipeline embeds results
if compgen -G "tests/scientific/test_*.py" >/dev/null 2>&1; then
  if .venv/bin/python -c "import pytest" >/dev/null 2>&1; then
    .venv/bin/python -m pytest -q tests/scientific
  else
    for t in tests/scientific/test_*.py; do
      .venv/bin/python "$t"
    done
  fi
  if [[ -f "code/analyze.py" ]]; then
    .venv/bin/python code/analyze.py
  fi
fi

echo "OK: Reproducible analysis run completed."
