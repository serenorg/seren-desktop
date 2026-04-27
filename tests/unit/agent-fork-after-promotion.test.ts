// ABOUTME: Source-level regression tests for #1682 — fork & resume survive
// ABOUTME: sessionId !== conversationId after a predictive-compaction promotion.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

const forkStart = agentStoreSource.indexOf("async forkConversation(");
const forkEnd = agentStoreSource.indexOf(
  "addErrorMessage(sessionId: string",
  forkStart,
);
const forkBody = agentStoreSource.slice(forkStart, forkEnd);

const resumeStart = agentStoreSource.indexOf("async resumeAgentConversation(");
const resumeBody = agentStoreSource.slice(resumeStart, resumeStart + 2000);

describe("#1682 — forkConversation tolerates promoted sessions", () => {
  it("locates the session via the conversationId-aware helper, not the sessionId-keyed index", () => {
    expect(forkStart).toBeGreaterThan(0);
    expect(forkBody).not.toMatch(/state\.sessions\[conversationId\]/);
    expect(forkBody).toContain("getSessionForConversation(conversationId)");
  });

  it("hands the runtime sessionId (session.info.id) to nativeForkSession", () => {
    expect(forkBody).toMatch(/nativeForkSession\(\s*session\.info\.id,?\s*\)/);
    expect(forkBody).not.toMatch(/nativeForkSession\(\s*conversationId\s*\)/);
  });

  it("reports native-fork failures against session.info.id, matching addErrorMessage's sessionId contract", () => {
    expect(forkBody).toMatch(
      /this\.addErrorMessage\(\s*session\.info\.id,/,
    );
  });
});

describe("#1682 — resumeAgentConversation tolerates promoted sessions", () => {
  it("checks for an already-running session via the conversationId-aware helper", () => {
    expect(resumeStart).toBeGreaterThan(0);
    expect(resumeBody).not.toMatch(/state\.sessions\[conversationId\]/);
    expect(resumeBody).toContain("getSessionForConversation(conversationId)");
  });
});
