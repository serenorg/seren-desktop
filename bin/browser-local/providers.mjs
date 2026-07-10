// ABOUTME: Browser-local provider runtime for direct agent integrations.
// ABOUTME: Runs Codex App Server directly over stdio while delegating install/login metadata to the agent registry.

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";
import {
  createBrowserLocalAgentRegistry,
  resolveInstalledCodexBinary,
} from "./agent-registry.mjs";
import { providerLogPrefix } from "./logging.mjs";
import { buildProviderMcpConfig } from "./mcp-config.mjs";
import { composeWindowsShellCommand } from "./windows-shell-args.mjs";

// Agent runtimes are loaded in isolation (#2457). Each runtime module is
// imported dynamically inside try/catch so that one agent failing to load — a
// missing optional dependency, a broken native binding, a throwing module —
// cannot crash the provider runtime or disable the other agents. A runtime that
// fails to load or instantiate is replaced with an unavailable stub that owns
// no sessions and throws a clear, per-agent error only when that agent is used.
async function loadAgentRuntimeModule(label, importer) {
  try {
    return { module: await importer(), error: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[provider-runtime] ${label} runtime failed to load: ${reason}`);
    return { module: null, error: reason };
  }
}

const claudeRuntimeModule = await loadAgentRuntimeModule(
  "claude-code",
  () => import("./claude-runtime.mjs"),
);
const geminiRuntimeModule = await loadAgentRuntimeModule(
  "gemini",
  () => import("./gemini-runtime.mjs"),
);
const lmStudioRuntimeModule = await loadAgentRuntimeModule(
  "lmstudio",
  () => import("./lmstudio-runtime.mjs"),
);
const pairedRuntimeModule = await loadAgentRuntimeModule(
  "claude-codex",
  () => import("./paired-runtime.mjs"),
);

// Needed for synchronous dispatch before the paired runtime is instantiated;
// fall back to the known identifier if the module failed to load so dispatch
// still recognizes the type and routes it to the unavailable stub.
const PAIRED_AGENT_TYPE =
  pairedRuntimeModule.module?.PAIRED_AGENT_TYPE ?? "claude-codex";

const CODEX_DEFAULT_INTENTS = new Set(["direct", "paired-executor"]);
const CODEX_DIRECT_PREFERRED_MODELS = ["gpt-5.6-sol", "gpt-5.6"];
const CODEX_PAIRED_EXECUTOR_PREFERRED_MODELS = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
];
const CODEX_KNOWN_GPT56_MODELS = new Map([
  [
    "gpt-5.6-sol",
    {
      name: "GPT-5.6 Sol",
      description: "Flagship GPT-5.6 model for Codex.",
      defaultReasoningEffort: "medium",
    },
  ],
  [
    "gpt-5.6",
    {
      name: "GPT-5.6",
      description: "GPT-5.6 alias that routes to Sol.",
      defaultReasoningEffort: "medium",
    },
  ],
  [
    "gpt-5.6-luna",
    {
      name: "GPT-5.6 Luna",
      description: "Fast, lower-cost GPT-5.6 model for Codex.",
      defaultReasoningEffort: "low",
    },
  ],
  [
    "gpt-5.6-terra",
    {
      name: "GPT-5.6 Terra",
      description: "Balanced GPT-5.6 model for Codex.",
      defaultReasoningEffort: "medium",
    },
  ],
]);
const CODEX_KNOWN_MODEL_PICKER_ORDER = [
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
];
const CODEX_GPT56_REASONING_EFFORTS = [
  { value: "low", name: "low" },
  { value: "medium", name: "medium" },
  { value: "high", name: "high" },
  { value: "xhigh", name: "xhigh" },
];

export function createUnavailableRuntime(label, reason) {
  const detail = reason ? `: ${reason}` : "";
  const unavailable = async () => {
    throw new Error(`The ${label} agent is unavailable${detail}`);
  };
  return {
    // Sync predicates must never force a load: an unavailable runtime owns no
    // sessions, so routing skips it and the other agents are unaffected.
    hasSession: () => false,
    interceptEmit: () => false,
    listSessions: async () => [],
    spawnSession: unavailable,
    sendPrompt: unavailable,
    cancelPrompt: unavailable,
    terminateSession: unavailable,
    setPermissionMode: unavailable,
    respondToPermission: unavailable,
    listRemoteSessions: unavailable,
    setModel: unavailable,
    setSessionModel: unavailable,
    setConfigOption: unavailable,
    updateSessionConfigOption: unavailable,
    forkSession: unavailable,
    buildSyntheticTranscript: unavailable,
    testConnection: unavailable,
    startServer: unavailable,
    stopServer: unavailable,
  };
}

function instantiateAgentRuntime(label, loaded, factoryName, args) {
  if (!loaded.module) {
    return createUnavailableRuntime(label, loaded.error);
  }
  const factory = loaded.module[factoryName];
  if (typeof factory !== "function") {
    return createUnavailableRuntime(
      label,
      `${factoryName} export missing from ${label} runtime`,
    );
  }
  try {
    return factory(args);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(
      `[provider-runtime] ${label} runtime failed to initialize: ${reason}`,
    );
    return createUnavailableRuntime(label, reason);
  }
}

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
  if (
    networkEnabled ||
    sandboxMode === "danger-full-access" ||
    sandboxMode === "full-access"
  ) {
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

function getContextText(context) {
  return Array.isArray(context)
    ? context
        .map((entry) => entry?.text)
        .filter((value) => typeof value === "string" && value.length > 0)
        .join("\n\n")
    : "";
}

function toDataImageUrl(entry) {
  if (!entry || entry.type !== "image") return null;
  if (typeof entry.url === "string" && entry.url.length > 0) return entry.url;

  const data = typeof entry.data === "string" ? entry.data : entry.base64;
  const mimeType =
    typeof entry.mimeType === "string" && entry.mimeType.length > 0
      ? entry.mimeType
      : typeof entry.mime_type === "string" && entry.mime_type.length > 0
        ? entry.mime_type
        : "image/png";

  if (typeof data !== "string" || data.length === 0) return null;
  if (data.startsWith("data:")) return data;
  return `data:${mimeType};base64,${data}`;
}

export function buildCodexTurnInput(prompt, context) {
  const contextText = getContextText(context);
  const combinedPrompt = [contextText, prompt].filter(Boolean).join("\n\n");
  const input = [];

  if (combinedPrompt) {
    input.push({
      type: "text",
      text: combinedPrompt,
      text_elements: [],
    });
  }

  if (Array.isArray(context)) {
    for (const entry of context) {
      const url = toDataImageUrl(entry);
      if (url) input.push({ type: "image", url });
    }
  }

  return input;
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
  const useWindowsShell = process.platform === "win32";
  const args = ["app-server"];
  if (mcpConfig.codexMcpConfigOverride) {
    args.push("-c", mcpConfig.codexMcpConfigOverride);
  }

  // Use the absolute-path resolver instead of bare `"codex"` so GUI-launched
  // instances don't depend on shell PATH — addresses the same class of
  // Windows regressions we hit for Claude (#876, #928, #1297, #1409).
  const codexBinary = resolveInstalledCodexBinary();
  const spawnEnv = {
    ...process.env,
    ...mcpConfig.childEnv,
  };

  if (useWindowsShell) {
    return spawn(composeWindowsShellCommand(codexBinary, args), {
      cwd,
      env: spawnEnv,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
      windowsVerbatimArguments: true,
    });
  }

  return spawn(codexBinary, args, {
    cwd,
    env: spawnEnv,
    stdio: ["pipe", "pipe", "pipe"],
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
    serviceTier: null,
    latestTurnUsage: undefined,
  };
}

function normalizeServiceTier(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function normalizeServiceTiers(record) {
  const tiers = [];
  const seen = new Set();
  const addTier = (id, name, description) => {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) {
      return;
    }
    seen.add(id);
    tiers.push({
      id,
      name: typeof name === "string" && name.length > 0 ? name : id,
      description:
        typeof description === "string" && description.length > 0
          ? description
          : null,
    });
  };

  if (Array.isArray(record?.serviceTiers)) {
    for (const tier of record.serviceTiers) {
      addTier(tier?.id, tier?.name, tier?.description);
    }
  }

  if (Array.isArray(record?.additionalSpeedTiers)) {
    for (const tier of record.additionalSpeedTiers) {
      addTier(tier, tier, null);
    }
  }

  return tiers;
}

function getFastServiceTier(modelRecord) {
  return (
    modelRecord?.serviceTiers?.find((tier) => tier.id === "fast") ?? null
  );
}

function normalizeModelRecords(result) {
  const data = Array.isArray(result?.data) ? result.data : [];
  return data
    .filter((record) => record && record.hidden !== true)
    .map((record) => {
      const serviceTiers = normalizeServiceTiers(record);
      return {
        modelId: record.id ?? record.model,
        name:
          record.displayName ?? record.id ?? record.model ?? "Unknown model",
        description: record.description ?? undefined,
        defaultReasoningEffort:
          record.defaultReasoningEffort ??
          record.default_reasoning_effort ??
          "medium",
        supportedReasoningEfforts: Array.isArray(
          record.supportedReasoningEfforts,
        )
          ? record.supportedReasoningEfforts
              .map((effort) => ({
                value: effort.reasoningEffort,
                name: effort.reasoningEffort,
                description: effort.description ?? undefined,
              }))
              .filter((effort) => typeof effort.value === "string")
          : [],
        defaultServiceTier: normalizeServiceTier(
          record.defaultServiceTier ?? record.default_service_tier,
        ),
        serviceTiers,
        isDefault: record.isDefault === true,
      };
    })
    .filter((record) => typeof record.modelId === "string");
}

function codexKnownModelRecord(modelId) {
  const known = CODEX_KNOWN_GPT56_MODELS.get(modelId);
  if (!known) return null;
  return {
    modelId,
    name: known.name,
    description: known.description,
    defaultReasoningEffort: known.defaultReasoningEffort,
    supportedReasoningEfforts: CODEX_GPT56_REASONING_EFFORTS,
    defaultServiceTier: null,
    serviceTiers: [],
    isDefault: false,
  };
}

function withKnownCodexModelRecords(records) {
  const catalog = Array.isArray(records) ? records : [];
  const seen = new Set(catalog.map((record) => record.modelId));
  const known = CODEX_KNOWN_MODEL_PICKER_ORDER
    .filter((modelId) => !seen.has(modelId))
    .map(codexKnownModelRecord)
    .filter(Boolean);
  return [...catalog, ...known];
}

function normalizeCodexDefaultIntent(value) {
  return CODEX_DEFAULT_INTENTS.has(value) ? value : "direct";
}

function findModelRecord(records, modelId) {
  return (
    records.find((record) => record.modelId === modelId) ??
    null
  );
}

function getCatalogDefaultModelRecord(records) {
  return records.find((record) => record.isDefault) ?? records[0] ?? null;
}

function resolveCodexPreferredModelRecord(
  records,
  { intent = "direct", explicitModelId = null } = {},
) {
  const catalog = Array.isArray(records) ? records : [];
  if (typeof explicitModelId === "string" && explicitModelId.length > 0) {
    const explicit =
      findModelRecord(catalog, explicitModelId) ??
      codexKnownModelRecord(explicitModelId);
    if (explicit) return explicit;
  }

  const preferred =
    normalizeCodexDefaultIntent(intent) === "paired-executor"
      ? CODEX_PAIRED_EXECUTOR_PREFERRED_MODELS
      : CODEX_DIRECT_PREFERRED_MODELS;
  for (const modelId of preferred) {
    const record =
      findModelRecord(catalog, modelId) ?? codexKnownModelRecord(modelId);
    if (record) return record;
  }

  return getCatalogDefaultModelRecord(catalog);
}

function resolveCodexInitialReasoningEffort(
  modelRecord,
  { intent = "direct", explicitEffort = null } = {},
) {
  const supported = Array.isArray(modelRecord?.supportedReasoningEfforts)
    ? modelRecord.supportedReasoningEfforts
        .map((option) => option?.value)
        .filter((value) => typeof value === "string" && value.length > 0)
    : [];
  const supports = (value) => supported.length === 0 || supported.includes(value);
  const preferred =
    typeof explicitEffort === "string" && explicitEffort.length > 0
      ? explicitEffort
      : normalizeCodexDefaultIntent(intent) === "paired-executor"
        ? "low"
        : (modelRecord?.defaultReasoningEffort ?? "medium");

  if (supports(preferred)) return preferred;
  const modelDefault = modelRecord?.defaultReasoningEffort ?? null;
  if (modelDefault && supports(modelDefault)) return modelDefault;
  return supported[0] ?? "medium";
}

function getSelectedModelRecord(session) {
  return (
    session.availableModelRecords.find(
      (record) => record.modelId === session.currentModelId,
    ) ??
    getCatalogDefaultModelRecord(session.availableModelRecords)
  );
}

function buildAvailableModels(session) {
  return session.availableModelRecords.map((record) => ({
    modelId: record.modelId,
    name: record.name,
    description: record.description,
    supportsFastMode: getFastServiceTier(record) !== null,
  }));
}

function buildReasoningEffortConfigOption(session) {
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
    return null;
  }

  const currentValue = efforts.some(
    (option) => option.value === session.reasoningEffort,
  )
    ? session.reasoningEffort
    : efforts[0]?.value ?? "medium";

  session.reasoningEffort = currentValue;

  return {
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
  };
}

function buildFastModeConfigOption(session) {
  const fastTier = getFastServiceTier(getSelectedModelRecord(session));
  if (!fastTier) {
    return null;
  }

  return {
    id: "fast_mode",
    name: "Fast Mode",
    description: "Uses the Codex Fast service tier for future turns.",
    type: "select",
    currentValue: session.serviceTier === fastTier.id ? "on" : "off",
    options: [
      {
        value: "on",
        name: "On",
        description: fastTier.description,
      },
      {
        value: "off",
        name: "Off",
        description: "Use the model's standard service tier.",
      },
    ],
  };
}

function buildConfigOptions(session) {
  const options = [];
  const reasoningEffortOption = buildReasoningEffortConfigOption(session);
  if (reasoningEffortOption) {
    options.push(reasoningEffortOption);
  }
  const fastModeOption = buildFastModeConfigOption(session);
  if (fastModeOption) {
    options.push(fastModeOption);
  }
  return options;
}

function codexServiceTierFromFastModeValue(valueId, session) {
  switch (valueId) {
    case "on": {
      const fastTier = getFastServiceTier(getSelectedModelRecord(session));
      if (!fastTier) {
        throw new Error("Fast mode is not supported by the selected Codex model.");
      }
      return fastTier.id;
    }
    case "off":
      return null;
    default:
      throw new Error(`Unsupported fast mode value: ${valueId}`);
  }
}

function buildCodexThreadStartParams(
  session,
  cwd,
  resolvedMode,
  resolvedSandbox,
) {
  return {
    cwd,
    approvalPolicy: codexApprovalPolicy(resolvedMode),
    sandbox: resolvedSandbox,
    experimentalRawEvents: false,
    ...(session.currentModelId ? { model: session.currentModelId } : {}),
    ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
  };
}

function buildCodexTurnStartParams(session, prompt, context) {
  return {
    threadId: session.agentSessionId,
    input: buildCodexTurnInput(prompt, context),
    ...(session.currentModelId ? { model: session.currentModelId } : {}),
    ...(session.reasoningEffort ? { effort: session.reasoningEffort } : {}),
    ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
  };
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

export function normalizeTurnUsage(tokenUsage) {
  const last = tokenUsage?.last ?? tokenUsage?.total ?? null;
  if (!last) {
    return undefined;
  }

  const meta = {
    usage: {
      input_tokens: last.inputTokens,
      output_tokens: last.outputTokens,
    },
  };

  if (
    typeof tokenUsage?.modelContextWindow === "number" &&
    tokenUsage.modelContextWindow > 0
  ) {
    meta.contextWindow = tokenUsage.modelContextWindow;
  }

  return meta;
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

function buildApprovalOptions() {
  return [
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
  ];
}

function buildPermissionRequestEvent(session, requestId, method, params) {
  return {
    sessionId: session.id,
    requestId,
    toolCall: buildApprovalToolCall(method, params),
    options: buildApprovalOptions(),
  };
}

function listPendingPermissions(session) {
  return Array.from(session.pendingPermissions.values()).map(
    (pending) => pending.permissionRequest,
  );
}

function isRecoverableResumeError(message) {
  const lower = String(message).toLowerCase();
  return (
    lower.includes("not found") ||
    lower.includes("missing thread") ||
    lower.includes("unknown thread") ||
    lower.includes("does not exist") ||
    lower.includes("no rollout") ||
    lower.includes("timed out")
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
  const params = payload.params ?? {};
  const pendingPermission = {
    requestId,
    jsonRpcId: payload.id,
    method,
    permissionRequest: buildPermissionRequestEvent(
      session,
      requestId,
      method,
      params,
    ),
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

  emit("provider://permission-request", pendingPermission.permissionRequest);
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
      const completedTurnId = turn.id ?? params.turnId;

      // Ignore stale turn/completed from a previously cancelled turn.
      // After cancellation, a delayed completion can race with a new prompt
      // and resolve/reject the wrong currentPrompt.
      if (
        typeof completedTurnId === "string" &&
        typeof session.activeTurnId === "string" &&
        completedTurnId !== session.activeTurnId
      ) {
        return;
      }

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

function attachProcessListeners(
  emit,
  sessions,
  session,
  logPrefix = providerLogPrefix("codex"),
) {
  session.output.on("line", (line) => handleLine(emit, session, line));

  session.process.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message.length > 0) {
      console.log(`${logPrefix} ${message}`);
    }
  });

  // Spawn-error guard (#1735): when the codex binary is missing or not
  // executable, Node emits an 'error' event on the ChildProcess. Without
  // a listener here, the default handling rethrows it as an
  // uncaughtException, killing the entire provider-runtime helper —
  // which takes down every agent runtime (claude, gemini, codex) for the
  // user. Translate to a structured per-session error so the UI can
  // surface "Codex is not installed" and the runtime stays alive.
  session.process.on("error", (err) => {
    const message =
      err && err.code === "ENOENT"
        ? "Codex binary not found. Install codex or fix the spawn path."
        : `Codex spawn error: ${err?.message ?? String(err)}`;
    console.warn(`${logPrefix} ${message}`);
    sessions.delete(session.id);
    if (session.currentPrompt) {
      rejectCurrentPrompt(session, new Error(message));
    }
    rejectPendingRequests(session, new Error(message));
    emit("provider://error", {
      sessionId: session.id,
      error: message,
    });
    session.status = "terminated";
    emit("provider://session-status", {
      sessionId: session.id,
      status: "terminated",
      agentSessionId: session.agentSessionId,
    });
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

export function createProviderHandlers({ emit: rawEmit, runtimeMode = "provider-runtime" }) {
  const sessions = new Map();
  // Paired-thread interceptor (#2368): events from inner Claude/Codex
  // sessions that belong to a paired `claude-codex` thread are remapped to
  // the paired session id (with role attribution) before reaching the
  // frontend. Non-paired sessions pass through untouched.
  let pairedRuntime = null;
  const emit = (channel, payload) => {
    if (pairedRuntime?.interceptEmit(channel, payload)) return;
    rawEmit(channel, payload);
  };
  const codexLogPrefix = providerLogPrefix("codex", runtimeMode);
  const agentRegistry = createBrowserLocalAgentRegistry({ emit });
  const claudeRuntime = instantiateAgentRuntime(
    "claude-code",
    claudeRuntimeModule,
    "createClaudeRuntime",
    { emit, runtimeMode },
  );
  const geminiRuntime = instantiateAgentRuntime(
    "gemini",
    geminiRuntimeModule,
    "createGeminiRuntime",
    { emit, runtimeMode },
  );
  const lmStudioRuntime = instantiateAgentRuntime(
    "lmstudio",
    lmStudioRuntimeModule,
    "createLmStudioRuntime",
    { emit, runtimeMode },
  );

  async function withTemporaryCodexSession(cwd, callback) {
    const processHandle = spawnCodexProcess(cwd);
    const session = createCodexSessionRecord({
      sessionId: randomUUID(),
      cwd,
      processHandle,
      currentModeId: "auto",
    });
    const tempSessions = new Map([[session.id, session]]);
    attachProcessListeners(() => {}, tempSessions, session, codexLogPrefix);

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
      initialModelId,
      reasoningEffort,
      codexDefaultIntent,
    } = params;

    if (agentType === PAIRED_AGENT_TYPE) {
      return pairedRuntime.spawnSession(params);
    }

    if (agentType === "claude-code") {
      return claudeRuntime.spawnSession(params);
    }

    if (agentType === "gemini") {
      return geminiRuntime.spawnSession(params);
    }

    if (agentType === "lmstudio") {
      return lmStudioRuntime.spawnSession(params);
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
    attachProcessListeners(emit, sessions, session, codexLogPrefix);

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
        console.warn(`${codexLogPrefix} model/list failed:`, error);
        // If the process was terminated during model/list, don't continue
        // to thread/start on a dead process — it will just time out.
        const errMsg = error instanceof Error ? error.message : String(error);
        if (errMsg.includes("terminated") || errMsg.includes("stopped")) {
          throw error;
        }
      }

      // Verify the session is still tracked before proceeding to thread/start.
      // A terminated session would cause a 20s timeout on a dead stdin pipe.
      if (!sessions.has(sessionId)) {
        throw new Error("Codex session was terminated during initialization.");
      }

      session.availableModelRecords = withKnownCodexModelRecords(
        normalizeModelRecords(modelListResult),
      );
      const defaultIntent = normalizeCodexDefaultIntent(codexDefaultIntent);
      const preferredModelRecord = resolveCodexPreferredModelRecord(
        session.availableModelRecords,
        {
          intent: defaultIntent,
          explicitModelId: initialModelId,
        },
      );
      session.currentModelId = preferredModelRecord?.modelId ?? null;
      session.reasoningEffort = resolveCodexInitialReasoningEffort(
        preferredModelRecord,
        {
          intent: defaultIntent,
          explicitEffort: reasoningEffort,
        },
      );

      const threadParams = {
        cwd,
        approvalPolicy: codexApprovalPolicy(resolvedMode),
        sandbox: resolvedSandbox,
        experimentalRawEvents: false,
        ...(session.serviceTier ? { serviceTier: session.serviceTier } : {}),
      };
      const threadStartParams = buildCodexThreadStartParams(
        session,
        cwd,
        resolvedMode,
        resolvedSandbox,
      );

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
            threadStartParams,
            20_000,
          );
        }
      } else {
        threadResult = await sendRequest(
          session,
          "thread/start",
          threadStartParams,
          20_000,
        );
      }

      session.agentSessionId =
        threadResult?.thread?.id ??
        threadResult?.threadId ??
        session.agentSessionId;
      session.codexVersion = threadResult?.thread?.cliVersion ?? session.codexVersion;
      const requestedModelId =
        getSelectedModelRecord(session)?.modelId ??
        session.availableModelRecords[0]?.modelId ??
        null;
      const servedModelId = threadResult?.model ?? null;
      // Codex's only place where a CLI silent fallback can surface is the
      // thread/start (or thread/resume) response — message.model is not
      // emitted by the codex stream the way Anthropic's is. Log when the
      // CLI hands us back a different model than we requested. #1718.
      if (
        servedModelId &&
        requestedModelId &&
        servedModelId !== requestedModelId
      ) {
        console.warn(
          `${codexLogPrefix} threadResult.model: requested=${requestedModelId}, served=${servedModelId}`,
        );
      }
      session.currentModelId = resumedExistingThread
        ? (servedModelId ?? requestedModelId ?? null)
        : (requestedModelId ?? servedModelId ?? null);
      if (resumedExistingThread) {
        session.reasoningEffort =
          threadResult?.reasoningEffort ??
          getSelectedModelRecord(session)?.defaultReasoningEffort ??
          session.reasoningEffort ??
          "medium";
      } else {
        session.reasoningEffort = resolveCodexInitialReasoningEffort(
          getSelectedModelRecord(session),
          {
            intent: defaultIntent,
            explicitEffort: reasoningEffort,
          },
        );
      }
      session.serviceTier = normalizeServiceTier(threadResult?.serviceTier);

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
        // OS PID of the agent child, so Rust can force-kill this one session
        // when the cooperative cancel/terminate RPCs are unreachable. #2313
        pid: session.process?.pid ?? null,
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
      if (pairedRuntime.hasSession(sessionId)) {
        return pairedRuntime.sendPrompt({ sessionId, prompt, context });
      }
      if (geminiRuntime.hasSession(sessionId)) {
        return geminiRuntime.sendPrompt({ sessionId, prompt, context });
      }
      if (lmStudioRuntime.hasSession(sessionId)) {
        return lmStudioRuntime.sendPrompt({ sessionId, prompt, context });
      }
      return claudeRuntime.sendPrompt({ sessionId, prompt, context });
    }
    if (session.currentPrompt) {
      throw new Error("Another prompt is already active for this session.");
    }

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
        buildCodexTurnStartParams(session, prompt, context),
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
      if (pairedRuntime.hasSession(sessionId)) {
        return pairedRuntime.cancelPrompt({ sessionId });
      }
      if (geminiRuntime.hasSession(sessionId)) {
        return geminiRuntime.cancelPrompt({ sessionId });
      }
      if (lmStudioRuntime.hasSession(sessionId)) {
        return lmStudioRuntime.cancelPrompt({ sessionId });
      }
      return claudeRuntime.cancelPrompt({ sessionId });
    }
    if (session.activeTurnId) {
      // Capture and clear activeTurnId before sending interrupt so a stale
      // turn/completed from this turn cannot match a subsequently started turn.
      const interruptTurnId = session.activeTurnId;
      session.activeTurnId = null;

      let interrupted = false;
      try {
        await sendRequest(
          session,
          "turn/interrupt",
          {
            threadId: session.agentSessionId,
            turnId: interruptTurnId,
          },
          10_000,
        );
        interrupted = true;
      } catch {
        // Interrupt not acknowledged — escalate below.
      }

      if (!interrupted) {
        // turn/interrupt was not honored (Codex hung or unresponsive). Hard-
        // kill the child tree so the cancel actually stops the agent, mirroring
        // terminateSession and the Claude cancel path. #2304.
        killChildTree(session.process);
      }
    }

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
      if (pairedRuntime.hasSession(sessionId)) {
        return pairedRuntime.terminateSession({ sessionId });
      }
      if (geminiRuntime.hasSession(sessionId)) {
        return geminiRuntime.terminateSession({ sessionId });
      }
      if (lmStudioRuntime.hasSession(sessionId)) {
        return lmStudioRuntime.terminateSession({ sessionId });
      }
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
        currentModelId: session.currentModelId,
        currentModeId: session.currentModeId,
        pendingPermissions: listPendingPermissions(session),
      })),
      ...(await claudeRuntime.listSessions()),
      ...(await geminiRuntime.listSessions()),
      ...(await lmStudioRuntime.listSessions()),
      ...(await pairedRuntime.listSessions()),
    ];
  }

  async function setPermissionMode({ sessionId, mode }) {
    const session = sessions.get(sessionId);
    if (!session) {
      if (pairedRuntime.hasSession(sessionId)) {
        return pairedRuntime.setPermissionMode({ sessionId, mode });
      }
      if (geminiRuntime.hasSession(sessionId)) {
        return geminiRuntime.setPermissionMode({ sessionId, mode });
      }
      if (lmStudioRuntime.hasSession(sessionId)) {
        return lmStudioRuntime.setPermissionMode({ sessionId, mode });
      }
      return claudeRuntime.setPermissionMode({ sessionId, mode });
    }

    session.currentModeId = mode === "ask" ? "ask" : "auto";
    emit("provider://session-status", buildSessionStatus(session));
  }

  async function respondToPermission({ sessionId, requestId, optionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      if (pairedRuntime.hasSession(sessionId)) {
        return pairedRuntime.respondToPermission({
          sessionId,
          requestId,
          optionId,
        });
      }
      if (geminiRuntime.hasSession(sessionId)) {
        return geminiRuntime.respondToPermission({ sessionId, requestId, optionId });
      }
      if (lmStudioRuntime.hasSession(sessionId)) {
        return lmStudioRuntime.respondToPermission({
          sessionId,
          requestId,
          optionId,
        });
      }
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

  async function checkAgentAuthenticated({ agentType }) {
    return agentRegistry.checkAgentAuthenticated(agentType);
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

    if (agentType === PAIRED_AGENT_TYPE) {
      // Paired threads resume from the conversation row's composite
      // agent_session_id, not from a remote session listing.
      return { sessions: [], nextCursor: null };
    }

    if (agentType === "gemini") {
      // gemini-cli supports `--list-sessions` and `--resume <index>` but the
      // ACP `session/load` flow is not yet wired through the desktop. Return
      // an empty list so the UI doesn't fail; users always get a fresh thread.
      return { sessions: [], nextCursor: null };
    }

    if (agentType === "lmstudio") {
      return lmStudioRuntime.listRemoteSessions({ cwd, cursor });
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

  async function buildSyntheticTranscript({
    sessionId,
    summaryText,
    preserveCount,
  }) {
    if (!claudeRuntime.hasSession(sessionId)) {
      throw new Error(
        "Synthetic-transcript pre-warm is only supported for Claude sessions.",
      );
    }
    return claudeRuntime.buildSyntheticTranscript({
      sessionId,
      summaryText,
      preserveCount,
    });
  }

  async function setSessionModel({ sessionId, modelId, role }) {
    const session = sessions.get(sessionId);
    if (!session) {
      if (pairedRuntime.hasSession(sessionId)) {
        return pairedRuntime.setSessionModel({ sessionId, modelId, role });
      }
      if (geminiRuntime.hasSession(sessionId)) {
        return geminiRuntime.setModel({ sessionId, modelId });
      }
      if (lmStudioRuntime.hasSession(sessionId)) {
        return lmStudioRuntime.setSessionModel({ sessionId, modelId });
      }
      return claudeRuntime.setModel({ sessionId, modelId });
    }

    const targetModel =
      session.availableModelRecords.find((record) => record.modelId === modelId) ??
      null;
    if (!targetModel) {
      throw new Error(`Unknown Codex model: ${modelId}`);
    }

    session.currentModelId = targetModel.modelId;
    if (
      session.serviceTier &&
      !targetModel.serviceTiers.some((tier) => tier.id === session.serviceTier)
    ) {
      if (session.agentSessionId) {
        await sendRequest(
          session,
          "thread/settings/update",
          {
            threadId: session.agentSessionId,
            serviceTier: null,
          },
          10_000,
        );
      }
      session.serviceTier = null;
    }
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

  // Read the switchable model catalog for a session. The paired coordinator uses
  // it to resolve the planner pin (Fable 5, else newest Opus) against what the
  // account can actually switch to. Codex sessions live in the local `sessions`
  // map; a Claude planner session is owned by claudeRuntime.
  function listSessionModels(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      return buildAvailableModels(session);
    }
    return claudeRuntime.listSessionModels(sessionId);
  }

  async function setSessionMode({ sessionId, mode }) {
    return setPermissionMode({ sessionId, mode });
  }

  async function updateSessionConfigOption({ sessionId, configId, valueId, role }) {
    const session = sessions.get(sessionId);
    if (!session) {
      if (pairedRuntime.hasSession(sessionId)) {
        return pairedRuntime.updateSessionConfigOption({
          sessionId,
          configId,
          valueId,
          role,
        });
      }
      if (geminiRuntime.hasSession(sessionId)) {
        // Gemini exposes no config options today — silently no-op.
        return null;
      }
      if (lmStudioRuntime.hasSession(sessionId)) {
        return lmStudioRuntime.updateSessionConfigOption({
          sessionId,
          configId,
          valueId,
          role,
        });
      }
      return claudeRuntime.setConfigOption({ sessionId, configId, valueId });
    }

    if (configId === "fast_mode") {
      const serviceTier = codexServiceTierFromFastModeValue(valueId, session);
      if (session.agentSessionId) {
        await sendRequest(
          session,
          "thread/settings/update",
          {
            threadId: session.agentSessionId,
            serviceTier,
          },
          10_000,
        );
      }
      session.serviceTier = serviceTier;
      emit("provider://config-options-update", {
        sessionId,
        configOptions: buildConfigOptions(session),
      });
      return null;
    }

    if (configId !== "reasoning_effort") {
      return null;
    }

    const configOption = buildConfigOptions(session).find(
      (option) => option.id === "reasoning_effort",
    );
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

  // Created last so the paired coordinator can drive the handler functions
  // above as its inner runtime (hoisted declarations). It receives the RAW
  // emit — its own events must not re-enter the interceptor.
  pairedRuntime = instantiateAgentRuntime(
    "claude-codex",
    pairedRuntimeModule,
    "createPairedRuntime",
    {
      emit: rawEmit,
      inner: {
        spawnSession,
        sendPrompt,
        cancelPrompt,
        terminateSession,
        setSessionModel,
        listSessionModels,
        updateSessionConfigOption,
        setPermissionMode,
        respondToPermission,
      },
    },
  );

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
    checkAgentAuthenticated,
    ensureAgentCli,
    launchLogin,
    listRemoteSessions,
    nativeForkSession,
    buildSyntheticTranscript,
    setSessionModel,
    setSessionMode,
    updateSessionConfigOption,
    testLmStudioConnection: lmStudioRuntime.testConnection,
    startLmStudioServer: lmStudioRuntime.startServer,
    stopLmStudioServer: lmStudioRuntime.stopServer,
  };
}

export {
  buildCodexThreadStartParams as _buildCodexThreadStartParams,
  buildCodexTurnStartParams as _buildCodexTurnStartParams,
  buildSessionStatus as _buildCodexSessionStatus,
  codexServiceTierFromFastModeValue as _codexServiceTierFromFastModeValue,
  codexApprovalPolicy as _codexApprovalPolicy,
  modeFromApprovalPolicy as _modeFromApprovalPolicy,
  normalizeModelRecords as _normalizeCodexModelRecords,
  resolveCodexInitialReasoningEffort as _resolveCodexInitialReasoningEffort,
  resolveCodexPreferredModelRecord as _resolveCodexPreferredModelRecord,
  sandboxFromMode as _sandboxFromMode,
};
