// ABOUTME: Grok-specific configuration for the shared browser-local ACP runtime.
// ABOUTME: Resolves and launches Grok Build, authenticates ACP, and maps Seren safety modes.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAcpRuntime } from "./acp-runtime.mjs";
import { resolveGrokBinary } from "./grok-binary.mjs";

const GROK_AVAILABLE_MODELS = [
  {
    modelId: "grok-4.5",
    name: "Grok 4.5",
    description: "Default Grok Build coding-agent model — 1M context window",
  },
];

const GROK_DEFAULT_MODEL_ID = "grok-4.5";

function resolveGrokMode({ approvalPolicy, sandboxMode }) {
  if (sandboxMode === "read-only") return "plan";
  if (sandboxMode === "danger-full-access" || sandboxMode === "full-access") {
    return "bypassPermissions";
  }
  if (approvalPolicy === "on-request" || approvalPolicy === "untrusted") {
    return "default";
  }
  return "acceptEdits";
}

function resolveGrokSandbox({ sandboxMode, networkEnabled }) {
  if (sandboxMode === "read-only") return "read-only";
  if (sandboxMode === "danger-full-access" || sandboxMode === "full-access") {
    return "off";
  }
  if (networkEnabled === false) return "strict";
  return "workspace";
}

function buildGrokModes(session) {
  return {
    currentModeId: session?.currentModeId ?? "default",
    availableModes: [
      {
        modeId: "default",
        name: "Default",
        description: "Prompt when a tool is not already allowed",
      },
      {
        modeId: "acceptEdits",
        name: "Accept Edits",
        description: "Auto-approve file edits and prompt for shell commands",
      },
      {
        modeId: "dontAsk",
        name: "Don't Ask",
        description: "Silently deny tools without an explicit allow rule",
      },
      {
        modeId: "bypassPermissions",
        name: "Always Approve",
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

function isGrokAuthError(message) {
  const lower = String(message).toLowerCase();
  return (
    lower.includes("not authenticated") ||
    lower.includes("authentication required") ||
    lower.includes("auth required") ||
    lower.includes("login required") ||
    lower.includes("not logged in") ||
    lower.includes("run `grok login`") ||
    lower.includes("run grok login") ||
    lower.includes("xai_api_key") ||
    lower.includes("xai.api_key") ||
    lower.includes("cached_token") ||
    lower.includes("grok authentication failed") ||
    lower.includes("no supported grok authentication method")
  );
}

function spawnGrokProcess(
  cwd,
  { extraEnv = {}, currentModeId, currentModelId, params },
) {
  const sandbox = resolveGrokSandbox(params);
  const args = [
    "--no-auto-update",
    "--model",
    currentModelId,
    "--permission-mode",
    currentModeId,
    "--sandbox",
    sandbox,
    "agent",
    "stdio",
  ];
  const binary = resolveGrokBinary();
  return spawn(binary, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32" && !binary.toLowerCase().endsWith(".exe"),
  });
}

async function authenticateGrok({ initResult, request }) {
  const authMethods = new Set(
    (initResult?.authMethods ?? [])
      .map((method) => method?.id)
      .filter((id) => typeof id === "string"),
  );
  const hasCachedAuth = existsSync(
    path.join(os.homedir(), ".grok", "auth.json"),
  );
  const methodId =
    process.env.XAI_API_KEY && authMethods.has("xai.api_key")
      ? "xai.api_key"
      : hasCachedAuth && authMethods.has("grok.com")
        ? "grok.com"
        : hasCachedAuth && authMethods.has("cached_token")
          ? "cached_token"
          : null;

  if (!methodId) {
    throw new Error(
      "No supported Grok authentication method. Run `grok login` or set XAI_API_KEY.",
    );
  }

  try {
    await request(
      "authenticate",
      { methodId, _meta: { headless: true } },
      30_000,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Grok authentication failed: ${message}`);
  }
}

const GROK_ADAPTER = {
  agentType: "grok",
  agentName: "Grok",
  agentInfoName: "Grok ACP",
  defaultModelId: GROK_DEFAULT_MODEL_ID,
  availableModels: GROK_AVAILABLE_MODELS,
  defaultModeId: "default",
  validModeIds: [
    "default",
    "dontAsk",
    "acceptEdits",
    "bypassPermissions",
    "plan",
  ],
  autoApproveModeIds: ["bypassPermissions"],
  buildModes: buildGrokModes,
  resolveInitialMode: resolveGrokMode,
  spawnProcess: spawnGrokProcess,
  authenticate: authenticateGrok,
  isAuthError: isGrokAuthError,
  stoppedBeforeRequestMessage: "Grok agent stopped before request completed.",
  processExitedWhilePromptMessage:
    "Grok process exited while prompt was active.",
  loginRequiredMessage:
    "Grok authentication required. Opening `grok login` in a Terminal window — finish the sign-in there, then click + New Agent → Grok again.",
  async setModel({ modelId, logPrefix }) {
    console.warn(
      `${logPrefix} setModel: ${modelId} stored as session intent — ` +
        "the running Grok process keeps its spawn-time model. The next " +
        "session spawn will use this model.",
    );
  },
};

export function createGrokRuntime(options) {
  return createAcpRuntime({ ...options, adapter: GROK_ADAPTER });
}
