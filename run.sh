#!/usr/bin/env bash
# Start the fly brain server and open the DJ app.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f vendor/Drosophila_brain_model/Connectivity_783.parquet ]; then
  echo "fetching the FlyWire v783 connectome model (Shiu et al.)…"
  git clone --depth 1 https://github.com/philshiu/Drosophila_brain_model.git vendor/Drosophila_brain_model
fi
if [ ! -f data/neuron_annotations.tsv ]; then
  echo "fetching FlyWire neuron annotations (Schlegel et al.)…"
  mkdir -p data
  curl -sL -o data/neuron_annotations.tsv \
    https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv
fi

PORT="${PORT:-8765}"
( sleep 4 && open "http://localhost:$PORT" ) >/dev/null 2>&1 &
exec python3 -m flybrain.server --port "$PORT" "$@"
