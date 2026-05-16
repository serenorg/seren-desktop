// ABOUTME: Static Rust command coverage for the issue #1823 host-side secret broker.
// ABOUTME: Asserts the IPC surface exists and keeps raw-secret reads out of list APIs.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const brokerRs = readFileSync(
  resolve("src-tauri/src/secret_broker.rs"),
  "utf-8",
);
const libRs = readFileSync(resolve("src-tauri/src/lib.rs"), "utf-8");

describe("Tauri secret broker commands (#1823)", () => {
  it("registers storage, migration, audit, and session commands", () => {
    for (const command of [
      "list_skill_secret_bindings",
      "upsert_skill_secret_binding",
      "request_skill_secret_env",
      "delete_skill_secret_binding",
      "scan_skill_env_migrations",
      "list_secret_access_audit",
      "grant_skill_secret_session",
      "end_skill_secret_session",
    ]) {
      expect(brokerRs).toContain(`pub async fn ${command}`);
      expect(libRs).toContain(`secret_broker::${command}`);
    }
  });

  it("uses service + skill for unique binding identity", () => {
    expect(brokerRs).toContain('format!("{service_id}::{skill_id}")');
    expect(brokerRs).toContain("service_id");
    expect(brokerRs).toContain("skill_id");
  });

  it("keeps audit rows and active sessions separate from key rows", () => {
    expect(brokerRs).toContain("SecretAccessAuditEvent");
    expect(brokerRs).toContain("SecretAccessSession");
    expect(brokerRs).toContain("ended_reason");
    expect(brokerRs).toContain("key_edited");
    expect(brokerRs).toContain('return Err("approval_required"');
    expect(brokerRs).toContain("Default $0 cap requires an explicit approval");
  });

  it("list API exposes metadata without returning secret values", () => {
    const listBody = brokerRs.slice(
      brokerRs.indexOf("pub async fn list_skill_secret_bindings"),
      brokerRs.indexOf("pub async fn upsert_skill_secret_binding"),
    );

    expect(listBody).toContain("SecretBindingSummary");
    expect(listBody).not.toContain("secret_values");
  });
});
