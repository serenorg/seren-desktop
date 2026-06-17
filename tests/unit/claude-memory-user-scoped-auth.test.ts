// ABOUTME: #2497 Defect 2 — prove the seren-db memory path authenticates with
// ABOUTME: the user-scoped desktop key / user JWT, never an agent/gateway key.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rustWatcher = readFileSync(
  resolve("src-tauri/src/claude_memory.rs"),
  "utf-8",
);
const databasesService = readFileSync(
  resolve("src/services/databases.ts"),
  "utf-8",
);
const tauriBridge = readFileSync(resolve("src/lib/tauri-bridge.ts"), "utf-8");
const setupAuth = readFileSync(resolve("src/api/setup-auth.ts"), "utf-8");

describe("seren-db memory path uses the user-scoped credential (#2497 Defect 2)", () => {
  it("the Rust watcher bears the SerenDB API key read from the user's store entry", () => {
    // The /publishers/seren-db/query call must bearer the API key field…
    expect(rustWatcher).toMatch(/\.bearer_auth\(&self\.api_key\)/);
    // …and that key is read from the same store entry the desktop key lands in.
    expect(rustWatcher).toMatch(/const SEREN_API_KEY_KEY: &str = "seren_api_key"/);
    expect(rustWatcher).toMatch(/fn read_seren_api_key/);
    expect(rustWatcher).toMatch(/\.get\(SEREN_API_KEY_KEY\)/);
  });

  it("the desktop stores the minted user key under that same `seren_api_key` entry", () => {
    expect(tauriBridge).toMatch(/export async function storeSerenApiKey/);
    expect(tauriBridge).toMatch(/key: "seren_api_key"/);
  });

  it("databases.runSql goes through the Rust user-key client, not the MCP gateway", () => {
    // The /query leg must use the Rust command (user-scoped API key) rather than
    // the seren-mcp gateway (agent-scoped keys). The Rust command name is the
    // load-bearing invariant.
    expect(databasesService).toMatch(
      /invoke<QueryResult>\("claude_memory_run_sql"/,
    );
  });

  it("the seren-db management SDK attaches the user JWT, not an agent key", () => {
    // setup-auth is the only interceptor on the seren-db client: it attaches the
    // user's OAuth token (or defers to the Rust gateway bridge, which also uses
    // the user JWT via authenticated_request). No agent/gateway key here.
    expect(setupAuth).toMatch(/getToken\(\)/);
    expect(setupAuth).toMatch(/Authorization.*Bearer \$\{token\}/);
    expect(setupAuth).not.toMatch(/api[_-]?key/i);
  });
});
