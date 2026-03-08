// ABOUTME: Browser-local agent registry for install/login/availability behaviors.
// ABOUTME: Keeps provider metadata and per-agent setup logic separate from session runtime handling.

import { execFile, spawn } from "node:child_process";

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

async function ensureGlobalNpmPackage({ emit, command, packageName, label }) {
  if (await isCommandAvailable(command)) {
    return command;
  }

  emit("acp://cli-install-progress", {
    stage: "installing",
    message: `Installing ${label} CLI...`,
  });

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

  emit("acp://cli-install-progress", {
    stage: "complete",
    message: `${label} CLI installed successfully`,
  });

  return command;
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
        return ensureGlobalNpmPackage({
          emit,
          command: "claude",
          packageName: "@anthropic-ai/claude-code",
          label: "Claude Code",
        });
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
