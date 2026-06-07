// ABOUTME: Source-level guard for #2128 runtime console noise reduction.
// ABOUTME: Ensures routine success logs stay debug-gated while failures stay visible.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(path), "utf-8");
}

describe("#2128 console noise policy", () => {
  it("keeps database maintenance success logs below production info level", () => {
    const database = source("src-tauri/src/services/database.rs");

    expect(database).toMatch(
      /log::debug!\(\s*"\[Database\] WAL checkpoint\(TRUNCATE\) completed: \{\}"/,
    );
    expect(database).toMatch(
      /log::debug!\(\s*"\[Database\] Persisted message \{\} for conversation \{\}"/,
    );
    expect(database).toMatch(
      /log::warn!\(\s*"\[Database\] WAL checkpoint\(TRUNCATE\) failed during \{\}: \{\}"/,
    );
    expect(database).toMatch(
      /log::error!\(\s*"\[Database\] Failed to persist message \{\} for conversation \{\}: \{\}"/,
    );
  });

  it("does not use raw console logging for named routine frontend success paths", () => {
    const files = [
      "src/stores/auth.store.ts",
      "src/services/mcp-gateway.ts",
      "src/components/chat/AgentChat.tsx",
      "src/stores/agent.store.ts",
      "src/stores/thread.store.ts",
      "src/stores/updater.store.ts",
    ];

    const forbiddenSnippets = [
      'console.log("[Auth Store] Using existing stored API key")',
      'console.log("[Auth Store] Adding Seren MCP server config...")',
      'console.log("[Auth Store] Initializing MCP Gateway (background)...")',
      'console.log("[Auth Store] MCP Gateway initialized successfully")',
      'console.log(\n      "[Auth Store] Triggering MCP auto-connect for local servers...",',
      'console.log("[Auth Store] MCP auto-connect results:", results)',
      'console.log("[MCP Gateway] Using cached tools (still valid)")',
      'console.log("[MCP Gateway] Initializing via MCP protocol...")',
      "console.log(`[MCP Gateway] Connecting to ${MCP_GATEWAY_URL}...`)",
      'console.log("[MCP Gateway] Connected successfully")',
      'console.log(\n        `[MCP Gateway] Initialized with ${cachedTools.length} tools via MCP protocol`,',
      'console.log("[AgentChat] sendMessage called:",',
      'console.log("[AgentChat] Attachment split:",',
      'console.log(\n      "[AgentChat] Sending prompt to agent runtime, context blocks:",',
      'console.log("[AgentStore] sendPrompt called:",',
      'console.log(\n      "[AgentRuntime] Adding user message to session:",',
      'console.log("[AgentStore] Calling providerService.sendPrompt...")',
      'console.log("[AgentStore] sendPrompt completed successfully")',
      'console.log(\n        "[AgentRuntime] Adding assistant message to session:",',
      'console.log(\n      "[AgentRuntime] setActiveSession - old:",',
      'console.log(\n        "[Thread] selectThread - looking for session with conversationId:",',
      'console.info("[Updater] Checking for updates...")',
      'console.info("[Updater] Update available:", update.version)',
      'console.info("[Updater] No update available")',
    ];

    const combined = files.map((file) => source(file)).join("\n");
    for (const snippet of forbiddenSnippets) {
      expect(combined).not.toContain(snippet);
    }
  });

  it("documents the opt-in verbose console switch in the README", () => {
    expect(source("README.md")).toContain(
      "localStorage.setItem(\"seren.debug.verboseConsole\", \"true\")",
    );
  });
});
