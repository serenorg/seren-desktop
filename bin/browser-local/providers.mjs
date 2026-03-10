// ABOUTME: Browser-local provider runtime for direct agent integrations.
// ABOUTME: Runs Codex App Server directly over stdio while delegating install/login metadata to the agent registry.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import { createBrowserLocalAgentRegistry } from "./agent-registry.mjs";
import { createClaudeRuntime } from "./claude-runtime.mjs";
import { buildProviderMcpConfig } from "./mcp-config.mjs";

function isAuthError(message) {
  const lower = String(message).toLowerCase();
  return (
    lower.includes("invalid api key") ||
    lower.includes("authentication required") ||
    lower.includes("auth required") ||
    lower.includes("please run /login") ||
    lower.includes("login required") ||
    lower.includes("not logged in")
  );
}

function killChildTree(child) {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    } catch {
      // Fall through to direct kill.
    }
  }

  try {
    child.kill();
  } catch {
    // Ignore double-kill races during cleanup.
  }
}

function mapDecision(optionId) {
  switch (optionId) {
    case "acceptForSession":
    case "allow_session":
      return "acceptForSession";
    case "decline":
    case "deny":
    case "reject":
      return "decline";
    case "cancel":
      return "cancel";
    case "accept":
    case "approve":
    case "allow_once":
    default:
      return "accept";
  }
}

function modeFromApprovalPolicy(approvalPolicy) {
  switch (approvalPolicy) {
    case "on-request":
    case "untrusted":
      return "ask";
    default:
      return "auto";
  }
}

function sandboxFromMode(sandboxMode, networkEnabled) {
  if (networkEnabled || sandboxMode === "danger-full-access") {
    return "danger-full-access";
  }
  if (sandboxMode === "read-only") {
    return "read-only";
  }
  return "workspace-write";
}

function codexApprovalPolicy(modeId) {
  return modeId === "ask" ? "on-request" : "never";
}

function codexModes(session) {
  return {
    currentModeId: session?.currentModeId ?? "auto",
    availableModes: [
      {
        modeId: "auto",
        name: "Auto",
        description: "Automatically approve safe operations",
      },
      {
        modeId: "ask",
        name: "Suggest",
        description: "Ask for approval on each action",
      },
    ],
  };
}

function buildInitializeParams() {
  return {
    clientInfo: {
      name: "seren_browser_local",
      title: "Seren Browser Local",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

function spawnCodexProcess(cwd, { apiKey, mcpServers } = {}) {
  const mcpConfig = buildProviderMcpConfig({ apiKey, mcpServers });
  const args = ["app-server"];
  if (mcpConfig.codexMcpConfigOverride) {
    args.push("-c", mcpConfig.codexMcpConfigOverride);
  }

  return spawn("codex", args, {
    cwd,
    env: {
      ...process.env,
      ...mcpConfig.childEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

function createCodexSessionRecord({
  sessionId,
  cwd,
  processHandle,
  timeoutSecs,
  currentModeId,
}) {
  return {
    id: sessionId,
    agentType: "codex",
    cwd,
    status: "initializing",
    createdAt: new Date().toISOString(),
    process: processHandle,
    output: readline.createInterface({ input: processHandle.stdout }),
    pendingRequests: new Map(),
    nextRequestId: 1,
    pendingPermissions: new Map(),
    toolOutputs: new Map(),
    currentPrompt: null,
    activeTurnId: null,
    agentSessionId: undefined,
    timeoutSecs: timeoutSecs ?? undefined,
    codexVersion: null,
    availableModelRecords: [],
    currentModelId: null,
    currentModeId,
    reasoningEffort: "medium",
    latestTurnUsage: undefined,
  };
}

function normalizeModelRecords(result) {
  const data = Array.isArray(result?.data) ? result.data : [];
  return data
    .filter((record) => record && record.hidden !== true)
    .map((record) => ({
      modelId: record.id ?? record.model,
      name: record.displayName ?? record.id ?? record.model ?? "Unknown model",
      description: record.description ?? undefined,
      defaultReasoningEffort:
        record.defaultReasoningEffort ??
        record.default_reasoning_effort ??
        "medium",
      supportedReasoningEfforts: Array.isArray(record.supportedReasoningEfforts)
        ? record.supportedReasoningEfforts
            .map((effort) => ({
              value: effort.reasoningEffort,
              name: effort.reasoningEffort,
              description: effort.description ?? undefined,
            }))
            .filter((effort) => typeof effort.value === "string")
        : [],
      isDefault: record.isDefault === true,
    }))
    .filter((record) => typeof record.modelId === "string");
}

function getSelectedModelRecord(session) {
  return (
    session.availableModelRecords.find(
      (record) => record.modelId === session.currentModelId,
    ) ??
    session.availableModelRecords.find((record) => record.isDefault) ??
    session.availableModelRecords[0] ??
    null
  );
}

function buildAvailableModels(session) {
  return session.availableModelRecords.map((record) => ({
    modelId: record.modelId,
    name: record.name,
    description: record.description,
  }));
}

function buildConfigOptions(session) {
  const modelRecord = getSelectedModelRecord(session);
  const efforts =
    modelRecord?.supportedReasoningEfforts?.length > 0
      ? modelRecord.supportedReasoningEfforts
      : [
          { value: "low", name: "low" },
          { value: "medium", name: "medium" },
          { value: "high", name: "high" },
          { value: "xhigh", name: "xhigh" },
        ];

  if (efforts.length === 0) {
    return [];
  }

  const currentValue = efforts.some(
    (option) => option.value === session.reasoningEffort,
  )
    ? session.reasoningEffort
    : efforts[0]?.value ?? "medium";

  session.reasoningEffort = currentValue;

  return [
    {
      id: "reasoning_effort",
      name: "Reasoning Effort",
      description: "Controls how much reasoning Codex uses on future turns.",
      type: "select",
      currentValue,
      options: efforts.map((option) => ({
        value: option.value,
        name: option.name,
        description: option.description ?? null,
      })),
    },
  ];
}

function buildSessionStatus(session, status = session.status) {
  return {
    sessionId: session.id,
    status,
    agentSessionId: session.agentSessionId,
    agentInfo: {
      name: "Codex App Server",
      version: session.codexVersion ?? "unknown",
    },
    models: {
      currentModelId: session.currentModelId,
      availableModels: buildAvailableModels(session),
    },
    modes: codexModes(session),
    configOptions: buildConfigOptions(session),
  };
}

function replayChunkMeta(item) {
  const messageId =
    typeof item?.id === "string" && item.id.length > 0 ? item.id : undefined;
  const rawTimestamp = item?.timestamp ?? item?.createdAt ?? item?.created_at;
  const timestamp =
    typeof rawTimestamp === "number"
      ? rawTimestamp
      : typeof rawTimestamp === "string" && rawTimestamp.length > 0
        ? Date.parse(rawTimestamp)
        : undefined;

  return {
    messageId,
    timestamp:
      typeof timestamp === "number" && Number.isFinite(timestamp)
        ? timestamp
        : undefined,
  };
}

function replayUserMessage(emit, session, item) {
  const content = Array.isArray(item?.content) ? item.content : [];
  const { messageId, timestamp } = replayChunkMeta(item);

  for (const block of content) {
    if (block?.type !== "text" || typeof block?.text !== "string") {
      continue;
    }

    emit("provider://user-message", {
      sessionId: session.id,
      text: block.text,
      messageId,
      timestamp,
      replay: true,
    });
  }
}

function replayAgentMessage(emit, session, item) {
  const { messageId, timestamp } = replayChunkMeta(item);
  const text =
    typeof item?.text === "string"
      ? item.text
      : Array.isArray(item?.content)
        ? item.content
            .map((part) =>
              typeof part === "string"
                ? part
                : typeof part?.text === "string"
                  ? part.text
                  : "",
            )
            .filter(Boolean)
            .join("")
        : "";
  if (!text) {
    return;
  }

  emit("provider://message-chunk", {
    sessionId: session.id,
    text,
    messageId,
    timestamp,
    replay: true,
  });
}

function replayReasoning(emit, session, item) {
  const { messageId, timestamp } = replayChunkMeta(item);
  const text = Array.isArray(item?.content)
    ? item.content
        .map((part) =>
          typeof part === "string"
            ? part
            : typeof part?.text === "string"
              ? part.text
              : "",
        )
        .filter(Boolean)
        .join("")
    : typeof item?.text === "string"
      ? item.text
      : "";
  if (!text) {
    return;
  }

  emit("provider://message-chunk", {
    sessionId: session.id,
    text,
    isThought: true,
    messageId,
    timestamp,
    replay: true,
  });
}

function replayToolLikeItem(emit, session, item) {
  if (!isToolLikeItem(item)) {
    return;
  }

  emitToolCall(emit, session, item, item?.status ?? "completed");
  emitToolResult(emit, session, item);
}

function replayThreadItems(emit, session, thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  for (const turn of turns) {
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (const item of items) {
      switch (item?.type) {
        case "userMessage":
          replayUserMessage(emit, session, item);
          break;
        case "agentMessage":
          replayAgentMessage(emit, session, item);
          break;
        case "reasoning":
          replayReasoning(emit, session, item);
          break;
        default:
          replayToolLikeItem(emit, session, item);
          break;
      }
    }
  }

  emit("provider://prompt-complete", {
    sessionId: session.id,
    stopReason: "HistoryReplay",
    historyReplay: true,
  });
}

function isToolLikeItem(item) {
  const type = String(item?.type ?? "").toLowerCase();
  return (
    type.includes("command") ||
    type.includes("filechange") ||
    type.includes("tool") ||
    type.includes("mcp") ||
    type.includes("websearch")
  );
}

function emitToolCall(emit, session, item, statusOverride) {
  const type = String(item?.type ?? "").toLowerCase();
  if (!isToolLikeItem(item)) {
    return;
  }

  const toolCallId = String(item.id ?? randomUUID());
  const title =
    item.command ??
    item.title ??
    item.path ??
    (type.includes("command")
      ? "Command run"
      : type.includes("filechange")
        ? "File change"
        : type.includes("websearch")
          ? "Web search"
          : "Tool call");

  emit("provider://tool-call", {
    sessionId: session.id,
    toolCallId,
    title,
    kind: item.type ?? "tool",
    status: statusOverride ?? item.status ?? "in_progress",
    parameters: item,
  });
}

function emitToolResult(emit, session, item) {
  if (!isToolLikeItem(item)) {
    return;
  }
  const toolCallId = String(item?.id ?? "");
  if (!toolCallId) {
    return;
  }

  const bufferedOutput = session.toolOutputs.get(toolCallId) ?? "";
  const rawResult =
    item.aggregatedOutput ??
    item.formattedOutput ??
    item.output ??
    bufferedOutput;
  const result =
    typeof rawResult === "string" && rawResult.length === 0
      ? undefined
      : rawResult;

  emit("provider://tool-result", {
    sessionId: session.id,
    toolCallId,
    status: item.status ?? "completed",
    result,
    error:
      item.error?.message ??
      item.error ??
      (item.exitCode && item.exitCode !== 0
        ? `Command exited with code ${item.exitCode}`
        : undefined),
  });

  session.toolOutputs.delete(toolCallId);
}

function normalizeTurnUsage(tokenUsage) {
  const last = tokenUsage?.last ?? tokenUsage?.total ?? null;
  if (!last) {
    return undefined;
  }

  return {
    usage: {
      input_tokens: last.inputTokens,
      output_tokens: last.outputTokens,
    },
  };
}

function buildApprovalToolCall(method, params) {
  const item = params?.item ?? {};
  if (method === "item/commandExecution/requestApproval") {
    return {
      name: "commandExecution",
      title: item.command ?? params?.command ?? "Run command",
      input: {
        command: item.command ?? params?.command ?? null,
        cwd: item.cwd ?? params?.cwd ?? null,
      },
    };
  }
  if (method === "item/fileRead/requestApproval") {
    return {
      name: "fileRead",
      title: "Read file",
      input: {
        path: item.path ?? params?.path ?? null,
      },
    };
  }
  return {
    name: "fileChange",
    title: item.path ?? params?.path ?? "Change file",
    input: {
      path: item.path ?? params?.path ?? null,
      oldText: item.oldText ?? item.old_text ?? null,
      newText: item.newText ?? item.new_text ?? null,
    },
  };
}

function isRecoverableResumeError(message) {
  const lower = String(message).toLowerCase();
  return (
    lower.includes("not found") ||
    lower.includes("missing thread") ||
    lower.includes("unknown thread") ||
    lower.includes("does not exist") ||
    lower.includes("no rollout")
  );
}

function sendRequest(session, method, params, timeoutMs = 30_000) {
  const id = session.nextRequestId;
  session.nextRequestId += 1;

  const payload = {
    jsonrpc: "2.0",
    id,
    method,
    params,
  };

  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      session.pendingRequests.delete(String(id));
      rejectPromise(new Error(`Timed out waiting for ${method}.`));
    }, timeoutMs);

    session.pendingRequests.set(String(id), {
      method,
      timeout,
      resolve: resolvePromise,
      reject: rejectPromise,
    });

    session.process.stdin.write(`${JSON.stringify(payload)}\n`);
  });
}

function writeMessage(session, message) {
  session.process.stdin.write(`${JSON.stringify(message)}\n`);
}

function rejectPendingRequests(session, error) {
  for (const [key, pending] of session.pendingRequests) {
    clearTimeout(pending.timeout);
    pending.reject(error);
    session.pendingRequests.delete(key);
  }
}

function rejectCurrentPrompt(session, error) {
  if (!session.currentPrompt) {
    return;
  }
  const pending = session.currentPrompt;
  session.currentPrompt = null;
  session.activeTurnId = null;
  pending.reject(error);
}

function resolveCurrentPrompt(session) {
  if (!session.currentPrompt) {
    return;
  }
  const pending = session.currentPrompt;
  session.currentPrompt = null;
  session.activeTurnId = null;
  pending.resolve();
}

function handleResponse(session, payload) {
  const pending = session.pendingRequests.get(String(payload.id));
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeout);
  session.pendingRequests.delete(String(payload.id));

  if (payload.error?.message) {
    pending.reject(new Error(`${pending.method} failed: ${payload.error.message}`));
    return;
  }

  pending.resolve(payload.result);
}

function handleServerRequest(emit, session, payload) {
  const method = payload.method;
  const requestId = randomUUID();
  const pendingPermission = {
    requestId,
    jsonRpcId: payload.id,
    method,
  };

  if (session.currentModeId === "auto") {
    writeMessage(session, {
      jsonrpc: "2.0",
      id: payload.id,
      result: {
        decision: "accept",
      },
    });
    return;
  }

  session.pendingPermissions.set(requestId, pendingPermission);

  emit("provider://permission-request", {
    sessionId: session.id,
    requestId,
    toolCall: buildApprovalToolCall(method, payload.params ?? {}),
    options: [
      {
        optionId: "accept",
        label: "Approve once",
        description: "Allow this action one time.",
      },
      {
        optionId: "acceptForSession",
        label: "Approve session",
        description: "Allow similar actions for the rest of this session.",
      },
    ],
  });
}

function handleNotification(emit, session, payload) {
  const method = payload.method;
  const params = payload.params ?? {};

  switch (method) {
    case "thread/started": {
      const thread = params.thread ?? {};
      const threadId = thread.id ?? params.threadId;
      if (typeof threadId === "string") {
        session.agentSessionId = threadId;
      }
      return;
    }

    case "turn/started": {
      const turnId = params.turn?.id;
      if (typeof turnId === "string") {
        session.activeTurnId = turnId;
      }
      session.status = "prompting";
      return;
    }

    case "item/started": {
      const item = params.item ?? {};
      emitToolCall(emit, session, item, "in_progress");
      return;
    }

    case "item/agentMessage/delta":
      emit("provider://message-chunk", {
        sessionId: session.id,
        text: params.delta ?? "",
      });
      return;

    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
      emit("provider://message-chunk", {
        sessionId: session.id,
        text: params.delta ?? "",
        isThought: true,
      });
      return;

    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta": {
      const toolCallId = String(params.itemId ?? "");
      if (!toolCallId) {
        return;
      }
      const chunk = String(params.delta ?? "");
      session.toolOutputs.set(
        toolCallId,
        `${session.toolOutputs.get(toolCallId) ?? ""}${chunk}`,
      );
      return;
    }

    case "item/completed": {
      const item = params.item ?? {};
      emitToolResult(emit, session, item);
      return;
    }

    case "turn/plan/updated": {
      const rawEntries =
        params.entries ??
        params.plan?.entries ??
        params.plan ??
        [];

      if (!Array.isArray(rawEntries)) {
        return;
      }

      emit("provider://plan-update", {
        sessionId: session.id,
        entries: rawEntries.map((entry) => ({
          content:
            entry.content ??
            entry.title ??
            entry.text ??
            entry.step ??
            "Untitled step",
          status:
            entry.status ??
            entry.state ??
            (entry.completed === true ? "completed" : "pending"),
        })),
      });
      return;
    }

    case "thread/tokenUsage/updated": {
      session.latestTurnUsage = normalizeTurnUsage(params.tokenUsage);
      return;
    }

    case "turn/completed": {
      const turn = params.turn ?? {};
      session.status = turn.status === "failed" ? "error" : "ready";
      session.activeTurnId = null;

      if (turn.status === "failed") {
        const message =
          turn.error?.message ??
          turn.error ??
          "Codex turn failed.";
        emit("provider://error", {
          sessionId: session.id,
          error: message,
        });
        rejectCurrentPrompt(session, new Error(message));
        return;
      }

      emit("provider://prompt-complete", {
        sessionId: session.id,
        stopReason: turn.stopReason ?? "end_turn",
        ...(session.latestTurnUsage ? { meta: session.latestTurnUsage } : {}),
      });
      emit("provider://session-status", buildSessionStatus(session, "ready"));
      resolveCurrentPrompt(session);
      return;
    }

    case "error": {
      const message =
        params.error?.message ??
        params.message ??
        "Codex App Server error.";
      emit("provider://error", {
        sessionId: session.id,
        error: message,
      });
      rejectCurrentPrompt(session, new Error(message));
      return;
    }

    default:
      return;
  }
}

function handleLine(emit, session, line) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }

  if (payload.id != null && payload.method) {
    handleServerRequest(emit, session, payload);
    return;
  }

  if (payload.id != null) {
    handleResponse(session, payload);
    return;
  }

  if (payload.method) {
    handleNotification(emit, session, payload);
  }
}

function attachProcessListeners(emit, sessions, session) {
  session.output.on("line", (line) => handleLine(emit, session, line));

  session.process.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message.length > 0) {
      console.log(`[browser-local][codex] ${message}`);
    }
  });

  session.process.on("exit", () => {
    const wasTracked = sessions.delete(session.id);
    if (!wasTracked) {
      return;
    }

    rejectPendingRequests(
      session,
      new Error("Codex App Server stopped before request completed."),
    );

    if (session.currentPrompt) {
      rejectCurrentPrompt(
        session,
        new Error("Worker thread dropped while prompt was active."),
      );
      emit("provider://error", {
        sessionId: session.id,
        error: "Worker thread dropped while prompt was active.",
      });
    }

    session.status = "terminated";
    emit("provider://session-status", {
      sessionId: session.id,
      status: "terminated",
      agentSessionId: session.agentSessionId,
    });
  });
}

export function createProviderHandlers({ emit }) {
  const sessions = new Map();
  const agentRegistry = createBrowserLocalAgentRegistry({ emit });
  const claudeRuntime = createClaudeRuntime({ emit });

  async function withTemporaryCodexSession(cwd, callback) {
    const processHandle = spawnCodexProcess(cwd);
    const session = createCodexSessionRecord({
      sessionId: randomUUID(),
      cwd,
      processHandle,
      currentModeId: "auto",
    });
    const tempSessions = new Map([[session.id, session]]);
    attachProcessListeners(() => {}, tempSessions, session);

    try {
      await sendRequest(session, "initialize", buildInitializeParams(), 15_000);
      writeMessage(session, {
        jsonrpc: "2.0",
        method: "initialized",
      });
      return await callback(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        isAuthError(message)
          ? "Agent authentication required. Run the login flow and try again."
          : message,
      );
    } finally {
      tempSessions.delete(session.id);
      try {
        session.output.close();
      } catch {
        // Ignore duplicate-close races during cleanup.
      }
      killChildTree(processHandle);
    }
  }

  async function spawnSession(params) {
    const {
      agentType,
      cwd,
      localSessionId,
      resumeAgentSessionId,
      apiKey,
      mcpServers,
      approvalPolicy,
      sandboxMode,
      networkEnabled,
      timeoutSecs,
    } = params;

    if (agentType === "claude-code") {
      return claudeRuntime.spawnSession(params);
    }

    if (agentType !== "codex") {
      throw new Error(`Unsupported browser-local agent type: ${agentType}`);
    }

    const sessionId = localSessionId ?? randomUUID();
    const resolvedMode = modeFromApprovalPolicy(approvalPolicy);
    const resolvedSandbox = sandboxFromMode(sandboxMode, networkEnabled);
    const processHandle = spawnCodexProcess(cwd, { apiKey, mcpServers });
    const session = createCodexSessionRecord({
      sessionId,
      cwd,
      processHandle,
      timeoutSecs,
      currentModeId: resolvedMode,
    });

    sessions.set(sessionId, session);
    attachProcessListeners(emit, sessions, session);

    try {
      await sendRequest(session, "initialize", buildInitializeParams(), 15_000);
      writeMessage(session, {
        jsonrpc: "2.0",
        method: "initialized",
      });

      let modelListResult = null;
      try {
        modelListResult = await sendRequest(session, "model/list", {}, 10_000);
      } catch (error) {
        console.warn("[browser-local] Codex model/list failed:", error);
      }

      session.availableModelRecords = normalizeModelRecords(modelListResult);

      const threadParams = {
        cwd,
        approvalPolicy: codexApprovalPolicy(resolvedMode),
        sandbox: resolvedSandbox,
        experimentalRawEvents: false,
      };

      let threadResult;
      let resumedExistingThread = false;
      if (resumeAgentSessionId) {
        try {
          threadResult = await sendRequest(
            session,
            "thread/resume",
            {
              ...threadParams,
              threadId: resumeAgentSessionId,
            },
            20_000,
          );
          resumedExistingThread = true;
        } catch (error) {
          if (!isRecoverableResumeError(error instanceof Error ? error.message : error)) {
            throw error;
          }
          threadResult = await sendRequest(
            session,
            "thread/start",
            threadParams,
            20_000,
          );
        }
      } else {
        threadResult = await sendRequest(
          session,
          "thread/start",
          threadParams,
          20_000,
        );
      }

      session.agentSessionId =
        threadResult?.thread?.id ??
        threadResult?.threadId ??
        session.agentSessionId;
      session.codexVersion = threadResult?.thread?.cliVersion ?? session.codexVersion;
      session.currentModelId =
        threadResult?.model ??
        getSelectedModelRecord(session)?.modelId ??
        session.availableModelRecords[0]?.modelId ??
        null;
      session.reasoningEffort =
        threadResult?.reasoningEffort ??
        getSelectedModelRecord(session)?.defaultReasoningEffort ??
        "medium";

      if (resumedExistingThread && session.agentSessionId) {
        let replayThread = threadResult?.thread;
        if (!Array.isArray(replayThread?.turns)) {
          const threadRead = await sendRequest(
            session,
            "thread/read",
            {
              threadId: session.agentSessionId,
              includeTurns: true,
            },
            20_000,
          );
          replayThread = threadRead?.thread ?? threadRead;
        }

        if (replayThread) {
          replayThreadItems(emit, session, replayThread);
        }
      }

      session.status = "ready";

      emit("provider://session-status", buildSessionStatus(session, "ready"));

      return {
        id: session.id,
        agentType: session.agentType,
        cwd: session.cwd,
        status: session.status,
        createdAt: session.createdAt,
        agentSessionId: session.agentSessionId,
        timeoutSecs: session.timeoutSecs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessions.delete(sessionId);
      killChildTree(processHandle);
      emit("provider://error", {
        sessionId,
        error: isAuthError(message)
          ? "Agent authentication required. Run the login flow and try again."
          : message,
      });
      throw error;
    }
  }

  async function sendPrompt({ sessionId, prompt, context }) {
    const session = sessions.get(sessionId);
    if (!session) {
      return claudeRuntime.sendPrompt({ sessionId, prompt, context });
    }
    if (session.currentPrompt) {
      throw new Error("Another prompt is already active for this session.");
    }

    const contextText = Array.isArray(context)
      ? context
          .map((entry) => entry?.text)
          .filter((value) => typeof value === "string" && value.length > 0)
          .join("\n\n")
      : "";
    const combinedPrompt = [contextText, prompt].filter(Boolean).join("\n\n");

    session.status = "prompting";
    session.latestTurnUsage = undefined;
    emit("provider://session-status", {
      sessionId,
      status: "prompting",
      agentSessionId: session.agentSessionId,
    });

    const pendingPrompt = new Promise((resolvePromise, rejectPromise) => {
      session.currentPrompt = {
        resolve: resolvePromise,
        reject: rejectPromise,
      };
    });

    try {
      const response = await sendRequest(
        session,
        "turn/start",
        {
          threadId: session.agentSessionId,
          input: [
            {
              type: "text",
              text: combinedPrompt,
              text_elements: [],
            },
          ],
          ...(session.currentModelId ? { model: session.currentModelId } : {}),
          ...(session.reasoningEffort
            ? { effort: session.reasoningEffort }
            : {}),
        },
        20_000,
      );

      const turnId = response?.turn?.id;
      if (typeof turnId === "string") {
        session.activeTurnId = turnId;
      }

      await pendingPrompt;
    } catch (error) {
      session.status = "ready";
      rejectCurrentPrompt(
        session,
        error instanceof Error ? error : new Error(String(error)),
      );
      throw error;
    }
  }

  async function cancelPrompt({ sessionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      return claudeRuntime.cancelPrompt({ sessionId });
    }
    if (!session.activeTurnId) {
      return;
    }

    await sendRequest(
      session,
      "turn/interrupt",
      {
        threadId: session.agentSessionId,
        turnId: session.activeTurnId,
      },
      10_000,
    ).catch(() => {
      // Best-effort interrupt only.
    });

    session.status = "ready";
    emit("provider://error", {
      sessionId,
      error: "Task cancelled",
    });
    emit("provider://session-status", buildSessionStatus(session, "ready"));
    rejectCurrentPrompt(session, new Error("Task cancelled"));
  }

  async function terminateSession({ sessionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      return claudeRuntime.terminateSession({ sessionId });
    }

    sessions.delete(sessionId);
    rejectPendingRequests(
      session,
      new Error("Session terminated before request completed."),
    );
    rejectCurrentPrompt(session, new Error("Session terminated."));
    session.output.close();
    killChildTree(session.process);
    emit("provider://session-status", {
      sessionId,
      status: "terminated",
      agentSessionId: session.agentSessionId,
    });
  }

  async function listSessions() {
    return [
      ...Array.from(sessions.values()).map((session) => ({
        id: session.id,
        agentType: session.agentType,
        cwd: session.cwd,
        status: session.status,
        createdAt: session.createdAt,
        agentSessionId: session.agentSessionId,
        timeoutSecs: session.timeoutSecs,
      })),
      ...(await claudeRuntime.listSessions()),
    ];
  }

  async function setPermissionMode({ sessionId, mode }) {
    const session = sessions.get(sessionId);
    if (!session) {
      return claudeRuntime.setPermissionMode({ sessionId, mode });
    }

    session.currentModeId = mode === "ask" ? "ask" : "auto";
    emit("provider://session-status", buildSessionStatus(session));
  }

  async function respondToPermission({ sessionId, requestId, optionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      return claudeRuntime.respondToPermission({ sessionId, requestId, optionId });
    }

    const pending = session.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request: ${requestId}`);
    }

    session.pendingPermissions.delete(requestId);
    writeMessage(session, {
      jsonrpc: "2.0",
      id: pending.jsonRpcId,
      result: {
        decision: mapDecision(optionId),
      },
    });
  }

  async function respondToDiffProposal() {
    return null;
  }

  async function getAvailableAgents() {
    return agentRegistry.getAvailableAgents();
  }

  async function checkAgentAvailable({ agentType }) {
    return agentRegistry.checkAgentAvailable(agentType);
  }

  async function ensureAgentCli({ agentType }) {
    return agentRegistry.ensureAgentCli(agentType);
  }

  async function launchLogin({ agentType }) {
    agentRegistry.launchLogin(agentType);
  }

  async function listRemoteSessions({ agentType, cwd, cursor }) {
    if (agentType === "claude-code") {
      return claudeRuntime.listRemoteSessions({ cwd, cursor });
    }

    return withTemporaryCodexSession(cwd, async (session) => {
      const raw = await sendRequest(
        session,
        "thread/list",
        {
          cursor: cursor ?? undefined,
          limit: 25,
          sortKey: "updated_at",
          archived: false,
        },
        20_000,
      );
      const entries = Array.isArray(raw?.data) ? raw.data : [];

      return {
        sessions: entries
          .filter((entry) => {
            const entryCwd = entry?.cwd;
            return typeof entryCwd === "string" && entryCwd === cwd;
          })
          .map((entry) => ({
            sessionId: entry.id,
            cwd: entry.cwd,
            title:
              (typeof entry.preview === "string" && entry.preview.length > 0
                ? entry.preview
                : null) ?? null,
            updatedAt:
              (typeof entry.updatedAt === "string" && entry.updatedAt.length > 0
                ? entry.updatedAt
                : typeof entry.updated_at === "string" &&
                    entry.updated_at.length > 0
                  ? entry.updated_at
                  : null) ?? null,
          }))
          .filter(
            (entry) =>
              typeof entry.sessionId === "string" &&
              entry.sessionId.length > 0 &&
              typeof entry.cwd === "string" &&
              entry.cwd.length > 0,
          ),
        nextCursor:
          (typeof raw?.nextCursor === "string" && raw.nextCursor.length > 0
            ? raw.nextCursor
            : typeof raw?.next_cursor === "string" && raw.next_cursor.length > 0
              ? raw.next_cursor
              : null) ?? null,
      };
    });
  }

  async function nativeForkSession({ sessionId }) {
    if (claudeRuntime.hasSession(sessionId)) {
      return claudeRuntime.forkSession({ sessionId });
    }

    throw new Error(
      "Native provider forking is only supported for Claude sessions.",
    );
  }

  async function setSessionModel({ sessionId, modelId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      return claudeRuntime.setModel({ sessionId, modelId });
    }

    const targetModel =
      session.availableModelRecords.find((record) => record.modelId === modelId) ??
      null;
    if (!targetModel) {
      throw new Error(`Unknown Codex model: ${modelId}`);
    }

    session.currentModelId = targetModel.modelId;
    const supportsCurrentEffort = targetModel.supportedReasoningEfforts.some(
      (option) => option.value === session.reasoningEffort,
    );
    if (!supportsCurrentEffort) {
      session.reasoningEffort = targetModel.defaultReasoningEffort ?? "medium";
    }

    emit("provider://session-status", buildSessionStatus(session));
    emit("provider://config-options-update", {
      sessionId,
      configOptions: buildConfigOptions(session),
    });
  }

  async function setSessionMode({ sessionId, mode }) {
    return setPermissionMode({ sessionId, mode });
  }

  async function updateSessionConfigOption({ sessionId, configId, valueId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      return claudeRuntime.setConfigOption({ sessionId, configId, valueId });
    }
    if (configId !== "reasoning_effort") {
      return null;
    }

    const configOption = buildConfigOptions(session)[0];
    if (
      !configOption ||
      !configOption.options.some((option) => option.value === valueId)
    ) {
      throw new Error(`Unsupported reasoning effort: ${valueId}`);
    }

    session.reasoningEffort = valueId;
    emit("provider://config-options-update", {
      sessionId,
      configOptions: buildConfigOptions(session),
    });
    return null;
  }

  return {
    spawnSession,
    sendPrompt,
    cancelPrompt,
    terminateSession,
    listSessions,
    setPermissionMode,
    respondToPermission,
    respondToDiffProposal,
    getAvailableAgents,
    checkAgentAvailable,
    ensureAgentCli,
    launchLogin,
    listRemoteSessions,
    nativeForkSession,
    setSessionModel,
    setSessionMode,
    updateSessionConfigOption,
  };
}
