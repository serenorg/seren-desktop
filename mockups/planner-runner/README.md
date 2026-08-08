# Planner + Runner — proposal mockups

Design mockups for the **Planner + Runner** coding agent: a generalization of
`Claude + Codex` that lets you pick *any* offered agent as the planner and *any*
offered agent as the runner, each with its own model, reasoning effort,
permissions and speed.

These are static HTML mockups styled with the real Seren Desktop dark theme
tokens (mirrored from `src/styles.css`). They are illustrative only — no app code
is changed by this folder.

| Screen | File | Shows |
| ------ | ---- | ----- |
| Launcher menu | `01-launcher.html` / `.png` | `Planner + Runner` inserted directly below `Claude + Codex` in the "New" menu |
| Launch config | `02-config.html` / `.png` | Two agent pickers (Planner / Runner) with per-role model, reasoning, permission and speed controls |
| Running thread | `03-thread.html` / `.png` | A live thread with a non-default pairing (Antigravity plans · Grok runs) and the per-role selector row |

## Regenerate the PNGs

```bash
node mockups/planner-runner/render.mjs
```

Requires the repo's dev dependencies (Playwright + Chromium) to be installed.
