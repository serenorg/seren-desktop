// ABOUTME: Browser-local Gemini runtime that embeds gemini-cli via ACP over stdio.
// ABOUTME: Mirrors the Codex inline pattern in providers.mjs but speaks Agent Client Protocol.

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// ============================================================================
// Binary resolution
// ============================================================================

/**
 * Resolve the installed gemini binary path. GUI apps don't inherit shell PATH
 * updates, so we check well-known npm-global install locations before falling
 * back to the bare command name.
 *
 * IMPORTANT: prefer the embedded-runtime npm install path (`<prefix>/bin/gemini`
 * on Unix, `<nodeDir>/gemini.cmd` on Windows) over ANY system install. The
 * Homebrew gemini-cli formula skips the keytar postinstall, so a Homebrew
 * binary on PATH cannot read its own keychain when spawned from a GUI app
 * and fails with "GEMINI_API_KEY environment variable" (#1476). Falling back
 * to a Homebrew install would silently break first-run auth.
 *
 * The bare "gemini" return value is the signal to the caller that no install
 * was found and ensureCli() should run.
 */
function resolveGeminiBinary() {
  if (process.platform === "win32") {
    const home = os.homedir();
    const appData = process.env.APPDATA ?? "";
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
      // Embedded runtime install (preferred — keytar postinstall ran here)
      path.join(nodeDir, "gemini.cmd"),
      path.join(nodeDir, "gemini"),
      // System-wide npm install
      ...(appData ? [path.join(appData, "npm", "gemini.cmd")] : []),
      // Generic user-local fallback
      path.join(home, ".local", "bin", "gemini.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  } else {
    const nodeDir = path.dirname(process.execPath);
    const prefix = path.dirname(nodeDir);
    const home = os.homedir();
    const candidates = [
      // Embedded runtime install (preferred — keytar postinstall ran here)
      path.join(prefix, "bin", "gemini"),
      // Generic user-local fallback
      path.join(home, ".local", "bin", "gemini"),
      // NOTE: /usr/local/bin/gemini and /opt/homebrew/bin/gemini are
      // intentionally NOT in this list. See block comment above.
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return "gemini";
}

// ============================================================================
// Process helpers
// ============================================================================

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

/**
 * Detect whether an error message from gemini-cli (or our own spawn pipeline)
 * indicates the user needs to run `gemini login`. Catches the literal string
 * gemini-cli prints when it cannot find credentials, the keychain failure
 * mode shipped by Homebrew's broken keytar, and the desktop's own
 * `Gemini API key is missing` wrapping.
 */
function isAuthError(message) {
  const lower = String(message).toLowerCase();
  if (lower.includes("not authenticated")) return true;
  if (lower.includes("authentication required")) return true;
  if (lower.includes("auth required")) return true;
  if (lower.includes("login required")) return true;
  if (lower.includes("not logged in")) return true;
  if (lower.includes("please run") && lower.includes("login")) return true;
  // Verbatim gemini-cli error when GEMINI_API_KEY env var is missing AND
  // no keychain credentials are available. (#1476)
  if (lower.includes("gemini_api_key")) return true;
  if (lower.includes("api key is missing")) return true;
  if (lower.includes("api key is not configured")) return true;
  // Homebrew's gemini-cli ships broken keytar; the keychain init failure
  // is a leading indicator that the next request will fail with auth.
  if (lower.includes("keychain initialization") && lower.includes("keytar")) {
    return true;
  }
  return false;
}

// ============================================================================
// ACP protocol helpers
// ============================================================================

/**
 * ACP protocol version this client implements. ACP uses uint16 versions,
 * starting at 1. Bump when gemini-cli requires a newer version.
 */
const ACP_PROTOCOL_VERSION = 1;

/**
 * Static list of supported Gemini models. ACP `initialize` does not return
 * a model list (Codex's `model/list` RPC has no equivalent in gemini-cli's
 * ACP surface), so we hardcode the publicly-available Gemini 2.5 family
 * to give the user a visible model picker. (#1480)
 *
 * Update this list when Google ships new models. Phase 2 follow-up could
 * query gemini-cli at startup if upstream adds a list endpoint.
 */
const GEMINI_AVAILABLE_MODELS = [
  {
    modelId: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    description: "Most capable Gemini model — 1M context window",
  },
  {
    modelId: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    description: "Fast and cheap — 1M context window",
  },
  {
    modelId: "gemini-2.5-flash-lite",
    name: "Gemini 2.5 Flash Lite",
    description: "Lowest cost / latency — 1M context window",
  },
];

const GEMINI_DEFAULT_MODEL_ID = "gemini-2.5-pro";

/**
 * Map Seren's approval policies to gemini-cli's --approval-mode values.
 *   - "never" / "auto"           → "auto_edit" (auto-approve safe edits)
 *   - "on-request" / "untrusted" → "default"   (prompt for approval)
 *   - "danger-full-access"       → "yolo"       (auto-approve everything)
 *   - "read-only"                → "plan"       (read-only / plan mode)
 */
function geminiApprovalMode(approvalPolicy, sandboxMode) {
  if (sandboxMode === "read-only") return "plan";
  if (sandboxMode === "danger-full-access") return "yolo";
  if (approvalPolicy === "on-request" || approvalPolicy === "untrusted") {
    return "default";
  }
  return "auto_edit";
}

/**
 * Build the available approval modes that the desktop UI can switch between
 * for a Gemini session. Mirrors the Codex `availableModes` shape.
 */
function geminiModes(session) {
  return {
    currentModeId: session?.currentModeId ?? "default",
    availableModes: [
      {
        modeId: "default",
        name: "Default",
        description: "Prompt for approval on each tool use",
      },
      {
        modeId: "auto_edit",
        name: "Auto Edit",
        description: "Auto-approve edit tools, prompt for everything else",
      },
      {
        modeId: "yolo",
        name: "YOLO",
        description: "Auto-approve all tools (use with caution)",
      },
      {
        modeId: "plan",
        name: "Plan",
        description: "Read-only — propose changes without executing",
      },
    ],
  };
}

function buildInitializeParams() {
  return {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientInfo: {
      name: "seren_provider_runtime",
      title: "Seren Provider Runtime",
      version: "0.1.0",
    },
    clientCapabilities: {
      // We don't expose terminal/fs capabilities to the agent — the desktop
      // mediates these via the existing approval UI and provider events.
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  };
}

// ============================================================================
// Spawn / session record
// ============================================================================

function spawnGeminiProcess(cwd) {
  const binary = resolveGeminiBinary();
  return spawn(binary, ["--acp"], {
    cwd,
    env: {
      ...process.env,
      // Force unbuffered stdout so the parent reads ACP messages promptly.
      NODE_NO_READLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

function createGeminiSessionRecord({
  sessionId,
  cwd,
  processHandle,
  timeoutSecs,
  currentModeId,
}) {
  return {
    id: sessionId,
    agentType: "gemini",
    cwd,
    status: "initializing",
    createdAt: new Date().toISOString(),
    process: processHandle,
    output: readline.createInterface({ input: processHandle.stdout }),
    pendingRequests: new Map(),
    nextRequestId: 1,
    pendingPermissions: new Map(),
    currentPrompt: null,
    agentSessionId: undefined,
    timeoutSecs: timeoutSecs ?? undefined,
    geminiVersion: null,
    currentModeId: currentModeId ?? "default",
    // Default to Gemini 2.5 Pro until the user picks something else.
    // Switching is wired through setSessionModel; the runtime persists
    // the choice but does NOT yet re-spawn gemini-cli with --model
    // (phase 2 of #1480 follow-up).
    currentModelId: GEMINI_DEFAULT_MODEL_ID,
  };
}

// ============================================================================
// JSON-RPC framing (newline-delimited JSON over stdio)
// ============================================================================

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
  if (!session.currentPrompt) return;
  const pending = session.currentPrompt;
  session.currentPrompt = null;
  pending.reject(error);
}

function resolveCurrentPrompt(session) {
  if (!session.currentPrompt) return;
  const pending = session.currentPrompt;
  session.currentPrompt = null;
  pending.resolve();
}

function handleResponse(session, payload) {
  const pending = session.pendingRequests.get(String(payload.id));
  if (!pending) return;

  clearTimeout(pending.timeout);
  session.pendingRequests.delete(String(payload.id));

  if (payload.error?.message) {
    pending.reject(
      new Error(`${pending.method} failed: ${payload.error.message}`),
    );
    return;
  }

  pending.resolve(payload.result);
}

// ============================================================================
// ACP → provider:// event translation
// ============================================================================

/**
 * Extract a text string from an ACP ContentBlock or array of blocks.
 * The agent emits ContentBlocks in `agent_message_chunk.content` and
 * `agent_thought_chunk.content`. We only render text blocks today.
 */
function contentBlockText(content) {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  if (content.type === "text" && typeof content.text === "string") {
    return content.text;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => contentBlockText(block))
      .filter(Boolean)
      .join("");
  }
  return "";
}

/**
 * ACP `tool_call` and `tool_call_update` updates carry a ToolCallContent[]
 * array. We flatten any text/diff/terminal output into a single string for
 * the existing provider://tool-result event format.
 */
function flattenToolCallContent(content) {
  if (!Array.isArray(content)) return undefined;
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "diff") {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function emitToolCallUpdate(emit, session, update) {
  const toolCallId = String(update.toolCallId ?? randomUUID());
  const status = update.status ?? "running";
  // ACP ToolCallContent supports text/image/diff/resource/terminal — for
  // active sessions we surface the title + raw input on the call event and
  // the flattened content on the result event below.
  emit("provider://tool-call", {
    sessionId: session.id,
    toolCallId,
    title: update.title ?? update.name ?? "Tool call",
    kind: update.name ?? "tool",
    status,
    parameters: update,
  });

  // Terminal/completed updates also produce a tool-result so the desktop's
  // existing approval UI can render the output.
  if (status === "completed" || status === "error") {
    emit("provider://tool-result", {
      sessionId: session.id,
      toolCallId,
      status,
      result: flattenToolCallContent(update.content),
      error:
        status === "error"
          ? update.result?.error ?? "Tool call failed"
          : undefined,
    });
  }
}

function handleSessionUpdate(emit, session, params) {
  const update = params?.update ?? {};
  const type = update.type ?? update.sessionUpdate;

  switch (type) {
    case "agent_message_chunk": {
      const text = contentBlockText(update.content);
      if (text) {
        emit("provider://message-chunk", { sessionId: session.id, text });
      }
      return;
    }

    case "agent_thought_chunk": {
      const text = contentBlockText(update.content);
      if (text) {
        emit("provider://message-chunk", {
          sessionId: session.id,
          text,
          isThought: true,
        });
      }
      return;
    }

    case "tool_call":
    case "tool_call_update":
      emitToolCallUpdate(emit, session, update);
      return;

    case "plan": {
      const entries = Array.isArray(update.entries) ? update.entries : [];
      emit("provider://plan-update", {
        sessionId: session.id,
        entries: entries.map((entry) => ({
          content: entry.content ?? entry.title ?? "Untitled step",
          status:
            entry.status ??
            (entry.completed === true ? "completed" : "pending"),
        })),
      });
      return;
    }

    case "current_mode_update": {
      if (typeof update.modeId === "string") {
        session.currentModeId = update.modeId;
        emit("provider://session-status", buildSessionStatus(session));
      }
      return;
    }

    default:
      // Unknown update types are ignored — gemini-cli may add new ones over
      // time and we don't want to crash on unfamiliar shapes.
      return;
  }
}

/**
 * Handle an inbound ACP request from the agent. Today the only one we expect
 * is `session/request_permission` for tool approvals.
 */
function handleAgentRequest(emit, session, payload) {
  if (payload.method === "session/request_permission") {
    const params = payload.params ?? {};
    const requestId = randomUUID();
    session.pendingPermissions.set(requestId, {
      requestId,
      jsonRpcId: payload.id,
      // Store the ACP option list verbatim so respondToPermission can map
      // a desktop optionId back to the agent's expected outcome.
      options: Array.isArray(params.options) ? params.options : [],
    });

    // Auto-approve in YOLO / auto_edit mode for non-destructive tools.
    // This mirrors how Codex handles "auto" mode in providers.mjs.
    if (session.currentModeId === "yolo") {
      const allowOption = (params.options ?? []).find(
        (opt) => opt.kind === "allow_once" || opt.kind === "allow_always",
      );
      writeMessage(session, {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          outcome: allowOption
            ? { outcome: "selected", optionId: allowOption.optionId }
            : { outcome: "cancelled" },
        },
      });
      session.pendingPermissions.delete(requestId);
      return;
    }

    emit("provider://permission-request", {
      sessionId: session.id,
      requestId,
      toolCall: {
        name: params.toolCall?.name ?? "tool",
        title: params.toolCall?.title ?? "Tool call",
        input: params.toolCall ?? {},
      },
      options: (params.options ?? []).map((opt) => ({
        optionId: opt.optionId,
        label: opt.name ?? opt.optionId,
        description: opt.kind,
      })),
    });
    return;
  }

  // Unknown request — respond with method-not-found so the agent doesn't
  // hang waiting for a reply.
  writeMessage(session, {
    jsonrpc: "2.0",
    id: payload.id,
    error: {
      code: -32601,
      message: `Method not implemented: ${payload.method}`,
    },
  });
}

function handleNotification(emit, session, payload) {
  const method = payload.method;
  const params = payload.params ?? {};

  if (method === "session/update") {
    handleSessionUpdate(emit, session, params);
    return;
  }
  // Other notifications (cancel, etc.) are agent→client info we don't act on.
}

function handleLine(emit, session, line) {
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    // gemini-cli occasionally writes diagnostic strings to stdout. Ignore
    // anything that isn't a valid JSON-RPC frame.
    return;
  }

  if (payload.id != null && payload.method) {
    handleAgentRequest(emit, session, payload);
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

// ============================================================================
// Session status payloads
// ============================================================================

function buildSessionStatus(session, status = session.status) {
  return {
    sessionId: session.id,
    status,
    agentSessionId: session.agentSessionId,
    agentInfo: {
      name: "Gemini ACP",
      version: session.geminiVersion ?? "unknown",
    },
    models: {
      currentModelId: session.currentModelId ?? GEMINI_DEFAULT_MODEL_ID,
      availableModels: GEMINI_AVAILABLE_MODELS,
    },
    modes: geminiModes(session),
    configOptions: [],
  };
}

function attachProcessListeners(emit, sessions, session) {
  session.output.on("line", (line) => handleLine(emit, session, line));

  // Buffer the latest stderr lines so the spawn-time catch block has
  // something to inspect when the JSON-RPC initialize call fails. gemini-cli
  // writes its auth/keychain errors to stderr, not over JSON-RPC, so without
  // this buffer the desktop only sees a generic "process exited" error.
  session.stderrTail = "";
  session.process.stderr.on("data", (chunk) => {
    const message = String(chunk);
    if (!message) return;
    session.stderrTail = (session.stderrTail + message).slice(-4096);
    const trimmed = message.trim();
    if (trimmed.length > 0) {
      console.log(`[browser-local][gemini] ${trimmed}`);
    }

    // Proactively detect auth failures from stderr while initialize is
    // still in flight — gives the catch block a richer error to surface.
    if (!session.authErrorDetected && isAuthError(trimmed)) {
      session.authErrorDetected = true;
    }
  });

  session.process.on("exit", () => {
    const wasTracked = sessions.delete(session.id);
    if (!wasTracked) return;

    rejectPendingRequests(
      session,
      new Error("Gemini agent stopped before request completed."),
    );

    if (session.currentPrompt) {
      rejectCurrentPrompt(
        session,
        new Error("Gemini process exited while prompt was active."),
      );
      emit("provider://error", {
        sessionId: session.id,
        error: "Gemini process exited while prompt was active.",
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

// ============================================================================
// Public factory
// ============================================================================

export function createGeminiRuntime({ emit }) {
  const sessions = new Map();

  async function spawnSession(params) {
    const {
      cwd,
      localSessionId,
      approvalPolicy,
      sandboxMode,
      networkEnabled,
      timeoutSecs,
    } = params;

    const sessionId = localSessionId ?? randomUUID();
    const resolvedMode = geminiApprovalMode(approvalPolicy, sandboxMode);
    const processHandle = spawnGeminiProcess(cwd);
    const session = createGeminiSessionRecord({
      sessionId,
      cwd,
      processHandle,
      timeoutSecs,
      currentModeId: resolvedMode,
    });

    sessions.set(sessionId, session);
    attachProcessListeners(emit, sessions, session);

    try {
      // ACP step 1: initialize handshake
      const initResult = await sendRequest(
        session,
        "initialize",
        buildInitializeParams(),
        15_000,
      );
      session.geminiVersion = initResult?.agentInfo?.version ?? null;

      // Verify the session is still tracked before proceeding to session/new.
      // A terminated process during init would otherwise hang on a dead pipe.
      if (!sessions.has(sessionId)) {
        throw new Error("Gemini session was terminated during initialization.");
      }

      // ACP step 2: create a new session in the requested cwd
      const sessionResult = await sendRequest(
        session,
        "session/new",
        {
          cwd,
          // mcpServers is required by the schema; empty array is valid and
          // means "no MCP servers" — the desktop manages MCP separately.
          mcpServers: [],
        },
        20_000,
      );

      session.agentSessionId = sessionResult?.sessionId ?? sessionId;
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
      // Auth failure can surface either via the JSON-RPC error message
      // returned by initialize/session/new OR via stderr (see attachProcessListeners
      // — keytar/keychain failures land on stderr, not JSON-RPC).
      const stderrTail = session.stderrTail ?? "";
      const authFailed =
        session.authErrorDetected ||
        isAuthError(message) ||
        isAuthError(stderrTail);

      sessions.delete(sessionId);
      killChildTree(processHandle);

      if (authFailed) {
        // Emit a typed event so agent.store can auto-trigger launchLogin
        // and surface a clear next-step toast to the user. This is the
        // Gemini equivalent of Claude/Codex's first-spawn login prompt.
        emit("provider://login-required", {
          sessionId,
          agentType: "gemini",
          reason: message || stderrTail || "Gemini authentication required.",
        });
      }

      emit("provider://error", {
        sessionId,
        error: authFailed
          ? "Gemini authentication required. Opening `gemini login` in a Terminal window — finish the sign-in there, then click + New Agent → Gemini Agent again."
          : message,
      });
      throw error;
    }
  }

  async function sendPrompt({ sessionId, prompt, context }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No Gemini session: ${sessionId}`);
    }
    if (session.currentPrompt) {
      throw new Error("Another prompt is already active for this session.");
    }

    // Combine optional context blocks (selected code, files) with the user
    // prompt — same shape Codex uses for the inline context parameter.
    const contextText = Array.isArray(context)
      ? context
          .map((entry) => entry?.text)
          .filter((value) => typeof value === "string" && value.length > 0)
          .join("\n\n")
      : "";
    const combinedPrompt = [contextText, prompt].filter(Boolean).join("\n\n");

    session.status = "prompting";
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
    // Four sites can reject pendingPrompt before the success-path
    // `await pendingPrompt` below ever runs: sendPrompt's own catch,
    // process-exit handler, cancelPrompt, and terminateSession. Without a
    // handler here, any of those leaves pendingPrompt as an orphaned
    // rejected promise → Node 22 unhandledRejection → the runtime process
    // crashes, killing every session (including Claude Code) sharing the
    // runtime. The real error still flows through `await sendRequest(...)`
    // → catch → `throw`; this no-op handler only marks pendingPrompt as
    // handled so the orphaned-rejection path is silent. See #1486.
    pendingPrompt.catch(() => {});

    try {
      // ACP `session/prompt` returns when the agent finishes the turn. The
      // streaming output arrives via session/update notifications in
      // parallel; the response.stopReason tells us how the turn ended.
      const response = await sendRequest(
        session,
        "session/prompt",
        {
          sessionId: session.agentSessionId ?? sessionId,
          prompt: [{ type: "text", text: combinedPrompt }],
        },
        // Long timeout — Gemini turns can run minutes for big tasks. The
        // upstream WebSocket layer also has a 10-minute overall request cap.
        10 * 60_000,
      );

      const stopReason = response?.stopReason ?? "completed";
      session.status = "ready";

      emit("provider://prompt-complete", {
        sessionId: session.id,
        stopReason,
      });
      emit("provider://session-status", buildSessionStatus(session, "ready"));
      resolveCurrentPrompt(session);

      await pendingPrompt;
    } catch (error) {
      session.status = "ready";
      rejectCurrentPrompt(
        session,
        error instanceof Error ? error : new Error(String(error)),
      );
      emit("provider://session-status", buildSessionStatus(session, "ready"));
      throw error;
    }
  }

  async function cancelPrompt({ sessionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No Gemini session: ${sessionId}`);
    }

    // ACP `session/cancel` is a notification (no id, no response).
    writeMessage(session, {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: session.agentSessionId ?? sessionId },
    });

    session.status = "ready";
    emit("provider://error", { sessionId, error: "Task cancelled" });
    emit("provider://session-status", buildSessionStatus(session, "ready"));
    rejectCurrentPrompt(session, new Error("Task cancelled"));
  }

  async function terminateSession({ sessionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No Gemini session: ${sessionId}`);
    }

    sessions.delete(sessionId);
    rejectPendingRequests(
      session,
      new Error("Session terminated before request completed."),
    );
    rejectCurrentPrompt(session, new Error("Session terminated."));
    try {
      session.output.close();
    } catch {
      // Ignore double-close races.
    }
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

  async function setPermissionMode({ sessionId, mode }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No Gemini session: ${sessionId}`);
    }

    // Validate against the four modes geminiModes() advertises.
    const valid = ["default", "auto_edit", "yolo", "plan"];
    if (!valid.includes(mode)) {
      throw new Error(`Unknown Gemini mode: ${mode}`);
    }

    session.currentModeId = mode;
    // ACP `session/set_mode` lets the agent know about the change too.
    sendRequest(
      session,
      "session/set_mode",
      { sessionId: session.agentSessionId, modeId: mode },
      5_000,
    ).catch(() => {
      // Best-effort — older gemini-cli builds may not support set_mode yet.
    });
    emit("provider://session-status", buildSessionStatus(session));
  }

  async function respondToPermission({ sessionId, requestId, optionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No Gemini session: ${sessionId}`);
    }

    const pending = session.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request: ${requestId}`);
    }

    session.pendingPermissions.delete(requestId);

    // The user-supplied optionId may be the desktop's (accept/decline) form
    // or a verbatim ACP optionId. Map decline → cancelled, anything else →
    // selected with the matching ACP option.
    const isDecline =
      optionId === "decline" ||
      optionId === "deny" ||
      optionId === "reject" ||
      optionId === "cancel";

    let outcome;
    if (isDecline) {
      const rejectOption = pending.options.find(
        (opt) => opt.kind === "reject_once" || opt.kind === "reject_always",
      );
      outcome = rejectOption
        ? { outcome: "selected", optionId: rejectOption.optionId }
        : { outcome: "cancelled" };
    } else {
      // Try the verbatim id first, then fall back to the first allow option.
      const exact = pending.options.find((opt) => opt.optionId === optionId);
      const allowOption =
        exact ??
        pending.options.find(
          (opt) => opt.kind === "allow_once" || opt.kind === "allow_always",
        );
      outcome = allowOption
        ? { outcome: "selected", optionId: allowOption.optionId }
        : { outcome: "cancelled" };
    }

    writeMessage(session, {
      jsonrpc: "2.0",
      id: pending.jsonRpcId,
      result: { outcome },
    });
  }

  /**
   * Update the active model for a Gemini session. Persists the choice on the
   * session record and emits a status update so the UI re-renders the picker.
   *
   * Phase 1 (this PR): the choice is persisted but is not yet sent to
   * gemini-cli — Gemini's --model flag is set at spawn time, so changing
   * models mid-session would require re-spawning the process. Phase 2
   * follow-up will plumb this through.
   */
  async function setModel({ sessionId, modelId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No Gemini session: ${sessionId}`);
    }
    const known = GEMINI_AVAILABLE_MODELS.find((m) => m.modelId === modelId);
    if (!known) {
      throw new Error(`Unknown Gemini model: ${modelId}`);
    }
    session.currentModelId = modelId;
    emit("provider://session-status", buildSessionStatus(session));
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
    setPermissionMode,
    respondToPermission,
    setModel,
  };
}
