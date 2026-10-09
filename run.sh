#!/usr/bin/env bash
# Start the fly brain server and open the DJ app.
#   ./run.sh [server options]       e.g. ./run.sh --flies 1, ./run.sh --cpu
#   PORT=8766 ./run.sh              another port (default 8765)
#   NO_BROWSER=1 ./run.sh           don't open a browser, just print the address
# The first run downloads the FlyWire v783 model (Shiu et al., ~180 MB, ~370 MB on disk) and the FlyWire neuron
# annotations (32 MB), both pinned to the versions this app was tested with and checked.
set -euo pipefail
cd "$(dirname "$0")"

SHIU_URL=https://github.com/philshiu/Drosophila_brain_model.git
SHIU_COMMIT=91bdd1e7dcf193f3e7ca5a8933497fcef63b7960
SHIU_DIR=vendor/Drosophila_brain_model
SHIU_FILES="Completeness_783.csv Connectivity_783.parquet"
# flyconnectome/flywire_annotations at 17fc577 (4 May 2026, "minor fixes for a few annotations")
ANNOT_URL=https://raw.githubusercontent.com/flyconnectome/flywire_annotations/17fc57722002e1a7d38cdd0c89ac382bf92718da/supplemental_files/Supplemental_file1_neuron_annotations.tsv
ANNOT_SHA256=9a4f8b2f843196074431ebd7cd883536afa1be86c8a4ce90970441e8be81d1be
ANNOT=data/neuron_annotations.tsv

die() { echo "run.sh: $*" >&2; exit 1; }

# --- Python: the project environment (.venv, with MLX for the GPU) if it exists, else the system python3
PY=python3
[ -x .venv/bin/python ] && PY=.venv/bin/python
command -v "$PY" >/dev/null 2>&1 || die "no python3 found. Install Python 3.12, then: python3.12 -m venv .venv && .venv/bin/pip install -r requirements.lock.txt"
PY_VER=$("$PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null) || die "$PY doesn't run"
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
  die "$PY is Python $PY_VER; the server needs Python 3.10 or newer (3.12 is the tested one). Create .venv with Python 3.12: see the README's Quick start"
fi
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'; then
  echo "run.sh: note: $PY is Python $PY_VER; only 3.12 is tested (requirements.txt needs 3.12+)" >&2
fi
if ! "$PY" -c 'import numpy, pandas, pyarrow, numba, aiohttp' 2>/dev/null; then
  # the pinned packages need Python 3.12: on an older python3, point at a 3.12 .venv rather than a pip that can't work
  if "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'; then
    die "$PY (Python $PY_VER) is missing the server's packages. Install them with: $PY -m pip install -r requirements.lock.txt (or make a .venv: see the README's Quick start)"
  fi
  die "$PY (Python $PY_VER) is missing the server's packages, which need Python 3.12. Make a .venv: uv venv --python 3.12 .venv && uv pip install -r requirements.lock.txt (see the README's Quick start)"
fi

# --- the Shiu et al. model, at the tested commit
shiu_complete() {
  for f in $SHIU_FILES; do [ -f "$SHIU_DIR/$f" ] || return 1; done
}
fetch_shiu() {
  local tmp="$SHIU_DIR.part"
  echo "fetching the FlyWire v783 connectome model (Shiu et al., commit ${SHIU_COMMIT:0:7}, ~180 MB)…"
  rm -rf "$tmp"
  mkdir -p vendor
  git init -q "$tmp"
  git -C "$tmp" remote add origin "$SHIU_URL"
  if ! git -C "$tmp" fetch --depth 1 origin "$SHIU_COMMIT"; then
    echo "run.sh: a shallow fetch of that commit failed; trying the full history…" >&2
    git -C "$tmp" fetch origin || { rm -rf "$tmp"; die "couldn't download $SHIU_URL (network?). Run ./run.sh again to retry."; }
  fi
  git -C "$tmp" -c advice.detachedHead=false checkout -q "$SHIU_COMMIT" \
    || { rm -rf "$tmp"; die "commit $SHIU_COMMIT isn't in $SHIU_URL any more (the upstream history changed): please open an issue"; }
  mv "$tmp" "$SHIU_DIR"
  shiu_complete || die "$SHIU_DIR is missing $SHIU_FILES after the download"
}
command -v git >/dev/null 2>&1 || shiu_complete || die "git is needed to download the Shiu et al. model; install git and run again"
if [ -d "$SHIU_DIR" ] && ! shiu_complete; then
  echo "run.sh: $SHIU_DIR is incomplete (an interrupted download?); removing it and downloading again" >&2
  rm -rf "$SHIU_DIR"
fi
if [ ! -d "$SHIU_DIR" ]; then
  fetch_shiu
elif [ -d "$SHIU_DIR/.git" ]; then
  have=$(git -C "$SHIU_DIR" rev-parse HEAD 2>/dev/null || echo unknown)
  [ "$have" = "$SHIU_COMMIT" ] \
    || echo "run.sh: note: $SHIU_DIR is at ${have:0:7}, not the tested ${SHIU_COMMIT:0:7}" >&2
fi

# --- the FlyWire neuron annotations (Schlegel et al.), checked against the tested file's SHA-256
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "need sha256sum or shasum to check the download"
  fi
}
# an older run.sh could save an error page under this name; a real table starts with its header
if [ -f "$ANNOT" ] && [ "$(head -c 21 "$ANNOT")" != "$(printf 'supervoxel_id\troot_id')" ]; then
  echo "run.sh: $ANNOT isn't the annotations table (a failed download?); downloading it again" >&2
  rm -f "$ANNOT"
fi
if [ ! -f "$ANNOT" ]; then
  echo "fetching FlyWire neuron annotations (Schlegel et al., 32 MB)…"
  mkdir -p data
  curl -fsSL --retry 3 -o "$ANNOT.part" "$ANNOT_URL" \
    || { rm -f "$ANNOT.part"; die "couldn't download $ANNOT_URL (network?). Run ./run.sh again to retry."; }
  got=$(sha256_of "$ANNOT.part")
  if [ "$got" != "$ANNOT_SHA256" ]; then
    rm -f "$ANNOT.part"
    die "the annotations download has SHA-256 $got, expected $ANNOT_SHA256; not using it"
  fi
  mv "$ANNOT.part" "$ANNOT"
fi

# --- the browser (a --port among the server options wins over PORT, as it does for the server)
PORT="${PORT:-8765}"
prev=
for a in "$@"; do
  case "$a" in --port=*) PORT="${a#--port=}" ;; esac
  [ "$prev" = --port ] && PORT="$a"
  prev="$a"
done
URL="http://localhost:$PORT"
OPENER=
if [ -z "${NO_BROWSER:-}" ]; then
  case "$(uname -s)" in
    Darwin) OPENER=open ;;
    Linux) command -v xdg-open >/dev/null 2>&1 && OPENER=xdg-open ;;
  esac
fi
if [ -n "$OPENER" ]; then
  echo "the app: $URL (opening it in your browser once the server is up)"
  ( sleep 4
    "$OPENER" "$URL" >/dev/null 2>&1 || echo "run.sh: couldn't open a browser ($OPENER failed); open $URL yourself" >&2
  ) &
else
  echo "the app: open $URL in your browser once the server is up"
fi

exec "$PY" -m flybrain.server --port "$PORT" "$@"
