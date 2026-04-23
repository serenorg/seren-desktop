// ABOUTME: Source-level regression tests for #1631 — draft persistence to SQLite.
// ABOUTME: Verifies migration, Tauri commands, bridge wiring, and debounce.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const database = readFileSync(
  resolve("src-tauri/src/services/database.rs"),
  "utf-8",
);
const chatCommands = readFileSync(
  resolve("src-tauri/src/commands/chat.rs"),
  "utf-8",
);
const libRs = readFileSync(resolve("src-tauri/src/lib.rs"), "utf-8");
const bridgeSource = readFileSync(
  resolve("src/lib/tauri-bridge.ts"),
  "utf-8",
);
const agentChatSource = readFileSync(
  resolve("src/components/chat/AgentChat.tsx"),
  "utf-8",
);

describe("#1631 — SQLite schema: draft column migration", () => {
  it("adds a nullable `draft TEXT` column to conversations idempotently", () => {
    expect(database).toContain(
      'SELECT draft FROM conversations LIMIT 1',
    );
    expect(database).toContain(
      '"ALTER TABLE conversations ADD COLUMN draft TEXT"',
    );
  });
});

describe("#1631 — Tauri commands for draft get/set", () => {
  it("get_thread_draft command is defined on the Rust side", () => {
    expect(chatCommands).toContain("pub async fn get_thread_draft(");
    expect(chatCommands).toContain(
      'SELECT draft FROM conversations WHERE id = ?1',
    );
  });

  it("set_thread_draft command is defined on the Rust side", () => {
    expect(chatCommands).toContain("pub async fn set_thread_draft(");
    expect(chatCommands).toContain(
      '"UPDATE conversations SET draft = ?1 WHERE id = ?2"',
    );
  });

  it("both commands are registered in lib.rs invoke_handler", () => {
    expect(libRs).toContain("commands::chat::get_thread_draft");
    expect(libRs).toContain("commands::chat::set_thread_draft");
  });
});

describe("#1631 — frontend draft bridge + debounced writes", () => {
  it("tauri-bridge exports getThreadDraft and setThreadDraft", () => {
    expect(bridgeSource).toContain("export async function getThreadDraft(");
    expect(bridgeSource).toContain("export async function setThreadDraft(");
    expect(bridgeSource).toContain('"get_thread_draft"');
    expect(bridgeSource).toContain('"set_thread_draft"');
  });

  it("AgentChat hydrates draft on thread open and debounces writes at 500ms", () => {
    expect(agentChatSource).toContain("getThreadDraft(");
    expect(agentChatSource).toContain("setThreadDraft(");
    expect(agentChatSource).toContain("DRAFT_DEBOUNCE_MS = 500");
    expect(agentChatSource).toContain("schedulePersistDraft(");
  });

  it("AgentChat deleted the in-memory agentDrafts Map", () => {
    expect(agentChatSource).not.toContain(
      "const agentDrafts = new Map<string, string>()",
    );
  });
});
