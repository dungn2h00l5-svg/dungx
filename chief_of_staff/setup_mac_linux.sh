#!/usr/bin/env bash
# One-time setup for macOS / Linux:  bash setup_mac_linux.sh
set -e
cd "$(dirname "$0")"
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python -m ipykernel install --user --name chief-of-staff --display-name "Chief of Staff (Python)"
[ -f .env ] || cp .env.example .env
echo "Setup done. Put your ANTHROPIC_API_KEY in .env, then run: bash start_mac_linux.sh"
