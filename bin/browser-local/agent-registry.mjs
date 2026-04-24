// ABOUTME: Browser-local agent registry for install/login/availability behaviors.
// ABOUTME: Keeps provider metadata and per-agent setup logic separate from session runtime handling.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { backgroundUpdateCli } from "./cli-updater.mjs";

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
  // Check well-known install paths first (bare `which`/`where` can find stale wrappers)
  const existing = resolveInstalledClaudeBinary();
  if (existing !== "claude") {
    return existing;
  }

  if (await isCommandAvailable("claude")) {
    return "claude";
  }

  // Strategy 1: Official native installer (PowerShell on Windows, bash on Unix)
  emit("provider://cli-install-progress", {
    stage: "installing",
    message: "Installing Claude Code CLI via official installer...",
  });

  let nativeInstallerFailed = false;
  try {
    await new Promise((resolvePromise, rejectPromise) => {
      let cmd;
      let args;

      if (process.platform === "win32") {
        cmd = "powershell";
        args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm https://claude.ai/install.ps1 | iex"];
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

    // Verify the binary actually landed where we expect
    const resolved = resolveInstalledClaudeBinary();
    if (resolved !== "claude") {
      emit("provider://cli-install-progress", {
        stage: "complete",
        message: "Claude Code CLI installed successfully",
      });
      return resolved;
    }

    // Installer returned success but binary not found — treat as failure
    console.warn("[agent-registry] Native installer succeeded but binary not found at expected paths");
    nativeInstallerFailed = true;
  } catch (nativeError) {
    console.warn("[agent-registry] Native installer failed:", nativeError.message);
    nativeInstallerFailed = true;
  }

  // Strategy 2: npm install via the embedded runtime's own Node.js and npm.
  // The Seren Desktop bundle ships node.exe and npm — use them directly so the
  // install works regardless of system PATH, PowerShell execution policy, or
  // whether the user has Node.js installed globally.
  if (nativeInstallerFailed) {
    emit("provider://cli-install-progress", {
      stage: "installing",
      message: "Installing Claude Code CLI via npm (bundled runtime)...",
    });

    const npmCliScript = resolveNpmCliScript();
    try {
      if (npmCliScript) {
        await new Promise((resolvePromise, rejectPromise) => {
          execFile(
            process.execPath,
            [npmCliScript, "install", "-g", "@anthropic-ai/claude-code"],
            { timeout: 120_000 },
            (error, stdout, stderr) => {
              if (error) {
                rejectPromise(new Error(stderr || error.message));
                return;
              }
              resolvePromise(stdout.trim());
            },
          );
        });
      } else if (process.platform === "win32") {
        // Last resort on Windows: try npm.cmd from PATH
        await new Promise((resolvePromise, rejectPromise) => {
          execFile(
            "npm.cmd",
            ["install", "-g", "@anthropic-ai/claude-code"],
            { timeout: 120_000 },
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
        throw new Error("npm not available in embedded runtime");
      }

      const resolved = resolveInstalledClaudeBinary();
      if (resolved !== "claude") {
        emit("provider://cli-install-progress", {
          stage: "complete",
          message: "Claude Code CLI installed successfully via npm",
        });
        return resolved;
      }

      // npm install returned success but binary not found
      throw new Error(
        "Claude Code package installed but binary not found. " +
        "Try running: npm install -g @anthropic-ai/claude-code"
      );
    } catch (npmError) {
      console.error("[agent-registry] npm install also failed:", npmError.message);
      throw new Error(
        `Failed to install Claude Code CLI.\n` +
        `Native installer: ${nativeInstallerFailed ? "failed (possibly blocked by execution policy)" : "skipped"}\n` +
        `npm install: ${npmError.message}\n` +
        `Please install manually: npm install -g @anthropic-ai/claude-code`
      );
    }
  }

  return resolveInstalledClaudeBinary();
}

/**
 * Resolve the installed Gemini CLI binary path.
 *
 * Mirrors `resolveInstalledClaudeBinary()` below. Prefers the binary that
 * the embedded runtime's `npm install -g @google/gemini-cli` would have
 * placed at `<prefix>/bin/gemini` (Unix) or `<nodeDir>/gemini.cmd` (Windows)
 * over any system install (Homebrew, system npm, etc.).
 *
 * Why: Homebrew's gemini-cli formula skips the `node-gyp rebuild` postinstall
 * step that compiles `keytar.node`, so the Homebrew binary cannot read
 * stored credentials when launched as a child process from a GUI app and
 * fails immediately with "When using Gemini API, you must specify the
 * GEMINI_API_KEY environment variable" (#1476). Preferring the embedded
 * install ensures Seren controls the install path end-to-end and the
 * keychain integration actually works.
 *
 * Returns the bare "gemini" string if no install is found, so the caller
 * can trigger ensureCli() to install via the embedded runtime's npm.
 */
function resolveInstalledGeminiBinary() {
  if (process.platform === "win32") {
    const home = os.homedir();
    const appData = process.env.APPDATA ?? "";
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
      // npm global install via embedded runtime's npm (prefix = node dir on Windows)
      path.join(nodeDir, "gemini.cmd"),
      path.join(nodeDir, "gemini"),
      // npm global install via system npm
      ...(appData ? [path.join(appData, "npm", "gemini.cmd")] : []),
      // Generic install fallbacks
      path.join(home, ".local", "bin", "gemini.exe"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } else {
    const home = os.homedir();
    const nodeDir = path.dirname(process.execPath);
    const prefix = path.dirname(nodeDir);
    const candidates = [
      // npm global install via embedded runtime's npm — check FIRST so a
      // broken Homebrew install doesn't shadow our working bundled one.
      path.join(prefix, "bin", "gemini"),
      // Generic user-local install fallbacks
      path.join(home, ".local", "bin", "gemini"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "gemini";
}

/**
 * Resolve the installed Claude Code binary path.
 * GUI apps don't inherit shell PATH updates made by installers, so check
 * well-known install locations before falling back to bare command name.
 */
export function resolveInstalledClaudeBinary() {
  if (process.platform === "win32") {
    const home = os.homedir();
    const appData = process.env.APPDATA ?? "";
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
      // Native installer location (install.ps1 puts it here)
      path.join(home, ".local", "bin", "claude.exe"),
      // Older native installer location
      path.join(home, ".claude", "bin", "claude.exe"),
      // Legacy / alternate location
      ...(appData ? [path.join(appData, "Claude", "claude.exe")] : []),
      // npm global install via system npm
      ...(appData ? [path.join(appData, "npm", "claude.cmd")] : []),
      // npm global install via embedded runtime's npm (prefix = node dir on Windows)
      path.join(nodeDir, "claude.cmd"),
      path.join(nodeDir, "claude"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } else {
    const home = os.homedir();
    const nodeDir = path.dirname(process.execPath);
    const prefix = path.dirname(nodeDir);
    const candidates = [
      path.join(home, ".claude", "bin", "claude"),
      path.join(home, ".local", "bin", "claude"),
      // npm global install via embedded runtime's npm
      path.join(prefix, "bin", "claude"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "claude";
}

/**
 * Resolve the absolute path of the installed Codex CLI binary.
 *
 * Mirrors `resolveInstalledClaudeBinary()`. Seren previously resolved Codex
 * by bare command name, which burned us on Windows (#876, #928) when GUI
 * apps don't inherit shell PATH and `.cmd` wrappers race with npm symlinks.
 * Prefer known install locations; fall back to bare "codex" only when
 * nothing resolves. Returning an absolute path lets the updater run the
 * binary directly without trusting PATH.
 */
export function resolveInstalledCodexBinary() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? "";
    const nodeDir = path.dirname(process.execPath);
    const candidates = [
      ...(appData ? [path.join(appData, "npm", "codex.cmd")] : []),
      ...(appData ? [path.join(appData, "npm", "codex.ps1")] : []),
      path.join(nodeDir, "codex.cmd"),
      path.join(nodeDir, "codex"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  } else {
    const home = os.homedir();
    const nodeDir = path.dirname(process.execPath);
    const prefix = path.dirname(nodeDir);
    const candidates = [
      path.join(prefix, "bin", "codex"),
      path.join(home, ".local", "bin", "codex"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return "codex";
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
    gemini: {
      type: "gemini",
      name: "Gemini",
      description: "Google Gemini via gemini-cli (Agent Client Protocol)",
      command: "gemini",
      async getAvailability() {
        // Resolve via the embedded-install-aware path, NOT bare PATH lookup.
        // A Homebrew gemini-cli on PATH cannot read its own keychain when
        // spawned from a GUI app (#1476), so we report the agent as needing
        // install whenever our embedded npm install path is empty — even if
        // some other gemini is on PATH.
        const resolved = resolveInstalledGeminiBinary();
        const installed = resolved !== "gemini";
        return {
          type: "gemini",
          name: "Gemini",
          description: "Google Gemini via gemini-cli (Agent Client Protocol)",
          command: "gemini",
          available: true,
          ...(installed
            ? {}
            : {
                unavailableReason:
                  "Gemini CLI is not installed yet. Seren can install it automatically on first launch.",
              }),
        };
      },
      async canSpawn() {
        return true;
      },
      async ensureCli() {
        // Short-circuit if our embedded install already exists. This prevents
        // re-running npm on every spawn while still bypassing broken system
        // installs that might be on PATH.
        const resolved = resolveInstalledGeminiBinary();
        if (resolved !== "gemini") {
          return resolved;
        }
        return ensureGlobalNpmPackage({
          emit,
          command: "gemini",
          packageName: "@google/gemini-cli",
          label: "Gemini",
        });
      },
      launchLogin() {
        // Use the resolved embedded-install path so the user runs `gemini login`
        // with the WORKING binary (with compiled keytar), not the broken one.
        const resolved = resolveInstalledGeminiBinary();
        launchLoginCommand(resolved !== "gemini" ? resolved : "gemini");
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

  // Fire-and-forget background update checks for bundled CLIs (#1637).
  // TTL-gated to 24h inside backgroundUpdateCli, same-channel only, silent
  // on failure. Do not await — registry init must not block on npm.
  const npmCliScript = resolveNpmCliScript();
  const onUpdated = ({ label, from, to }) => {
    emit?.("provider://cli-updated", { label, from, to });
  };
  void backgroundUpdateCli({
    label: "Codex",
    bareCommand: "codex",
    resolvedPath: resolveInstalledCodexBinary(),
    packageName: "@openai/codex",
    npmCliScript,
    onUpdated,
  });
  void backgroundUpdateCli({
    label: "Claude Code",
    bareCommand: "claude",
    resolvedPath: resolveInstalledClaudeBinary(),
    packageName: "@anthropic-ai/claude-code",
    npmCliScript,
    onUpdated,
  });

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
