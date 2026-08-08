// ABOUTME: Hosted Seren runtime — SerenModels and Private Models as paired-role sessions (#3748).
// ABOUTME: OpenAI-compatible streaming through the Rust credential broker's loopback publisher proxy.

import { randomUUID } from "node:crypto";
import {
  buildLmStudioPromptForContextBudget,
  buildToolCatalog,
  createMcpGatewayClient,
  executeToolCall,
  listPendingPermissions,
  MAX_TOOL_ITERATIONS,
  runChatCompletion,
} from "./lmstudio-runtime.mjs";
import { providerLogPrefix } from "./logging.mjs";
import { resolveBrokeredSerenCredential } from "./mcp-config.mjs";
import {
  createOAuthSelectionEventEmitter,
  createSerenMcpOAuthProxy,
} from "./seren-mcp-oauth-proxy.mjs";

export const SEREN_HOSTED_AGENT_TYPES = new Set(["seren", "seren-private"]);

const PUBLISHER_SLUGS = {
  seren: "seren-models",
  "seren-private": "seren-private-models",
};

const AGENT_DISPLAY_NAMES = {
  seren: "Seren",
  "seren-private": "Seren Private Models",
};

// Hosted SerenModels run with large native contexts; the shared context-budget
// trimming only engages on very long paired sessions.
const HOSTED_CONTEXT_LENGTH = 200_000;

function publisherBaseUrl(apiBaseUrl, agentType) {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  return `${base}publishers/${PUBLISHER_SLUGS[agentType]}`;
}

function normalizeHostedModels(payload) {
  const records = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  return records
    .map((model) => {
      const modelId = String(model?.id ?? model?.modelId ?? "").trim();
      if (!modelId) return null;
      return {
        modelId,
        name: String(model?.name ?? modelId),
        ...(model?.description ? { description: String(model.description) } : {}),
      };
    })
    .filter(Boolean);
}

async function fetchHostedModels(session) {
  const response = await fetch(`${session.publisherBaseUrl}/models`, {
    headers: { Authorization: `Bearer ${session.apiKey}` },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `${session.displayName} model catalog HTTP ${response.status}: ${detail}`,
    );
  }
  return normalizeHostedModels(await response.json());
}

function buildHostedSessionStatus(session, status = session.status) {
  return {
    sessionId: session.id,
    status,
    agentSessionId: session.agentSessionId,
    agentInfo: { name: session.displayName, version: "hosted" },
    models: {
      currentModelId: session.currentModelId,
      availableModels: session.availableModelRecords,
    },
    modes: {
      currentModeId: session.currentModeId,
      availableModes: [
        {
          modeId: "ask",
          name: "Review First",
          description: "Local edits and commands pause for review.",
        },
        {
          modeId: "auto",
          name: "Auto",
          description: "Approve safe local operations automatically.",
        },
      ],
    },
    configOptions: [],
  };
}

async function sendPromptToSeren(session, prompt, context) {
  if (session.currentPrompt) {
    throw new Error(
      `Another prompt is already active for this ${session.displayName} session.`,
    );
  }

  session.status = "prompting";
  session.emit(
    "provider://session-status",
    buildHostedSessionStatus(session, "prompting"),
  );

  const abortController = new AbortController();
  session.currentPrompt = { abortController };

  try {
    const builtPrompt = buildLmStudioPromptForContextBudget(
      prompt,
      context,
      session.contextLength,
    );
    session.messages.push({ role: "user", content: builtPrompt.prompt });

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
        session.messages.push({ role: "assistant", content: result.content });
        session.status = "ready";
        session.currentPrompt = null;
        session.emit("provider://prompt-complete", {
          sessionId: session.id,
          stopReason: result.stopReason ?? "stop",
        });
        session.emit(
          "provider://session-status",
          buildHostedSessionStatus(session, "ready"),
        );
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

    throw new Error(
      `${session.displayName} stopped after too many tool iterations.`,
    );
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
    session.emit(
      "provider://session-status",
      buildHostedSessionStatus(session, "ready"),
    );
    throw error;
  }
}

export function createSerenHostedRuntime({
  emit,
  runtimeMode = "provider-runtime",
}) {
  const sessions = new Map();
  const logPrefix = providerLogPrefix("seren-hosted", runtimeMode);

  function hasSession(sessionId) {
    return sessions.has(sessionId);
  }

  function requireSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Unknown hosted Seren session: ${sessionId}`);
    return session;
  }

  async function spawnSession(params) {
    const agentType = params.agentType;
    if (!SEREN_HOSTED_AGENT_TYPES.has(agentType)) {
      throw new Error(`Not a hosted Seren agent type: ${agentType}`);
    }
    const serenCredential = resolveBrokeredSerenCredential(params);
    if (!serenCredential) {
      throw new Error(
        "Sign in to Seren to use hosted Seren models in this thread.",
      );
    }

    const sessionId = params.localSessionId ?? randomUUID();
    const displayName = AGENT_DISPLAY_NAMES[agentType];

    let serenMcpProxy = null;
    if (serenCredential.mcpUrl) {
      serenMcpProxy = await createSerenMcpOAuthProxy({
        gatewayUrl: serenCredential.mcpUrl,
        apiUrl: serenCredential.apiBaseUrl,
        onConnectionSelected: createOAuthSelectionEventEmitter(emit, sessionId),
      });
    }

    let session;
    try {
      session = {
        id: sessionId,
        agentType,
        displayName,
        cwd: params.cwd,
        status: "initializing",
        createdAt: new Date().toISOString(),
        agentSessionId: sessionId,
        timeoutSecs: params.timeoutSecs ?? undefined,
        baseUrl: serenCredential.apiBaseUrl,
        apiKey: serenCredential.capability,
        publisherBaseUrl: publisherBaseUrl(
          serenCredential.apiBaseUrl,
          agentType,
        ),
        chatCompletionsUrl: `${publisherBaseUrl(serenCredential.apiBaseUrl, agentType)}/chat/completions`,
        mcpGateway: createMcpGatewayClient({
          capability: serenCredential.capability,
          url: serenMcpProxy?.url,
        }),
        serenMcpConfigured: serenMcpProxy != null,
        serenMcpProxy,
        availableModelRecords: [],
        currentModelId: null,
        currentModeId: params.approvalPolicy === "never" ? "auto" : "ask",
        sandboxMode: params.sandboxMode ?? "workspace-write",
        approvalPolicy: params.approvalPolicy ?? "on-request",
        autoApproveReads: params.autoApproveReads !== false,
        currentPrompt: null,
        pendingPermissions: new Map(),
        approvedForSession: new Set(),
        fileAccessGrants: [],
        messages: [],
        toolIncompatibleModelIds: new Set(),
        contextLength: HOSTED_CONTEXT_LENGTH,
        logPrefix,
        emit,
      };

      session.availableModelRecords = await fetchHostedModels(session);
      if (session.availableModelRecords.length === 0) {
        throw new Error(
          agentType === "seren-private"
            ? "No private models are enabled for this organization."
            : "The Seren model catalog is empty for this account.",
        );
      }
      session.currentModelId =
        session.availableModelRecords.find(
          (model) => model.modelId === params.initialModelId,
        )?.modelId ?? session.availableModelRecords[0].modelId;

      sessions.set(sessionId, session);
      session.status = "ready";
      emit(
        "provider://session-status",
        buildHostedSessionStatus(session, "ready"),
      );
    } catch (error) {
      sessions.delete(sessionId);
      await serenMcpProxy?.close().catch(() => {});
      throw error;
    }

    return {
      id: session.id,
      agentType: session.agentType,
      cwd: session.cwd,
      status: session.status,
      createdAt: session.createdAt,
      agentSessionId: session.agentSessionId,
      timeoutSecs: session.timeoutSecs,
      serenMcpConfigured: session.serenMcpConfigured,
      pid: null,
    };
  }

  async function sendPrompt({ sessionId, prompt, context, onAccepted }) {
    const session = requireSession(sessionId);
    try {
      onAccepted?.();
    } catch {
      // Acceptance telemetry must never fail the turn.
    }
    return sendPromptToSeren(session, prompt, context);
  }

  async function cancelPrompt({ sessionId }) {
    const session = requireSession(sessionId);
    session.currentPrompt?.abortController?.abort();
    session.currentPrompt = null;
    session.status = "ready";
    emit("provider://error", { sessionId, error: "Task cancelled" });
    emit(
      "provider://session-status",
      buildHostedSessionStatus(session, "ready"),
    );
  }

  async function terminateSession({ sessionId }) {
    const session = requireSession(sessionId);
    sessions.delete(sessionId);
    session.currentPrompt?.abortController?.abort();
    await session.serenMcpProxy?.close().catch(() => {});
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
      serenMcpConfigured: session.serenMcpConfigured,
      pid: null,
    }));
  }

  function listSessionModels(sessionId) {
    return sessions.get(sessionId)?.availableModelRecords ?? [];
  }

  async function setSessionModel({ sessionId, modelId }) {
    const session = requireSession(sessionId);
    const target = session.availableModelRecords.find(
      (model) => model.modelId === modelId,
    );
    if (!target) {
      throw new Error(`Unknown ${session.displayName} model: ${modelId}`);
    }
    session.currentModelId = target.modelId;
    emit("provider://session-status", buildHostedSessionStatus(session));
  }

  async function setPermissionMode({ sessionId, mode }) {
    const session = requireSession(sessionId);
    session.currentModeId = mode === "auto" ? "auto" : "ask";
    emit("provider://session-status", buildHostedSessionStatus(session));
  }

  async function setOAuthRouting({ sessionId, routing }) {
    const session = requireSession(sessionId);
    session.serenMcpProxy?.setRouting(routing);
  }

  async function respondToPermission({ sessionId, requestId, optionId }) {
    const session = requireSession(sessionId);
    const pending = session.pendingPermissions.get(requestId);
    if (!pending) throw new Error(`No pending permission request: ${requestId}`);
    session.pendingPermissions.delete(requestId);
    pending.resolve(optionId);
  }

  async function updateSessionConfigOption() {
    return null;
  }

  return {
    hasSession,
    spawnSession,
    sendPrompt,
    cancelPrompt,
    terminateSession,
    listSessions,
    listSessionModels,
    setSessionModel,
    setPermissionMode,
    setOAuthRouting,
    respondToPermission,
    updateSessionConfigOption,
  };
}
