#!/bin/bash
# Build the acp_agent sidecar binary with correct target triple naming for Tauri

set -e

cd "$(dirname "$0")/.."

# Get target triple
TARGET_TRIPLE=$(rustc --print host-tuple)
echo "Building acp_agent for $TARGET_TRIPLE"

# Determine profile
PROFILE="${1:-debug}"
if [ "$PROFILE" = "release" ]; then
    CARGO_FLAGS="--release"
    TARGET_DIR="src-tauri/target/release"
else
    CARGO_FLAGS=""
    TARGET_DIR="src-tauri/target/debug"
fi

# Build acp_agent
(cd src-tauri && cargo build --bin acp_agent $CARGO_FLAGS)

# Create binaries directory if needed
mkdir -p src-tauri/binaries

# Copy with target triple suffix
EXT=""
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    EXT=".exe"
fi

cp "$TARGET_DIR/acp_agent$EXT" "src-tauri/binaries/acp_agent-$TARGET_TRIPLE$EXT"
chmod +x "src-tauri/binaries/acp_agent-$TARGET_TRIPLE$EXT"
echo "Copied to src-tauri/binaries/acp_agent-$TARGET_TRIPLE$EXT"
