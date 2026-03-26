// ABOUTME: Browser-local agent registry for install/login/availability behaviors.
// ABOUTME: Keeps provider metadata and per-agent setup logic separate from session runtime handling.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function launchLoginCommand(command) {
  const loginCommand = `${command} login`;

  if (process.platform === "darwin") {
    spawn(
      "osascript",
      [
        "-e",
        `tell application "Terminal" to do script "${loginCommand}"`,
        "-e",
        'tell application "Terminal" to activate',
      ],
      { detached: true, stdio: "ignore" },
    ).unref();
    return;
  }

  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "cmd", "/c", loginCommand], {
      detached: true,
      stdio: "ignore",
    }).unref();
    return;
  }

  spawn("x-terminal-emulator", ["-e", command, "login"], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function execText(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(stderr || error.message));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

async function isCommandAvailable(command) {
  const whichCommand = process.platform === "win32" ? "where" : "which";
  try {
    await execText(whichCommand, [command]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the path to npm-cli.js relative to the running Node.js binary.
 * This bypasses shell wrapper shims that break execFile() on macOS/Linux
 * after Tauri bundling replaces symlinks with shell scripts.
 *
 * Layout:
 *   macOS/Linux: <prefix>/bin/node  → <prefix>/lib/node_modules/npm/bin/npm-cli.js
 *   Windows:     <prefix>/node.exe  → <prefix>/node_modules/npm/bin/npm-cli.js
 */
function resolveNpmCliScript() {
  const nodeDir = path.dirname(process.execPath);

  if (process.platform === "win32") {
    // Windows: node.exe sits at the prefix root
    const candidate = path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(candidate)) {
      return candidate;
    }
  } else {
    // macOS/Linux: node sits in <prefix>/bin/
    const prefix = path.dirname(nodeDir);
    const candidate = path.join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function ensureGlobalNpmPackage({ emit, command, packageName, label }) {
  if (await isCommandAvailable(command)) {
    return command;
  }

  emit("provider://cli-install-progress", {
    stage: "installing",
    message: `Installing ${label} CLI...`,
  });

  // Invoke node with npm-cli.js directly to avoid shell wrapper shims that
  // break execFile() after Tauri replaces bin/npm symlinks with shell scripts.
  const npmCliScript = resolveNpmCliScript();
  if (npmCliScript) {
    await new Promise((resolvePromise, rejectPromise) => {
      execFile(
        process.execPath,
        [npmCliScript, "install", "-g", packageName],
        (error, stdout, stderr) => {
          if (error) {
            rejectPromise(new Error(stderr || error.message));
            return;
          }
          resolvePromise(stdout.trim());
        },
      );
    });
  } else {
    // Fallback: try npm directly (works in dev where symlinks are intact,
    // and on Windows where npm.cmd is a valid batch file).
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    await new Promise((resolvePromise, rejectPromise) => {
      execFile(
        npmCommand,
        ["install", "-g", packageName],
        (error, stdout, stderr) => {
          if (error) {
            rejectPromise(new Error(stderr || error.message));
            return;
          }
          resolvePromise(stdout.trim());
        },
      );
    });
  }

  emit("provider://cli-install-progress", {
    stage: "complete",
    message: `${label} CLI installed successfully`,
  });

  return command;
}

async function ensureClaudeCodeViaNativeInstaller(emit) {
  if (await isCommandAvailable("claude")) {
    return "claude";
  }

  emit("provider://cli-install-progress", {
    stage: "installing",
    message: "Installing Claude Code CLI via official installer...",
  });

  await new Promise((resolvePromise, rejectPromise) => {
    let cmd;
    let args;

    if (process.platform === "win32") {
      cmd = "powershell";
      args = ["-NoProfile", "-Command", "irm https://claude.ai/install.ps1 | iex"];
    } else {
      cmd = "bash";
      args = ["-c", "curl -fsSL https://claude.ai/install.sh | bash"];
    }

    execFile(cmd, args, { timeout: 120_000 }, (error, stdout, stderr) => {
      if (error) {
        rejectPromise(new Error(stderr || error.message));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });

  emit("provider://cli-install-progress", {
    stage: "complete",
    message: "Claude Code CLI installed successfully",
  });

  // Re-resolve the binary path after install. The installer adds the binary
  // to a well-known location that the current process PATH may not include.
  return resolveInstalledClaudeBinary();
}

/**
 * Resolve the installed Claude Code binary path.
 * GUI apps don't inherit shell PATH updates made by installers, so check
 * well-known install locations before falling back to bare command name.
 */
function resolveInstalledClaudeBinary() {
  if (process.platform === "win32") {
    const home = os.homedir();
    const appData = process.env.APPDATA ?? "";
    const candidates = [
      path.join(home, ".claude", "bin", "claude.exe"),
      ...(appData ? [path.join(appData, "Claude", "claude.exe")] : []),
      ...(appData ? [path.join(appData, "npm", "claude.cmd")] : []),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } else {
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
  }
  return "claude";
}

export function createBrowserLocalAgentRegistry({ emit }) {
  const definitions = {
    codex: {
      type: "codex",
      name: "Codex",
      description: "OpenAI Codex via direct App Server integration",
      command: "codex",
      async getAvailability() {
        const installed = await isCommandAvailable("codex");
        return {
          type: "codex",
          name: "Codex",
          description: "OpenAI Codex via direct App Server integration",
          command: "codex",
          available: true,
          ...(installed
            ? {}
            : {
                unavailableReason:
                  "Codex CLI is not installed yet. Seren can install it automatically on first launch.",
              }),
        };
      },
      async canSpawn() {
        return true;
      },
      async ensureCli() {
        return ensureGlobalNpmPackage({
          emit,
          command: "codex",
          packageName: "@openai/codex",
          label: "Codex",
        });
      },
      launchLogin() {
        launchLoginCommand("codex");
      },
    },
    "claude-code": {
      type: "claude-code",
      name: "Claude Code",
      description: "Anthropic Claude Code via direct provider runtime",
      command: "claude",
      async getAvailability() {
        const installed = await isCommandAvailable("claude");
        return {
          type: "claude-code",
          name: "Claude Code",
          description: "Anthropic Claude Code via direct provider runtime",
          command: "claude",
          available: true,
          ...(installed
            ? {}
            : {
                unavailableReason:
                  "Claude Code CLI is not installed yet. Seren can install it automatically on first launch.",
              }),
        };
      },
      async canSpawn() {
        return true;
      },
      async ensureCli() {
        return ensureClaudeCodeViaNativeInstaller(emit);
      },
      launchLogin() {
        launchLoginCommand("claude");
      },
    },
  };

  function getDefinition(agentType) {
    const definition = definitions[agentType];
    if (!definition) {
      throw new Error(`Unknown agent type: ${agentType}`);
    }
    return definition;
  }

  return {
    async getAvailableAgents() {
      return Promise.all(
        Object.values(definitions).map((definition) =>
          definition.getAvailability(),
        ),
      );
    },

    async checkAgentAvailable(agentType) {
      return getDefinition(agentType).canSpawn();
    },

    async ensureAgentCli(agentType) {
      return getDefinition(agentType).ensureCli();
    },

    launchLogin(agentType) {
      getDefinition(agentType).launchLogin();
    },
  };
}
