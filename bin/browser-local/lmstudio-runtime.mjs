// ABOUTME: Browser-local LM Studio runtime backed by the local LM Studio server.
// ABOUTME: Owns model discovery/loading, OpenAI-compatible streaming, and Seren MCP tool calls.

import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";
import { LMStudioClient } from "@lmstudio/sdk";
import {
  createDirectory,
  listDirectory,
  pathExists,
  readFile,
  readFileBase64,
  writeFile,
} from "./fs.mjs";
import { providerLogPrefix } from "./logging.mjs";

const DEFAULT_BASE_URL = "http://localhost:1234";
const DEFAULT_MCP_GATEWAY_URL =
  process.env.SEREN_MCP_GATEWAY_URL ?? "https://mcp.serendb.com/mcp";
const LMSTUDIO_AGENT_TYPE = "lmstudio";
const MAX_TOOL_ITERATIONS = 25;
const DEFAULT_CONTEXT_LENGTH = 4096;
const RESERVED_OUTPUT_TOKENS = 1024;
const REQUEST_INPUT_OVERHEAD_TOKENS = 128;
const MIN_COMPLETION_TOKENS = 128;
const CONTEXT_SAFETY_FRACTION = 0.82;
const AGGRESSIVE_CONTEXT_SAFETY_FRACTION = 0.58;
const MIN_INPUT_BUDGET_TOKENS = 512;
const TOOL_SCHEMA_TOKEN_SAFETY_MULTIPLIER = 1.35;
const TOOLS_UNSUPPORTED_NOTICE =
  "_This LM Studio model doesn't support tool calls, so local file access and Seren tools are off for this model._\n\n";
const TOOLS_CONTEXT_OVERFLOW_NOTICE =
  "_This LM Studio request exceeded the loaded context with tools enabled, so this turn is retrying without tools._\n\n";
const CONTEXT_TRIM_NOTICE =
  "[Seren trimmed older LM Studio context so this request fits the loaded model context window.]";

const FILE_TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file from the user's local filesystem.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file_base64",
      description:
        "Read a local binary file and return its bytes as a base64 string.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories at a local filesystem path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write UTF-8 text to a local file, creating or overwriting it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path." },
          content: { type: "string", description: "Text content to write." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "path_exists",
      description: "Check whether a local file or directory exists.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description: "Create a local directory, including missing parents.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative path." },
        },
        required: ["path"],
      },
    },
  },
];

const FILE_TOOL_HANDLERS = {
  read_file: readFile,
  read_file_base64: readFileBase64,
  list_directory: listDirectory,
  write_file: writeFile,
  path_exists: pathExists,
  create_directory: createDirectory,
};

function trimToNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeLmStudioBaseUrl(value) {
  const raw = trimToNull(value) ?? DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

export function lmStudioHttpBaseUrl(value) {
  const normalized = normalizeLmStudioBaseUrl(value);
  if (normalized.startsWith("ws://")) return `http://${normalized.slice(5)}`;
  if (normalized.startsWith("wss://")) return `https://${normalized.slice(6)}`;
  return normalized;
}

export function lmStudioWsBaseUrl(value) {
  const normalized = normalizeLmStudioBaseUrl(value);
  if (normalized.startsWith("http://")) return `ws://${normalized.slice(7)}`;
  if (normalized.startsWith("https://")) return `wss://${normalized.slice(8)}`;
  return normalized;
}

export function isLoopbackLmStudioBaseUrl(value) {
  try {
    const parsed = new URL(lmStudioHttpBaseUrl(value));
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function openAiBaseUrl(value) {
  return `${lmStudioHttpBaseUrl(value)}/v1`;
}

function isExecutableCandidate(candidate) {
  try {
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveLmsBinary() {
  const home = os.homedir();
  const appData = process.env.APPDATA ?? "";
  const localAppData = process.env.LOCALAPPDATA ?? "";

  const candidates =
    process.platform === "win32"
      ? [
          path.join(home, ".lmstudio", "bin", "lms.exe"),
          path.join(home, ".lmstudio", "bin", "lms.cmd"),
          ...(appData ? [path.join(appData, "npm", "lms.cmd")] : []),
          ...(localAppData
            ? [path.join(localAppData, "Programs", "LM Studio", "lms.exe")]
            : []),
        ]
      : [
          path.join(home, ".lmstudio", "bin", "lms"),
          path.join(home, ".local", "bin", "lms"),
          "/opt/homebrew/bin/lms",
          "/usr/local/bin/lms",
          "/usr/bin/lms",
        ];

  for (const candidate of candidates) {
    if (existsSync(candidate) && isExecutableCandidate(candidate)) {
      return candidate;
    }
  }
  return "lms";
}

export function buildLmsExecInvocation(command, args = [], platform = process.platform) {
  const normalizedCommand = String(command ?? "lms");
  const normalizedArgs = Array.isArray(args) ? args.map(String) : [];
  if (
    platform === "win32" &&
    (normalizedCommand.toLowerCase() === "lms" ||
      /\.(cmd|bat)$/i.test(normalizedCommand))
  ) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", normalizedCommand, ...normalizedArgs],
    };
  }
  return { command: normalizedCommand, args: normalizedArgs };
}

function execText(command, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const invocation = buildLmsExecInvocation(command, args);
    execFile(
      invocation.command,
      invocation.args,
      { timeout: 15_000, ...opts },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(stderr || error.message));
          return;
        }
        resolvePromise(String(stdout ?? "").trim());
      },
    );
  });
}

async function commandRuns(command, args) {
  try {
    await execText(command, args);
    return true;
  } catch {
    return false;
  }
}

async function isLmsInstalled() {
  const resolved = resolveLmsBinary();
  if (resolved !== "lms") {
    return commandRuns(resolved, ["--version"]);
  }
  return commandRuns("lms", ["--version"]);
}

function createClient(baseUrl) {
  return new LMStudioClient({
    baseUrl: lmStudioWsBaseUrl(baseUrl),
    logger: {
      info: (...args) => console.info("[lmstudio]", ...args),
      warn: (...args) => console.warn("[lmstudio]", ...args),
      error: (...args) => console.error("[lmstudio]", ...args),
      debug: (...args) => console.debug("[lmstudio]", ...args),
    },
  });
}

async function probeServer(baseUrl, apiKey, timeoutMs = 2_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${openAiBaseUrl(baseUrl)}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function startServerWithLms() {
  const binary = resolveLmsBinary();
  if (!(await isLmsInstalled())) {
    throw new Error(
      "LM Studio is not installed. Install LM Studio from https://lmstudio.ai/download, then click Retry.",
    );
  }
  await execText(binary, ["server", "start"], { timeout: 30_000 });
}

async function stopServerWithLms() {
  const binary = resolveLmsBinary();
  await execText(binary, ["server", "stop"], { timeout: 30_000 });
}

async function waitForServer(baseUrl, apiKey, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probeServer(baseUrl, apiKey, 1_500)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function modelDescription(model) {
  const parts = [
    model.paramsString,
    typeof model.quantization === "string" ? model.quantization : null,
    typeof model.sizeBytes === "number"
      ? `${(model.sizeBytes / 1024 / 1024 / 1024).toFixed(1)} GB`
      : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" • ") : undefined;
}

async function listDownloadedModels(client) {
  const models = await client.system.listDownloadedModels("llm");
  return models
    .map((model) => ({
      modelId: model.modelKey,
      name: model.displayName ?? model.modelKey,
      description: modelDescription(model),
    }))
    .filter((model) => typeof model.modelId === "string" && model.modelId.length > 0);
}

function safeJsonParse(value, fallback = {}) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function textFromMcpContent(content) {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : JSON.stringify(content ?? null);
  }
  return content
    .map((entry) => {
      if (entry?.type === "text") return entry.text ?? "";
      if (entry?.type === "image") return `[image:${entry.mimeType ?? "unknown"}]`;
      if (entry?.type === "resource") {
        return entry.resource?.text ?? entry.resource?.uri ?? JSON.stringify(entry);
      }
      return JSON.stringify(entry);
    })
    .filter(Boolean)
    .join("\n");
}

function parseEventStream(text) {
  const out = [];
  for (const event of text.split(/\n\n+/)) {
    const dataLines = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    if (data === "[DONE]") continue;
    out.push(safeJsonParse(data, null));
  }
  return out.filter(Boolean);
}

async function parseMcpResponse(response) {
  const sessionId =
    response.headers.get("mcp-session-id") ??
    response.headers.get("Mcp-Session-Id") ??
    null;
  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${text}`);
  }
  const payloads = contentType.includes("text/event-stream")
    ? parseEventStream(text)
    : [safeJsonParse(text, null)].filter(Boolean);
  const payload = payloads.find((entry) => entry?.id != null) ?? payloads.at(-1);
  if (!payload) return { sessionId, result: null };
  if (payload.error) {
    throw new Error(payload.error.message ?? JSON.stringify(payload.error));
  }
  return { sessionId, result: payload.result ?? null };
}

function createMcpGatewayClient({ apiKey, url = DEFAULT_MCP_GATEWAY_URL } = {}) {
  let nextId = 1;
  let sessionId = null;
  let initialized = false;

  async function request(method, params = {}) {
    const headers = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    };
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method,
        params,
      }),
    });
    const parsed = await parseMcpResponse(response);
    if (parsed.sessionId) sessionId = parsed.sessionId;
    return parsed.result;
  }

  async function notify(method, params = {}) {
    if (!sessionId) return;
    await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "Mcp-Session-Id": sessionId,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
      }),
    }).catch(() => {});
  }

  async function ensureInitialized() {
    if (initialized) return;
    await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "seren-lmstudio-runtime",
        version: "0.1.0",
      },
    });
    await notify("notifications/initialized", {});
    initialized = true;
  }

  return {
    async listTools() {
      if (!apiKey) return [];
      await ensureInitialized();
      const result = await request("tools/list", {});
      return Array.isArray(result?.tools) ? result.tools : [];
    },
    async callTool(name, args) {
      if (!apiKey) {
        throw new Error("Seren MCP gateway is unavailable because no Seren API key is loaded.");
      }
      await ensureInitialized();
      const result = await request("tools/call", {
        name,
        arguments: args ?? {},
      });
      return {
        content: result?.content ?? [],
        isError: result?.isError === true || result?.is_error === true,
      };
    },
  };
}

export function normalizeOpenAiToolName(name) {
  return String(name ?? "tool")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/^_+/, "")
    .slice(0, 64) || "tool";
}

function toolIncompatibleModelIds(session) {
  if (!(session.toolIncompatibleModelIds instanceof Set)) {
    session.toolIncompatibleModelIds = new Set();
  }
  return session.toolIncompatibleModelIds;
}

function modelToolStateKey(modelId) {
  return typeof modelId === "string" ? modelId.trim() : "";
}

export function isLmStudioModelToolIncompatible(
  session,
  modelId = session.currentModelId,
) {
  const key = modelToolStateKey(modelId);
  return key.length > 0 && toolIncompatibleModelIds(session).has(key);
}

export function markLmStudioModelToolIncompatible(
  session,
  modelId = session.currentModelId,
) {
  const key = modelToolStateKey(modelId);
  if (key.length > 0) {
    toolIncompatibleModelIds(session).add(key);
  }
}

function uniqueToolName(name, used) {
  const base = normalizeOpenAiToolName(name);
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    const suffix = `_${index++}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function schemaFromMcpTool(tool) {
  const schema = tool?.inputSchema ?? tool?.input_schema ?? {};
  return {
    type: "object",
    properties: schema.properties ?? {},
    required: schema.required,
    additionalProperties:
      typeof schema.additionalProperties === "boolean"
        ? schema.additionalProperties
        : true,
  };
}

async function buildToolCatalog(session) {
  const used = new Set();
  const tools = [];
  const handlers = new Map();

  for (const tool of FILE_TOOLS) {
    const name = uniqueToolName(tool.function.name, used);
    tools.push({ ...tool, function: { ...tool.function, name } });
    handlers.set(name, {
      kind: "local",
      displayName: tool.function.name,
      handler: FILE_TOOL_HANDLERS[tool.function.name],
    });
  }

  try {
    const mcpTools = await session.mcpGateway.listTools();
    for (const tool of mcpTools) {
      const originalName = String(tool.name ?? "");
      if (!originalName) continue;
      const name = uniqueToolName(originalName, used);
      tools.push({
        type: "function",
        function: {
          name,
          description: tool.description ?? `Seren MCP tool: ${originalName}`,
          parameters: schemaFromMcpTool(tool),
        },
      });
      handlers.set(name, {
        kind: "mcp",
        displayName: originalName,
        originalName,
      });
    }
  } catch (error) {
    console.warn(
      `${session.logPrefix} MCP tool discovery failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return { tools, handlers };
}

function buildSessionStatus(session, status = session.status) {
  return {
    sessionId: session.id,
    status,
    agentSessionId: session.agentSessionId,
    agentInfo: {
      name: "LM Studio",
      version: session.lmStudioVersion ?? "unknown",
    },
    models: {
      currentModelId: session.currentModelId,
      availableModels: session.availableModelRecords,
    },
    modes: {
      currentModeId: session.currentModeId,
      availableModes: [
        {
          modeId: "ask",
          name: "Suggest",
          description: "Ask before each local file or Seren MCP tool call",
        },
        {
          modeId: "auto",
          name: "Auto",
          description: "Approve tool calls automatically for this session",
        },
      ],
    },
    configOptions: [],
  };
}

function estimateLmStudioTokens(value) {
  return Math.ceil(String(value ?? "").length / 4);
}

function resolvedLmStudioContextLength(contextLength) {
  return Number.isFinite(contextLength) && contextLength > 0
    ? Math.floor(contextLength)
    : DEFAULT_CONTEXT_LENGTH;
}

function totalInputBudgetForContextLength(
  contextLength,
  { aggressive = false } = {},
) {
  const resolvedContextLength = resolvedLmStudioContextLength(contextLength);
  const fraction = aggressive
    ? AGGRESSIVE_CONTEXT_SAFETY_FRACTION
    : CONTEXT_SAFETY_FRACTION;
  return Math.max(
    MIN_INPUT_BUDGET_TOKENS,
    Math.floor(resolvedContextLength * fraction) - RESERVED_OUTPUT_TOKENS,
  );
}

function inputBudgetForContextLength(
  contextLength,
  { aggressive = false, reservedInputTokens = 0 } = {},
) {
  return Math.max(
    MIN_INPUT_BUDGET_TOKENS,
    totalInputBudgetForContextLength(contextLength, { aggressive }) -
      Math.max(0, Math.ceil(reservedInputTokens)),
  );
}

function truncateTextToTokenBudget(text, tokenBudget) {
  const raw = String(text ?? "");
  if (estimateLmStudioTokens(raw) <= tokenBudget) return raw;
  const maxChars = Math.max(0, Math.floor(tokenBudget * 4));
  if (maxChars <= 0) return "";
  return raw.slice(Math.max(0, raw.length - maxChars));
}

function contextTextFromEntries(context) {
  const contextText = Array.isArray(context)
    ? context
        .map((entry) => entry?.text)
        .filter((value) => typeof value === "string" && value.length > 0)
        .join("\n\n")
    : "";
  return contextText;
}

function buildPrompt(prompt, context) {
  return [contextTextFromEntries(context), prompt].filter(Boolean).join("\n\n");
}

export function buildLmStudioPromptForContextBudget(
  prompt,
  context,
  contextLength,
  options = {},
) {
  const fullPrompt = buildPrompt(prompt, context);
  const budget = inputBudgetForContextLength(contextLength, options);
  if (estimateLmStudioTokens(fullPrompt) <= budget) {
    return {
      prompt: fullPrompt,
      trimmed: false,
      estimatedTokens: estimateLmStudioTokens(fullPrompt),
    };
  }

  const rawPrompt = String(prompt ?? "");
  const contextText = contextTextFromEntries(context);
  const noticeTokens = estimateLmStudioTokens(CONTEXT_TRIM_NOTICE) + 8;
  const promptBudget = Math.max(128, budget - noticeTokens);
  const boundedPrompt = truncateTextToTokenBudget(rawPrompt, promptBudget);
  const remainingBudget =
    budget -
    noticeTokens -
    estimateLmStudioTokens(boundedPrompt) -
    (contextText ? 8 : 0);
  const boundedContext =
    remainingBudget > 64
      ? truncateTextToTokenBudget(contextText, remainingBudget)
      : "";
  const parts = [CONTEXT_TRIM_NOTICE];
  if (boundedContext) {
    parts.push(`Most recent retained context:\n${boundedContext}`);
  }
  parts.push(boundedPrompt);
  const bounded = parts.filter(Boolean).join("\n\n");

  return {
    prompt: bounded,
    trimmed: true,
    estimatedTokens: estimateLmStudioTokens(bounded),
  };
}

function estimateLmStudioMessageTokens(message) {
  const content =
    typeof message?.content === "string"
      ? message.content
      : JSON.stringify(message?.content ?? "");
  return 8 + estimateLmStudioTokens(content);
}

function estimateLmStudioMessagesTokens(messages) {
  return messages.reduce(
    (total, message) => total + estimateLmStudioMessageTokens(message),
    0,
  );
}

function estimateLmStudioToolTokens(tool) {
  return (
    Math.ceil(
      estimateLmStudioTokens(JSON.stringify(tool ?? {})) *
        TOOL_SCHEMA_TOKEN_SAFETY_MULTIPLIER,
    ) + 12
  );
}

function maxCompletionTokensForContextLength(contextLength, estimatedInputTokens) {
  const resolvedContextLength = resolvedLmStudioContextLength(contextLength);
  const available =
    Math.floor(resolvedContextLength * 0.94) -
    Math.max(0, Math.ceil(estimatedInputTokens));
  if (available <= 0) return 1;
  if (available < MIN_COMPLETION_TOKENS) return available;
  return Math.min(RESERVED_OUTPUT_TOKENS, available);
}

function selectLmStudioToolsForContextBudget(
  tools,
  messages,
  contextLength,
  options = {},
) {
  const availableTools = Array.isArray(tools) ? tools : [];
  const messageTokens = estimateLmStudioMessagesTokens(
    Array.isArray(messages) ? messages : [],
  );
  const availableToolBudget =
    totalInputBudgetForContextLength(contextLength, options) -
    messageTokens -
    REQUEST_INPUT_OVERHEAD_TOKENS;
  const selected = [];
  let estimatedTokens = 0;

  if (availableToolBudget <= 0) {
    return {
      tools: selected,
      droppedTools: availableTools.length,
      estimatedTokens,
    };
  }

  for (const tool of availableTools) {
    const toolTokens = estimateLmStudioToolTokens(tool);
    if (estimatedTokens + toolTokens > availableToolBudget) continue;
    selected.push(tool);
    estimatedTokens += toolTokens;
  }

  return {
    tools: selected,
    droppedTools: availableTools.length - selected.length,
    estimatedTokens,
  };
}

export function prepareLmStudioMessagesForContextBudget(
  messages,
  contextLength,
  options = {},
) {
  const budget = inputBudgetForContextLength(contextLength, options);
  let prepared = Array.isArray(messages) ? [...messages] : [];
  let droppedMessages = 0;

  while (
    prepared.length > 1 &&
    estimateLmStudioMessagesTokens(prepared) > budget
  ) {
    const nextUserIndex = prepared.findIndex(
      (message, index) => index > 0 && message?.role === "user",
    );
    if (nextUserIndex === -1) break;
    droppedMessages += nextUserIndex;
    prepared = prepared.slice(nextUserIndex);
  }

  while (prepared.length > 1 && prepared[0]?.role !== "user") {
    prepared.shift();
    droppedMessages += 1;
  }

  if (
    prepared.length === 1 &&
    estimateLmStudioMessagesTokens(prepared) > budget
  ) {
    const [onlyMessage] = prepared;
    if (typeof onlyMessage?.content === "string") {
      const contentBudget = Math.max(
        128,
        budget - estimateLmStudioTokens(CONTEXT_TRIM_NOTICE) - 8,
      );
      prepared = [
        {
          ...onlyMessage,
          content: `${CONTEXT_TRIM_NOTICE}\n\n${truncateTextToTokenBudget(
            onlyMessage.content,
            contentBudget,
          )}`,
        },
      ];
    }
  }

  return {
    messages: prepared,
    droppedMessages,
    estimatedTokens: estimateLmStudioMessagesTokens(prepared),
  };
}

export function buildLmStudioChatCompletionBodyForContextBudget({
  model,
  messages,
  tools = [],
  contextLength,
  useTools = true,
  options = {},
}) {
  const availableTools = useTools && Array.isArray(tools) ? tools : [];
  let selectedTools = selectLmStudioToolsForContextBudget(
    availableTools,
    messages,
    contextLength,
    options,
  );
  let prepared = prepareLmStudioMessagesForContextBudget(
    messages,
    contextLength,
    {
      ...options,
      reservedInputTokens:
        selectedTools.estimatedTokens + REQUEST_INPUT_OVERHEAD_TOKENS,
    },
  );

  selectedTools = selectLmStudioToolsForContextBudget(
    availableTools,
    prepared.messages,
    contextLength,
    options,
  );
  prepared = prepareLmStudioMessagesForContextBudget(messages, contextLength, {
    ...options,
    reservedInputTokens:
      selectedTools.estimatedTokens + REQUEST_INPUT_OVERHEAD_TOKENS,
  });

  const estimatedInputTokens =
    prepared.estimatedTokens +
    selectedTools.estimatedTokens +
    REQUEST_INPUT_OVERHEAD_TOKENS;
  const maxTokens = maxCompletionTokensForContextLength(
    contextLength,
    estimatedInputTokens,
  );
  const baseBody = {
    model,
    messages: prepared.messages,
    stream: true,
    max_tokens: maxTokens,
  };

  return {
    body:
      selectedTools.tools.length > 0
        ? { ...baseBody, tools: selectedTools.tools, tool_choice: "auto" }
        : baseBody,
    messages: prepared.messages,
    droppedMessages: prepared.droppedMessages,
    estimatedMessageTokens: prepared.estimatedTokens,
    estimatedToolTokens: selectedTools.estimatedTokens,
    estimatedInputTokens,
    droppedTools: selectedTools.droppedTools,
    maxTokens,
  };
}

export function isLmStudioContextOverflowError(message) {
  const lower = String(message ?? "").toLowerCase();
  return (
    (lower.includes("tokens to keep") && lower.includes("context length")) ||
    lower.includes("context length exceeded") ||
    lower.includes("context window exceeded") ||
    lower.includes("prompt is too long")
  );
}

function appendToolDelta(accumulator, toolCall) {
  const index = toolCall.index ?? 0;
  const current =
    accumulator.get(index) ??
    {
      id: toolCall.id ?? `call_${index}`,
      type: "function",
      function: { name: "", arguments: "" },
    };
  if (toolCall.id) current.id = toolCall.id;
  if (toolCall.function?.name) {
    current.function.name += toolCall.function.name;
  }
  if (toolCall.function?.arguments) {
    current.function.arguments += toolCall.function.arguments;
  }
  accumulator.set(index, current);
}

export function normalizeToolCalls(accumulator) {
  return Array.from(accumulator.entries())
    .sort(([left], [right]) => left - right)
    .map(([, call], index) => ({
      id: call.id || `call_${index}`,
      type: "function",
      function: {
        name: call.function?.name ?? "",
        arguments: call.function?.arguments ?? "{}",
      },
    }))
    .filter((call) => call.function.name);
}

/**
 * Extract reasoning text from an OpenAI-compatible streaming delta (or a
 * non-streamed message). LM Studio exposes a reasoning model's chain of thought
 * as `reasoning_content`; some builds use `reasoning`. Returns "" when neither
 * is present so non-reasoning models are unaffected.
 */
export function reasoningTextFromDelta(delta) {
  if (typeof delta?.reasoning_content === "string") return delta.reasoning_content;
  if (typeof delta?.reasoning === "string") return delta.reasoning;
  return "";
}

function throwIfErrorPayload(payload) {
  if (payload?.error == null) return;
  const detail = payload.error?.message ?? payload.error;
  throw new Error(
    typeof detail === "string" ? detail : JSON.stringify(detail),
  );
}

/**
 * True when an LM Studio failure means the loaded model can't accept tool
 * definitions. Tool support is a property of the specific GGUF's Jinja chat
 * template, not the model family — community "obliterated"/abliterated builds
 * routinely ship a template that throws when `tools` are present, while the
 * official build of the same model handles them. We can't know up front, so
 * the caller degrades reactively on these signatures.
 */
export function isToolIncompatibilityError(message) {
  const lower = String(message ?? "").toLowerCase();
  return (
    lower.includes("jinja") ||
    lower.includes("does not support tool") ||
    lower.includes("doesn't support tool") ||
    lower.includes("not support tools") ||
    lower.includes("tool use is not supported") ||
    lower.includes("tools are not supported") ||
    lower.includes("tool calling is not supported") ||
    lower.includes("function calling is not supported") ||
    lower.includes("tool_choice")
  );
}

async function streamOpenAiResponse({ session, body, signal, onContent }) {
  const response = await fetch(`${openAiBaseUrl(session.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(session.apiKey ? { Authorization: `Bearer ${session.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`LM Studio chat completion HTTP ${response.status}: ${detail}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    const payload = await response.json();
    throwIfErrorPayload(payload);
    const message = payload?.choices?.[0]?.message ?? {};
    const reasoning = reasoningTextFromDelta(message);
    if (reasoning.length > 0) onContent(reasoning, { isThought: true });
    if (message.content) onContent(message.content);
    return {
      content: message.content ?? "",
      toolCalls: message.tool_calls ?? [],
      stopReason: payload?.choices?.[0]?.finish_reason ?? "stop",
    };
  }

  const decoder = new TextDecoder();
  const toolAccumulator = new Map();
  let buffer = "";
  let content = "";
  let stopReason = "stop";

  const processEvent = (event) => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") return;

    const payload = safeJsonParse(data, null);
    // LM Studio reports server/model failures (e.g. a chat template that can't
    // render tool definitions) as a 200 OK SSE `event: error` frame with no
    // `choices`. Surface it instead of silently returning an empty completion.
    throwIfErrorPayload(payload);
    const choice = payload?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) stopReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    // Reasoning models (Qwen3.5, DeepSeek-R1, gpt-oss) stream their chain of
    // thought as `reasoning_content` before any `content`. Surface it as a
    // thought chunk so the UI shows live "thinking…" instead of a blank,
    // hung-looking reply. Reasoning is display-only — never added to `content`,
    // so it does not re-enter the model's context on later turns.
    const reasoning = reasoningTextFromDelta(delta);
    if (reasoning.length > 0) {
      onContent(reasoning, { isThought: true });
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content;
      onContent(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const toolCall of delta.tool_calls) {
        appendToolDelta(toolAccumulator, toolCall);
      }
    }
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      processEvent(event);
    }
  }
  // Flush a trailing event the server emitted without a closing blank line —
  // otherwise a final error frame can be dropped and surface as an empty reply.
  if (buffer.trim().length > 0) {
    processEvent(buffer);
  }

  return {
    content,
    toolCalls: normalizeToolCalls(toolAccumulator),
    stopReason,
  };
}

/**
 * Run one chat completion, degrading gracefully when the loaded model rejects
 * tool definitions. Tool-capable models keep full tool calling; models whose
 * chat template can't render tools (common for community local builds) drop
 * tools for that model and retry, so the user always gets a reply instead of a
 * silent empty response.
 */
async function runChatCompletion({ session, tools, signal, onContent }) {
  const requestModelId = session.currentModelId;
  const useTools =
    tools.length > 0 &&
    !isLmStudioModelToolIncompatible(session, requestModelId);
  const buildPreparedBody = (options = {}, forceNoTools = false) =>
    buildLmStudioChatCompletionBodyForContextBudget({
      model: requestModelId,
      messages: session.messages,
      tools,
      contextLength: session.contextLength,
      useTools: useTools && !forceNoTools,
      options,
    });
  const applyPreparedBody = (prepared) => {
    if (prepared.messages !== session.messages) {
      session.messages = prepared.messages;
    }
    return prepared.body;
  };
  const logPreparedBodyTrim = (prepared, estimatedTokensBefore) => {
    if (
      prepared.droppedMessages > 0 ||
      prepared.estimatedMessageTokens < estimatedTokensBefore
    ) {
      console.warn(
        prepared.droppedMessages > 0
          ? `${session.logPrefix} trimmed ${prepared.droppedMessages} old message(s) to fit ${session.contextLength ?? DEFAULT_CONTEXT_LENGTH} token context.`
          : `${session.logPrefix} trimmed an oversized message to fit ${session.contextLength ?? DEFAULT_CONTEXT_LENGTH} token context.`,
      );
    }
    if (useTools && prepared.droppedTools > 0) {
      console.warn(
        `${session.logPrefix} omitted ${prepared.droppedTools} LM Studio tool definition(s) to fit ${session.contextLength ?? DEFAULT_CONTEXT_LENGTH} token context.`,
      );
    }
  };

  try {
    const estimatedTokensBefore = estimateLmStudioMessagesTokens(
      session.messages,
    );
    const prepared = buildPreparedBody();
    logPreparedBodyTrim(prepared, estimatedTokensBefore);
    const body = applyPreparedBody(prepared);
    return await streamOpenAiResponse({
      session,
      signal,
      onContent,
      body,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isLmStudioContextOverflowError(message)) {
      const estimatedTokensBefore = estimateLmStudioMessagesTokens(
        session.messages,
      );
      const prepared = buildPreparedBody({ aggressive: true });
      if (prepared.droppedMessages > 0 || prepared.droppedTools > 0) {
        console.warn(
          `${session.logPrefix} LM Studio reported context overflow; retrying with tighter local context trim.`,
        );
        logPreparedBodyTrim(prepared, estimatedTokensBefore);
        const retryBody = applyPreparedBody(prepared);
        try {
          return await streamOpenAiResponse({
            session,
            signal,
            onContent,
            body: retryBody,
          });
        } catch (retryError) {
          const retryMessage =
            retryError instanceof Error ? retryError.message : String(retryError);
          if (!useTools || !isLmStudioContextOverflowError(retryMessage)) {
            throw retryError;
          }
        }
      }
      if (useTools) {
        console.warn(
          `${session.logPrefix} LM Studio context overflow persisted with tools; retrying this turn without tools.`,
        );
        onContent(TOOLS_CONTEXT_OVERFLOW_NOTICE);
        const noToolBody = applyPreparedBody(
          buildPreparedBody({ aggressive: true }, true),
        );
        return streamOpenAiResponse({
          session,
          signal,
          onContent,
          body: noToolBody,
        });
      }
    }
    if (
      !useTools ||
      error?.name === "AbortError" ||
      !isToolIncompatibilityError(message)
    ) {
      throw error;
    }

    markLmStudioModelToolIncompatible(session, requestModelId);
    console.warn(
      `${session.logPrefix} model "${requestModelId}" rejected tool definitions (${message}); retrying without tools for this model.`,
    );
    // One-time, honest notice so the user understands why tools are inactive.
    // Emitted to the UI only (not pushed into session.messages), so it never
    // re-enters the model's context on later turns.
    onContent(TOOLS_UNSUPPORTED_NOTICE);
    return streamOpenAiResponse({
      session,
      signal,
      onContent,
      body: applyPreparedBody(buildPreparedBody({}, true)),
    });
  }
}

async function requestPermission(session, toolCall, args) {
  if (
    session.currentModeId === "auto" ||
    session.approvedForSession.has(toolCall.function.name)
  ) {
    return "accept";
  }

  const requestId = randomUUID();
  const permission = new Promise((resolve) => {
    session.pendingPermissions.set(requestId, { resolve, toolName: toolCall.function.name });
  });

  session.emit("provider://permission-request", {
    sessionId: session.id,
    requestId,
    toolCall: {
      name: toolCall.function.name,
      title: toolCall.function.name,
      input: args,
    },
    options: [
      {
        optionId: "accept",
        label: "Approve once",
        description: "Run this tool call one time.",
      },
      {
        optionId: "acceptForSession",
        label: "Approve session",
        description: "Allow this tool for the rest of the session.",
      },
      {
        optionId: "decline",
        label: "Deny",
        description: "Return a denial to the model.",
      },
    ],
  });

  return permission;
}

async function executeToolCall(session, toolCall, handlers) {
  const args = safeJsonParse(toolCall.function.arguments, {});
  const handler = handlers.get(toolCall.function.name);
  const title = handler?.displayName ?? toolCall.function.name;

  session.emit("provider://tool-call", {
    sessionId: session.id,
    toolCallId: toolCall.id,
    title,
    name: toolCall.function.name,
    kind: handler?.kind ?? "tool",
    status: "pending",
    parameters: args,
  });

  const decision = await requestPermission(session, toolCall, args);
  if (decision === "decline" || decision === "cancel" || decision === "deny") {
    const denial = "Tool call denied by the user.";
    session.emit("provider://tool-result", {
      sessionId: session.id,
      toolCallId: toolCall.id,
      status: "denied",
      error: denial,
    });
    return { role: "tool", tool_call_id: toolCall.id, content: denial };
  }
  if (decision === "acceptForSession") {
    session.approvedForSession.add(toolCall.function.name);
  }

  session.emit("provider://tool-call", {
    sessionId: session.id,
    toolCallId: toolCall.id,
    title,
    name: toolCall.function.name,
    kind: handler?.kind ?? "tool",
    status: "running",
    parameters: args,
  });

  try {
    let result;
    if (!handler) {
      throw new Error(`Unknown tool: ${toolCall.function.name}`);
    }
    if (handler.kind === "local") {
      result = await handler.handler(args);
    } else {
      const mcpResult = await session.mcpGateway.callTool(handler.originalName, args);
      if (mcpResult.isError) {
        throw new Error(textFromMcpContent(mcpResult.content));
      }
      result = textFromMcpContent(mcpResult.content);
    }
    const content =
      typeof result === "string" ? result : JSON.stringify(result ?? null, null, 2);
    session.emit("provider://tool-result", {
      sessionId: session.id,
      toolCallId: toolCall.id,
      status: "completed",
      result: content,
    });
    return { role: "tool", tool_call_id: toolCall.id, content };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    session.emit("provider://tool-result", {
      sessionId: session.id,
      toolCallId: toolCall.id,
      status: "error",
      error: message,
    });
    return { role: "tool", tool_call_id: toolCall.id, content: message };
  }
}

async function ensureModelLoaded(session, modelId = session.currentModelId) {
  if (!modelId) {
    throw new Error(
      "No LM Studio model selected. Download a model in LM Studio and select it from Seren.",
    );
  }
  if (session.loadedModelKey === modelId && session.contextLength) return;

  const loadedBefore = await session.client.llm.listLoaded().catch(() => []);
  const wasLoaded = loadedBefore.some(
    (model) =>
      model.modelKey === modelId ||
      model.path === modelId ||
      model.identifier === modelId,
  );
  const model = await session.client.llm.model(modelId, { verbose: false });
  session.loadedModelKey = modelId;
  session.loadedModelIdentifier = model.identifier;
  session.loadedBySession = !wasLoaded;
  session.loadedModelHandle = model;
  session.contextLength = await model
    .getContextLength()
    .catch(() => DEFAULT_CONTEXT_LENGTH);
}

async function sendPromptToLmStudio(session, prompt, context) {
  if (session.currentPrompt) {
    throw new Error(
      "Another prompt is already active for this LM Studio session.",
    );
  }

  session.status = "prompting";
  session.emit(
    "provider://session-status",
    buildSessionStatus(session, "prompting"),
  );

  const abortController = new AbortController();
  session.currentPrompt = { abortController };

  try {
    await ensureModelLoaded(session);
    const builtPrompt = buildLmStudioPromptForContextBudget(
      prompt,
      context,
      session.contextLength,
    );
    if (builtPrompt.trimmed) {
      console.warn(
        `${session.logPrefix} trimmed LM Studio prompt context before dispatch (${builtPrompt.estimatedTokens} estimated tokens).`,
      );
    }
    session.messages.push({
      role: "user",
      content: builtPrompt.prompt,
    });

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const { tools, handlers } = await buildToolCatalog(session);
      const result = await runChatCompletion({
        session,
        tools,
        signal: abortController.signal,
        onContent: (text, options) => {
          session.emit("provider://message-chunk", {
            sessionId: session.id,
            text,
            ...(options?.isThought ? { isThought: true } : {}),
          });
        },
      });

      if (!result.toolCalls || result.toolCalls.length === 0) {
        session.messages.push({
          role: "assistant",
          content: result.content,
        });
        session.status = "ready";
        session.currentPrompt = null;
        session.emit("provider://prompt-complete", {
          sessionId: session.id,
          stopReason: result.stopReason ?? "stop",
        });
        session.emit("provider://session-status", buildSessionStatus(session, "ready"));
        return;
      }

      session.messages.push({
        role: "assistant",
        content: result.content || null,
        tool_calls: result.toolCalls,
      });

      for (const toolCall of result.toolCalls) {
        const toolResult = await executeToolCall(session, toolCall, handlers);
        session.messages.push(toolResult);
      }
    }

    throw new Error("LM Studio stopped after too many tool iterations.");
  } catch (error) {
    session.status = "ready";
    session.currentPrompt = null;
    const message =
      error?.name === "AbortError"
        ? "Task cancelled"
        : error instanceof Error
          ? error.message
          : String(error);
    session.emit("provider://error", { sessionId: session.id, error: message });
    session.emit("provider://session-status", buildSessionStatus(session, "ready"));
    throw error;
  }
}

export function createLmStudioRuntime({ emit, runtimeMode = "provider-runtime" }) {
  const sessions = new Map();
  const logPrefix = providerLogPrefix("lmstudio", runtimeMode);

  function hasSession(sessionId) {
    return sessions.has(sessionId);
  }

  async function spawnSession(params) {
    const sessionId = params.localSessionId ?? randomUUID();
    const baseUrl = normalizeLmStudioBaseUrl(params.lmStudioBaseUrl);
    const lmStudioApiKey = trimToNull(params.lmStudioApiKey);
    const serenApiKey = trimToNull(params.apiKey);
    const client = createClient(baseUrl);

    if (!(await probeServer(baseUrl, lmStudioApiKey))) {
      if (!isLoopbackLmStudioBaseUrl(baseUrl)) {
        throw new Error(
          `LM Studio server is not reachable at ${baseUrl}. Start it on that machine and try again.`,
        );
      }
      await startServerWithLms();
      const ready = await waitForServer(baseUrl, lmStudioApiKey);
      if (!ready) {
        throw new Error("LM Studio server did not become ready after lms server start.");
      }
    }

    const availableModelRecords = await listDownloadedModels(client);
    if (availableModelRecords.length === 0) {
      throw new Error(
        "No local LM Studio models are downloaded. Download a chat model in LM Studio, then try again.",
      );
    }

    const initialModel =
      availableModelRecords.find((model) => model.modelId === params.initialModelId) ??
      availableModelRecords[0];
    const lmStudioVersion = await client.system
      .getLMStudioVersion()
      .then((info) => info.version)
      .catch(() => null);

    const session = {
      id: sessionId,
      agentType: LMSTUDIO_AGENT_TYPE,
      cwd: params.cwd,
      status: "initializing",
      createdAt: new Date().toISOString(),
      agentSessionId: sessionId,
      timeoutSecs: params.timeoutSecs ?? undefined,
      baseUrl,
      apiKey: lmStudioApiKey,
      client,
      mcpGateway: createMcpGatewayClient({ apiKey: serenApiKey }),
      availableModelRecords,
      currentModelId: initialModel.modelId,
      currentModeId: params.approvalPolicy === "never" ? "auto" : "ask",
      currentPrompt: null,
      pendingPermissions: new Map(),
      approvedForSession: new Set(),
      messages: [],
      toolIncompatibleModelIds: new Set(),
      loadedModelKey: null,
      loadedModelIdentifier: null,
      loadedModelHandle: null,
      loadedBySession: false,
      contextLength: null,
      lmStudioVersion,
      logPrefix,
      emit,
    };

    sessions.set(sessionId, session);
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
      pid: null,
    };
  }

  async function sendPrompt({ sessionId, prompt, context }) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown LM Studio session: ${sessionId}`);
    return sendPromptToLmStudio(session, prompt, context);
  }

  async function cancelPrompt({ sessionId }) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown LM Studio session: ${sessionId}`);
    session.currentPrompt?.abortController?.abort();
    session.currentPrompt = null;
    session.status = "ready";
    emit("provider://error", { sessionId, error: "Task cancelled" });
    emit("provider://session-status", buildSessionStatus(session, "ready"));
  }

  async function terminateSession({ sessionId }) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown LM Studio session: ${sessionId}`);
    sessions.delete(sessionId);
    session.currentPrompt?.abortController?.abort();
    if (session.loadedBySession && session.loadedModelIdentifier) {
      await session.client.llm.unload(session.loadedModelIdentifier).catch((error) => {
        console.warn(`${logPrefix} failed to unload model:`, error);
      });
    }
    await session.client[Symbol.asyncDispose]?.().catch(() => {});
    emit("provider://session-status", {
      sessionId,
      status: "terminated",
      agentSessionId: session.agentSessionId,
    });
  }

  async function listSessions() {
    return Array.from(sessions.values()).map((session) => ({
      id: session.id,
      agentType: session.agentType,
      cwd: session.cwd,
      status: session.status,
      createdAt: session.createdAt,
      agentSessionId: session.agentSessionId,
      timeoutSecs: session.timeoutSecs,
    }));
  }

  async function setPermissionMode({ sessionId, mode }) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown LM Studio session: ${sessionId}`);
    session.currentModeId = mode === "auto" ? "auto" : "ask";
    emit("provider://session-status", buildSessionStatus(session));
  }

  async function respondToPermission({ sessionId, requestId, optionId }) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown LM Studio session: ${sessionId}`);
    const pending = session.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`No pending permission request: ${requestId}`);
    session.pendingPermissions.delete(requestId);
    pending.resolve(optionId);
  }

  async function setSessionModel({ sessionId, modelId }) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown LM Studio session: ${sessionId}`);
    const targetModel = session.availableModelRecords.find(
      (model) => model.modelId === modelId,
    );
    if (!targetModel) throw new Error(`Unknown LM Studio model: ${modelId}`);
    session.currentModelId = targetModel.modelId;
    await ensureModelLoaded(session, targetModel.modelId);
    emit("provider://session-status", buildSessionStatus(session));
  }

  async function updateSessionConfigOption() {
    return null;
  }

  async function listRemoteSessions() {
    return { sessions: [], nextCursor: null };
  }

  async function testConnection({ baseUrl, apiKey }) {
    const resolvedBaseUrl = normalizeLmStudioBaseUrl(baseUrl);
    const resolvedApiKey = trimToNull(apiKey);
    const reachable = await probeServer(resolvedBaseUrl, resolvedApiKey, 3_000);
    if (!reachable) {
      return {
        ok: false,
        baseUrl: resolvedBaseUrl,
        message: `LM Studio server is not reachable at ${resolvedBaseUrl}.`,
      };
    }
    const client = createClient(resolvedBaseUrl);
    try {
      const models = await listDownloadedModels(client);
      return {
        ok: true,
        baseUrl: resolvedBaseUrl,
        models,
        message: `Connected to LM Studio with ${models.length} downloaded model${
          models.length === 1 ? "" : "s"
        }.`,
      };
    } finally {
      await client[Symbol.asyncDispose]?.().catch(() => {});
    }
  }

  async function startServer({ baseUrl, apiKey }) {
    const resolvedBaseUrl = normalizeLmStudioBaseUrl(baseUrl);
    if (!isLoopbackLmStudioBaseUrl(resolvedBaseUrl)) {
      throw new Error("Server lifecycle controls are disabled for LAN LM Studio URLs.");
    }
    await startServerWithLms();
    const ready = await waitForServer(resolvedBaseUrl, trimToNull(apiKey));
    if (!ready) {
      throw new Error("LM Studio server did not become ready after start.");
    }
    return { ok: true };
  }

  async function stopServer({ baseUrl }) {
    const resolvedBaseUrl = normalizeLmStudioBaseUrl(baseUrl);
    if (!isLoopbackLmStudioBaseUrl(resolvedBaseUrl)) {
      throw new Error("Server lifecycle controls are disabled for LAN LM Studio URLs.");
    }
    await stopServerWithLms();
    return { ok: true };
  }

  return {
    hasSession,
    spawnSession,
    sendPrompt,
    cancelPrompt,
    terminateSession,
    listSessions,
    setPermissionMode,
    respondToPermission,
    setSessionModel,
    updateSessionConfigOption,
    listRemoteSessions,
    testConnection,
    startServer,
    stopServer,
  };
}

export async function checkLmStudioAvailable({ baseUrl, apiKey } = {}) {
  const resolvedBaseUrl = normalizeLmStudioBaseUrl(baseUrl);
  if (await probeServer(resolvedBaseUrl, trimToNull(apiKey), 1_000)) return true;
  return isLoopbackLmStudioBaseUrl(resolvedBaseUrl) && isLmsInstalled();
}

export async function checkLmStudioAuthenticated({ baseUrl, apiKey } = {}) {
  return probeServer(normalizeLmStudioBaseUrl(baseUrl), trimToNull(apiKey), 1_000);
}

export async function ensureLmStudioCli() {
  if (await isLmsInstalled()) {
    return resolveLmsBinary();
  }
  throw new Error(
    "LM Studio is not installed. Install LM Studio from https://lmstudio.ai/download.",
  );
}

export function launchLmStudioDownload() {
  const url = "https://lmstudio.ai/download";
  if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
    }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

export function killLmStudioChildTree(child) {
  if (process.platform === "win32" && child?.pid !== undefined) {
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
    child?.kill();
  } catch {
    // Ignore.
  }
}
