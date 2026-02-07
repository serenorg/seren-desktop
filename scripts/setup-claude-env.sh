#!/bin/bash
# ABOUTME: Configures Claude Code environment for seren-desktop development.
# ABOUTME: Adds cargo/rustup to PATH in user's Claude Code settings.

set -e

CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CARGO_BIN="$HOME/.cargo/bin"

echo "Setting up Claude Code environment for seren-desktop..."

# Check if cargo is installed
if [ ! -d "$CARGO_BIN" ]; then
    echo "Error: Cargo not found at $CARGO_BIN"
    echo "Please install Rust first: https://rustup.rs"
    exit 1
fi

# Create .claude directory if it doesn't exist
mkdir -p "$HOME/.claude"

# Check if settings.json exists
if [ -f "$CLAUDE_SETTINGS" ]; then
    echo "Found existing Claude Code settings at $CLAUDE_SETTINGS"

    # Check if PATH is already configured
    if grep -q ".cargo/bin" "$CLAUDE_SETTINGS" 2>/dev/null; then
        echo "✓ Cargo is already in Claude Code PATH"
        exit 0
    fi

    # Backup existing settings
    cp "$CLAUDE_SETTINGS" "$CLAUDE_SETTINGS.backup"
    echo "Backed up existing settings to $CLAUDE_SETTINGS.backup"

    # Add env section with PATH if it doesn't exist
    # Using node/jq to safely modify JSON would be better, but keeping it simple
    if grep -q '"env"' "$CLAUDE_SETTINGS"; then
        echo "Warning: settings.json already has an 'env' section."
        echo "Please manually add this to your env.PATH:"
        echo "  $CARGO_BIN"
        exit 1
    fi

    # Insert env section after the opening brace
    # This is a simple approach - for complex settings, use jq
    sed -i.tmp 's/^{$/{\n  "env": {\n    "PATH": "'"$CARGO_BIN"':\/usr\/local\/bin:\/usr\/bin:\/bin"\n  },/' "$CLAUDE_SETTINGS"
    rm -f "$CLAUDE_SETTINGS.tmp"
else
    # Create new settings file
    cat > "$CLAUDE_SETTINGS" << EOF
{
  "env": {
    "PATH": "$CARGO_BIN:/usr/local/bin:/usr/bin:/bin"
  }
}
EOF
fi

echo "✓ Claude Code environment configured!"
echo "  Added $CARGO_BIN to PATH"
echo ""
echo "Restart Claude Code for changes to take effect."
