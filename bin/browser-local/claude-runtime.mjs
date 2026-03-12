// ABOUTME: Browser-local Claude Code runtime backed by the local claude CLI.
// ABOUTME: Manages long-lived stream-json sessions, permissions, and session listing without ACP.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { buildProviderMcpConfig } from "./mcp-config.mjs";

/**
 * Resolve the full path to the `claude` binary.
 * GUI apps don't inherit shell profile PATH additions, so `which claude`
 * and bare `spawn("claude")` may fail even when Claude Code is installed.
 * Check well-known install locations before falling back to bare command name.
 */
function resolveClaudeBinary() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? "";
    if (appData) {
      const candidate = path.join(appData, "Claude", "claude.exe");
      if (existsSync(candidate)) {
        return candidate;
      }
    }
    return "claude";
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, ".claude", "bin", "claude"),
    path.join(home, ".local", "bin", "claude"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Try PATH lookup (works when Rust side has extended PATH correctly)
  try {
    const resolved = execFileSync("which", ["claude"], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    if (resolved) {
      return resolved;
    }
  } catch {
    // which failed — fall through to bare command name
  }

  return "claude";
}

function isAuthError(message) {
  const lower = String(message).toLowerCase();
  return (
    lower.includes("invalid api key") ||
    lower.includes("authentication required") ||
    lower.includes("auth required") ||
    lower.includes("failed to authenticate") ||
    lower.includes("login required") ||
    lower.includes("not logged in") ||
    lower.includes("please login again") ||
    lower.includes("please sign in") ||
    lower.includes("session expired") ||
    lower.includes("does not have access") ||
    lower.includes("re-authenticate")
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

function encodeProjectDirName(cwd) {
  const resolved = path.resolve(cwd);
  const unixPath = resolved.replaceAll("\\", "/");
  const sanitized = unixPath.replace(/^\/+/, "").replaceAll(":", "");
  return `-${sanitized.replaceAll("/", "-")}`;
}

function claudeProjectsRoot() {
  return path.join(os.homedir(), ".claude", "projects");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(targetPath) {
  const bytes = await fs.readFile(targetPath, "utf8");
  return JSON.parse(bytes);
}

async function findSessionsIndexPath(cwd) {
  const root = claudeProjectsRoot();
  const direct = path.join(root, encodeProjectDirName(cwd), "sessions-index.json");
  if (await pathExists(direct)) {
    return direct;
  }

  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  const resolvedCwd = path.resolve(cwd);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const indexPath = path.join(root, entry.name, "sessions-index.json");
    if (!(await pathExists(indexPath))) {
      continue;
    }

    try {
      const index = await readJson(indexPath);
      if (
        index?.originalPath === resolvedCwd ||
        index?.originalPath === cwd
      ) {
        return indexPath;
      }
    } catch {
      // Ignore malformed indexes.
    }
  }

  return null;
}

async function readSessionsIndex(cwd) {
  const indexPath = await findSessionsIndexPath(cwd);
  if (!indexPath) {
    return null;
  }

  try {
    return await readJson(indexPath);
  } catch {
    return null;
  }
}

async function findSessionJsonlPath(cwd, sessionId) {
  const index = await readSessionsIndex(cwd);
  const entry = index?.entries?.find?.((candidate) => candidate.sessionId === sessionId);
  if (entry?.fullPath) {
    return entry.fullPath;
  }

  const inferred = path.join(
    claudeProjectsRoot(),
    encodeProjectDirName(cwd),
    `${sessionId}.jsonl`,
  );
  if (await pathExists(inferred)) {
    return inferred;
  }

  let entries;
  try {
    entries = await fs.readdir(claudeProjectsRoot(), { withFileTypes: true });
  } catch {
    return null;
  }

  for (const directory of entries) {
    if (!directory.isDirectory()) {
      continue;
    }
    const candidate = path.join(
      claudeProjectsRoot(),
      directory.name,
      `${sessionId}.jsonl`,
    );
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildModeState(currentModeId) {
  return {
    currentModeId,
    availableModes: [
      {
        modeId: "default",
        name: "Default",
        description: "Standard behavior",
      },
      {
        modeId: "acceptEdits",
        name: "Accept Edits",
        description: "Auto-accept file edit operations",
      },
      {
        modeId: "plan",
        name: "Plan Mode",
        description: "Planning mode; no actual tool execution",
      },
      {
        modeId: "bypassPermissions",
        name: "Bypass Permissions",
        description: "Auto-approve all operations",
      },
    ],
  };
}

function buildAvailableModels(session) {
  return session.availableModelRecords.map((record) => ({
    modelId: record.modelId,
    name: record.name,
    description: record.description,
  }));
}

function buildSessionStatus(session, status = session.status) {
  return {
    sessionId: session.id,
    status,
    agentSessionId: session.agentSessionId,
    agentInfo: {
      name: "Claude Code",
      version: session.claudeVersion ?? "unknown",
    },
    ...(session.availableModelRecords.length > 0
      ? {
          models: {
            currentModelId:
              session.currentModelId ??
              session.availableModelRecords[0]?.modelId ??
              "default",
            availableModels: buildAvailableModels(session),
          },
        }
      : {}),
    modes: buildModeState(session.currentModeId),
  };
}

function normalizeModelRecords(result) {
  const models = Array.isArray(result?.models) ? result.models : [];
  return models
    .map((record) => ({
      modelId: record?.value ?? null,
      name: record?.displayName ?? record?.value ?? "Unknown model",
      description: record?.description ?? undefined,
      supportsEffort: record?.supportsEffort === true,
      supportedEffortLevels: Array.isArray(record?.supportedEffortLevels)
        ? record.supportedEffortLevels.filter(
            (effort) => typeof effort === "string",
          )
        : [],
      isDefault: record?.value === "default",
    }))
    .filter((record) => typeof record.modelId === "string");
}

function inferCurrentModelId(currentModel, records) {
  if (!currentModel || records.length === 0) {
    return records[0]?.modelId ?? null;
  }

  const exact = records.find((record) => record.modelId === currentModel);
  if (exact) {
    return exact.modelId;
  }

  const lower = String(currentModel).toLowerCase();
  if (lower.includes("opus")) {
    return (
      records.find((record) => record.modelId === "default")?.modelId ??
      records.find((record) => record.modelId.startsWith("opus"))?.modelId ??
      records[0]?.modelId ??
      null
    );
  }

  if (lower.includes("sonnet")) {
    return (
      records.find((record) => record.modelId.startsWith("sonnet"))?.modelId ??
      records[0]?.modelId ??
      null
    );
  }

  if (lower.includes("haiku")) {
    return (
      records.find((record) => record.modelId.startsWith("haiku"))?.modelId ??
      records[0]?.modelId ??
      null
    );
  }

  return records[0]?.modelId ?? null;
}

function combinePrompt(prompt, context) {
  const contextText = Array.isArray(context)
    ? context
        .map((entry) => entry?.text)
        .filter((value) => typeof value === "string" && value.length > 0)
        .join("\n\n")
    : "";
  return [contextText, prompt].filter(Boolean).join("\n\n");
}

function toolKindForName(toolName) {
  const lower = String(toolName ?? "").toLowerCase();
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec")) {
    return "commandExecution";
  }
  if (lower.includes("read")) {
    return "fileRead";
  }
  if (
    lower.includes("edit") ||
    lower.includes("write") ||
    lower.includes("replace")
  ) {
    return "fileChange";
  }
  if (
    lower.includes("search") ||
    lower.includes("grep") ||
    lower.includes("glob")
  ) {
    return "search";
  }
  if (lower.includes("fetch") || lower.includes("web")) {
    return "webFetch";
  }
  return toolName ?? "tool";
}

function isEditLikeTool(toolName) {
  const lower = String(toolName ?? "").toLowerCase();
  return (
    lower.includes("edit") ||
    lower.includes("write") ||
    lower.includes("replace") ||
    lower.includes("notebookedit")
  );
}

function resolveToolTitle(toolName, input) {
  if (toolName === "Bash" && typeof input?.description === "string") {
    return input.description;
  }
  if (toolName === "Bash" && typeof input?.command === "string") {
    return input.command;
  }
  if (typeof input?.file_path === "string") {
    return `${toolName}: ${input.file_path}`;
  }
  if (typeof input?.path === "string") {
    return `${toolName}: ${input.path}`;
  }
  return toolName ?? "Tool call";
}

function buildPermissionToolCall(toolName, input, toolUseId) {
  return {
    id: toolUseId,
    name: toolName,
    title: resolveToolTitle(toolName, input),
    input,
  };
}

function stringifyToolResultContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((block) =>
        typeof block?.text === "string"
          ? block.text
          : typeof block === "string"
            ? block
            : JSON.stringify(block),
      )
      .filter((value) => typeof value === "string" && value.length > 0);
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
    return JSON.stringify(content);
  }

  if (content && typeof content === "object") {
    return JSON.stringify(content);
  }

  return undefined;
}

function emitToolCall(emit, session, toolName, input, toolUseId, status = "in_progress") {
  const title = resolveToolTitle(toolName, input);
  emit("provider://tool-call", {
    sessionId: session.id,
    toolCallId: toolUseId,
    title,
    kind: toolKindForName(toolName),
    status,
    parameters: input,
  });
}

function emitToolResult(emit, session, toolUseId, content, isError = false) {
  emit("provider://tool-result", {
    sessionId: session.id,
    toolCallId: toolUseId,
    status: isError ? "failed" : "completed",
    result: isError ? undefined : stringifyToolResultContent(content),
    error: isError ? stringifyToolResultContent(content) ?? "Tool failed." : undefined,
  });
}

function resolveCurrentPrompt(session) {
  if (!session.currentPrompt) {
    return;
  }

  const pending = session.currentPrompt;
  session.currentPrompt = null;
  pending.resolve();
}

function rejectCurrentPrompt(session, error) {
  if (!session.currentPrompt) {
    return;
  }

  const pending = session.currentPrompt;
  session.currentPrompt = null;
  pending.reject(error);
}

function rejectPendingControlRequests(session, error) {
  for (const [key, pending] of session.pendingControlRequests) {
    clearTimeout(pending.timeout);
    pending.reject(error);
    session.pendingControlRequests.delete(key);
  }
}

function writeMessage(session, payload) {
  session.process.stdin.write(`${JSON.stringify(payload)}\n`);
}

function sendControlRequest(session, request, timeoutMs = 30_000) {
  const requestId = `req_${session.nextControlRequestId}_${randomUUID().replaceAll("-", "")}`;
  session.nextControlRequestId += 1;

  return new Promise((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      session.pendingControlRequests.delete(requestId);
      rejectPromise(
        new Error(`Timed out waiting for Claude control request ${request.subtype}.`),
      );
    }, timeoutMs);

    session.pendingControlRequests.set(requestId, {
      timeout,
      resolve: resolvePromise,
      reject: rejectPromise,
      subtype: request.subtype,
    });

    writeMessage(session, {
      type: "control_request",
      request_id: requestId,
      request,
    });
  });
}

function buildClaudeArgs({
  sessionId,
  resumeSessionId,
  forkSession,
  preferredModel,
  mcpConfigJson,
}) {
  const args = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--include-partial-messages",
    "--replay-user-messages",
  ];

  if (mcpConfigJson) {
    args.push("--mcp-config", mcpConfigJson, "--strict-mcp-config");
  }

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  if (!resumeSessionId || forkSession) {
    args.push("--session-id", sessionId);
  }

  if (forkSession) {
    args.push("--fork-session");
  }

  if (preferredModel) {
    args.push("--model", preferredModel);
  }

  return args;
}

function buildPromptMeta(result) {
  const usage = result?.usage ?? {};
  const inputTokens =
    typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens =
    typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;

  return {
    meta: {
      ...(inputTokens != null || outputTokens != null
        ? {
            usage: {
              ...(inputTokens != null ? { input_tokens: inputTokens } : {}),
              ...(outputTokens != null ? { output_tokens: outputTokens } : {}),
            },
          }
        : {}),
      ...(typeof result?.num_turns === "number" ? { numTurns: result.num_turns } : {}),
    },
  };
}

function replayMetaFromHistoryEntry(entry) {
  const messageId =
    typeof entry?.uuid === "string" && entry.uuid.length > 0
      ? entry.uuid
      : undefined;
  const rawTimestamp = entry?.timestamp;
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

function replayClaudeHistoryEntry(emit, session, entry) {
  const type = entry?.type;
  if (type !== "user" && type !== "assistant") {
    return;
  }

  const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
  const { messageId, timestamp } = replayMetaFromHistoryEntry(entry);

  for (const block of blocks) {
    switch (block?.type) {
      case "text":
        if (typeof block.text !== "string" || block.text.length === 0) {
          break;
        }
        if (type === "user") {
          emit("provider://user-message", {
            sessionId: session.id,
            text: block.text,
            messageId,
            timestamp,
            replay: true,
          });
        } else {
          emit("provider://message-chunk", {
            sessionId: session.id,
            text: block.text,
            messageId,
            timestamp,
            replay: true,
          });
        }
        break;

      case "thinking":
        if (type !== "assistant") {
          break;
        }
        if (typeof block.thinking !== "string" || block.thinking.length === 0) {
          break;
        }
        emit("provider://message-chunk", {
          sessionId: session.id,
          text: block.thinking,
          isThought: true,
          messageId,
          timestamp,
          replay: true,
        });
        break;

      case "tool_use":
        if (type !== "assistant") {
          break;
        }
        if (typeof block.id !== "string" || typeof block.name !== "string") {
          break;
        }
        emitToolCall(
          emit,
          session,
          block.name,
          block.input ?? {},
          block.id,
          "completed",
        );
        break;

      case "tool_result":
        if (type !== "user" || typeof block.tool_use_id !== "string") {
          break;
        }
        emitToolResult(
          emit,
          session,
          block.tool_use_id,
          block.content ?? null,
          block.is_error === true,
        );
        break;

      default:
        break;
    }
  }
}

async function replayClaudeHistoryBestEffort(emit, session, cwd, sessionId) {
  const historyPath = await findSessionJsonlPath(cwd, sessionId);
  if (!historyPath) {
    return;
  }

  let bytes;
  try {
    bytes = await fs.readFile(historyPath, "utf8");
  } catch {
    return;
  }

  for (const line of bytes.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    replayClaudeHistoryEntry(emit, session, entry);
  }

  emit("provider://prompt-complete", {
    sessionId: session.id,
    stopReason: "HistoryReplay",
    historyReplay: true,
  });
}

function handleControlResponse(session, payload) {
  const requestId = payload?.response?.request_id;
  if (typeof requestId !== "string") {
    return;
  }

  const pending = session.pendingControlRequests.get(requestId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeout);
  session.pendingControlRequests.delete(requestId);

  if (payload?.response?.subtype && payload.response.subtype !== "success") {
    pending.reject(
      new Error(
        `${pending.subtype} failed: ${payload.response.message ?? payload.response.subtype}`,
      ),
    );
    return;
  }

  pending.resolve(payload?.response?.response ?? null);
}

function autoPermissionDecision(session, toolName) {
  if (session.allowedTools.has(toolName)) {
    return "allow_once";
  }

  switch (session.currentModeId) {
    case "bypassPermissions":
      return "allow_once";
    case "acceptEdits":
      return isEditLikeTool(toolName) ? "allow_once" : "ask";
    case "plan":
      return "deny";
    default:
      return "ask";
  }
}

function buildPermissionResponse(optionId, toolInput) {
  switch (optionId) {
    case "allow_once":
      return {
        behavior: "allow",
        updatedInput: toolInput,
      };
    case "allow_session":
      return {
        behavior: "allow",
        updatedInput: toolInput,
      };
    case "cancel":
      return {
        behavior: "deny",
        message: "Turn cancelled",
        interrupt: true,
      };
    case "deny":
    default:
      return {
        behavior: "deny",
        message: "Tool use denied",
        interrupt: false,
      };
  }
}

function respondToControlRequest(session, payload, response) {
  writeMessage(session, {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: payload.request_id,
      response,
    },
  });
}

function handlePermissionRequest(emit, session, payload) {
  const subtype = payload?.request?.subtype;
  if (subtype !== "can_use_tool") {
    respondToControlRequest(session, payload, {
      behavior: "deny",
      message: `Unsupported Claude control request: ${subtype ?? "unknown"}`,
      interrupt: true,
    });
    return;
  }

  const toolName =
    payload.request.tool_name ?? payload.request.toolName ?? "Tool";
  const toolInput =
    payload.request.tool_input ?? payload.request.toolInput ?? {};
  const toolUseId =
    payload.request.tool_use_id ?? payload.request.toolUseId ?? randomUUID();

  emitToolCall(emit, session, toolName, toolInput, toolUseId, "pending");

  const autoDecision = autoPermissionDecision(session, toolName);
  if (autoDecision === "allow_once") {
    respondToControlRequest(
      session,
      payload,
      buildPermissionResponse("allow_once", toolInput),
    );
    return;
  }

  if (autoDecision === "deny") {
    emitToolResult(
      emit,
      session,
      toolUseId,
      "Plan mode does not allow tool execution.",
      true,
    );
    respondToControlRequest(session, payload, buildPermissionResponse("deny", toolInput));
    return;
  }

  const requestId = randomUUID();
  session.pendingPermissions.set(requestId, {
    controlRequestId: payload.request_id,
    toolName,
    toolInput,
    toolUseId,
  });

  emit("provider://permission-request", {
    sessionId: session.id,
    requestId,
    toolCall: buildPermissionToolCall(toolName, toolInput, toolUseId),
    options: [
      {
        optionId: "allow_once",
        label: "Allow once",
        description: "Allow this action one time.",
      },
      {
        optionId: "allow_session",
        label: "Allow session",
        description: "Allow this tool for the rest of this session.",
      },
      {
        optionId: "deny",
        label: "Reject",
        description: "Reject this action but keep the turn running.",
      },
      {
        optionId: "cancel",
        label: "Cancel turn",
        description: "Reject this action and interrupt the turn.",
      },
    ],
  });
}

function handleSystemMessage(emit, session, payload) {
  switch (payload.subtype) {
    case "init": {
      if (typeof payload.session_id === "string") {
        session.agentSessionId = payload.session_id;
      }
      if (typeof payload.claude_code_version === "string") {
        session.claudeVersion = payload.claude_code_version;
      }
      session.currentModelId =
        session.currentModelId ??
        inferCurrentModelId(payload.model, session.availableModelRecords);
      emit("provider://session-status", buildSessionStatus(session));
      return;
    }

    case "hook_response":
      if (payload.outcome === "error" && payload.stderr) {
        console.warn(`[browser-local][claude] Hook error: ${payload.stderr}`);
      }
      return;

    default:
      return;
  }
}

function handleAssistantMessage(emit, session, payload) {
  const message = payload?.message ?? {};
  const blocks = Array.isArray(message.content) ? message.content : [];
  const sawStreamedAssistant =
    session.currentPrompt != null && session.currentPromptHasChunks === true;

  if (typeof payload.session_id === "string") {
    session.agentSessionId = payload.session_id;
  }
  if (typeof session.currentModelId !== "string") {
    session.currentModelId = inferCurrentModelId(
      message.model,
      session.availableModelRecords,
    );
  }

  for (const block of blocks) {
    switch (block?.type) {
      case "text":
        if (!sawStreamedAssistant && typeof block.text === "string" && block.text.length > 0) {
          session.currentPromptHasChunks = true;
          emit("provider://message-chunk", {
            sessionId: session.id,
            text: block.text,
          });
        }
        break;

      case "thinking":
        if (
          !sawStreamedAssistant &&
          typeof block.thinking === "string" &&
          block.thinking.length > 0
        ) {
          session.currentPromptHasChunks = true;
          emit("provider://message-chunk", {
            sessionId: session.id,
            text: block.thinking,
            isThought: true,
          });
        }
        break;

      case "tool_use":
        if (typeof block.id === "string" && typeof block.name === "string") {
          emitToolCall(emit, session, block.name, block.input ?? {}, block.id);
        }
        break;

      default:
        break;
    }
  }
}

function handleUserMessage(emit, session, payload) {
  const message = payload?.message ?? {};
  const blocks = Array.isArray(message.content) ? message.content : [];

  for (const block of blocks) {
    if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") {
      continue;
    }
    emitToolResult(
      emit,
      session,
      block.tool_use_id,
      block.content ?? null,
      block.is_error === true,
    );
  }
}

function handleStreamEvent(emit, session, payload) {
  const event = payload?.event ?? {};
  switch (event.type) {
    case "message_start":
      session.currentPromptHasChunks = false;
      return;

    case "content_block_delta": {
      const delta = event.delta ?? {};
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        session.currentPromptHasChunks = true;
        emit("provider://message-chunk", {
          sessionId: session.id,
          text: delta.text,
        });
      } else if (
        delta.type === "thinking_delta" &&
        typeof delta.thinking === "string"
      ) {
        session.currentPromptHasChunks = true;
        emit("provider://message-chunk", {
          sessionId: session.id,
          text: delta.thinking,
          isThought: true,
        });
      }
      return;
    }

    default:
      return;
  }
}

function handleResult(emit, session, payload) {
  session.status = "ready";

  emit("provider://prompt-complete", {
    sessionId: session.id,
    stopReason: payload?.stop_reason ?? (payload?.is_error ? "error" : "end_turn"),
    ...buildPromptMeta(payload),
  });
  emit("provider://session-status", buildSessionStatus(session, "ready"));

  if (payload?.is_error) {
    const message =
      payload?.result ??
      payload?.error ??
      "Claude Code request failed.";
    emit("provider://error", {
      sessionId: session.id,
      error: isAuthError(message)
        ? "Agent authentication required. Run the login flow and try again."
        : message,
    });
    rejectCurrentPrompt(session, new Error(message));
    return;
  }

  resolveCurrentPrompt(session);
}

function handleLine(emit, session, line) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }

  switch (payload?.type) {
    case "control_response":
      handleControlResponse(session, payload);
      return;
    case "control_request":
      handlePermissionRequest(emit, session, payload);
      return;
    case "system":
      handleSystemMessage(emit, session, payload);
      return;
    case "assistant":
      handleAssistantMessage(emit, session, payload);
      return;
    case "user":
      handleUserMessage(emit, session, payload);
      return;
    case "stream_event":
      handleStreamEvent(emit, session, payload);
      return;
    case "result":
      handleResult(emit, session, payload);
      return;
    default:
      return;
  }
}

function attachProcessListeners(emit, sessions, session) {
  session.output.on("line", (line) => handleLine(emit, session, line));

  session.process.stderr.on("data", (chunk) => {
    const message = String(chunk).trim();
    if (message.length > 0) {
      console.log(`[browser-local][claude] ${message}`);
    }
  });

  session.process.on("exit", () => {
    const wasTracked = sessions.delete(session.id);
    if (!wasTracked) {
      return;
    }

    rejectPendingControlRequests(
      session,
      new Error("Claude Code stopped before request completed."),
    );

    if (session.currentPrompt) {
      rejectCurrentPrompt(
        session,
        new Error("Claude Code stopped while prompt was active."),
      );
      emit("provider://error", {
        sessionId: session.id,
        error: "Claude Code stopped while prompt was active.",
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

export function createClaudeRuntime({ emit }) {
  const sessions = new Map();
  const silentEmit = () => {};

  function createSessionRecord({
    sessionId,
    cwd,
    processHandle,
    timeoutSecs,
    agentSessionId,
    currentModelId = null,
    currentModeId = "default",
    mcpConfigJson = null,
    spawnEnv = {},
  }) {
    return {
      id: sessionId,
      agentType: "claude-code",
      cwd,
      status: "initializing",
      createdAt: new Date().toISOString(),
      process: processHandle,
      output: readline.createInterface({ input: processHandle.stdout }),
      pendingControlRequests: new Map(),
      nextControlRequestId: 1,
      pendingPermissions: new Map(),
      currentPrompt: null,
      currentPromptHasChunks: false,
      allowedTools: new Set(),
      agentSessionId,
      timeoutSecs: timeoutSecs ?? undefined,
      claudeVersion: null,
      availableModelRecords: [],
      currentModelId,
      currentModeId,
      mcpConfigJson,
      spawnEnv,
    };
  }

  function claudeModeFromApprovalPolicy(approvalPolicy) {
    switch (approvalPolicy) {
      case "on-request":
      case "untrusted":
        return "default";
      case "on-failure":
        return "acceptEdits";
      case "never":
        return "bypassPermissions";
      default:
        return "default";
    }
  }

  async function spawnSession(params) {
    const {
      cwd,
      localSessionId,
      resumeAgentSessionId,
      apiKey,
      mcpServers,
      approvalPolicy,
      timeoutSecs,
    } = params;

    const sessionId = localSessionId ?? randomUUID();
    const remoteSessionId = resumeAgentSessionId ?? randomUUID();
    const mcpConfig = buildProviderMcpConfig({ apiKey, mcpServers });
    const claudeBin = resolveClaudeBinary();
    const processHandle = spawn(
      claudeBin,
      buildClaudeArgs({
        sessionId: remoteSessionId,
        resumeSessionId: resumeAgentSessionId ?? null,
        forkSession: false,
        preferredModel: null,
        mcpConfigJson: mcpConfig.claudeMcpConfigJson,
      }),
      {
        cwd,
        env: {
          ...process.env,
          ...mcpConfig.childEnv,
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );

    // Catch spawn errors (e.g. ENOENT) to prevent crashing the provider runtime.
    processHandle.on("error", (spawnError) => {
      console.error(`[browser-local][claude] Spawn error: ${spawnError.message}`);
      sessions.delete(sessionId);
      emit("provider://error", {
        sessionId,
        error: spawnError.code === "ENOENT"
          ? `Claude Code CLI not found at "${claudeBin}". Install it from https://claude.ai/download`
          : `Failed to start Claude Code: ${spawnError.message}`,
      });
      emit("provider://session-status", {
        sessionId,
        status: "terminated",
      });
    });

    const resolvedMode = claudeModeFromApprovalPolicy(approvalPolicy);
    const session = createSessionRecord({
      sessionId,
      cwd,
      processHandle,
      timeoutSecs,
      agentSessionId: remoteSessionId,
      currentModeId: resolvedMode,
      mcpConfigJson: mcpConfig.claudeMcpConfigJson,
      spawnEnv: mcpConfig.childEnv,
    });

    sessions.set(sessionId, session);
    attachProcessListeners(emit, sessions, session);

    try {
      const initResult = await sendControlRequest(
        session,
        {
          subtype: "initialize",
          hooks: null,
        },
        20_000,
      );

      session.availableModelRecords = normalizeModelRecords(initResult);
      session.currentModelId =
        inferCurrentModelId(
          initResult?.model ?? null,
          session.availableModelRecords,
        ) ??
        session.currentModelId;

      // Sync the permission mode with Claude CLI so it sends control_request
      // messages for tool approval instead of auto-approving everything.
      if (resolvedMode !== "bypassPermissions") {
        await sendControlRequest(
          session,
          { subtype: "set_permission_mode", mode: resolvedMode },
          10_000,
        ).catch((err) => {
          console.warn(
            `[browser-local][claude] Failed to set permission mode "${resolvedMode}":`,
            err.message,
          );
        });
      }

      if (resumeAgentSessionId) {
        await replayClaudeHistoryBestEffort(
          emit,
          session,
          cwd,
          resumeAgentSessionId,
        );
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
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.currentPrompt) {
      throw new Error("Another prompt is already active for this session.");
    }

    const combinedPrompt = combinePrompt(prompt, context);
    session.status = "prompting";
    session.currentPromptHasChunks = false;
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

    writeMessage(session, {
      type: "user",
      message: {
        role: "user",
        content: combinedPrompt,
      },
      session_id: session.agentSessionId,
    });

    return pendingPrompt;
  }

  async function cancelPrompt({ sessionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!session.currentPrompt) {
      return;
    }

    await sendControlRequest(
      session,
      {
        subtype: "interrupt",
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
      throw new Error(`Session not found: ${sessionId}`);
    }

    sessions.delete(sessionId);
    rejectPendingControlRequests(
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

  async function listRemoteSessions({ cwd }) {
    const index = await readSessionsIndex(cwd);
    const entries = Array.isArray(index?.entries) ? index.entries : [];

    return {
      sessions: entries.map((entry) => ({
        sessionId: entry.sessionId,
        cwd: entry.projectPath ?? cwd,
        title: entry.firstPrompt ?? null,
        updatedAt: entry.modified ?? null,
      })),
      nextCursor: null,
    };
  }

  async function setPermissionMode({ sessionId, mode }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (
      mode !== "default" &&
      mode !== "acceptEdits" &&
      mode !== "plan" &&
      mode !== "bypassPermissions"
    ) {
      throw new Error(`Unsupported Claude mode: ${mode}`);
    }

    session.currentModeId = mode;

    await sendControlRequest(
      session,
      {
        subtype: "set_permission_mode",
        mode,
      },
      10_000,
    ).catch(() => {
      // Best-effort sync only.
    });

    emit("provider://session-status", buildSessionStatus(session));
  }

  async function respondToPermission({ sessionId, requestId, optionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const pending = session.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request: ${requestId}`);
    }

    session.pendingPermissions.delete(requestId);
    if (optionId === "allow_session") {
      session.allowedTools.add(pending.toolName);
    }

    if (optionId === "deny" || optionId === "cancel") {
      emitToolResult(
        emit,
        session,
        pending.toolUseId,
        optionId === "cancel" ? "Turn cancelled" : "Tool use denied",
        true,
      );
    }

    writeMessage(session, {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: pending.controlRequestId,
        response: buildPermissionResponse(optionId, pending.toolInput),
      },
    });
  }

  async function setModel({ sessionId, modelId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const targetModel =
      session.availableModelRecords.find((record) => record.modelId === modelId) ??
      null;
    if (!targetModel) {
      throw new Error(`Unknown Claude model: ${modelId}`);
    }

    await sendControlRequest(
      session,
      {
        subtype: "set_model",
        model: modelId,
      },
      10_000,
    );

    session.currentModelId = targetModel.modelId;
    emit("provider://session-status", buildSessionStatus(session));
  }

  async function setConfigOption() {
    return null;
  }

  async function forkSession({ sessionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const sourceAgentSessionId = session.agentSessionId;
    if (!sourceAgentSessionId) {
      throw new Error("Claude session does not have a resumable session id yet.");
    }

    const historyPath = await findSessionJsonlPath(session.cwd, sourceAgentSessionId);
    if (!historyPath) {
      throw new Error(`Claude session not found: ${sourceAgentSessionId}`);
    }

    const forkedAgentSessionId = randomUUID();
    const tempLocalSessionId = randomUUID();
    const claudeBin = resolveClaudeBinary();
    const processHandle = spawn(
      claudeBin,
      buildClaudeArgs({
        sessionId: forkedAgentSessionId,
        resumeSessionId: sourceAgentSessionId,
        forkSession: true,
        preferredModel: session.currentModelId,
        mcpConfigJson: session.mcpConfigJson,
      }),
      {
        cwd: session.cwd,
        env: {
          ...process.env,
          ...(session.spawnEnv ?? {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      },
    );

    // Catch spawn errors to prevent crashing the provider runtime.
    processHandle.on("error", (spawnError) => {
      console.error(`[browser-local][claude] Fork spawn error: ${spawnError.message}`);
    });

    const tempSession = createSessionRecord({
      sessionId: tempLocalSessionId,
      cwd: session.cwd,
      processHandle,
      timeoutSecs: session.timeoutSecs,
      agentSessionId: forkedAgentSessionId,
      currentModelId: session.currentModelId,
      currentModeId: session.currentModeId,
      mcpConfigJson: session.mcpConfigJson,
      spawnEnv: session.spawnEnv,
    });
    const tempSessions = new Map([[tempSession.id, tempSession]]);
    attachProcessListeners(silentEmit, tempSessions, tempSession);

    try {
      const initResult = await sendControlRequest(
        tempSession,
        {
          subtype: "initialize",
          hooks: null,
        },
        20_000,
      );

      tempSession.availableModelRecords = normalizeModelRecords(initResult);
      tempSession.currentModelId =
        inferCurrentModelId(
          initResult?.model ?? null,
          tempSession.availableModelRecords,
        ) ?? tempSession.currentModelId;

      if (!tempSession.agentSessionId) {
        throw new Error("Claude fork did not return a resumable session id.");
      }

      return tempSession.agentSessionId;
    } finally {
      tempSessions.delete(tempSession.id);
      rejectPendingControlRequests(
        tempSession,
        new Error("Fork helper session terminated."),
      );
      rejectCurrentPrompt(
        tempSession,
        new Error("Fork helper session terminated."),
      );
      tempSession.output.close();
      killChildTree(processHandle);
    }
  }

  return {
    hasSession(sessionId) {
      return sessions.has(sessionId);
    },
    spawnSession,
    sendPrompt,
    cancelPrompt,
    terminateSession,
    listSessions,
    listRemoteSessions,
    setPermissionMode,
    respondToPermission,
    setModel,
    setConfigOption,
    forkSession,
  };
}
