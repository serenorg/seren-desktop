// ABOUTME: Central registry of all slash commands with their handlers.
// ABOUTME: Commands are organized by tier and registered at module load.

import { acpStore } from "@/stores/acp.store";
import { promptLogin } from "@/stores/auth.store";
import { chatStore } from "@/stores/chat.store";
import { conversationStore } from "@/stores/conversation.store";
import { providerStore } from "@/stores/provider.store";
import { settingsStore } from "@/stores/settings.store";
import { walletStore } from "@/stores/wallet.store";
import type { SlashCommand } from "./types";

class CommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(cmd: SlashCommand) {
    this.commands.set(cmd.name, cmd);
  }

  get(name: string, panel: "chat" | "agent"): SlashCommand | undefined {
    const cmd = this.commands.get(name);
    if (!cmd) return undefined;
    if (!cmd.panels.includes(panel)) return undefined;
    return cmd;
  }

  search(partial: string, panel: "chat" | "agent"): SlashCommand[] {
    const results: SlashCommand[] = [];
    for (const cmd of this.commands.values()) {
      if (!cmd.panels.includes(panel)) continue;
      if (cmd.name.startsWith(partial)) {
        results.push(cmd);
      }
    }
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  all(panel: "chat" | "agent"): SlashCommand[] {
    return Array.from(this.commands.values())
      .filter((cmd) => cmd.panels.includes(panel))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
}

export const registry = new CommandRegistry();

const DISCORD_AUTOPROMPT =
  "Set up and start OpenClaw Discord in chat-only mode. If Discord is not connected, guide me through connecting it first, then confirm readiness for support-intake to send Discord chat/ticket.";

function startDiscordFlow(showStatus: (message: string) => void) {
  window.dispatchEvent(new CustomEvent("seren:open-panel", { detail: "chat" }));
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("seren:set-chat-input", {
        detail: {
          text: DISCORD_AUTOPROMPT,
          autoSend: true,
          skipAuthGate: true,
          command: "discord",
        },
      }),
    );
  }, 0);
  showStatus("Starting Discord setup flow...");
}

// ---------------------------------------------------------------------------
// Tier 1: Essential Commands
// ---------------------------------------------------------------------------

registry.register({
  name: "model",
  description: "Switch AI model",
  argHint: "<model-name>",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    if (!ctx.args) {
      const models = providerStore
        .getModels(providerStore.activeProvider)
        .map((m) => m.name)
        .join(", ");
      ctx.showStatus(`Usage: /model <name>. Available: ${models}`);
      return true;
    }

    const allModels = providerStore.getModels(providerStore.activeProvider);
    const match = allModels.find(
      (m) =>
        m.id.toLowerCase().includes(ctx.args.toLowerCase()) ||
        m.name.toLowerCase().includes(ctx.args.toLowerCase()),
    );

    if (match) {
      providerStore.setActiveModel(match.id);
      chatStore.setModel(match.id);
      ctx.showStatus(`Switched to ${match.name}`);
    } else {
      ctx.showStatus(`Model "${ctx.args}" not found.`);
    }
    ctx.clearInput();
    return true;
  },
});

registry.register({
  name: "clear",
  description: "Clear chat messages",
  panels: ["chat"],
  execute: (ctx) => {
    conversationStore.clearMessages();
    ctx.clearInput();
    ctx.showStatus("Chat cleared.");
    return true;
  },
});

registry.register({
  name: "new",
  description: "Start new conversation",
  panels: ["chat"],
  execute: async (ctx) => {
    await conversationStore.createConversation();
    ctx.clearInput();
    ctx.showStatus("New conversation started.");
    return true;
  },
});

registry.register({
  name: "attach",
  description: "Attach an image",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    window.dispatchEvent(new CustomEvent("seren:pick-images"));
    ctx.clearInput();
    return true;
  },
});

registry.register({
  name: "copy",
  description: "Copy last response",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    let lastContent: string | undefined;
    if (ctx.panel === "agent") {
      const last = [...acpStore.messages]
        .reverse()
        .find((m) => m.type === "assistant");
      lastContent = last?.content;
    } else {
      const last = [...conversationStore.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      lastContent = last?.content;
    }
    if (lastContent) {
      navigator.clipboard.writeText(lastContent);
      ctx.showStatus("Response copied to clipboard.");
    } else {
      ctx.showStatus("No response to copy.");
    }
    ctx.clearInput();
    return true;
  },
});

registry.register({
  name: "topup",
  description: "Top up SerenBucks",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    window.dispatchEvent(new CustomEvent("seren:open-deposit"));
    ctx.clearInput();
    ctx.showStatus("Opening deposit...");
    return true;
  },
});

registry.register({
  name: "discord",
  description: "Setup/start OpenClaw Discord in chat-only mode",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    ctx.clearInput();
    startDiscordFlow(ctx.showStatus);
    return true;
  },
});

registry.register({
  name: "login",
  description: "Sign in to Seren",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    promptLogin();
    ctx.clearInput();
    ctx.showStatus("Opening sign in...");
    return true;
  },
});

// ---------------------------------------------------------------------------
// Tier 2: Navigation Commands
// ---------------------------------------------------------------------------

registry.register({
  name: "settings",
  description: "Open settings panel",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    ctx.openPanel("settings");
    ctx.clearInput();
    return true;
  },
});

registry.register({
  name: "editor",
  description: "Open code editor",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    ctx.openPanel("editor");
    ctx.clearInput();
    return true;
  },
});

registry.register({
  name: "database",
  description: "Open database panel",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    ctx.openPanel("database");
    ctx.clearInput();
    return true;
  },
});

// ---------------------------------------------------------------------------
// Tier 3: Power User Commands
// ---------------------------------------------------------------------------

registry.register({
  name: "balance",
  description: "Show SerenBucks balance",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    ctx.showStatus(`Balance: ${walletStore.formattedBalance}`);
    ctx.clearInput();
    return true;
  },
});

registry.register({
  name: "about",
  description: "Show About Seren dialog",
  panels: ["chat", "agent"],
  execute: async (ctx) => {
    const { emit } = await import("@tauri-apps/api/event");
    await emit("open-about");
    ctx.clearInput();
    return true;
  },
});

registry.register({
  name: "tools",
  description: "List available MCP tools",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    window.dispatchEvent(new CustomEvent("seren:list-tools"));
    ctx.clearInput();
    ctx.showStatus("Listing available tools...");
    return true;
  },
});

registry.register({
  name: "thinking",
  description: "Toggle thinking display",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    const current = settingsStore.get("chatShowThinking");
    settingsStore.set("chatShowThinking", !current);
    ctx.showStatus(`Thinking display ${!current ? "enabled" : "disabled"}.`);
    ctx.clearInput();
    return true;
  },
});

registry.register({
  name: "help",
  description: "Show available commands",
  panels: ["chat", "agent"],
  execute: (ctx) => {
    const commands = registry.all(ctx.panel);
    const lines = commands.map((c) => `/${c.name} — ${c.description}`);
    ctx.showStatus(lines.join("\n"));
    ctx.clearInput();
    return true;
  },
});
