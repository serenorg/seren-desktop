# Feature Proposal: Clarify `Seren Agent` Tools And Add `Claude + Codex`

## Approval Gate

Do not implement this issue until Taariq approves both:

- this GitHub issue proposal
- the UI/UX mockups in `mockups/claude-codex-workflow/`

Requested approval signal: comment `Approved: issue + mockups`.

## Audit Correction

The first proposal added a separate `Seren Agent + Tools` row. That is not justified by the current code path.

Audit result: existing `Seren Agent` and `Seren Agent (Private)` chat threads already receive local and gateway tool definitions through the normal chat/orchestrator path. A separate `Seren Agent + Tools` row would duplicate capability and create unnecessary launcher complexity.

## User Story

As a Seren Desktop user, I want the New launcher to make two existing/product paths clear: pay-as-you-go Seren chat with tools, and a subscription-backed Claude + Codex coding-agent workflow for users who already pay for those tools.

## Desired Outcome

- Keep the current `New` launcher menu structure shown in `~/Desktop/agents.png`.
- Do not add a separate `Seren Agent + Tools` row.
- Clarify the existing `Seren Agent` row subtitle so users understand it includes local tools.
- Keep `Seren Agent (Private)` as the private model-routing option.
- Add `Claude + Codex` under `Coding agents` for users who want to use their Claude and Codex subscriptions together.
- Keep the existing `Pay-as-you-go`, `Subscription`, and `CLI` badge language.
- Do not add a setup-audit panel or secondary setup rail. Existing login/setup toasts remain the setup surface for subscription CLIs.

## UI/UX Mockups

Local proposal assets:

- `mockups/claude-codex-workflow/index.html`
- `mockups/claude-codex-workflow/desktop.png`
- `mockups/claude-codex-workflow/mobile.png`

Mocked states:

- Current Seren Desktop New launcher context.
- Existing `Chat`, `Coding agents`, `Command line`, and `Shell` sections.
- Existing `Seren Agent` row with clarified subtitle: `Seren models + local tools`.
- New `Claude + Codex` row in `Coding agents` with `Subscription`.
- Selected `Claude + Codex` thread state with an in-chat setup declaration, bottom-row planner/executor model and effort selectors, visible agent attribution, and a handoff event.
- Existing subscription badges preserved for Claude Code, Codex, and Gemini.
- Existing CLI badges preserved for Claude Code and Codex terminal launchers.

## Design Requirements

### In-Chat Setup Declaration

The paired thread must start with a visible setup declaration in the chat transcript. This is the primary way non-programmers understand who is doing what. It should follow the current pattern shown in `~/Desktop/models.png`: clear, plain-language role assignment before work begins.

Required declaration content:

- `Claude is planner and reviewer.`
- `Codex is executor for code edits, commands, and tests.`
- `Handoffs appear inline when ownership changes.`
- Planner model summary: defaults to Claude's account/workspace default and shows the currently resolved model when known.
- Executor model summary: defaults to Codex's recommended/default model and shows the currently resolved model when known.
- Planner effort summary: defaults to the Claude runtime/model default and shows the currently resolved effort when known.
- Executor effort summary: defaults to the Codex runtime/model default and shows the currently resolved effort when known.

Rendering requirements:

- The setup declaration appears as the first assistant/system-visible message in the new `Claude + Codex` thread.
- It is part of the transcript, not a setup panel, modal, tooltip, or toaster.
- It persists in thread history so Jill can scroll back and confirm the workflow.
- It appears before Claude posts a plan and before Codex performs edits.
- It uses the existing chat message visual language; no extra pill stacks or audit panel.
- It declares the selected/resolved Planner and Executor models and effort levels in plain language.
- It does not contain model or effort switching controls; switching belongs in the existing composer bottom row where Seren already places model, effort, approval, and mode controls.

### Bottom-Row Planner/Executor Model And Effort Selection

Jill should be able to choose the Claude planner/reviewer model and the Codex executor model independently.
She should also be able to choose the reasoning effort for each role independently when the underlying runtime/model supports it.

The model and effort controls must live in the Seren composer bottom row, not in the setup transcript message, launcher, modal, or side panel. This matches the existing Seren UI pattern:

- `src/components/chat/ChatContent.tsx` places `ModelSelector` in `COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES`.
- `src/components/chat/AgentChat.tsx` places `ThreadProviderSwitcher`, `AgentModelSelector`, mode, fast mode, effort, and skills controls in the same bottom-left toolbar group.
- `src/components/chat/AgentEffortSelector.tsx` already renders runtime-provided `reasoning_effort` options for native agent sessions.
- `Claude + Codex` should extend that bottom-row pattern with role-scoped model and effort selectors.

Required bottom-row controls:

- `Planner` selector: Claude runtime model picker for planning/review turns.
- `Executor` selector: Codex runtime model picker for edit/command/test turns.
- `Planner effort` selector: Claude runtime effort picker for future planning/review turns when Claude reports supported effort options.
- `Executor effort` selector: Codex runtime effort picker for future edit/command/test turns when Codex reports supported effort options.
- Each control should show the role label plus the selected or resolved model, for example `Planner · Claude Default · Fable 5` and `Executor · Codex Recommended · GPT-5.5`.
- Effort controls should show the role label plus the selected or resolved effort, for example `Planner effort · high` and `Executor effort · medium`.
- Dropdown menus should reuse the existing native agent selector behavior and styling where possible.
- The setup declaration should update its plain-language model and effort summary after a change, but the primary place Jill changes models and effort is the composer bottom row.

Default behavior:

- Planner defaults to the Claude Code runtime default for Jill's account/workspace.
- Executor defaults to the Codex runtime recommended/default model.
- Planner effort defaults to the selected Claude model's runtime default.
- Executor effort defaults to the selected Codex model's runtime default.
- The setup declaration shows both the stable default label and the currently resolved model/effort when the runtime reports it, for example `Claude Default · currently Fable 5 · high effort` and `Codex Recommended · currently GPT-5.5 · medium effort`.

Switching behavior:

- The `Claude + Codex` thread exposes two model selectors: `Planner` and `Executor`.
- The Planner selector lists models reported by the Claude Code runtime, reusing the existing native agent model-selector behavior where possible.
- The Executor selector lists models reported by the Codex runtime, reusing the existing native agent model-selector behavior where possible.
- Changing the Planner model affects future Claude planning/review turns only.
- Changing the Executor model affects future Codex implementation turns only.
- Changing Planner effort affects future Claude planning/review turns only.
- Changing Executor effort affects future Codex implementation turns only.
- If the active turn has already started, Seren should either apply the change to the next turn or clearly state that a restart/new turn is required.
- Model and effort choices persist with the paired thread and restore when Jill reopens or resumes it, subject to provider/runtime semantics.

Effort behavior:

- Render an effort selector only when that role's runtime exposes a `reasoning_effort` select config option.
- Hide or disable the selector with a clear tooltip/status when the selected model does not support effort.
- The effort option list must come from the role's runtime, not a hardcoded shared scale, because supported levels differ by provider and model.
- If changing a Claude Code effort value applies only to the next session/spawn, Seren should say so inline or in the selector status rather than implying it changes the already-running process.
- If changing a Codex effort value applies to future turns, Seren should preserve the selection for subsequent Codex executor turns.
- If Jill changes the Planner or Executor model and the previously selected effort is unsupported, Seren should fall back to that model's default/supported effort and show the change.

Provider behavior notes:

- Codex documentation describes reasoning effort as a control for how long Codex thinks before responding, with higher effort increasing latency/token usage; the IDE exposes it through the model switcher under the chat input.
- Claude Code documentation describes effort as model-dependent adaptive reasoning; supported levels and defaults vary by model, and some levels such as `max` or `ultracode` have session-only or non-`--effort` semantics.
- Therefore Seren must treat effort as runtime-reported configuration per role, not as one global paired-thread setting.

Upgrade behavior:

- Default/recommended choices should float forward when Claude or Codex upgrades their default models.
- Pinned explicit choices should remain pinned until Jill changes them.
- If a pinned model disappears, is retired, or is no longer available under Jill's subscription/workspace policy, Seren should show a clear inline status and offer the provider default/recommended replacement.
- The bottom-row selectors, setup declaration, and final summary should always show the actual resolved model and effort used for each role when known.

Non-goals:

- Do not require Jill to type `/model`, edit config files, or know provider model IDs.
- Do not require Jill to type `/effort`, edit config files, or know provider effort IDs.
- Do not expose every low-level provider setting in the launcher.
- Do not add a separate model/effort setup panel.
- Do not place Planner/Executor model or effort switching controls inside the in-chat setup declaration.

### Active Agent Visibility

The paired thread must also show current ownership outside the setup message:

- Header title: `Claude + Codex`
- Header state examples: `Claude planning`, `Codex editing`, `Claude reviewing`, `Waiting for approval`
- Message attribution: `Claude`, `Codex`, or `Seren`
- Inline handoff event: `Claude handed off to Codex to make the approved code changes.`

### Non-Programmer Clarity

Jill should never need to know about CLIs, app-server processes, provider runtimes, or internal event names. The visible product contract is:

- Claude decides the plan and reviews quality using Jill's selected Planner model.
- Codex performs the implementation work using Jill's selected Executor model.
- Each role uses its own selected effort level when the runtime/model supports effort.
- Seren shows setup, handoffs, approvals, and final status.

## Current Code-Path Audit

### Launcher/Menu Path

- `src/components/layout/ThreadSidebar.tsx`
  - `handleNewChat` creates a normal Seren chat thread with `provider: "seren"`.
  - `handleNewPrivateChat` creates a normal private chat thread with `provider: "seren-private"`.
  - Existing Chat rows use `LauncherChip variant="paid"` and `Pay-as-you-go`.
  - Existing coding-agent rows use `LauncherChip variant="subscription"`.
  - Existing command-line rows use `LauncherChip variant="cli"`.
  - Therefore the Chat section should be clarified, not expanded with a duplicate mode.

### Existing Seren Chat Tool Path

- `src/components/chat/ChatContent.tsx`
  - User sends route through `orchestrate(id, prompt, images)`.

- `src/services/orchestrator.ts`
  - `buildCapabilities(...)` calls `getAllTools()`.
  - The capabilities payload includes both `available_tools` and full `tool_definitions`.
  - The code comment explicitly states tools are available in both public and private chat.

- `src-tauri/src/orchestrator/service.rs`
  - `WorkerType::ChatModel` creates `ChatModelWorker::with_tools(capabilities.tool_definitions.clone(), ...)`.

- `src-tauri/src/orchestrator/chat_model_worker.rs`
  - Selects relevant tools for the prompt.
  - Sends those tools into the chat completion request.
  - Executes tool calls in a loop.
  - Local tools execute directly; gateway/MCP tools route through the frontend bridge.

- `src/lib/tools/definitions.ts`
  - Defines local file/web/shell tools including `read_file`, `write_file`, `list_directory`, `seren_web_fetch`, and `execute_command`.
  - `getAllTools()` also adds built-in Seren tools, local MCP tools, and Seren Gateway publisher tools.

- `src/lib/tools/executor.ts`
  - Executes built-in Seren, gateway, local MCP, file, web, and shell tools.
  - Shell execution requires user approval.

### Subscription Coding-Agent Path

- `bin/browser-local/agent-registry.mjs`
  - Defines external native agents: `claude-code`, `codex`, `gemini`.
  - Handles CLI install/login/resolution for subscription-backed agents.
  - Candidate target for a paired `Claude + Codex` capability definition if the paired workflow is implemented as a native coding-agent mode.

- `bin/browser-local/providers.mjs`
  - Spawns Codex app-server and delegates to Claude/Gemini runtimes.
  - Candidate path for starting and supervising the two subscription-backed local agents.
  - Supports setting the Codex session model and normalizing model records from the Codex runtime.

- `src/stores/agent.store.ts`
  - Owns native agent lifecycle state and setup status.
  - Already exposes `setModel(modelId, sessionId)` for native agent sessions and persists `agent_model_id`.
  - Candidate place to expose paired-workflow setup state without adding a separate setup panel.

- `src/components/chat/AgentModelSelector.tsx`
  - Existing dropdown for native agent session model selection.
  - Candidate component/pattern to reuse for the paired Planner and Executor selectors in the composer bottom row.

- `src/components/chat/AgentEffortSelector.tsx`
  - Existing dropdown for native agent session reasoning effort.
  - Renders when the active session exposes a `reasoning_effort` select config option.
  - Candidate component/pattern to reuse for role-scoped Planner effort and Executor effort selectors.

- `src/components/chat/AgentChat.tsx`
  - Renders native-agent controls inside `COMPOSER_TOOLBAR_LEFT_GROUP_CLASSES`.
  - Candidate placement for paired Planner/Executor model and effort selectors alongside existing agent controls.

- `src/components/chat/composerToolbarClasses.ts`
  - The bottom-left composer toolbar group already uses `flex-wrap`, so additional role-scoped controls should wrap instead of clipping.

- `bin/browser-local/claude-runtime.mjs`
  - Supports setting the Claude Code model through the runtime control path.
  - Supports `reasoning_effort` through the Claude Code effort config path.
  - Notes that the `--effort` flag is spawn-time, so mid-session changes apply to the next session spawn/resume/fork.

- `bin/browser-local/providers.mjs`
  - Builds Codex `reasoning_effort` config options from the selected model's supported effort records.
  - Supports updating Codex session config option `reasoning_effort`.

- `src-tauri/src/commands/provider_runtime.rs`
  - `switch_thread_provider` flips runtime/provider metadata and can convert chat rows into native-agent rows.
  - Valid for subscription coding-agent rows, not for ordinary Seren chat.

## Proposed Implementation

### 1. Clarify Existing Seren Agent

Update the existing Chat row copy only:

- Title: `Seren Agent`
- Subtitle: `Seren models + local tools`
- Badge: `Pay-as-you-go`
- Behavior: unchanged; creates a chat-mode thread through the existing Seren chat/orchestrator tool path

Do not add `Seren Agent + Tools` as a separate launcher row.

### 2. Add One Subscription Coding-Agent Row

Add a new row under `Coding agents`:

- Title: `Claude + Codex`
- Subtitle: `Anthropic + OpenAI · paired coding agents`
- Badge: `Subscription`
- Behavior: creates a subscription-backed coding-agent workflow using the user's local authenticated CLIs

### 3. Keep The Billing Paths Separate

`Seren Agent` should:

- continue using Seren Chat / SerenModels billing
- continue using local tools through Seren Desktop's existing tool runtime
- avoid native-agent `agent_type`
- avoid requiring Claude Code, Codex, or Gemini CLI login

`Claude + Codex` should:

- stay under `Coding agents`
- use the existing subscription setup/toast patterns
- require the user's local Claude/Codex CLI availability and login when needed
- use native-agent metadata because the user explicitly selected a subscription coding-agent workflow
- support independent Planner and Executor model/effort selection with sensible defaults

### 4. Make Agent Ownership Visible

Jill should never have to infer which agent is active. The selected paired thread must show:

- thread header title: `Claude + Codex`
- compact header state: `Claude planning`, `Codex editing`, `Claude reviewing`, or `Waiting for approval`
- first in-chat setup declaration: `Claude is planner and reviewer; Codex is executor`
- Planner and Executor model selectors in the composer bottom row where Seren already places model controls
- Planner effort and Executor effort selectors in the composer bottom row where Seren already places effort controls
- message attribution: every assistant-visible work update is labeled `Claude`, `Codex`, or `Seren`
- inline handoff event: for example, `Claude handed off to Codex to make the approved code changes`
- final summary attribution: who planned, who changed files, who reviewed

This should use normal thread/header/message UI, not a separate setup panel. The handoff event should be lightweight and scannable, similar to an activity line in the transcript.

### 5. Jill's Expected UX

1. Jill clicks `Claude + Codex`.
2. If both local authenticated tools are ready, Seren opens one paired thread titled `Claude + Codex`.
3. If either tool needs setup, Seren uses the existing toaster/login surface.
4. Jill sends a plain-English request.
5. Seren posts a short setup declaration in the chat: Claude plans/reviews; Codex executes.
6. The setup declaration names the currently selected/resolved Planner and Executor models and effort levels.
7. The composer bottom row shows `Planner`, `Executor`, `Planner effort`, and `Executor effort` selectors when supported.
8. Jill can keep the defaults or change either model/effort independently from that bottom row.
9. The thread header shows the active stage, starting with `Claude planning`.
10. Claude posts a short attributed plan.
11. Seren inserts an inline handoff event when responsibility moves to Codex.
12. The header changes to `Codex editing`.
13. Codex posts attributed progress while applying changes.
14. Before risky commands or writes requiring approval, Jill sees the normal approval prompt.
15. When Codex finishes, the header changes to `Claude reviewing`.
16. The final response summarizes the result with clear attribution, resolved model names, resolved effort levels, and test status.

### 6. Avoid New Setup Panels

Do not add:

- a setup-audit panel
- a right-side setup checklist
- new pill stacks beyond the existing launcher badges

If a subscription CLI needs setup, use the existing toaster/login flow already used by the current Claude Code and Codex entries.

## Required Tests Only

Add focused tests only where behavior changes:

- Unit/source guard: `ThreadSidebar.tsx` keeps a single `Seren Agent` Chat row with `Pay-as-you-go`.
- Unit/source guard: `ThreadSidebar.tsx` renders `Claude + Codex` in the `Coding agents` section with `Subscription`.
- Unit test: selecting `Seren Agent` still creates a chat thread and does not stamp `agent_type`.
- Unit test: selecting `Claude + Codex` uses the native coding-agent path and surfaces existing setup/login toast state if either CLI is unavailable.
- Unit/component test: the paired thread emits or renders the initial setup declaration naming Claude as planner/reviewer and Codex as executor.
- Unit/component test: paired-agent handoff events render inline in the transcript with source and destination agent names.
- Unit/component test: paired thread renders independent Planner and Executor model selectors in the composer bottom toolbar.
- Unit/component test: paired thread renders independent Planner effort and Executor effort selectors in the composer bottom toolbar when both runtimes report `reasoning_effort`.
- Unit test: changing Planner model updates only the Claude planning/review session metadata.
- Unit test: changing Executor model updates only the Codex execution session metadata.
- Unit test: changing Planner effort updates only the Claude planning/review effort metadata and explains next-session timing when applicable.
- Unit test: changing Executor effort updates only the Codex execution effort metadata.
- Unit test: unsupported effort values are hidden, disabled, or downgraded with a visible status rather than silently applied.
- Unit test: paired model and effort choices persist and restore with the thread.
- Unit test: unavailable pinned model falls back with a clear inline status instead of silently switching.
- Component/source guard: existing Claude Code, Codex, Gemini, and CLI rows remain present with their current badge categories.

Do not duplicate existing Seren chat tool-loop tests or existing Codex/Claude native runtime tests; cover only the copy clarification and new paired-workflow routing.

## Acceptance Criteria

- The New launcher matches the current menu context from `~/Desktop/agents.png`.
- There is no separate `Seren Agent + Tools` row.
- `Seren Agent` remains under `Chat`.
- `Seren Agent` is labeled `Pay-as-you-go`.
- `Seren Agent` copy makes tool capability clear.
- `Seren Agent` opens a chat-mode thread and does not require Claude Code, Codex, or Gemini CLI login.
- `Seren Agent (Private)` remains the private model-routing option.
- `Claude + Codex` appears under `Coding agents`.
- `Claude + Codex` is labeled `Subscription`.
- `Claude + Codex` uses the existing subscription setup/login surface rather than a new setup-audit panel.
- `Claude + Codex` declares the setup in chat before work starts.
- Jill can change the Planner Claude model and Executor Codex model independently from the composer bottom row.
- Jill can change the Planner Claude effort and Executor Codex effort independently from the composer bottom row when the runtime/model supports it.
- Default/recommended model choices float forward as providers upgrade, while explicit pinned choices remain pinned.
- Default effort choices track provider/model defaults, while explicit effort choices remain pinned only as long as the selected runtime/model supports them.
- If a pinned model is unavailable, Seren shows the issue and offers a default/recommended replacement.
- If a pinned effort is unavailable for the selected model, Seren shows the issue and offers or applies the nearest supported/default effort with visible status.
- The active planner/executor/reviewer state is visible in the thread header and transcript.
- Existing Claude Code/Codex/Gemini subscription agents still work as separate rows.
- Existing Claude Code/Codex terminal launchers still work as separate CLI rows.

## Risks And Mitigations

- Risk: users think Seren Agent is model-only.
  - Mitigation: clarify the existing subtitle instead of adding a duplicate row.

- Risk: users with Claude and Codex subscriptions do not see a combined workflow.
  - Mitigation: add `Claude + Codex` as a first-class `Coding agents` row with a `Subscription` badge.

- Risk: implementation accidentally changes the existing Seren chat behavior.
  - Mitigation: add a focused guard that `Seren Agent` still creates a chat thread and does not stamp `agent_type`.

- Risk: launcher becomes visually heavier.
  - Mitigation: add only one new row, reuse the existing launcher row pattern and chip categories, and avoid panels or custom pill stacks.
