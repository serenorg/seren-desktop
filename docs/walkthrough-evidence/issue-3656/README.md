# Issue #3656 live walkthrough

Date: 2026-08-03

Platform: macOS

App: signed-in `SerenDesktop (Validation)` native build

## Audit correction

The initial issue described two live agent-launcher menus. The walkthrough
proved that `ThreadTabBar` has not been mounted since commit `661c0fef`; the
visible title-bar `+` belongs to `WorkspaceBar` and creates a workspace. The
issue was corrected before commit. This fix and walkthrough cover the one
mounted agent-launcher surface: `ThreadSidebar`.

## Source-of-truth comparison

The catalog in `live-catalog.json` was read directly from the validation
app's running provider runtime with `provider_get_available_agents`. All six
entries reported `available: true`:

1. Codex
2. Claude Code
3. Claude + Codex
4. Antigravity
5. Grok
6. LM Studio

The live sidebar New menu rendered the same six entries in the same order.
The menu uses the existing user-facing label `LM Studio Agent` for the runtime
entry named `LM Studio`.

## Walkthrough

1. Built and launched the real validation Tauri app on macOS.
2. Signed in through the real Google OAuth flow.
3. Queried the running provider runtime and recorded the sanitized catalog.
4. Opened the sidebar New menu.
5. Compared every Coding agents row with the runtime catalog. The top and
   middle captures together show all six rows.
6. Scrolled the same live menu and verified the Claude Code CLI, Codex CLI,
   and shell rows remain in their separate sections.

## Before and after

- Before: `ThreadSidebar` authored six independent native-agent rows. Runtime
  availability and presentation could drift because the mounted menu did not
  consume the catalog.
- After: the mounted menu projects `agentStore.availableAgents`, filters on
  live availability and organization policy in one helper, and uses an
  exhaustive presentation map keyed by `AgentType`.

## Evidence

- `sidebar-new-menu-top.png`: Chat rows and the first three runtime agents.
- `sidebar-new-menu-mid.png`: Claude Code through LM Studio, including
  Antigravity and Grok.
- `sidebar-new-menu-bottom.png`: LM Studio followed by the unchanged CLI and
  shell sections.

Only the launcher menu was cropped from native window captures. Account data,
thread data, balances, and local paths are not present in the committed images.

## Validation

- Focused launcher/agent tests: 63 passed.
- Full frontend suite: 432 files, 2,989 tests passed.
- Production frontend build: passed.
- Frontend build manifest verification: passed.
- Native validation build and signed-in live walkthrough: passed.
- `git diff --check`: passed.

## Network path

This inventory path uses the local Tauri command
`provider_get_available_agents` and the loopback provider runtime. It has no
outbound publisher or third-party API slug.
