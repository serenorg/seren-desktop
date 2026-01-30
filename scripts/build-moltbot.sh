#!/usr/bin/env bash
# ABOUTME: Builds the Moltbot sidecar from the openclaw fork.
# ABOUTME: Copies dist + node_modules + wrapper to embedded-runtime for Tauri.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -z "${OPENCLAW_DIR:-}" ]; then
  # Try sibling of repo root first, then sibling of git toplevel (for worktrees)
  if [ -d "$REPO_ROOT/../openclaw" ]; then
    OPENCLAW_DIR="$(cd "$REPO_ROOT/../openclaw" && pwd)"
  else
    GIT_TOPLEVEL="$(git -C "$REPO_ROOT" rev-parse --show-toplevel 2>/dev/null || echo "$REPO_ROOT")"
    OPENCLAW_DIR="$(cd "$(dirname "$GIT_TOPLEVEL")/openclaw" && pwd)"
  fi
fi
DEST_DIR="$REPO_ROOT/src-tauri/embedded-runtime"

echo "[build-moltbot] Source: $OPENCLAW_DIR"
echo "[build-moltbot] Destination: $DEST_DIR"

# --- 1. Build openclaw if dist/ is missing ---
if [ ! -d "$OPENCLAW_DIR/dist" ]; then
  echo "[build-moltbot] Building openclaw..."
  (cd "$OPENCLAW_DIR" && pnpm build)
fi

# --- 2. Create moltbot directory in embedded-runtime ---
MOLTBOT_DIR="$DEST_DIR/moltbot"
rm -rf "$MOLTBOT_DIR"
mkdir -p "$MOLTBOT_DIR"

echo "[build-moltbot] Copying openclaw dist..."
cp -R "$OPENCLAW_DIR/dist" "$MOLTBOT_DIR/dist"
cp "$OPENCLAW_DIR/openclaw.mjs" "$MOLTBOT_DIR/openclaw.mjs"
cp "$OPENCLAW_DIR/package.json" "$MOLTBOT_DIR/package.json"

# Copy skills and assets if they exist
[ -d "$OPENCLAW_DIR/skills" ] && cp -R "$OPENCLAW_DIR/skills" "$MOLTBOT_DIR/skills"
[ -d "$OPENCLAW_DIR/assets" ] && cp -R "$OPENCLAW_DIR/assets" "$MOLTBOT_DIR/assets"
[ -d "$OPENCLAW_DIR/extensions" ] && cp -R "$OPENCLAW_DIR/extensions" "$MOLTBOT_DIR/extensions"

echo "[build-moltbot] Installing production dependencies..."
(cd "$MOLTBOT_DIR" && pnpm install --prod --ignore-scripts 2>&1 | tail -5)

# --- 3. Create the moltbot wrapper script ---
WRAPPER="$DEST_DIR/bin/moltbot"
cat > "$WRAPPER" << 'WRAPPER_EOF'
#!/usr/bin/env bash
# ABOUTME: Wrapper script that launches openclaw gateway via Node.js.
# ABOUTME: Translates MOLTBOT_* env vars to OPENCLAW_* env vars.

set -euo pipefail

# Translate Seren's Moltbot env vars to openclaw gateway env vars
export OPENCLAW_GATEWAY_PORT="${MOLTBOT_PORT:-3100}"
export OPENCLAW_GATEWAY_TOKEN="${MOLTBOT_HOOK_TOKEN:-}"
export OPENCLAW_GATEWAY_HOST="${MOLTBOT_HOST:-127.0.0.1}"

# Disable channels that aren't configured (faster startup)
# Channels are connected dynamically via the Seren UI
export OPENCLAW_SKIP_CHANNELS="${OPENCLAW_SKIP_CHANNELS:-1}"

# Resolve the moltbot package directory (sibling to bin/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOLTBOT_PKG="$SCRIPT_DIR/../moltbot"

if [ ! -f "$MOLTBOT_PKG/openclaw.mjs" ]; then
  echo "[moltbot] ERROR: openclaw.mjs not found at $MOLTBOT_PKG" >&2
  exit 1
fi

# Find node: prefer embedded runtime, then system
if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  echo "[moltbot] ERROR: Node.js not found in PATH" >&2
  exit 1
fi

NODE_VERSION=$($NODE_BIN --version 2>/dev/null || echo "unknown")
echo "[moltbot] Starting gateway on ${OPENCLAW_GATEWAY_HOST}:${OPENCLAW_GATEWAY_PORT} (node $NODE_VERSION)" >&2

exec "$NODE_BIN" "$MOLTBOT_PKG/openclaw.mjs" gateway
WRAPPER_EOF

chmod +x "$WRAPPER"

echo "[build-moltbot] Done. Wrapper at: $WRAPPER"
echo "[build-moltbot] Moltbot package at: $MOLTBOT_DIR"
echo "[build-moltbot] Total size: $(du -sh "$MOLTBOT_DIR" | cut -f1)"
