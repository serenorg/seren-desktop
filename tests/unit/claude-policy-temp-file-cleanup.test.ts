// ABOUTME: Guards the Windows --settings/--mcp-config temp files against per-launch leaks (#3154).
// ABOUTME: A spawn that never starts emits "error" without "exit", so both must clear them.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const claudeModulePath = new URL(
  "../../bin/browser-local/claude-runtime.mjs",
  import.meta.url,
).href;
const { _removeClaudeArgsTempFiles: removeClaudeArgsTempFiles } = await import(
  /* @vite-ignore */ claudeModulePath
);
const claudeRuntime = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf8",
);

describe("Claude temp settings cleanup (#3154)", () => {
  it("removes both temp config files from disk", () => {
    const root = mkdtempSync(join(tmpdir(), "seren-claude-temp-"));
    const mcpTempFile = join(root, "seren-mcp-session.json");
    const policyTempFile = join(root, "seren-policy-session.json");
    writeFileSync(mcpTempFile, "{}", "utf-8");
    writeFileSync(policyTempFile, "{}", "utf-8");

    removeClaudeArgsTempFiles({
      _mcpTempFile: mcpTempFile,
      _policyTempFile: policyTempFile,
    });

    expect(existsSync(mcpTempFile)).toBe(false);
    expect(existsSync(policyTempFile)).toBe(false);
  });

  it("tolerates already-removed files and the non-Windows shape", () => {
    // On macOS and Linux the config is passed inline, so neither field is
    // ever set. A respawn also unlinks the same paths twice.
    const root = mkdtempSync(join(tmpdir(), "seren-claude-temp-"));
    expect(() => removeClaudeArgsTempFiles({})).not.toThrow();
    expect(() =>
      removeClaudeArgsTempFiles({
        _policyTempFile: join(root, "never-written.json"),
      }),
    ).not.toThrow();
  });

  it("clears the files on a spawn that never starts", () => {
    // Binding cleanup to "exit" alone stranded one %TEMP%\\seren-policy-*.json
    // per failed launch: Node emits "error" for a process that failed to
    // spawn and may never emit "exit". A synchronous spawn throw skips the
    // listeners entirely, so that path unlinks directly.
    const launchAt = claudeRuntime.indexOf("const launchClaudeProcess = ()");
    expect(launchAt).toBeGreaterThan(-1);
    const region = claudeRuntime.slice(launchAt, launchAt + 4000);

    expect(region).toMatch(
      /catch \(spawnError\) \{\s*removeClaudeArgsTempFiles\(claudeArgs\);\s*throw spawnError;/,
    );
    expect(region).toContain(
      'processHandle.on("exit", () => removeClaudeArgsTempFiles(claudeArgs))',
    );

    // The "error" path cleans up inside the existing #2470-guarded listener,
    // after the orphan check, so a replaced handle cannot clear the live
    // launch's files. A second listener here would also shadow the #2470
    // regression guard, which anchors on the first processHandle.on("error").
    const errorAt = region.indexOf('processHandle.on("error"');
    expect(errorAt).toBeGreaterThan(-1);
    expect(region.indexOf('processHandle.on("error"', errorAt + 1)).toBe(-1);
    const guardAt = region.indexOf("sessions.get(sessionId) !== launchedSession");
    const cleanupAt = region.indexOf(
      "removeClaudeArgsTempFiles(claudeArgs)",
      errorAt,
    );
    expect(guardAt).toBeGreaterThan(errorAt);
    expect(cleanupAt).toBeGreaterThan(guardAt);
  });
});
