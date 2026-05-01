// ABOUTME: Source-level regression for #1767 — graceful Task cancelled must
// ABOUTME: clear thread turnInFlight so ThinkingStatus dots don't strand.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

const errorCaseStart = agentStoreSource.indexOf('case "error": {');
const errorCaseEnd = agentStoreSource.indexOf(
  'case "permissionRequest":',
  errorCaseStart,
);
const errorCaseBody = agentStoreSource.slice(errorCaseStart, errorCaseEnd);

const cancelBranchStart = errorCaseBody.indexOf("if (isGracefulCancel) {");
const cancelBranchEnd = errorCaseBody.indexOf(
  "} else if (String(event.data.error).includes(\"unresponsive\"))",
  cancelBranchStart,
);
const cancelBranchBody = errorCaseBody.slice(cancelBranchStart, cancelBranchEnd);

describe("#1767 — graceful cancel restores thread turnInFlight", () => {
  it("the isGracefulCancel branch clears turnInFlight on the conversation", () => {
    // Without this clear, ThinkingStatus stays stuck on Evaluating… because
    // promptComplete never fires after a cancellation (see comment block in
    // the same branch). The composer unfreezes via info.status="ready",
    // but the dots are gated on agentStore.isTurnInFlight.
    expect(cancelBranchBody).toMatch(/setTurnInFlight\([^)]*,\s*false\)/);
  });

  it("the isGracefulCancel branch clears any stale turnError", () => {
    // Mirrors the symmetric cleanup in the promptComplete handler.
    expect(cancelBranchBody).toContain("clearTurnError(");
  });

  it("cleanup uses the resolved cancelConvoId, not a re-fetched lookup", () => {
    // The branch already resolves cancelConvoId for persistAgentMessage;
    // reusing it avoids a second state lookup and keeps the cleanup gated
    // on the same null check.
    expect(cancelBranchBody).toContain("cancelConvoId");
  });
});
