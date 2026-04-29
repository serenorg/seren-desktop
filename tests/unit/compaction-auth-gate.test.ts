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
  it("imports authStore and the modal-trigger from auth.store (#1661 renamed promptLogin)", () => {
    expect(agentStoreSource).toContain(
      'import { authStore, requestSignInModal } from "@/stores/auth.store"',
    );
  });

  it("checks authStore.isAuthenticated before kicking predictive compaction", () => {
    // Post-#1716: the auto-compact branch routes through
    // `this.kickPredictiveCompact(sessionId)` instead of calling
    // `compactAgentConversation` directly. The auth gate must still
    // dominate the kick — otherwise an unauthenticated user at >=85%
    // usage triggers a Sonnet-4 summary call that will fail at the
    // gateway and burn telemetry.
    const authCheck = "if (!authStore.isAuthenticated)";
    const kickCall = "this.kickPredictiveCompact(sessionId)";
    const autoCompactAnchor = "Auto-compact check runs BEFORE drain (#1623)";
    const autoCompactIdx = agentStoreSource.indexOf(autoCompactAnchor);
    expect(autoCompactIdx, "auto-compact anchor must exist").toBeGreaterThan(
      0,
    );

    const authCheckAfterAnchor = agentStoreSource.indexOf(
      authCheck,
      autoCompactIdx,
    );
    const kickCallAfterAnchor = agentStoreSource.indexOf(
      kickCall,
      autoCompactIdx,
    );
    expect(
      authCheckAfterAnchor,
      "auth check must appear after auto-compact anchor",
    ).toBeGreaterThan(autoCompactIdx);
    expect(
      kickCallAfterAnchor,
      "auto-compact branch must call kickPredictiveCompact",
    ).toBeGreaterThan(autoCompactIdx);
    expect(
      authCheckAfterAnchor,
      "auth check must appear before kickPredictiveCompact call",
    ).toBeLessThan(kickCallAfterAnchor);
  });

  it("calls requestSignInModal() when auth check fails in auto-compact path (#1661 — was promptLogin, now real modal)", () => {
    const autoCompactAnchor = "Auto-compact check runs BEFORE drain (#1623)";
    const drainAnchor = "Drain the prompt queue for this session";
    const autoCompactIdx = agentStoreSource.indexOf(autoCompactAnchor);
    const drainIdx = agentStoreSource.indexOf(drainAnchor);

    const authBlock = agentStoreSource.slice(autoCompactIdx, drainIdx);
    expect(authBlock).toContain("requestSignInModal()");
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

describe("#1639 — refreshAccessToken pairs clearAuthState + requestSignInModal on terminal failure (#1661 rename)", () => {
  it("imports clearAuthState and requestSignInModal from auth.store", () => {
    expect(authServiceSource).toContain(
      'import { clearAuthState, requestSignInModal } from "@/stores/auth.store"',
    );
  });

  it("clears auth state AND requests the sign-in modal when no refresh token is available", () => {
    const noTokenIdx = authServiceSource.indexOf("if (!refreshToken)");
    expect(noTokenIdx).toBeGreaterThan(0);
    const blockAfter = authServiceSource.slice(noTokenIdx, noTokenIdx + 200);
    expect(blockAfter).toContain("clearAuthState()");
    expect(blockAfter).toContain("requestSignInModal()");
  });

  it("clears auth state AND requests the sign-in modal on 401 from refresh endpoint", () => {
    const refreshFnIdx = authServiceSource.indexOf(
      "async function refreshAccessToken",
    );
    const fnBody = authServiceSource.slice(refreshFnIdx, refreshFnIdx + 1400);
    const clear401Block = fnBody.indexOf("response.status === 401");
    expect(clear401Block).toBeGreaterThan(0);
    const afterClear = fnBody.slice(clear401Block, clear401Block + 300);
    expect(afterClear).toContain("clearAuthState()");
    expect(afterClear).toContain("requestSignInModal()");
  });

  it("does NOT trigger the modal on network errors (user may be offline)", () => {
    const refreshFnIdx = authServiceSource.indexOf(
      "async function refreshAccessToken",
    );
    const fnBody = authServiceSource.slice(refreshFnIdx, refreshFnIdx + 1400);
    const catchBlock = fnBody.indexOf("} catch {");
    expect(catchBlock).toBeGreaterThan(0);
    const afterCatch = fnBody.slice(catchBlock, catchBlock + 200);
    expect(afterCatch).not.toContain("requestSignInModal");
    expect(afterCatch).not.toContain("clearAuthState");
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
    // Recovery spawn passes localSessionId so the new session inherits the
    // conversation. (#1733 added initialModelId here too — the closing brace
    // no longer immediately follows localSessionId.)
    expect(agentStoreSource).toContain("localSessionId: conversationId,");
  });
});
