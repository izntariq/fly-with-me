#!/usr/bin/env bash
# Create .venv-allin1, the song analyser's environment (All-In-One + Demucs on MLX), from requirements-allin1.txt.
# Optional: the app runs without it, but then dropped tracks keep the estimated beat grid instead of the analysed one.
# Needs uv (https://docs.astral.sh/uv/) and macOS 14+ on Apple silicon. About 1.3 GB installed, plus ~170 MB of
# models fetched on the first analysis.
#   scripts/setup_allin1.sh            create it (refuses if it already exists)
#   scripts/setup_allin1.sh --force    delete and recreate it
set -euo pipefail
cd "$(dirname "$0")/.."

PYTHON_VERSION=3.11.14          # the tested interpreter
VENV=.venv-allin1

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "setup_allin1: the song analyser runs Demucs through MLX, which needs macOS on Apple silicon" >&2
  echo "  (this is $(uname -s) $(uname -m)). The app works without it." >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "setup_allin1: uv not found. Install it (https://docs.astral.sh/uv/getting-started/installation/)," >&2
  echo "  for example with:  brew install uv" >&2
  exit 1
fi
if [ -e "$VENV" ]; then
  if [ "${1:-}" = --force ]; then
    echo "removing the old $VENV"
    rm -rf "$VENV"
  else
    echo "setup_allin1: $VENV already exists; run with --force to recreate it" >&2
    exit 1
  fi
fi

echo "creating $VENV (Python $PYTHON_VERSION; uv downloads it if needed)"
uv venv --python "$PYTHON_VERSION" "$VENV"
echo "installing requirements-allin1.txt (about 1.3 GB)"
if ! uv pip install --python "$VENV/bin/python" -r requirements-allin1.txt; then
  echo "setup_allin1: the install failed; $VENV is left as it is. Fix the error above and run again with --force." >&2
  exit 1
fi
"$VENV/bin/python" -c "import allin1_infer, demucs_mlx, torch, soundfile, librosa" \
  || { echo "setup_allin1: installed, but the analyser's imports fail (see above)" >&2; exit 1; }
echo "done: the server will analyse dropped tracks in the background (models download on the first one)"
