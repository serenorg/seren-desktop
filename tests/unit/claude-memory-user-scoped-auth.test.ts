// ABOUTME: #2497 Defect 2 — prove the seren-db memory path authenticates with
// ABOUTME: the user-scoped desktop key / user JWT, never an agent/gateway key.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rustWatcher = readFileSync(
  resolve("src-tauri/src/claude_memory.rs"),
  "utf-8",
);
const credentialStore = readFileSync(
  resolve("src-tauri/src/credential_store.rs"),
  "utf-8",
);
const databasesService = readFileSync(
  resolve("src/services/databases.ts"),
  "utf-8",
);
const tauriBridge = readFileSync(resolve("src/lib/tauri-bridge.ts"), "utf-8");
const setupAuth = readFileSync(resolve("src/api/setup-auth.ts"), "utf-8");

describe("seren-db memory path uses the user-scoped credential (#2497 Defect 2)", () => {
  it("the Rust watcher bears the SerenDB API key read from the user's native credential entry", () => {
    // The /publishers/seren-db/query call must bearer the API key field…
    expect(rustWatcher).toMatch(/\.bearer_auth\(&self\.api_key\)/);
    // …and that key is read through the same OS-backed boundary the desktop
    // key lands in, never directly from auth.json.
    expect(rustWatcher).toMatch(/fn read_seren_api_key/);
    // The credential is the publisher-invocation-only key (#3675). It is still
    // user-scoped and still read through the OS-backed boundary; it simply
    // omits the publisher-administration scopes this path never uses.
    expect(rustWatcher).toMatch(
      /credential_store::get_seren_skill_api_key\(app\)/,
    );
    expect(rustWatcher).not.toMatch(/credential_store::get_seren_api_key\(app\)/);
    expect(credentialStore).toMatch(
      /const SEREN_API_KEY_ACCOUNT: &str = "seren\.api-key\.v1"/,
    );
    expect(credentialStore).toMatch(
      /const SEREN_SKILL_API_KEY_ACCOUNT: &str = "seren\.skill-api-key\.v1"/,
    );
    expect(rustWatcher).not.toMatch(/\.store\("auth\.json"\)/);
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
