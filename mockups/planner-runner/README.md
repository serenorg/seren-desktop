# Planner + Runner — proposal mockups

Design mockups for the **Planner + Runner** coding agent: a generalization of
`Claude + Codex` that lets you pick *any* offered agent as the planner and *any*
offered agent as the runner, each with its own model, reasoning effort,
permissions and speed.

Deliberately minimal — they mirror the live `Claude + Codex` chat start: flat,
plain-text setup, muted pill selectors, **no new modal**. You pick each role's
agent through the same flat dropdown you already use to pick a model.

Styled with the real Seren Desktop dark-theme tokens (see `theme.css`). No app
code is changed by this folder.

| Screen | File | Shows |
| ------ | ---- | ----- |
| Chat start | `01-chatstart.html` / `.png` | A running Planner + Runner thread (Seren Agent plans · Codex runs). Identical layout to Claude + Codex; the Planner-agent pill dropdown is open showing every offered agent — the 5 CLI agents plus Seren Agent (SerenModels) and Seren Private Models. |
| Launcher menu | `02-launcher.html` / `.png` | `Planner + Runner` as one plain row directly below `Claude + Codex` in the "New" menu. |

## Regenerate the PNGs

```bash
node mockups/planner-runner/render.mjs
```

Requires the repo's dev dependencies (Playwright + Chromium).
