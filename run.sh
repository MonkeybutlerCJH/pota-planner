#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VENV_DIR=".venv"

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"

# Install/upgrade deps if pyproject.toml is newer than the venv marker
MARKER="$VENV_DIR/.installed"
if [ ! -f "$MARKER" ] || [ "pyproject.toml" -nt "$MARKER" ]; then
    echo "Installing dependencies..."
    pip install --quiet -e .
    touch "$MARKER"
fi

# Open browser on Linux if available
if command -v xdg-open &>/dev/null; then
    (sleep 1.5 && xdg-open http://localhost:8000) &
fi

exec python main.py
