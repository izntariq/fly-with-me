#!/usr/bin/env bash
# Start the fly brain server and open the app (macOS and Linux).
set -euo pipefail
cd "$(dirname "$0")"

command -v python3 >/dev/null || { echo "python3 not found (3.10+ needed)"; exit 1; }
python3 -c "import numpy, pandas, pyarrow, numba, aiohttp" 2>/dev/null || {
  echo "missing Python packages — install them with:  python3 -m pip install -r requirements.txt"; exit 1; }

if [ ! -f vendor/Drosophila_brain_model/Connectivity_783.parquet ]; then
  echo "fetching the FlyWire v783 connectome model (Shiu et al.; data CC BY-NC 4.0)…"
  git clone --depth 1 https://github.com/philshiu/Drosophila_brain_model.git vendor/Drosophila_brain_model
fi
if [ ! -f data/neuron_annotations.tsv ]; then
  echo "fetching FlyWire neuron annotations (Schlegel et al.; CC BY-NC 4.0)…"
  mkdir -p data
  curl -sL -o data/neuron_annotations.tsv \
    https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv
fi

PORT="${PORT:-8765}"
URL="http://localhost:$PORT"
opener=""
if command -v open >/dev/null; then opener=open; elif command -v xdg-open >/dev/null; then opener=xdg-open; fi
if [ -n "$opener" ]; then ( sleep 4 && "$opener" "$URL" ) >/dev/null 2>&1 & else echo "open $URL in your browser"; fi
exec python3 -m flybrain.server --port "$PORT" "$@"
