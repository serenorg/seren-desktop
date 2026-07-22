// ABOUTME: Shared browser-local Agent Client Protocol runtime over newline-delimited JSON-RPC.
// ABOUTME: Owns session lifecycle, streaming, permissions, MCP wiring, cancellation, and cleanup for ACP agents.

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

import { buildProviderMcpConfig } from "./mcp-config.mjs";
import { providerLogPrefix } from "./logging.mjs";
import { createSerenMcpOAuthProxy } from "./seren-mcp-oauth-proxy.mjs";

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

// ============================================================================
// ACP protocol helpers
// ============================================================================

/**
 * ACP protocol version this client implements. ACP uses uint16 versions,
 * starting at 1. Bump only when every configured ACP agent supports it.
 */
const ACP_PROTOCOL_VERSION = 1;

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
// Session record
// ============================================================================

function createAcpSessionRecord({
  adapter,
  sessionId,
  cwd,
  processHandle,
  timeoutSecs,
  currentModeId,
  currentModelId,
  logPrefix,
  serenMcpProxy = null,
}) {
  return {
    id: sessionId,
    agentType: adapter.agentType,
    agentName: adapter.agentName,
    agentInfoName: adapter.agentInfoName,
    adapter,
    cwd,
    status: "initializing",
    createdAt: new Date().toISOString(),
    process: processHandle,
    output: readline.createInterface({ input: processHandle.stdout }),
    pendingRequests: new Map(),
    nextRequestId: 1,
    pendingPermissions: new Map(),
    logPrefix,
    currentPrompt: null,
    agentSessionId: undefined,
    timeoutSecs: timeoutSecs ?? undefined,
    agentVersion: null,
    currentModeId: currentModeId ?? adapter.defaultModeId,
    currentModelId: currentModelId ?? adapter.defaultModelId,
    availableModels: adapter.availableModels,
    configOptions: [],
    serenMcpProxy,
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

// Resolve true once `pendingPrompt` is no longer the session's active prompt
// (the agent settled the turn — resolve or reject clears currentPrompt), or
// false if `timeoutMs` elapses first. Used to detect whether a cooperative
// cancel actually stopped the turn before escalating to a hard kill.
function waitForPromptToClear(session, pendingPrompt, timeoutMs) {
  if (session.currentPrompt !== pendingPrompt) return Promise.resolve(true);
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      clearInterval(poll);
      resolve(false);
    }, timeoutMs);
    const poll = setInterval(() => {
      if (session.currentPrompt !== pendingPrompt) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(true);
      }
    }, 100);
  });
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
      // Unknown update types are ignored — ACP agents may add new ones over
      // time and we don't want to crash on unfamiliar shapes.
      return;
  }
}

/**
 * Handle an inbound ACP request from the agent. Today the only one we expect
 * is `session/request_permission` for tool approvals.
 */
function buildPermissionRequestEvent(session, requestId, params) {
  return {
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
  };
}

function listPendingPermissions(session) {
  return Array.from(session.pendingPermissions.values()).map(
    (pending) => pending.permissionRequest,
  );
}

function handleAgentRequest(emit, session, payload) {
  if (payload.method === "session/request_permission") {
    const params = payload.params ?? {};
    const requestId = randomUUID();
    const permissionRequest = buildPermissionRequestEvent(
      session,
      requestId,
      params,
    );
    session.pendingPermissions.set(requestId, {
      requestId,
      jsonRpcId: payload.id,
      // Store the ACP option list verbatim so respondToPermission can map
      // a desktop optionId back to the agent's expected outcome.
      options: Array.isArray(params.options) ? params.options : [],
      permissionRequest,
    });

    // Auto-approve in YOLO / auto_edit mode for non-destructive tools.
    // This mirrors how Codex handles "auto" mode in providers.mjs.
    if (session.adapter.autoApproveModeIds.includes(session.currentModeId)) {
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

    emit("provider://permission-request", permissionRequest);
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
    // Some ACP agents write diagnostic strings to stdout. Ignore
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
      name: session.agentInfoName,
      version: session.agentVersion ?? "unknown",
    },
    models: {
      currentModelId: session.currentModelId ?? session.adapter.defaultModelId,
      availableModels: session.availableModels,
    },
    modes: session.adapter.buildModes(session),
    configOptions: session.configOptions,
  };
}

function attachProcessListeners(emit, sessions, session) {
  const logPrefix =
    session.logPrefix ?? providerLogPrefix(session.agentType);
  session.output.on("line", (line) => handleLine(emit, session, line));

  // Buffer the latest stderr lines so the spawn-time catch block has
  // something to inspect when a JSON-RPC handshake fails. Some agents write
  // auth/keychain errors to stderr, not over JSON-RPC, so without
  // this buffer the desktop only sees a generic "process exited" error.
  session.stderrTail = "";
  session.process.stderr.on("data", (chunk) => {
    const message = String(chunk);
    if (!message) return;
    session.stderrTail = (session.stderrTail + message).slice(-4096);
    const trimmed = message.trim();
    if (trimmed.length > 0) {
      console.log(`${logPrefix} ${trimmed}`);
    }

    // Proactively detect auth failures from stderr while initialize is
    // still in flight — gives the catch block a richer error to surface.
    if (
      !session.authErrorDetected &&
      session.adapter.isAuthError(trimmed)
    ) {
      session.authErrorDetected = true;
    }
  });

  // ChildProcess emits `error` before `close` when spawning fails. Keep an
  // error listener installed so the provider runtime does not crash; `close`
  // remains the single cleanup path for both spawn failures and normal exits.
  session.process.on("error", (error) => {
    console.error(`${logPrefix} process error: ${error.message}`);
  });

  session.process.on("close", () => {
    const wasTracked = sessions.delete(session.id);
    if (!wasTracked) return;

    void session.serenMcpProxy?.close();

    rejectPendingRequests(
      session,
      new Error(session.adapter.stoppedBeforeRequestMessage),
    );

    if (session.currentPrompt) {
      rejectCurrentPrompt(
        session,
        new Error(session.adapter.processExitedWhilePromptMessage),
      );
      emit("provider://error", {
        sessionId: session.id,
        error: session.adapter.processExitedWhilePromptMessage,
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

export function createAcpRuntime({
  emit,
  runtimeMode = "provider-runtime",
  adapter,
}) {
  if (!adapter?.agentType || !adapter?.agentName) {
    throw new Error("ACP runtime requires an agent adapter.");
  }

  const sessions = new Map();
  const agentLogPrefix = providerLogPrefix(adapter.agentType, runtimeMode);

  async function spawnSession(params) {
    const {
      cwd,
      localSessionId,
      apiKey,
      mcpServers,
      approvalPolicy,
      sandboxMode,
      networkEnabled,
      timeoutSecs,
      initialModelId,
    } = params;

    const sessionId = localSessionId ?? randomUUID();
    const resolvedMode = adapter.resolveInitialMode({
      approvalPolicy,
      sandboxMode,
      networkEnabled,
    });
    const requestedModel = adapter.availableModels.some(
      (model) => model.modelId === initialModelId,
    )
      ? initialModelId
      : adapter.defaultModelId;
    const resolvedModel = adapter.resolveInitialModelId
      ? adapter.resolveInitialModelId(requestedModel)
      : requestedModel;
    let serenMcpProxy = null;
    let mcpConfig;
    let processHandle;
    let session;
    try {
      if (apiKey) serenMcpProxy = await createSerenMcpOAuthProxy();
      mcpConfig = buildProviderMcpConfig({
        apiKey,
        mcpServers,
        serenMcpGatewayUrl: serenMcpProxy?.url,
      });
      processHandle = adapter.spawnProcess(cwd, {
        extraEnv: mcpConfig.childEnv,
        currentModeId: resolvedMode,
        currentModelId: resolvedModel,
        params,
      });
      session = createAcpSessionRecord({
        adapter,
        sessionId,
        cwd,
        processHandle,
        timeoutSecs,
        currentModeId: resolvedMode,
        currentModelId: resolvedModel,
        logPrefix: agentLogPrefix,
        serenMcpProxy,
      });

      sessions.set(sessionId, session);
      attachProcessListeners(emit, sessions, session);
    } catch (error) {
      sessions.delete(sessionId);
      if (processHandle) killChildTree(processHandle);
      await serenMcpProxy?.close();
      throw error;
    }

    try {
      // ACP step 1: initialize handshake
      const initResult = await sendRequest(
        session,
        "initialize",
        buildInitializeParams(),
        15_000,
      );
      session.agentVersion = initResult?.agentInfo?.version ?? null;
      // Per ACP, the client (us) is responsible for honoring the agent's
      // advertised mcpCapabilities. The encoder gates optional HTTP/SSE
      // transports so a runtime degrades cleanly instead of failing session/new.
      const mcpCapabilities =
        initResult?.agentCapabilities?.mcpCapabilities ?? {};

      if (adapter.authenticate) {
        await adapter.authenticate({
          initResult,
          session,
          request(method, requestParams, timeoutMs) {
            return sendRequest(session, method, requestParams, timeoutMs);
          },
        });
      }

      // Verify the session is still tracked before proceeding to session/new.
      // A terminated process during init would otherwise hang on a dead pipe.
      if (!sessions.has(sessionId)) {
        throw new Error(
          `${adapter.agentName} session was terminated during initialization.`,
        );
      }

      // ACP step 2: create a new session in the requested cwd, wired up with
      // the user's configured MCP servers. The agent child is a separate
      // process and cannot see the Tauri-side MCP supervisor, so the
      // wiring must be passed explicitly on every session/new.
      const sessionResult = await sendRequest(
        session,
        "session/new",
        {
          cwd,
          mcpServers: mcpConfig.acpMcpServers(mcpCapabilities),
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
        // OS PID of the agent child, so Rust can force-kill this one session
        // when the cooperative cancel/terminate RPCs are unreachable. #2313
        pid: session.process?.pid ?? null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Auth failure can surface either via the JSON-RPC error message
      // returned by initialize/session/new OR via stderr (see attachProcessListeners
      // — keytar/keychain failures land on stderr, not JSON-RPC).
      const stderrTail = session.stderrTail ?? "";
      const authFailed =
        session.authErrorDetected ||
        adapter.isAuthError(message) ||
        adapter.isAuthError(stderrTail);

      sessions.delete(sessionId);
      killChildTree(processHandle);
      await serenMcpProxy?.close();

      if (authFailed) {
        // Emit a typed event so agent.store can auto-trigger launchLogin
        // and surface a clear next-step toast to the user. This is the
        emit("provider://login-required", {
          sessionId,
          agentType: adapter.agentType,
          reason:
            message ||
            stderrTail ||
            `${adapter.agentName} authentication required.`,
        });
      }

      emit("provider://error", {
        sessionId,
        error: authFailed
          ? adapter.loginRequiredMessage
          : message,
      });
      throw error;
    }
  }

  async function sendPrompt({ sessionId, prompt, context }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No ${adapter.agentName} session: ${sessionId}`);
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
        // Coding-agent turns can run for minutes on large tasks.
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
      throw new Error(`No ${adapter.agentName} session: ${sessionId}`);
    }

    const pendingPrompt = session.currentPrompt;

    // ACP `session/cancel` is a notification (no id, no response).
    writeMessage(session, {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: session.agentSessionId ?? sessionId },
    });

    // The notification has no acknowledgement. Give the agent a short grace
    // window to actually stop — its own turn-end clears currentPrompt. If the
    // turn is still active after the window the agent ignored the cancel, so
    // hard-kill the child tree to guarantee it stops, mirroring the Claude and
    // Codex cancel paths. #2304.
    if (pendingPrompt) {
      const settled = await waitForPromptToClear(session, pendingPrompt, 10_000);
      if (!settled) {
        killChildTree(session.process);
      }
    }

    session.status = "ready";
    emit("provider://error", { sessionId, error: "Task cancelled" });
    emit("provider://session-status", buildSessionStatus(session, "ready"));
    rejectCurrentPrompt(session, new Error("Task cancelled"));
  }

  async function terminateSession({ sessionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No ${adapter.agentName} session: ${sessionId}`);
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
    await session.serenMcpProxy?.close();
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
      currentModelId: session.currentModelId,
      currentModeId: session.currentModeId,
      pendingPermissions: listPendingPermissions(session),
      pid: session.process?.pid ?? null,
    }));
  }

  async function setPermissionMode({ sessionId, mode }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No ${adapter.agentName} session: ${sessionId}`);
    }

    if (!adapter.validModeIds.includes(mode)) {
      throw new Error(`Unknown ${adapter.agentName} mode: ${mode}`);
    }

    session.currentModeId = mode;
    // ACP `session/set_mode` lets the agent know about the change too.
    sendRequest(
      session,
      "session/set_mode",
      { sessionId: session.agentSessionId, modeId: mode },
      5_000,
    ).catch(() => {
      // Best-effort — older ACP agents may not support set_mode yet.
    });
    emit("provider://session-status", buildSessionStatus(session));
  }

  async function setOAuthRouting({ sessionId, routing }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No ${adapter.agentName} session: ${sessionId}`);
    }
    session.serenMcpProxy?.setRouting(routing);
  }

  async function respondToPermission({ sessionId, requestId, optionId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No ${adapter.agentName} session: ${sessionId}`);
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

  async function setModel({ sessionId, modelId }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`No ${adapter.agentName} session: ${sessionId}`);
    }
    const known = adapter.availableModels.find((model) => model.modelId === modelId);
    if (!known) {
      throw new Error(`Unknown ${adapter.agentName} model: ${modelId}`);
    }
    session.currentModelId = modelId;
    emit("provider://session-status", buildSessionStatus(session));
    await adapter.setModel?.({
      session,
      modelId,
      request(method, requestParams, timeoutMs) {
        return sendRequest(session, method, requestParams, timeoutMs);
      },
      logPrefix: session.logPrefix ?? agentLogPrefix,
    });
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
    setOAuthRouting,
    respondToPermission,
    setModel,
  };
}
