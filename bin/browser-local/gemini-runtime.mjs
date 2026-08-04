// ABOUTME: Antigravity CLI runtime behind Seren's durable `gemini` agent ID.
// ABOUTME: Runs one structured headless process per turn and resumes its conversation ID.

import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import {
  ANTIGRAVITY_MIN_VERSION,
  isAntigravityVersionSupported,
  readAntigravityVersion,
  resolveAntigravityBinary,
} from "./antigravity-binary.mjs";
import { providerLogPrefix } from "./logging.mjs";

const logPrefix = providerLogPrefix("gemini");

function killChildTree(child) {
  if (!child) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      return;
    } catch {
      // Fall through to direct termination.
    }
  }
  try {
    child.kill();
  } catch {
    // Ignore duplicate close/cancel races.
  }
}

function stripAnsi(value) {
  return String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

export function isAntigravityAuthError(message) {
  const normalized = String(message ?? "").toLowerCase();
  return (
    normalized.includes("please sign in") ||
    normalized.includes("sign-in required") ||
    normalized.includes("authentication required") ||
    normalized.includes("not authenticated") ||
    normalized.includes("not logged in") ||
    normalized.includes("no valid oauth token") ||
    normalized.includes("no valid refresh token") ||
    normalized.includes("failed to load token")
  );
}

function normalizeModelObject(model) {
  if (!model || typeof model !== "object") return null;
  const modelId =
    model.modelId ??
    model.model_id ??
    model.id ??
    model.value ??
    model.name;
  if (typeof modelId !== "string" || modelId.trim().length === 0) return null;
  const name =
    model.displayName ?? model.display_name ?? model.label ?? model.name ?? modelId;
  const description = model.description ?? model.summary;
  return {
    modelId: modelId.trim(),
    name: typeof name === "string" && name.trim() ? name.trim() : modelId.trim(),
    ...(typeof description === "string" && description.trim()
      ? { description: description.trim() }
      : {}),
  };
}

function modelsFromJson(value) {
  const candidates = Array.isArray(value)
    ? value
    : value?.models ?? value?.availableModels ?? value?.available_models;
  if (!Array.isArray(candidates)) return [];
  return candidates.map(normalizeModelObject).filter(Boolean);
}

export function normalizeAntigravityModels(output) {
  const text = stripAnsi(output).trim();
  if (!text) return [];
  try {
    const parsed = modelsFromJson(JSON.parse(text));
    if (parsed.length > 0) return parsed;
  } catch {
    // The documented `models` subcommand currently emits human-readable text.
  }

  const records = [];
  const seen = new Set();
  for (const rawLine of text.split("\n")) {
    const line = rawLine
      .replace(/^\s*(?:[>*•-]|\d+[.)])\s*/, "")
      .replace(/\s+\(current\)\s*$/i, "")
      .trim();
    if (
      !line ||
      /^(?:available\s+)?models?:?$/i.test(line) ||
      /^[-=\s]+$/.test(line)
    ) {
      continue;
    }

    const parenthetical = line.match(/^(.*?)\s+\(([^()]+)\)$/);
    const columns = line.split(/\s{2,}|\t+/).filter(Boolean);
    const identifier = line.match(
      /\b(?:gemini|claude|gpt|auto)[a-z0-9]*(?:[-_.][a-z0-9][a-z0-9_.-]*)+\b/i,
    )?.[0];
    const modelId =
      identifier ??
      (parenthetical && /[-_.]/.test(parenthetical[2])
        ? parenthetical[2].trim()
        : columns.length > 1 && /[-_.]/.test(columns[0])
          ? columns[0]
          : line);
    const name =
      parenthetical && modelId === parenthetical[2].trim()
        ? parenthetical[1].trim()
        : columns.length > 1 && modelId === columns[0]
          ? columns.slice(1).join(" ")
          : line.replace(modelId, "").replace(/^\s*[-:|]\s*|\s*[-:|]\s*$/g, "").trim() || modelId;
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    records.push({ modelId, name });
  }
  return records;
}

function execText(command, args, { cwd, timeout = 15_000 } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      command,
      args,
      {
        cwd,
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        env: {
          ...process.env,
          AGY_CLI_HIDE_ACCOUNT_INFO: "1",
          BROWSER: "false",
          CI: "1",
          NO_COLOR: "1",
          TERM: "dumb",
        },
      },
      (error, stdout, stderr) => {
        const standardOutput = stripAnsi(stdout).trim();
        const standardError = stripAnsi(stderr).trim();
        if (error) {
          rejectPromise(
            new Error(standardError || standardOutput || error.message),
          );
          return;
        }
        resolvePromise(standardOutput);
      },
    );
    child.stdin?.end();
  });
}

export async function listAntigravityModels({
  binary = resolveAntigravityBinary(),
  cwd,
} = {}) {
  if (binary === "agy") {
    throw new Error("Antigravity CLI is not installed.");
  }
  const output = await execText(binary, ["models"], { cwd });
  const models = normalizeAntigravityModels(output);
  if (models.length === 0) {
    throw new Error("Antigravity returned no available models.");
  }
  return models;
}

function resolveAntigravityMode({ approvalPolicy, sandboxMode }) {
  if (sandboxMode === "read-only") return "plan";
  if (sandboxMode === "danger-full-access" || sandboxMode === "full-access") {
    return "yolo";
  }
  if (approvalPolicy === "on-request" || approvalPolicy === "untrusted") {
    return "default";
  }
  return "accept-edits";
}

function buildModes(session) {
  return {
    currentModeId: session.currentModeId,
    availableModes: [
      {
        modeId: "default",
        name: "Saved rules",
        description:
          "Use saved Antigravity rules; headless requests that need a prompt are denied",
      },
      {
        modeId: "accept-edits",
        name: "Accept edits",
        description: "Automatically approve file edits; command rules still apply",
      },
      {
        modeId: "plan",
        name: "Plan",
        description: "Analyze with read-only tools and return an execution plan",
      },
      {
        modeId: "yolo",
        name: "Skip permissions",
        description: "Auto-approve all tool requests without sandbox restrictions",
      },
    ],
  };
}

function buildPermissionCatalog(params = {}) {
  const defaultModeId = resolveAntigravityMode(params);
  const state = buildModes({ currentModeId: defaultModeId });
  return {
    defaultModeId,
    modes: state.availableModes,
  };
}

function buildStatus(session, status = session.status) {
  return {
    sessionId: session.id,
    status,
    agentSessionId: session.agentSessionId,
    agentInfo: {
      name: "Antigravity CLI",
      version: session.agentVersion ?? "unknown",
    },
    models: {
      currentModelId: session.currentModelId,
      availableModels: session.availableModels,
    },
    modes: buildModes(session),
    configOptions: [],
    pid: session.process?.pid ?? null,
  };
}

// `--print-timeout` caps the whole turn, not idle time, and the CLI applies
// its own 5m default when the flag is absent. A session without an explicit
// timeout waits for as long as the work takes, so pass a duration long enough
// to never fire rather than omitting the flag. #3662
const ANTIGRAVITY_UNBOUNDED_TURN = "8760h";

export function buildAntigravityArgs(session, prompt) {
  const args = [
    "--print",
    prompt,
    "--output-format",
    "stream-json",
    "--print-timeout",
    session.timeoutSecs
      ? `${session.timeoutSecs}s`
      : ANTIGRAVITY_UNBOUNDED_TURN,
  ];
  if (session.agentSessionId) {
    args.push("--conversation", session.agentSessionId);
  }
  if (session.currentModelId) {
    args.push("--model", session.currentModelId);
  }
  if (session.currentModeId === "accept-edits") {
    args.push("--mode", "accept-edits");
  } else if (session.currentModeId === "plan") {
    args.push("--mode", "plan");
  } else if (session.currentModeId === "yolo") {
    args.push("--dangerously-skip-permissions");
  }
  if (
    session.currentModeId !== "yolo" &&
    session.sandboxMode !== "danger-full-access" &&
    session.sandboxMode !== "full-access"
  ) {
    args.push("--sandbox");
  }
  return args;
}

function firstString(value, keys) {
  for (const key of keys) {
    const candidate = value?.[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return "";
}

function eventConversationId(event) {
  return firstString(event, ["conversation_id", "conversationId"]) ||
    firstString(event?.conversation, ["id", "conversation_id", "conversationId"]);
}

function eventText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return firstString(value, [
    "text",
    "content",
    "message",
    "delta",
    "output",
    "response",
    "result",
  ]);
}

function emitTextDelta(emit, session, key, text, isThought = false) {
  if (!text) return;
  const previous = session.stepText.get(key) ?? "";
  const delta = text.startsWith(previous) ? text.slice(previous.length) : text;
  session.stepText.set(key, text);
  if (!delta) return;
  session.assistantText += delta;
  emit("provider://message-chunk", {
    sessionId: session.id,
    text: delta,
    ...(isThought ? { isThought: true } : {}),
  });
}

function emitToolUpdate(emit, session, step) {
  const tool = step.tool_info ?? step.toolInfo;
  if (!tool || typeof tool !== "object") return false;
  const toolCallId = String(
    step.step_id ?? step.stepId ?? tool.id ?? tool.tool_call_id ?? randomUUID(),
  );
  const status = step.status ?? tool.status ?? "running";
  emit("provider://tool-call", {
    sessionId: session.id,
    toolCallId,
    title: tool.title ?? tool.name ?? tool.tool_name ?? "Tool call",
    kind: tool.name ?? tool.tool_name ?? "tool",
    status,
    parameters: tool.parameters ?? tool.input ?? {},
  });
  const output = tool.output ?? tool.result;
  if (
    output !== undefined ||
    ["completed", "complete", "error", "failed"].includes(status)
  ) {
    const failed = status === "error" || status === "failed" || tool.is_error === true;
    emit("provider://tool-result", {
      sessionId: session.id,
      toolCallId,
      status: failed ? "error" : "completed",
      result: typeof output === "string" ? output : output == null ? undefined : JSON.stringify(output),
      ...(failed
        ? { error: eventText(tool.error) || eventText(output) || "Tool call failed" }
        : {}),
    });
  }
  return true;
}

function usageMeta(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = usage.input_tokens ?? usage.inputTokens;
  const output = usage.output_tokens ?? usage.outputTokens;
  if (typeof input !== "number" && typeof output !== "number") return null;
  return {
    usage: {
      ...(typeof input === "number" ? { input_tokens: input } : {}),
      ...(typeof output === "number" ? { output_tokens: output } : {}),
      ...(typeof usage.cache_read_tokens === "number"
        ? { cache_read_tokens: usage.cache_read_tokens }
        : {}),
    },
  };
}

export function handleAntigravityEvent(emit, session, event) {
  if (!event || typeof event !== "object") return;
  const type = event.type ?? event.event;
  const conversationId = eventConversationId(event);
  if (conversationId) session.agentSessionId = conversationId;

  if (type === "init") {
    const model = firstString(event, ["model", "model_id", "modelId"]);
    if (model) session.currentModelId = model;
    return;
  }

  if (type === "step_update") {
    const step = event.step ?? event.update ?? event;
    if (emitToolUpdate(emit, session, step)) return;
    const stepType = String(step.step_type ?? step.stepType ?? "").toLowerCase();
    const text = eventText(step);
    const key = String(
      step.step_id ?? step.stepId ?? (stepType || "assistant"),
    );
    emitTextDelta(
      emit,
      session,
      key,
      text,
      /thought|reason|analysis/.test(stepType),
    );
    return;
  }

  if (type === "result") {
    const resultText = eventText(event.result) || eventText(event);
    if (resultText) {
      const delta = resultText.startsWith(session.assistantText)
        ? resultText.slice(session.assistantText.length)
        : session.assistantText.includes(resultText)
          ? ""
          : resultText;
      if (delta) {
        session.assistantText += delta;
        emit("provider://message-chunk", { sessionId: session.id, text: delta });
      }
    }
    session.resultEvent = event;
    session.resultError =
      event.is_error === true || event.success === false
        ? eventText(event.error) || resultText || "Antigravity task failed."
        : null;
    session.usageMeta = usageMeta(event.usage);
  }
}

function createSessionRecord(params, models, version) {
  const currentModeId = resolveAntigravityMode(params);
  const requestedModel =
    typeof params.initialModelId === "string" &&
    models.some((model) => model.modelId === params.initialModelId)
      ? params.initialModelId
      : null;
  return {
    id: params.localSessionId ?? randomUUID(),
    agentType: "gemini",
    cwd: params.cwd,
    status: "ready",
    createdAt: new Date().toISOString(),
    agentSessionId: params.resumeAgentSessionId ?? undefined,
    timeoutSecs: params.timeoutSecs ?? undefined,
    currentModelId: requestedModel ?? models[0]?.modelId ?? null,
    currentModeId,
    sandboxMode: params.sandboxMode,
    availableModels: models,
    cliModels: models,
    agentVersion: version,
    process: null,
    output: null,
    currentPrompt: false,
    cancelled: false,
    terminated: false,
    stepText: new Map(),
    assistantText: "",
    resultEvent: null,
    resultError: null,
    usageMeta: null,
  };
}

export function createGeminiRuntime({ emit }) {
  const runtimeSessions = new Map();
  const runtime = {};

  async function spawnSession(params) {
    if (params.requireExactResume === true && !params.resumeAgentSessionId) {
      throw new Error("Antigravity exact resume requires a conversation ID.");
    }
    const sessionId = params.localSessionId ?? randomUUID();
    const binary = resolveAntigravityBinary();
    const version = await readAntigravityVersion(binary);
    if (!isAntigravityVersionSupported(version)) {
      throw new Error(
        `Antigravity CLI ${ANTIGRAVITY_MIN_VERSION} or newer is required.`,
      );
    }

    let models;
    try {
      models = await listAntigravityModels({ binary, cwd: params.cwd });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isAntigravityAuthError(message)) {
        emit("provider://login-required", {
          sessionId,
          agentType: "gemini",
          reason: message,
        });
        emit("provider://error", {
          sessionId,
          error:
            "Antigravity authentication required. Finish Google Sign-In in the Terminal window, then start Antigravity again.",
        });
      }
      throw error;
    }

    const session = createSessionRecord({ ...params, localSessionId: sessionId }, models, version);
    runtimeSessions.set(sessionId, session);
    emit("provider://session-status", buildStatus(session, "ready"));
    return {
      id: session.id,
      agentType: session.agentType,
      cwd: session.cwd,
      status: session.status,
      createdAt: session.createdAt,
      agentSessionId: session.agentSessionId,
      timeoutSecs: session.timeoutSecs,
      serenMcpConfigured: false,
      pid: null,
    };
  }

  async function sendPrompt({ sessionId, prompt, context, onAccepted }) {
    const session = runtimeSessions.get(sessionId);
    if (!session) throw new Error(`No Antigravity session: ${sessionId}`);
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
    const binary = resolveAntigravityBinary();

    session.currentPrompt = true;
    session.cancelled = false;
    session.stepText.clear();
    session.assistantText = "";
    session.resultEvent = null;
    session.resultError = null;
    session.usageMeta = null;
    session.status = "prompting";

    const child = spawn(binary, buildAntigravityArgs(session, combinedPrompt), {
      cwd: session.cwd,
      env: {
        ...process.env,
        AGY_CLI_HIDE_ACCOUNT_INFO: "1",
        CI: "1",
        NO_COLOR: "1",
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    session.process = child;
    session.output = readline.createInterface({ input: child.stdout });
    emit("provider://session-status", buildStatus(session, "prompting"));

    let stderrTail = "";
    let accepted = false;
    const markAccepted = () => {
      if (accepted) return;
      accepted = true;
      onAccepted?.();
    };
    child.once("spawn", markAccepted);
    child.stderr.on("data", (chunk) => {
      const message = stripAnsi(chunk);
      stderrTail = `${stderrTail}${message}`.slice(-8192);
      if (message.trim()) console.log(`${logPrefix} ${message.trim()}`);
    });
    session.output.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      handleAntigravityEvent(emit, session, event);
      if (event?.type === "init") {
        emit("provider://session-status", {
          ...buildStatus(session, "prompting"),
          readinessUnchanged: true,
        });
      }
    });

    try {
      const exit = await new Promise((resolvePromise, rejectPromise) => {
        child.once("error", rejectPromise);
        child.once("close", (code, signal) => resolvePromise({ code, signal }));
      });
      if (session.cancelled) throw new Error("Task cancelled");
      if (session.terminated) throw new Error("Session terminated.");
      const authMessage = isAntigravityAuthError(stderrTail) ? stderrTail.trim() : "";
      if (authMessage) {
        emit("provider://login-required", {
          sessionId,
          agentType: "gemini",
          reason: authMessage,
        });
        throw new Error(
          "Antigravity authentication required. Finish Google Sign-In in the Terminal window, then retry.",
        );
      }
      if (session.resultError) throw new Error(session.resultError);
      if (exit.code !== 0) {
        throw new Error(
          stderrTail.trim() ||
            `Antigravity stopped while prompt was active (${exit.signal ?? `code ${exit.code}`}).`,
        );
      }
      if (!session.resultEvent) {
        throw new Error("Antigravity ended without a terminal result event.");
      }
      if (!session.agentSessionId) {
        throw new Error("Antigravity did not return a resumable conversation ID.");
      }

      session.status = "ready";
      emit("provider://prompt-complete", {
        sessionId,
        stopReason: "end_turn",
        ...(session.usageMeta ? { meta: session.usageMeta } : {}),
      });
      emit("provider://session-status", buildStatus(session, "ready"));
    } catch (error) {
      session.status = "ready";
      const message = error instanceof Error ? error.message : String(error);
      // cancelPrompt already emitted the cancellation, and the killed child
      // then lands here with the same message. Emitting again persists a
      // duplicate error row for every cancel. #3664
      if (!session.cancelled && runtimeSessions.get(sessionId) === session) {
        emit("provider://error", { sessionId, error: message });
        emit("provider://session-status", buildStatus(session, "ready"));
      }
      throw error;
    } finally {
      session.currentPrompt = false;
      session.process = null;
      try {
        session.output?.close();
      } catch {
        // Ignore close races after cancellation.
      }
      session.output = null;
    }
  }

  async function cancelPrompt({ sessionId }) {
    const session = runtimeSessions.get(sessionId);
    if (!session) throw new Error(`No Antigravity session: ${sessionId}`);
    session.cancelled = true;
    killChildTree(session.process);
    session.status = "ready";
    emit("provider://error", { sessionId, error: "Task cancelled" });
    emit("provider://session-status", buildStatus(session, "ready"));
  }

  async function terminateSession({ sessionId }) {
    const session = runtimeSessions.get(sessionId);
    if (!session) throw new Error(`No Antigravity session: ${sessionId}`);
    runtimeSessions.delete(sessionId);
    session.terminated = true;
    killChildTree(session.process);
    emit("provider://session-status", {
      sessionId,
      status: "terminated",
      agentSessionId: session.agentSessionId,
    });
  }

  async function setPermissionMode({ sessionId, mode }) {
    const session = runtimeSessions.get(sessionId);
    if (!session) throw new Error(`No Antigravity session: ${sessionId}`);
    if (!["default", "accept-edits", "plan", "yolo"].includes(mode)) {
      throw new Error(`Unknown Antigravity mode: ${mode}`);
    }
    if (session.currentPrompt) {
      throw new Error("Antigravity mode cannot change during an active turn.");
    }
    session.currentModeId = mode;
    emit("provider://session-status", {
      ...buildStatus(session),
      readinessUnchanged: true,
    });
  }

  async function setModel({ sessionId, modelId }) {
    const session = runtimeSessions.get(sessionId);
    if (!session) throw new Error(`No Antigravity session: ${sessionId}`);
    if (!session.availableModels.some((model) => model.modelId === modelId)) {
      throw new Error(`Unknown Antigravity model: ${modelId}`);
    }
    if (session.currentPrompt) {
      throw new Error("Antigravity model cannot change during an active turn.");
    }
    session.currentModelId = modelId;
    emit("provider://session-status", buildStatus(session));
  }

  Object.assign(runtime, {
    hasSession(sessionId) {
      return runtimeSessions.has(sessionId);
    },
    spawnSession,
    sendPrompt,
    cancelPrompt,
    terminateSession,
    async listSessions() {
      return Array.from(runtimeSessions.values()).map((session) => ({
        id: session.id,
        agentType: session.agentType,
        cwd: session.cwd,
        status: session.status,
        createdAt: session.createdAt,
        agentSessionId: session.agentSessionId,
        timeoutSecs: session.timeoutSecs,
        currentModelId: session.currentModelId,
        currentModeId: session.currentModeId,
        pendingPermissions: [],
        serenMcpConfigured: false,
        pid: session.process?.pid ?? null,
      }));
    },
    setPermissionMode,
    async setOAuthRouting() {},
    async respondToPermission({ sessionId }) {
      if (!runtimeSessions.has(sessionId)) {
        throw new Error(`No Antigravity session: ${sessionId}`);
      }
      throw new Error(
        "Antigravity headless mode cannot pause for interactive permission responses.",
      );
    },
    setModel,
    listCliModels(sessionId) {
      return runtimeSessions.get(sessionId)?.cliModels ?? [];
    },
    getPermissionCatalog: buildPermissionCatalog,
  });
  return runtime;
}
