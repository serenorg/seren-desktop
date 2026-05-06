// ABOUTME: Critical regression guards for #1825 — fork JSONL must be durable
// ABOUTME: before --resume; forkConversation must gate on claudeSessionExists.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);
const claudeRuntimeSource = readFileSync(
  resolve("bin/browser-local/claude-runtime.mjs"),
  "utf-8",
);

const forkStart = agentStoreSource.indexOf("async forkConversation(");
const forkEnd = agentStoreSource.indexOf(
  "addErrorMessage(sessionId: string",
  forkStart,
);
const forkBody = agentStoreSource.slice(forkStart, forkEnd);

describe("#1825 — forkConversation gates on claudeSessionExists between native fork and spawn", () => {
  it("imports claudeSessionExists from the claudeMemory service", () => {
    // Same service the resume-side gate uses (#1657); reusing it keeps the
    // existence check unified and means a single Rust `claude_session_exists`
    // command underwrites both code paths.
    expect(agentStoreSource).toMatch(
      /import\s*\{[^}]*claudeSessionExists[^}]*\}\s*from\s*["']@\/services\/claudeMemory["']/,
    );
  });

  it("calls claudeSessionExists after nativeForkSession returns and before the resume-side spawnSession", () => {
    expect(forkStart).toBeGreaterThan(0);
    const nativeForkIdx = forkBody.indexOf("nativeForkSession(");
    const existsIdx = forkBody.indexOf("claudeSessionExists(");
    const spawnIdx = forkBody.indexOf("spawnSession(");
    expect(nativeForkIdx, "nativeForkSession call missing").toBeGreaterThan(0);
    expect(existsIdx, "claudeSessionExists call missing").toBeGreaterThan(0);
    expect(spawnIdx, "spawnSession call missing").toBeGreaterThan(0);
    // Order: nativeForkSession → claudeSessionExists → spawnSession.
    expect(existsIdx).toBeGreaterThan(nativeForkIdx);
    expect(spawnIdx).toBeGreaterThan(existsIdx);
  });

  it("falls back to bootstrapPromptContext when the fork JSONL does not exist", () => {
    // When the existence check returns false (or throws), the call site must
    // drop newAgentSessionId and seed the new session through
    // buildForkBootstrapContext — exactly the shape the useNativeFork=false
    // branch already uses. Without this, a missing-file outcome surfaces the
    // raw spawn failure to the user instead of degrading gracefully.
    expect(forkBody).toContain("buildForkBootstrapContext(");
    // Source-level shape: there must be a branch that, in response to a
    // negative existence check, sets bootstrapPromptContext from the helper.
    // We assert the absence of the dangerous shape (passing
    // newAgentSessionId straight through without an existence guard) by
    // requiring that the spawnSession call's resumeAgentSessionId arg is
    // resolved through a guarded local rather than the raw native-fork id.
    expect(forkBody).not.toMatch(
      /spawnSession\([^)]*resumeAgentSessionId:\s*newAgentSessionId,/s,
    );
  });
});

describe("#1825 — forkSession writes the JSONL directly instead of spawning a temp Claude", () => {
  it("forkSession does not pass --fork-session and does not spawn a child process", () => {
    const fnIdx = claudeRuntimeSource.indexOf("async function forkSession(");
    expect(fnIdx, "forkSession function missing").toBeGreaterThan(0);
    // Find the function body. forkSession is at module scope inside
    // createClaudeRuntime; the next async/function at module level closes it.
    // A simple bounded slice is enough — every assertion below operates on
    // the body, not the rest of the file.
    const bodyEnd = claudeRuntimeSource.indexOf(
      "\n  async function ",
      fnIdx + 30,
    );
    const fnBody = claudeRuntimeSource.slice(
      fnIdx,
      bodyEnd > 0 ? bodyEnd : fnIdx + 4000,
    );

    // No more temp-process spawn. The race we are eliminating is precisely
    // the one where a temp Claude exits before its fork JSONL flushes.
    expect(fnBody).not.toContain("spawn(");
    expect(fnBody).not.toContain("--fork-session");
    expect(fnBody).not.toContain("forkSession: true");
    expect(fnBody).not.toContain("attachProcessListeners");
    expect(fnBody).not.toContain("sendControlRequest");
    expect(fnBody).not.toContain("killChildTree");
  });

  it("forkSession resolves the parent JSONL via findSessionJsonlPath and writes to projectsRoot", () => {
    const fnIdx = claudeRuntimeSource.indexOf("async function forkSession(");
    const bodyEnd = claudeRuntimeSource.indexOf(
      "\n  async function ",
      fnIdx + 30,
    );
    const fnBody = claudeRuntimeSource.slice(
      fnIdx,
      bodyEnd > 0 ? bodyEnd : fnIdx + 4000,
    );
    expect(fnBody).toContain("findSessionJsonlPath(");
    expect(fnBody).toContain("writeForkedTranscript(");
  });
});
