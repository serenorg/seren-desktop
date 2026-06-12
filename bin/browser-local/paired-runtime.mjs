// ABOUTME: Paired Claude + Codex coordinator — Claude plans/reviews, Codex executes (#2368).
// ABOUTME: Presents one paired session to the frontend; inner runtime events are remapped with role attribution.

import { randomUUID } from "node:crypto";

export const PAIRED_AGENT_TYPE = "claude-codex";

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
    ? (modelDisplayName(roleState) ?? roleState.pinnedModelId)
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

function buildPlannerPrompt(userPrompt) {
  return [
    "You are the PLANNER and REVIEWER in a paired workflow. A separate",
    "executor agent (Codex) will make all code edits, run commands, and run",
    "tests. Do NOT edit files or run state-changing commands yourself.",
    "Read whatever you need, then reply with a short, concrete implementation",
    "plan the executor can follow. Plain language; numbered steps.",
    "",
    "User request:",
    userPrompt,
  ].join("\n");
}

function buildExecutorPrompt(userPrompt, planText) {
  return [
    "You are the EXECUTOR in a paired workflow. Claude (the planner) reviewed",
    "the user's request and produced the plan below. Implement it: make the",
    "code edits, run the commands, and run the tests the plan calls for.",
    "Report what you changed and any test results.",
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
    await inner.sendPrompt({
      sessionId: roleState.innerSessionId,
      prompt,
      context,
    });
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
