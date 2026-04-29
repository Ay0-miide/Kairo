#!/usr/bin/env bash
# Downloads the Vosk small English model used by Kairo's offline speech engine.
# Idempotent: skips download if the model is already present.
#
# Usage: ./scripts/download-vosk-model.sh
#   Or:  npm run vosk:install   (if wired into package.json)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_DIR="$REPO_ROOT/server/models/vosk-en"
ZIP_NAME="vosk-model-small-en-us-0.15.zip"
URL="https://alphacephei.com/vosk/models/$ZIP_NAME"
EXTRACTED_NAME="vosk-model-small-en-us-0.15"

if [ -d "$MODEL_DIR" ] && [ -f "$MODEL_DIR/conf/model.conf" ]; then
  echo "[vosk] Model already present at $MODEL_DIR"
  exit 0
fi

mkdir -p "$REPO_ROOT/server/models"
cd "$REPO_ROOT/server/models"

echo "[vosk] Downloading $URL (~40MB)..."
curl -L -# -o "$ZIP_NAME" "$URL"

echo "[vosk] Extracting..."
unzip -q "$ZIP_NAME"
rm "$ZIP_NAME"

# Normalise directory name so the server doesn't have to track versions
if [ -d "$EXTRACTED_NAME" ] && [ ! -d "vosk-en" ]; then
  mv "$EXTRACTED_NAME" "vosk-en"
fi

echo "[vosk] Done. Model installed at $MODEL_DIR"
