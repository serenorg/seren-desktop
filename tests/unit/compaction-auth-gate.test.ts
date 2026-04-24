// ABOUTME: Regression tests for #1639 — compaction must not fire without auth.
// ABOUTME: Verifies auth gates on auto-compact and predictive-compact triggers.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

const authServiceSource = readFileSync(
  resolve("src/services/auth.ts"),
  "utf-8",
);

describe("#1639 — auto-compact auth gate", () => {
  it("imports authStore and promptLogin from auth.store", () => {
    expect(agentStoreSource).toContain(
      'import { authStore, promptLogin } from "@/stores/auth.store"',
    );
  });

  it("checks authStore.isAuthenticated before calling compactAgentConversation", () => {
    const authCheck = "if (!authStore.isAuthenticated)";
    const compactCall = "this.compactAgentConversation(";
    const authCheckIdx = agentStoreSource.indexOf(authCheck);
    expect(authCheckIdx, "auth check must exist").toBeGreaterThan(0);

    // The auth check must appear before the compact call in the auto-compact block
    const autoCompactAnchor = "Auto-compact check runs BEFORE drain (#1623)";
    const autoCompactIdx = agentStoreSource.indexOf(autoCompactAnchor);
    const authCheckAfterAnchor = agentStoreSource.indexOf(
      authCheck,
      autoCompactIdx,
    );
    const compactCallAfterAnchor = agentStoreSource.indexOf(
      compactCall,
      autoCompactIdx,
    );
    expect(
      authCheckAfterAnchor,
      "auth check must appear after auto-compact anchor",
    ).toBeGreaterThan(autoCompactIdx);
    expect(
      authCheckAfterAnchor,
      "auth check must appear before compactAgentConversation call",
    ).toBeLessThan(compactCallAfterAnchor);
  });

  it("calls promptLogin() when auth check fails in auto-compact path", () => {
    const autoCompactAnchor = "Auto-compact check runs BEFORE drain (#1623)";
    const drainAnchor = "Drain the prompt queue for this session";
    const autoCompactIdx = agentStoreSource.indexOf(autoCompactAnchor);
    const drainIdx = agentStoreSource.indexOf(drainAnchor);

    const authBlock = agentStoreSource.slice(autoCompactIdx, drainIdx);
    expect(authBlock).toContain("promptLogin()");
  });

  it("logs a warning when skipping compaction due to auth", () => {
    expect(agentStoreSource).toContain(
      "Skipping auto-compaction — user is not authenticated",
    );
  });
});

describe("#1639 — predictive-compact auth gate", () => {
  it("gates predictive compaction on authStore.isAuthenticated", () => {
    // The promptComplete handler's predictive-compact block must check auth
    const predictiveAnchor =
      "Predictive compaction — warm a replacement session";
    const predictiveIdx = agentStoreSource.indexOf(predictiveAnchor);
    expect(predictiveIdx).toBeGreaterThan(0);

    // The if-condition immediately following the anchor must include auth
    const nextIf = agentStoreSource.indexOf("if (", predictiveIdx);
    const ifBlock = agentStoreSource.slice(nextIf, nextIf + 100);
    expect(ifBlock).toContain("authStore.isAuthenticated");
  });
});

describe("#1639 — refreshAccessToken calls promptLogin on terminal failure", () => {
  it("imports promptLogin from auth.store", () => {
    expect(authServiceSource).toContain(
      'import { promptLogin } from "@/stores/auth.store"',
    );
  });

  it("calls promptLogin when no refresh token is available", () => {
    // Find the "if (!refreshToken)" block and verify promptLogin is called
    const noTokenIdx = authServiceSource.indexOf("if (!refreshToken)");
    expect(noTokenIdx).toBeGreaterThan(0);
    const blockAfter = authServiceSource.slice(noTokenIdx, noTokenIdx + 100);
    expect(blockAfter).toContain("promptLogin()");
  });

  it("calls promptLogin on 401 from refresh endpoint", () => {
    // Find the 401 handling block inside refreshAccessToken
    const refreshFnIdx = authServiceSource.indexOf(
      "async function refreshAccessToken",
    );
    const fnBody = authServiceSource.slice(refreshFnIdx, refreshFnIdx + 1200);
    const clear401Block = fnBody.indexOf("response.status === 401");
    expect(clear401Block).toBeGreaterThan(0);
    const afterClear = fnBody.slice(clear401Block, clear401Block + 200);
    expect(afterClear).toContain("promptLogin()");
  });

  it("does NOT call promptLogin on network errors (user may be offline)", () => {
    const refreshFnIdx = authServiceSource.indexOf(
      "async function refreshAccessToken",
    );
    const fnBody = authServiceSource.slice(refreshFnIdx, refreshFnIdx + 1200);
    const catchBlock = fnBody.indexOf("} catch {");
    expect(catchBlock).toBeGreaterThan(0);
    const afterCatch = fnBody.slice(catchBlock, catchBlock + 150);
    expect(afterCatch).not.toContain("promptLogin");
  });
});

describe("#1639 — compaction failure preserves transcript", () => {
  it("snapshots fullTranscript before the try block", () => {
    const hoistAnchor = "Hoisted for catch-handler access";
    const hoistIdx = agentStoreSource.indexOf(hoistAnchor);
    expect(hoistIdx, "hoist comment must exist").toBeGreaterThan(0);

    const tryIdx = agentStoreSource.indexOf("try {", hoistIdx);
    const transcriptDecl = agentStoreSource.indexOf(
      "const fullTranscript = [...session.messages]",
      hoistIdx,
    );
    expect(
      transcriptDecl,
      "fullTranscript must be declared before the try block",
    ).toBeLessThan(tryIdx);
  });

  it("hoists cwd, agentType, and conversationId before the try block", () => {
    const hoistIdx = agentStoreSource.indexOf("Hoisted for catch-handler");
    const tryIdx = agentStoreSource.indexOf("try {", hoistIdx);
    const block = agentStoreSource.slice(hoistIdx, tryIdx);

    expect(block).toContain("const cwd = session.cwd");
    expect(block).toContain("const agentType = session.info.agentType");
    expect(block).toContain("const conversationId = session.conversationId");
  });

  it("catch handler attempts recovery spawn when original session is gone", () => {
    expect(agentStoreSource).toContain(
      "Attempting recovery — restoring",
    );
    expect(agentStoreSource).toContain(
      'localSessionId: conversationId,\n          });',
    );
  });
});
