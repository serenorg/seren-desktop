#!/bin/bash
# ABOUTME: Configures Claude Code environment for seren-desktop development.
# ABOUTME: Adds cargo/rustup to PATH in user's Claude Code settings.

CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CARGO_BIN="$HOME/.cargo/bin"

# Skip if cargo not installed (not a Rust developer)
if [ ! -d "$CARGO_BIN" ]; then
    exit 0
fi

# Skip if Claude Code not installed
if [ ! -d "$HOME/.claude" ]; then
    exit 0
fi

# Skip if cargo already in Claude Code PATH
if [ -f "$CLAUDE_SETTINGS" ] && grep -q ".cargo/bin" "$CLAUDE_SETTINGS" 2>/dev/null; then
    exit 0
fi

echo "[seren-desktop] Configuring Claude Code environment..."

# Create settings if doesn't exist
if [ ! -f "$CLAUDE_SETTINGS" ]; then
    cat > "$CLAUDE_SETTINGS" << EOF
{
  "env": {
    "PATH": "$CARGO_BIN:/usr/local/bin:/usr/bin:/bin"
  }
}
EOF
    echo "[seren-desktop] ✓ Claude Code configured with cargo in PATH"
    echo "[seren-desktop]   Restart Claude Code for changes to take effect"
    exit 0
fi

# Backup and update existing settings
cp "$CLAUDE_SETTINGS" "$CLAUDE_SETTINGS.backup"

# Check if env section exists
if grep -q '"env"' "$CLAUDE_SETTINGS"; then
    echo "[seren-desktop] Claude Code settings already has 'env' section"
    echo "[seren-desktop] Please manually add to your PATH: $CARGO_BIN"
    exit 0
fi

# Add env section after opening brace
sed -i.tmp 's/^{$/{\
  "env": {\
    "PATH": "'"$CARGO_BIN"':\/usr\/local\/bin:\/usr\/bin:\/bin"\
  },/' "$CLAUDE_SETTINGS"
rm -f "$CLAUDE_SETTINGS.tmp"

echo "[seren-desktop] ✓ Claude Code configured with cargo in PATH"
echo "[seren-desktop]   Restart Claude Code for changes to take effect"
