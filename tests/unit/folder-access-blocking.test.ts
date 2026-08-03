// ABOUTME: Critical regression coverage for folder-access probe scheduling.
// ABOUTME: Protects the blocking-pool wrap around macOS TCC consent probes.

import { describe, expect, it } from "vitest";
import { readSource } from "./source-text";

describe("#3613 folder-access probes run on the blocking pool", () => {
  it("wraps both probe commands in spawn_blocking", () => {
    const source = readSource("src-tauri/src/commands/folder_access.rs");

    // A TCC consent probe blocks until the user answers the dialog —
    // potentially minutes. It must not pin an async runtime worker.
    expect(source).toContain("tauri::async_runtime::spawn_blocking(preflight)");
    expect(source).toContain("tauri::async_runtime::spawn_blocking(move || {");
  });
});
