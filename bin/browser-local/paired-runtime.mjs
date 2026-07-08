// ABOUTME: Paired Claude + Codex coordinator — Claude plans/reviews, Codex executes (#2368).
// ABOUTME: Presents one paired session to the frontend; inner runtime events are remapped with role attribution.

import { randomUUID } from "node:crypto";

export const PAIRED_AGENT_TYPE = "claude-codex";

// Default Claude model for the paired agent's planner/reviewer role. The paired
// agent pins the Claude role to Fable 5 unless the user has explicitly chosen a
// planner model. When the account cannot switch to Fable, the planner falls back
// to the newest Opus (#2827) rather than silently running the Claude default.
// Applied as a post-spawn model switch (see spawnRole), resolved against the
// session's real switchable catalog.
//
// Match on the base id, NOT an exact literal: the Claude Code CLI reports Fable
// in its switchable catalog as `claude-fable-5[1m]` (1M-tier suffix, the same
// shape as its Opus/Sonnet 1M entries), and future builds may date-stamp it. An
// exact bare-id compare silently missed the real `[1m]` entry and demoted every
// Fable-capable account to the Opus fallback with a false "unavailable" notice
// (#2859). Resolve against the normalized base and pin whichever concrete id the
// catalog actually exposes. #2825.
const PAIRED_PLANNER_BASE_MODEL_ID = "claude-fable-5";

// Friendly labels for pinned model ids the Claude Code catalog may not report by
// name, so the setup declaration reads "Fable 5" rather than a raw model id.
const MODEL_DISPLAY_LABELS = {
  "claude-fable-5": "Fable 5",
  "claude-fable-5[1m]": "Fable 5",
};

// Normalize a catalog model id to its base for family matching: drop the 1M-tier
// `[1m]` suffix and any trailing `-YYYYMMDD` date stamp. Mirrors the stripping in
// claude-runtime.mjs's inferClaudeContextWindow so `claude-fable-5[1m]` and a
// dated `claude-fable-5-20260601` both resolve to `claude-fable-5`.
function normalizeBaseModelId(modelId) {
  return typeof modelId === "string"
    ? modelId.replace(/\[1m\]$/i, "").replace(/-\d{8}$/, "")
    : "";
}

// Find the account's switchable Fable entry regardless of tier/date suffix.
// Prefer the 1M-tier variant when the catalog lists more than one, so the pin
// lands on Fable's native 1M context.
function findFableModel(availableModels) {
  const fable = availableModels.filter(
    (m) => normalizeBaseModelId(m.modelId) === PAIRED_PLANNER_BASE_MODEL_ID,
  );
  if (fable.length === 0) return null;
  return fable.find((m) => /\[1m\]$/i.test(m.modelId)) ?? fable[0];
}

// When Fable 5 isn't available on the account, the planner falls back to Opus.
// The Claude catalog is sorted opus-first, newest version first, so the first
// Opus entry is the latest; prefer its 1M-context tier (the app default, #2810).
function findFallbackOpus(availableModels) {
  const opus = availableModels.filter(
    (m) => typeof m.modelId === "string" && m.modelId.startsWith("claude-opus-"),
  );
  if (opus.length === 0) return null;
  const newestBaseId = opus[0].modelId.replace(/\[1m\]$/, "");
  return (
    opus.find((m) => m.modelId === `${newestBaseId}[1m]`) ??
    opus.find((m) => m.modelId === newestBaseId) ??
    opus[0]
  );
}

// Resolve which model to pin for the planner given the account's switchable
// catalog. Prefer an explicit user choice, then Fable 5, then the newest Opus.
// Returns a null modelId when none apply so the caller keeps the Claude default.
// The `reason` drives the notice/label so a fallback never claims to be Fable.
export function resolvePlannerModel(explicitModelId, availableModels) {
  if (explicitModelId) {
    return { modelId: explicitModelId, reason: "explicit", name: null };
  }
  const models = Array.isArray(availableModels) ? availableModels : [];
  const fable = findFableModel(models);
  if (fable) {
    return { modelId: fable.modelId, reason: "fable", name: fable.name ?? null };
  }
  const opus = findFallbackOpus(models);
  if (opus) {
    return { modelId: opus.modelId, reason: "opus-fallback", name: opus.name };
  }
  return { modelId: null, reason: "default", name: null };
}

const ROLE_DEFS = {
  planner: {
    role: "planner",
    label: "Claude",
    agentType: "claude-code",
    defaultModelLabel: "Claude Default",
  },
  executor: {
    role: "executor",
    label: "Codex",
    agentType: "codex",
    defaultModelLabel: "Codex Recommended",
  },
};

function modelDisplayName(roleState) {
  const id = roleState.models?.currentModelId;
  if (!id) return null;
  const match = (roleState.models?.availableModels ?? []).find(
    (m) => m.modelId === id,
  );
  return match?.name ?? id;
}

function effortDisplayValue(roleState) {
  const option = (roleState.configOptions ?? []).find(
    (o) => o.id === "reasoning_effort",
  );
  return option?.currentValue ?? null;
}

function describeRoleModel(roleState) {
  const base = roleState.pinnedModelId
    ? (modelDisplayName(roleState) ??
        MODEL_DISPLAY_LABELS[roleState.pinnedModelId] ??
        roleState.pinnedModelId)
    : ROLE_DEFS[roleState.role].defaultModelLabel;
  const current = modelDisplayName(roleState);
  return current && current !== base ? `${base} · currently ${current}` : base;
}

export function buildPairedDeclaration(paired) {
  const planner = paired.roles.planner;
  const executor = paired.roles.executor;
  const plannerEffort = effortDisplayValue(planner) ?? "runtime default";
  const executorEffort = effortDisplayValue(executor) ?? "runtime default";
  return [
    "**Setup**",
    "",
    "- Claude is planner and reviewer.",
    "- Codex is executor for code edits, commands, and tests.",
    `- Planner: ${describeRoleModel(planner)} · ${plannerEffort} effort.`,
    `- Executor: ${describeRoleModel(executor)} · ${executorEffort} effort.`,
    "- Handoffs appear inline when ownership changes.",
  ].join("\n");
}

// A planner turn ends with this control token when the plan is NOT ready to
// hand to the executor — the user asked to keep discussing or designing first,
// asked to withhold execution, or the request needs a clarifying question. When
// present, the coordinator returns control to the user instead of handing off
// to Codex (#2880). The token is stripped from the streamed planner text so it
// never renders to the user.
const PLANNER_HOLD_SENTINEL = "[[PAIRED:AWAIT_USER]]";

// Streaming-safe removal of a fixed control token from a text stream. The token
// can arrive split across chunks, so each push() emits everything that cannot
// be part of the token and holds back a trailing prefix until later text
// decides it. `found` flips true once a complete token has been seen.
function createSentinelFilter(sentinel) {
  let pending = "";
  let found = false;
  const heldPrefixLen = () => {
    const max = Math.min(pending.length, sentinel.length - 1);
    for (let n = max; n > 0; n--) {
      if (sentinel.startsWith(pending.slice(pending.length - n))) return n;
    }
    return 0;
  };
  return {
    push(text) {
      pending += text ?? "";
      let idx = pending.indexOf(sentinel);
      while (idx !== -1) {
        found = true;
        pending = pending.slice(0, idx) + pending.slice(idx + sentinel.length);
        idx = pending.indexOf(sentinel);
      }
      const keep = pending.length - heldPrefixLen();
      const out = pending.slice(0, keep);
      pending = pending.slice(keep);
      return out;
    },
    flush() {
      const out = pending;
      pending = "";
      return out;
    },
    get found() {
      return found;
    },
  };
}

function buildPlannerPrompt(userPrompt) {
  return [
    "You are the PLANNER in a paired workflow. A separate executor agent",
    "(Codex) will make all code edits, run commands, and run tests — you do",
    "not. Read only the files you need to write an accurate plan.",
    "",
    "If the user is not ready for execution — they asked you to discuss,",
    "design, or scope the work before any code changes, asked you to hold off",
    "handing to the executor, or the request needs a clarifying question — then",
    "do NOT write an implementation plan. Respond to the user directly (ask",
    "your question or share the discussion, one point at a time when they ask",
    "for that), and end your entire message with this exact control line on its",
    `own line: ${PLANNER_HOLD_SENTINEL}`,
    "The control line keeps ownership with you so the executor never starts;",
    "the user does not see it. Use it every turn you need to keep talking.",
    "",
    "Otherwise the request is ready to build. Reply with the implementation plan and nothing else:",
    "numbered steps the executor can follow, each naming the concrete file",
    "paths and functions to change. Skip preamble, restating the request,",
    "rationale, alternatives you weighed, and risk commentary — the executor",
    "needs the steps, not the reasoning. Do not include the control line when",
    "you hand off a plan.",
    "",
    "User request:",
    userPrompt,
  ].join("\n");
}

function buildExecutorPrompt(userPrompt, planText) {
  return [
    "You are the EXECUTOR in a paired workflow. Claude's plan is approved",
    "guidance, but the repository is the source of truth. Inspect the",
    "relevant files, callers, tests, and config before editing. If the plan",
    "conflicts with the code, adapt and report the deviation.",
    "",
    "Make the code changes needed to satisfy the user's request end-to-end.",
    "Preserve unrelated user work and do not revert unrelated changes.",
    "Run focused verification first, then broader impacted lint, typecheck,",
    "build, and test checks when available. Diagnose and fix failures unless",
    "blocked by missing secrets, unavailable external state, or evidence of a",
    "pre-existing failure.",
    "",
    "If third-party services are relevant, use live MCP/publisher discovery",
    "before assuming integrations are unavailable.",
    "",
    "Report only: changed files, verification commands/results, plan",
    "deviations, and remaining risks/blockers.",
    "",
    "Original user request:",
    userPrompt,
    "",
    "Approved plan from Claude:",
    planText || "(The planner did not produce plan text; use the user request directly.)",
  ].join("\n");
}

function buildReviewPrompt(userPrompt, executorReport) {
  return [
    "You are the REVIEWER in a paired workflow. Codex (the executor) just",
    "implemented your plan. Review the work below against the user's request.",
    "Do NOT edit files. Verify the changes look correct, call out any gaps or",
    "risks, and finish with a short summary for the user: who planned, what",
    "changed, who reviewed, and test status.",
    "",
    "Original user request:",
    userPrompt,
    "",
    "Executor report from Codex:",
    executorReport || "(The executor did not produce a report.)",
  ].join("\n");
}

function mergeUsage(target, meta) {
  const usage = meta?.usage;
  if (!usage) return;
  target.input_tokens += usage.input_tokens ?? 0;
  target.output_tokens += usage.output_tokens ?? 0;
}

export function createPairedRuntime({ emit, inner }) {
  const pairedSessions = new Map();
  const innerToPaired = new Map();

  function createRoleState(role) {
    return {
      ...ROLE_DEFS[role],
      innerSessionId: null,
      agentSessionId: null,
      models: undefined,
      configOptions: undefined,
      pinnedModelId: null,
      pinnedEffort: null,
      notice: null,
      turnText: "",
      lastTurnMeta: null,
      holdRequested: false,
      sentinelFilter: null,
    };
  }

  function compositeAgentSessionId(paired) {
    const planner = paired.roles.planner.agentSessionId;
    const executor = paired.roles.executor.agentSessionId;
    if (!planner && !executor) return undefined;
    return JSON.stringify({ planner, executor });
  }

  function roleStatusView(roleState) {
    return {
      role: roleState.role,
      label: roleState.label,
      agentType: roleState.agentType,
      defaultModelLabel: roleState.defaultModelLabel,
      models: roleState.models,
      configOptions: roleState.configOptions,
      pinnedModelId: roleState.pinnedModelId,
      pinnedEffort: roleState.pinnedEffort,
      notice: roleState.notice,
    };
  }

  function emitPairedStatus(paired, status = paired.status) {
    emit("provider://session-status", {
      sessionId: paired.id,
      status,
      agentSessionId: compositeAgentSessionId(paired),
      agentInfo: { name: "Claude + Codex", version: "paired" },
      paired: {
        state: paired.state,
        activeRole: paired.activeRole,
        planner: roleStatusView(paired.roles.planner),
        executor: roleStatusView(paired.roles.executor),
      },
    });
  }

  function emitDeclaration(paired, { replace = false } = {}) {
    paired.declarationEmitted = true;
    emit("provider://paired-event", {
      sessionId: paired.id,
      kind: "declaration",
      messageId: `paired-declaration-${paired.id}`,
      text: buildPairedDeclaration(paired),
      replace,
    });
  }

  function refreshDeclaration(paired) {
    if (!paired.declarationEmitted) return;
    emitDeclaration(paired, { replace: true });
  }

  function emitHandoff(paired, from, to, text) {
    emit("provider://paired-event", {
      sessionId: paired.id,
      kind: "handoff",
      messageId: randomUUID(),
      text,
      from,
      to,
    });
  }

  function setPhase(paired, state, activeRole) {
    paired.state = state;
    paired.activeRole = activeRole;
    emitPairedStatus(paired);
  }

  function roleForInner(innerSessionId) {
    return innerToPaired.get(innerSessionId) ?? null;
  }

  /**
   * Intercepts every runtime emit. Returns true when the event belonged to a
   * paired inner session and was consumed (re-emitted remapped, captured, or
   * suppressed). providers.mjs forwards untouched events when this returns
   * false, so non-paired sessions are unaffected.
   */
  function interceptEmit(channel, payload) {
    const route = roleForInner(payload?.sessionId);
    if (!route) return false;
    const paired = pairedSessions.get(route.pairedId);
    if (!paired) return false;
    // Teardown in flight: swallow every inner emission so raw inner session
    // ids never reach the frontend during terminate (#2373).
    if (paired.terminating) return true;
    const roleState = paired.roles[route.role];

    switch (channel) {
      case "provider://session-status": {
        let meaningfulChange = false;
        if (payload.models) {
          meaningfulChange =
            meaningfulChange ||
            JSON.stringify(payload.models) !== JSON.stringify(roleState.models);
          roleState.models = payload.models;
        }
        if (payload.configOptions) {
          meaningfulChange =
            meaningfulChange ||
            JSON.stringify(payload.configOptions) !==
              JSON.stringify(roleState.configOptions);
          roleState.configOptions = payload.configOptions;
        }
        if (
          payload.agentSessionId &&
          payload.agentSessionId !== roleState.agentSessionId
        ) {
          roleState.agentSessionId = payload.agentSessionId;
          meaningfulChange = true;
        }
        if (payload.status === "terminated" && !paired.terminating) {
          emit("provider://error", {
            sessionId: paired.id,
            error: `${roleState.label} stopped unexpectedly. Send a new message to restart the paired workflow.`,
          });
          paired.state = "idle";
          paired.activeRole = null;
          emitPairedStatus(paired, "error");
          return true;
        }
        if (meaningfulChange) {
          refreshDeclaration(paired);
          emitPairedStatus(paired);
        }
        return true;
      }

      case "provider://prompt-complete": {
        roleState.lastTurnMeta = payload.meta ?? null;
        return true;
      }

      case "provider://message-chunk": {
        if (payload.replay === true) return true;
        const filter = roleState.sentinelFilter;
        if (filter && !payload.isThought) {
          // Planner visible text: strip the hold control token before it
          // streams so the user never sees it (#2880). Thoughts bypass the
          // filter — the token only appears in the final answer.
          const visible = filter.push(payload.text ?? "");
          roleState.turnText += visible;
          if (visible) {
            emit(channel, {
              ...payload,
              text: visible,
              sessionId: paired.id,
              agentProvider: roleState.agentType,
            });
          }
          return true;
        }
        if (!payload.isThought) {
          roleState.turnText += payload.text ?? "";
        }
        emit(channel, {
          ...payload,
          sessionId: paired.id,
          agentProvider: roleState.agentType,
        });
        return true;
      }

      case "provider://user-message":
        // Synthetic role prompts and replayed history must not surface as
        // user bubbles — the paired thread's user messages come from Seren.
        return true;

      case "provider://permission-request": {
        paired.permissionRoutes.set(payload.requestId, payload.sessionId);
        if (paired.state !== "waiting-approval") {
          paired.stateBeforeApproval = {
            state: paired.state,
            activeRole: paired.activeRole,
          };
          paired.state = "waiting-approval";
          emitPairedStatus(paired);
        }
        emit(channel, { ...payload, sessionId: paired.id });
        return true;
      }

      case "provider://error": {
        const message = String(payload.error ?? "");
        if (paired.cancelRequested && message.includes("Task cancelled")) {
          return true;
        }
        emit(channel, { ...payload, sessionId: paired.id });
        return true;
      }

      case "provider://login-required": {
        // Keep the inner agentType so the auto-login flow targets the right CLI.
        emit(channel, { ...payload, sessionId: paired.id });
        return true;
      }

      default:
        emit(channel, {
          ...payload,
          sessionId: paired.id,
          agentProvider: roleState.agentType,
        });
        return true;
    }
  }

  async function spawnRole(paired, role, params, pairedConfig) {
    const roleState = paired.roles[role];
    const innerSessionId = randomUUID();
    roleState.innerSessionId = innerSessionId;
    innerToPaired.set(innerSessionId, { pairedId: paired.id, role });

    const resume = paired.resumeIds?.[role] ?? null;
    const config = pairedConfig?.[role] ?? {};
    roleState.pinnedModelId = config.modelId ?? null;
    roleState.pinnedEffort = config.effort ?? null;

    const base = {
      cwd: params.cwd,
      localSessionId: innerSessionId,
      resumeAgentSessionId: resume,
      apiKey: params.apiKey,
      mcpServers: params.mcpServers,
      timeoutSecs: params.timeoutSecs,
    };

    if (role === "planner") {
      const info = await inner.spawnSession({
        ...base,
        agentType: ROLE_DEFS.planner.agentType,
        approvalPolicy: params.approvalPolicy,
        reasoningEffort: config.effort ?? params.reasoningEffort,
        initialModelId: config.modelId ?? undefined,
      });
      roleState.agentSessionId = info?.agentSessionId ?? roleState.agentSessionId;

      // Pin the planner/reviewer model. Prefer the user's explicit choice, then
      // Fable 5 (#2825), then the newest Opus when the account has no Fable
      // access (#2827). Resolve against the session's real switchable catalog
      // instead of assuming setSessionModel throws on a miss — the Claude path
      // does not throw for an unavailable id, so a blind pin would silently run
      // the wrong model while claiming Fable. Switch after spawn so the process
      // stays on the Claude default first; pinnedModelId/notice always reflect
      // the model actually pinned, never a Fable claim while running Opus.
      const availableModels =
        typeof inner.listSessionModels === "function"
          ? (inner.listSessionModels(innerSessionId) ?? [])
          : [];
      const target = resolvePlannerModel(config.modelId, availableModels);
      if (target.modelId) {
        try {
          await inner.setSessionModel({
            sessionId: innerSessionId,
            modelId: target.modelId,
          });
          roleState.pinnedModelId = target.modelId;
          roleState.notice =
            target.reason === "opus-fallback"
              ? `Fable 5 is unavailable on this account; planning with ${target.name ?? "Opus"} instead.`
              : null;
        } catch {
          roleState.pinnedModelId = null;
          roleState.notice = `Pinned model ${target.modelId} is unavailable in this Claude Code install. Using the Claude default instead.`;
        }
      } else {
        roleState.pinnedModelId = null;
        roleState.notice =
          "Neither Fable 5 nor an Opus model is available on this account. Using the Claude default instead.";
      }
      return info;
    }

    const info = await inner.spawnSession({
      ...base,
      agentType: ROLE_DEFS.executor.agentType,
      approvalPolicy: params.approvalPolicy,
      sandboxMode: params.sandboxMode,
      networkEnabled: params.networkEnabled,
    });
    roleState.agentSessionId = info?.agentSessionId ?? roleState.agentSessionId;

    if (config.modelId) {
      try {
        await inner.setSessionModel({
          sessionId: innerSessionId,
          modelId: config.modelId,
        });
      } catch {
        roleState.pinnedModelId = null;
        roleState.notice = `Pinned model ${config.modelId} is no longer available. Using the Codex default instead.`;
      }
    }
    if (config.effort) {
      try {
        await inner.updateSessionConfigOption({
          sessionId: innerSessionId,
          configId: "reasoning_effort",
          valueId: config.effort,
        });
      } catch {
        roleState.pinnedEffort = null;
        roleState.notice = `Pinned effort ${config.effort} is not supported by the selected Codex model. Using its default effort instead.`;
      }
    }
    return info;
  }

  async function spawnSession(params) {
    const pairedId = params.localSessionId ?? randomUUID();
    let resumeIds = null;
    if (params.resumeAgentSessionId) {
      try {
        resumeIds = JSON.parse(params.resumeAgentSessionId);
      } catch {
        resumeIds = null;
      }
    }

    const paired = {
      id: pairedId,
      cwd: params.cwd,
      status: "initializing",
      createdAt: new Date().toISOString(),
      timeoutSecs: params.timeoutSecs ?? undefined,
      state: "idle",
      activeRole: null,
      roles: {
        planner: createRoleState("planner"),
        executor: createRoleState("executor"),
      },
      resumeIds,
      currentPrompt: null,
      cancelRequested: false,
      terminating: false,
      declarationEmitted: Boolean(resumeIds),
      permissionRoutes: new Map(),
      stateBeforeApproval: null,
    };
    pairedSessions.set(pairedId, paired);

    try {
      await spawnRole(paired, "planner", params, params.paired);
      await spawnRole(paired, "executor", params, params.paired);

      paired.status = "ready";
      if (!resumeIds) {
        emitDeclaration(paired);
      }
      emitPairedStatus(paired, "ready");

      return {
        id: paired.id,
        agentType: PAIRED_AGENT_TYPE,
        cwd: paired.cwd,
        status: paired.status,
        createdAt: paired.createdAt,
        agentSessionId: compositeAgentSessionId(paired),
        timeoutSecs: paired.timeoutSecs,
        // Two child processes back this session; per-PID force-kill cannot
        // target both, so cancel/terminate are the supported stop paths.
        pid: null,
      };
    } catch (error) {
      paired.terminating = true;
      // Terminate before dropping the route entries so teardown emissions
      // from the inner runtimes stay intercepted (#2373).
      for (const role of Object.values(paired.roles)) {
        if (!role.innerSessionId) continue;
        try {
          await inner.terminateSession({ sessionId: role.innerSessionId });
        } catch {
          // Best-effort teardown — the inner spawn may never have registered.
        }
      }
      for (const role of Object.values(paired.roles)) {
        if (role.innerSessionId) innerToPaired.delete(role.innerSessionId);
      }
      pairedSessions.delete(pairedId);
      const message = error instanceof Error ? error.message : String(error);
      emit("provider://error", { sessionId: pairedId, error: message });
      throw error;
    }
  }

  function requirePaired(sessionId) {
    const paired = pairedSessions.get(sessionId);
    if (!paired) {
      throw new Error(`Paired session not found: ${sessionId}`);
    }
    return paired;
  }

  function throwIfCancelled(paired) {
    if (paired.cancelRequested) {
      const error = new Error("Task cancelled");
      error.pairedCancelled = true;
      throw error;
    }
  }

  async function runRoleTurn(paired, role, prompt, context) {
    const roleState = paired.roles[role];
    roleState.turnText = "";
    roleState.lastTurnMeta = null;
    roleState.holdRequested = false;
    // Only the planner can hold the turn for the user; its control token is
    // stripped from the streamed text as chunks arrive (#2880).
    roleState.sentinelFilter =
      role === "planner" ? createSentinelFilter(PLANNER_HOLD_SENTINEL) : null;
    try {
      await inner.sendPrompt({
        sessionId: roleState.innerSessionId,
        prompt,
        context,
      });
    } finally {
      const filter = roleState.sentinelFilter;
      roleState.sentinelFilter = null;
      if (filter) {
        // Emit any held-back tail (a partial token that never completed) so the
        // last visible characters still reach the UI.
        const tail = filter.flush();
        if (tail && !paired.cancelRequested) {
          roleState.turnText += tail;
          emit("provider://message-chunk", {
            sessionId: paired.id,
            text: tail,
            agentProvider: roleState.agentType,
          });
        }
        roleState.holdRequested = filter.found;
      }
    }
    throwIfCancelled(paired);
    return roleState.turnText;
  }

  async function sendPrompt({ sessionId, prompt, context }) {
    const paired = requirePaired(sessionId);
    if (paired.currentPrompt) {
      throw new Error("Another prompt is already active for this session.");
    }

    paired.cancelRequested = false;
    paired.currentPrompt = {};
    // The whole pipeline is one turn from the frontend's perspective. The
    // composer's Send gate reads info.status, so every status frame emitted
    // during a phase must carry "prompting" — a mid-turn "ready" re-enables
    // Send and the second submit collides with this turn (#2372).
    paired.status = "prompting";
    const usage = { input_tokens: 0, output_tokens: 0 };
    let contextWindow;

    const collectMeta = (role) => {
      const meta = paired.roles[role].lastTurnMeta;
      mergeUsage(usage, meta);
      if (typeof meta?.contextWindow === "number") {
        contextWindow = meta.contextWindow;
      }
    };

    try {
      if (!paired.declarationEmitted) {
        emitDeclaration(paired);
      }

      setPhase(paired, "planning", "planner");
      const planText = await runRoleTurn(
        paired,
        "planner",
        buildPlannerPrompt(prompt),
        context,
      );
      collectMeta("planner");

      // The planner can hold the turn for the user — a design/discussion phase
      // or a clarifying question — instead of handing off. Skip execution and
      // review and return control so the user can reply (#2880).
      if (paired.roles.planner.holdRequested) {
        paired.currentPrompt = null;
        paired.status = "ready";
        setPhase(paired, "idle", null);
        emit("provider://prompt-complete", {
          sessionId: paired.id,
          stopReason: "end_turn",
          meta: {
            usage,
            ...(contextWindow ? { contextWindow } : {}),
          },
        });
        emitPairedStatus(paired, "ready");
        return;
      }

      emitHandoff(
        paired,
        "Claude",
        "Codex",
        "Claude handed off to Codex to make the approved code changes.",
      );
      setPhase(paired, "executing", "executor");
      const executorReport = await runRoleTurn(
        paired,
        "executor",
        buildExecutorPrompt(prompt, planText),
        context,
      );
      collectMeta("executor");

      emitHandoff(
        paired,
        "Codex",
        "Claude",
        "Codex handed back to Claude to review the changes.",
      );
      setPhase(paired, "reviewing", "planner");
      await runRoleTurn(paired, "planner", buildReviewPrompt(prompt, executorReport));
      collectMeta("planner");

      paired.currentPrompt = null;
      paired.status = "ready";
      setPhase(paired, "idle", null);
      emit("provider://prompt-complete", {
        sessionId: paired.id,
        stopReason: "end_turn",
        meta: {
          usage,
          ...(contextWindow ? { contextWindow } : {}),
        },
      });
      emitPairedStatus(paired, "ready");
    } catch (error) {
      paired.currentPrompt = null;
      const message = error instanceof Error ? error.message : String(error);
      const wasCancelled =
        paired.cancelRequested || message.includes("Task cancelled");
      paired.status = "ready";
      paired.state = "idle";
      paired.activeRole = null;
      if (wasCancelled) {
        // cancelPrompt already emitted the cancel error + ready status.
        // Reject like the single-session runtimes so the frontend's prompt
        // RPC unwinds the same way for every agent type.
        throw error instanceof Error ? error : new Error("Task cancelled");
      }
      emitPairedStatus(paired, "ready");
      throw error;
    }
  }

  async function cancelPrompt({ sessionId }) {
    const paired = requirePaired(sessionId);
    paired.cancelRequested = true;

    const activeRole = paired.activeRole;
    if (activeRole) {
      const innerSessionId = paired.roles[activeRole].innerSessionId;
      try {
        await inner.cancelPrompt({ sessionId: innerSessionId });
      } catch {
        // The inner runtime escalates to a hard kill itself; keep going so
        // the paired turn still unwinds.
      }
    }

    paired.status = "ready";
    paired.state = "idle";
    paired.activeRole = null;
    emit("provider://error", {
      sessionId: paired.id,
      error: "Task cancelled",
    });
    emitPairedStatus(paired, "ready");
  }

  async function terminateSession({ sessionId }) {
    const paired = requirePaired(sessionId);
    paired.terminating = true;

    // Inner runtimes emit their own terminated statuses while teardown is
    // in flight. Keep the route entries (and the paired record) alive until
    // both inner sessions are down so those emits stay intercepted — the
    // terminating flag swallows them (#2373).
    for (const role of Object.values(paired.roles)) {
      if (!role.innerSessionId) continue;
      try {
        await inner.terminateSession({ sessionId: role.innerSessionId });
      } catch {
        // Best-effort: one inner session may already be gone.
      }
    }

    for (const role of Object.values(paired.roles)) {
      if (role.innerSessionId) innerToPaired.delete(role.innerSessionId);
    }
    pairedSessions.delete(sessionId);

    emit("provider://session-status", {
      sessionId: paired.id,
      status: "terminated",
      agentSessionId: compositeAgentSessionId(paired),
    });
  }

  async function listSessions() {
    return Array.from(pairedSessions.values()).map((paired) => ({
      id: paired.id,
      agentType: PAIRED_AGENT_TYPE,
      cwd: paired.cwd,
      status: paired.status,
      createdAt: paired.createdAt,
      agentSessionId: compositeAgentSessionId(paired),
      timeoutSecs: paired.timeoutSecs,
    }));
  }

  function requireRole(paired, role) {
    if (role !== "planner" && role !== "executor") {
      throw new Error(
        "Paired sessions require an explicit role: planner or executor.",
      );
    }
    return paired.roles[role];
  }

  async function setSessionModel({ sessionId, modelId, role }) {
    const paired = requirePaired(sessionId);
    const roleState = requireRole(paired, role);
    await inner.setSessionModel({
      sessionId: roleState.innerSessionId,
      modelId,
    });
    roleState.pinnedModelId = modelId;
    roleState.notice = null;
    refreshDeclaration(paired);
    emitPairedStatus(paired);
  }

  async function updateSessionConfigOption({
    sessionId,
    configId,
    valueId,
    role,
  }) {
    const paired = requirePaired(sessionId);
    const roleState = requireRole(paired, role);
    await inner.updateSessionConfigOption({
      sessionId: roleState.innerSessionId,
      configId,
      valueId,
    });
    if (configId === "reasoning_effort") {
      roleState.pinnedEffort = valueId;
      roleState.notice =
        role === "planner"
          ? "Planner effort applies from the next planning session Claude spawns."
          : null;
      // Claude re-emits a status with the new effort; Codex emits a
      // config-options-update. Either way the local snapshot keeps the
      // selector responsive until the runtime echo lands.
      const option = (roleState.configOptions ?? []).find(
        (o) => o.id === "reasoning_effort",
      );
      if (option) option.currentValue = valueId;
    }
    refreshDeclaration(paired);
    emitPairedStatus(paired);
    return null;
  }

  async function setPermissionMode({ sessionId, mode }) {
    const paired = requirePaired(sessionId);
    // The executor performs the edits/commands — approval mode belongs to it.
    await inner.setPermissionMode({
      sessionId: paired.roles.executor.innerSessionId,
      mode,
    });
    emitPairedStatus(paired);
  }

  async function respondToPermission({ sessionId, requestId, optionId }) {
    const paired = requirePaired(sessionId);
    const innerSessionId = paired.permissionRoutes.get(requestId);
    if (!innerSessionId) {
      throw new Error(`No pending permission request: ${requestId}`);
    }
    paired.permissionRoutes.delete(requestId);
    await inner.respondToPermission({
      sessionId: innerSessionId,
      requestId,
      optionId,
    });
    if (paired.permissionRoutes.size === 0 && paired.stateBeforeApproval) {
      paired.state = paired.stateBeforeApproval.state;
      paired.activeRole = paired.stateBeforeApproval.activeRole;
      paired.stateBeforeApproval = null;
      emitPairedStatus(paired);
    }
  }

  return {
    hasSession(sessionId) {
      return pairedSessions.has(sessionId);
    },
    interceptEmit,
    spawnSession,
    sendPrompt,
    cancelPrompt,
    terminateSession,
    listSessions,
    setSessionModel,
    updateSessionConfigOption,
    setPermissionMode,
    respondToPermission,
  };
}
