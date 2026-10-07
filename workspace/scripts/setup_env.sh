#!/usr/bin/env bash
set -e

echo "Setting up Python virtual environment..."
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

echo "Generating initial mock data..."
python3 src/generate_mock_data.py

echo "Running validation tests..."
python3 scripts/run_tests.py

echo "Setup completed successfully."
