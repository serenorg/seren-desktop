#!/usr/bin/env bash
# ABOUTME: Builds the OpenClaw sidecar from the openclaw repo.
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

echo "[build-openclaw] Source: $OPENCLAW_DIR"
echo "[build-openclaw] Destination: $DEST_DIR"

# --- 1. Build openclaw if dist/ is missing ---
if [ ! -d "$OPENCLAW_DIR/dist" ]; then
  echo "[build-openclaw] Building openclaw..."
  (cd "$OPENCLAW_DIR" && pnpm build)
fi

# --- 2. Create openclaw directory in embedded-runtime ---
OPENCLAW_RUNTIME_DIR="$DEST_DIR/openclaw"
rm -rf "$OPENCLAW_RUNTIME_DIR"
mkdir -p "$OPENCLAW_RUNTIME_DIR"

echo "[build-openclaw] Copying openclaw dist..."
cp -R "$OPENCLAW_DIR/dist" "$OPENCLAW_RUNTIME_DIR/dist"
cp "$OPENCLAW_DIR/openclaw.mjs" "$OPENCLAW_RUNTIME_DIR/openclaw.mjs"
cp "$OPENCLAW_DIR/package.json" "$OPENCLAW_RUNTIME_DIR/package.json"

# Copy skills and assets if they exist
[ -d "$OPENCLAW_DIR/skills" ] && cp -R "$OPENCLAW_DIR/skills" "$OPENCLAW_RUNTIME_DIR/skills"
[ -d "$OPENCLAW_DIR/assets" ] && cp -R "$OPENCLAW_DIR/assets" "$OPENCLAW_RUNTIME_DIR/assets"
[ -d "$OPENCLAW_DIR/extensions" ] && cp -R "$OPENCLAW_DIR/extensions" "$OPENCLAW_RUNTIME_DIR/extensions"

echo "[build-openclaw] Installing production dependencies..."
(cd "$OPENCLAW_RUNTIME_DIR" && pnpm install --prod --ignore-scripts 2>&1 | tail -5)

# --- 3. Create the openclaw wrapper script ---
WRAPPER="$DEST_DIR/bin/openclaw"
cat > "$WRAPPER" << 'WRAPPER_EOF'
#!/usr/bin/env bash
# ABOUTME: Wrapper script that launches openclaw gateway via Node.js.

set -euo pipefail

# Default OpenClaw gateway env vars if not already set by the parent process
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-3100}"
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
export OPENCLAW_GATEWAY_HOST="${OPENCLAW_GATEWAY_HOST:-127.0.0.1}"

# Disable channels that aren't configured (faster startup)
# Channels are connected dynamically via the Seren UI
export OPENCLAW_SKIP_CHANNELS="${OPENCLAW_SKIP_CHANNELS:-1}"

# Resolve the openclaw package directory (sibling to bin/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_PKG="$SCRIPT_DIR/../openclaw"

if [ ! -f "$OPENCLAW_PKG/openclaw.mjs" ]; then
  echo "[openclaw] ERROR: openclaw.mjs not found at $OPENCLAW_PKG" >&2
  exit 1
fi

# Find node: prefer embedded runtime, then system
if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  echo "[openclaw] ERROR: Node.js not found in PATH" >&2
  exit 1
fi

NODE_VERSION=$($NODE_BIN --version 2>/dev/null || echo "unknown")
echo "[openclaw] Starting gateway on ${OPENCLAW_GATEWAY_HOST}:${OPENCLAW_GATEWAY_PORT} (node $NODE_VERSION)" >&2

exec "$NODE_BIN" "$OPENCLAW_PKG/openclaw.mjs" gateway
WRAPPER_EOF

chmod +x "$WRAPPER"

echo "[build-openclaw] Done. Wrapper at: $WRAPPER"
echo "[build-openclaw] OpenClaw package at: $OPENCLAW_RUNTIME_DIR"
echo "[build-openclaw] Total size: $(du -sh "$OPENCLAW_RUNTIME_DIR" | cut -f1)"
