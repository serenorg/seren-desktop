#!/bin/bash
# Create GitHub labels for seren-desktop repository
# Run: gh auth login && ./scripts/create-labels.sh

set -e

REPO="serenorg/seren-desktop"

echo "Creating labels for $REPO..."

# Delete default labels (ignore errors if they don't exist)
for label in "bug" "documentation" "duplicate" "enhancement" "good first issue" "help wanted" "invalid" "question" "wontfix"; do
  gh label delete "$label" --repo $REPO --yes 2>/dev/null || true
done

# Type labels (what kind of work)
gh label create "type: bug" --color "d73a4a" --description "Something is broken" --repo $REPO
gh label create "type: feature" --color "a2eeef" --description "New functionality" --repo $REPO
gh label create "type: docs" --color "0075ca" --description "Documentation only" --repo $REPO
gh label create "type: refactor" --color "cfd3d7" --description "Code improvement, no behavior change" --repo $REPO
gh label create "type: test" --color "bfdadc" --description "Test coverage" --repo $REPO
gh label create "type: chore" --color "fef2c0" --description "Maintenance, dependencies" --repo $REPO

# Area labels (where in the codebase)
gh label create "area: auth" --color "5319e7" --description "Authentication, tokens, login" --repo $REPO
gh label create "area: chat" --color "5319e7" --description "Chat UI, streaming, history" --repo $REPO
gh label create "area: editor" --color "5319e7" --description "Monaco editor, autocomplete" --repo $REPO
gh label create "area: catalog" --color "5319e7" --description "Publisher catalog" --repo $REPO
gh label create "area: mcp" --color "5319e7" --description "MCP client, actions" --repo $REPO
gh label create "area: wallet" --color "5319e7" --description "Balance, billing, top-up" --repo $REPO
gh label create "area: rust" --color "5319e7" --description "Tauri backend" --repo $REPO
gh label create "area: ui" --color "5319e7" --description "General UI/UX" --repo $REPO

# Priority labels
gh label create "priority: critical" --color "b60205" --description "Must fix immediately" --repo $REPO
gh label create "priority: high" --color "d93f0b" --description "Important, do soon" --repo $REPO
gh label create "priority: medium" --color "fbca04" --description "Normal priority" --repo $REPO
gh label create "priority: low" --color "0e8a16" --description "Nice to have" --repo $REPO

# Phase labels (implementation order)
gh label create "phase: 1-foundation" --color "006b75" --description "Scaffold, auth, basic chat" --repo $REPO
gh label create "phase: 2-chat" --color "006b75" --description "Streaming, history, models" --repo $REPO
gh label create "phase: 3-editor" --color "006b75" --description "Monaco, autocomplete" --repo $REPO
gh label create "phase: 4-catalog" --color "006b75" --description "Projects, publishers" --repo $REPO
gh label create "phase: 5-mcp" --color "006b75" --description "MCP client, actions" --repo $REPO
gh label create "phase: 6-polish" --color "006b75" --description "Telemetry, updates, signing" --repo $REPO

# Status labels
gh label create "status: blocked" --color "b60205" --description "Waiting on something" --repo $REPO
gh label create "status: in progress" --color "0e8a16" --description "Being worked on" --repo $REPO
gh label create "status: needs review" --color "fbca04" --description "PR ready for review" --repo $REPO

# Contributor labels
gh label create "good first issue" --color "7057ff" --description "Good for newcomers" --repo $REPO
gh label create "help wanted" --color "008672" --description "Extra attention needed" --repo $REPO
gh label create "security" --color "d73a4a" --description "Security-related" --repo $REPO

echo ""
echo "Labels created successfully!"
echo "View at: https://github.com/$REPO/labels"
