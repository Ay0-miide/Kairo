#!/usr/bin/env bash
# KAIRO — Download Node.js binaries for all Tauri target platforms
# Run this once before building: bash scripts/download-node-bins.sh
set -e

NODE_VERSION="22.14.0"
DEST="src-tauri/bin"
TMP=$(mktemp -d)

mkdir -p "$DEST"

echo "Downloading Node.js v${NODE_VERSION} binaries…"

# ── macOS Apple Silicon ───────────────────────────────────────────────────
if [ ! -f "$DEST/node-aarch64-apple-darwin" ]; then
  echo "  → macOS arm64"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz" \
    -o "$TMP/node-darwin-arm64.tar.gz"
  tar -xzf "$TMP/node-darwin-arm64.tar.gz" -C "$TMP"
  cp "$TMP/node-v${NODE_VERSION}-darwin-arm64/bin/node" "$DEST/node-aarch64-apple-darwin"
  chmod +x "$DEST/node-aarch64-apple-darwin"
else
  echo "  ✓ macOS arm64 already exists"
fi

# ── macOS Intel ───────────────────────────────────────────────────────────
if [ ! -f "$DEST/node-x86_64-apple-darwin" ]; then
  echo "  → macOS x64"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-x64.tar.gz" \
    -o "$TMP/node-darwin-x64.tar.gz"
  tar -xzf "$TMP/node-darwin-x64.tar.gz" -C "$TMP"
  cp "$TMP/node-v${NODE_VERSION}-darwin-x64/bin/node" "$DEST/node-x86_64-apple-darwin"
  chmod +x "$DEST/node-x86_64-apple-darwin"
else
  echo "  ✓ macOS x64 already exists"
fi

# ── Windows x64 ───────────────────────────────────────────────────────────
if [ ! -f "$DEST/node-x86_64-pc-windows-msvc.exe" ]; then
  echo "  → Windows x64"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip" \
    -o "$TMP/node-win-x64.zip"
  unzip -q "$TMP/node-win-x64.zip" -d "$TMP"
  cp "$TMP/node-v${NODE_VERSION}-win-x64/node.exe" "$DEST/node-x86_64-pc-windows-msvc.exe"
else
  echo "  ✓ Windows x64 already exists"
fi

# ── Linux x64 ─────────────────────────────────────────────────────────────
if [ ! -f "$DEST/node-x86_64-unknown-linux-gnu" ]; then
  echo "  → Linux x64"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
    -o "$TMP/node-linux-x64.tar.gz"
  tar -xzf "$TMP/node-linux-x64.tar.gz" -C "$TMP"
  cp "$TMP/node-v${NODE_VERSION}-linux-x64/bin/node" "$DEST/node-x86_64-unknown-linux-gnu"
  chmod +x "$DEST/node-x86_64-unknown-linux-gnu"
else
  echo "  ✓ Linux x64 already exists"
fi

rm -rf "$TMP"
echo ""
echo "✓ All Node.js binaries ready in $DEST/"
ls -lh "$DEST/"
