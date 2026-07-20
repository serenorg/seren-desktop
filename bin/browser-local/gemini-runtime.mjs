// ABOUTME: Gemini-specific configuration for the shared browser-local ACP runtime.
// ABOUTME: Preserves gemini-cli resolution, modes, model metadata, and authentication behavior.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAcpRuntime } from "./acp-runtime.mjs";

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
 * GUI apps do not inherit shell PATH updates. Prefer the embedded npm install
 * and deliberately exclude Homebrew builds, whose skipped keytar postinstall
 * breaks Gemini credential access when launched by the desktop. #1476.
 */
function resolveGeminiBinary() {
  if (process.platform === "win32") {
    const home = os.homedir();
    const appData = process.env.APPDATA ?? "";
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
      path.join(nodeDir, "gemini.cmd"),
      path.join(nodeDir, "gemini"),
      ...(appData ? [path.join(appData, "npm", "gemini.cmd")] : []),
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
      path.join(prefix, "bin", "gemini"),
      path.join(home, ".local", "bin", "gemini"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return "gemini";
}

function isGeminiAuthError(message) {
  const lower = String(message).toLowerCase();
  if (lower.includes("not authenticated")) return true;
  if (lower.includes("authentication required")) return true;
  if (lower.includes("auth required")) return true;
  if (lower.includes("login required")) return true;
  if (lower.includes("not logged in")) return true;
  if (lower.includes("please run") && lower.includes("login")) return true;
  if (lower.includes("gemini_api_key")) return true;
  if (lower.includes("api key is missing")) return true;
  if (lower.includes("api key is not configured")) return true;
  return lower.includes("keychain initialization") && lower.includes("keytar");
}

function resolveGeminiMode({ approvalPolicy, sandboxMode }) {
  if (sandboxMode === "read-only") return "plan";
  if (sandboxMode === "danger-full-access") return "yolo";
  if (approvalPolicy === "on-request" || approvalPolicy === "untrusted") {
    return "default";
  }
  return "auto_edit";
}

function buildGeminiModes(session) {
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

function spawnGeminiProcess(cwd, { extraEnv = {} } = {}) {
  return spawn(resolveGeminiBinary(), ["--acp"], {
    cwd,
    env: {
      ...process.env,
      NODE_NO_READLINE: "1",
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

const GEMINI_ADAPTER = {
  agentType: "gemini",
  agentName: "Gemini",
  agentInfoName: "Gemini ACP",
  defaultModelId: GEMINI_DEFAULT_MODEL_ID,
  availableModels: GEMINI_AVAILABLE_MODELS,
  // Preserve Gemini's pre-refactor behavior: the ACP process does not receive
  // an initial model and every fresh session starts on the static default.
  resolveInitialModelId: () => GEMINI_DEFAULT_MODEL_ID,
  defaultModeId: "default",
  validModeIds: ["default", "auto_edit", "yolo", "plan"],
  autoApproveModeIds: ["yolo"],
  buildModes: buildGeminiModes,
  resolveInitialMode: resolveGeminiMode,
  spawnProcess: spawnGeminiProcess,
  isAuthError: isGeminiAuthError,
  stoppedBeforeRequestMessage:
    "Gemini agent stopped before request completed.",
  processExitedWhilePromptMessage:
    "Gemini process exited while prompt was active.",
  loginRequiredMessage:
    "Gemini authentication required. Opening `gemini login` in a Terminal window — finish the sign-in there, then click + New Agent → Gemini Agent again.",
  async setModel({ modelId, logPrefix }) {
    console.warn(
      `${logPrefix} setModel: ${modelId} stored as session intent — ` +
        "no-op against the running CLI process (Gemini --model is fixed at " +
        "spawn time). The next session spawn will use this model.",
    );
  },
};

export function createGeminiRuntime(options) {
  return createAcpRuntime({ ...options, adapter: GEMINI_ADAPTER });
}
