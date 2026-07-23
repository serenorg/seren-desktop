// ABOUTME: Pins the agent-store handoff from session lifecycle to credential lease commands.
// ABOUTME: The command boundary itself is observed in credential-lease-bridge.test.ts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const agentStoreSource = readFileSync(
  resolve(process.cwd(), "src/stores/agent.store.ts"),
  "utf8",
);

function bodyAfter(marker: string, width = 12_000): string {
  const index = agentStoreSource.indexOf(marker);
  expect(index, `missing ${marker}`).toBeGreaterThanOrEqual(0);
  return agentStoreSource.slice(index, index + width);
}

function directTerminationContext(sessionExpression: string): string {
  const matcher = new RegExp(
    `providerService\\s*\\.\\s*terminateSession\\(${sessionExpression}\\s*(?:,|\\))`,
  );
  const match = matcher.exec(agentStoreSource);
  expect(match, `missing provider termination for ${sessionExpression}`).toBeTruthy();
  const index = match?.index ?? -1;
  return agentStoreSource.slice(Math.max(0, index - 1_200), index + 400);
}

describe("agent session credential leases (#3194)", () => {
  it("creates a per-session lease instead of reading the persistent desktop key", () => {
    const spawnBody = bodyAfter("async spawnSession(");
    expect(spawnBody).toContain("await createCredentialLease(localSessionId)");
    expect(spawnBody).not.toContain("getSerenApiKey()");
    expect(spawnBody).not.toContain("ensureApiKey()");
  });

  it("hands the spawn the broker endpoints and never a key", () => {
    const spawnBody = bodyAfter("async spawnSession(");
    expect(spawnBody).toContain("capability: lease.capability");
    expect(spawnBody).toContain("mcpUrl: lease.mcpUrl");
    expect(spawnBody).toContain("apiBaseUrl: lease.apiBaseUrl");
    expect(spawnBody).not.toContain("lease.apiKey");
    // providerService.spawnAgent takes the brokered credential in the slot the
    // raw key used to occupy.
    expect(bodyAfter("async spawnSession(", 30_000)).toMatch(
      /agentSandboxMode,\s*\n\s*serenCredential,/,
    );
  });

  it("revokes the lease in the common teardown and stale-session cleanup paths", () => {
    const teardownBody = bodyAfter("async terminateSession(");
    const resumeBody = bodyAfter("async resumeAgentConversation(");
    expect(teardownBody).toContain("await revokeCredentialLease(sessionId)");
    expect(resumeBody).toContain("await revokeCredentialLease(conversationId)");
  });

  it("covers every direct provider-runtime termination escape hatch", () => {
    expect(
      [...agentStoreSource.matchAll(/providerService\s*\.\s*terminateSession\(/g)],
    ).toHaveLength(8);
    expect(directTerminationContext("newId")).toContain(
      "await revokeCredentialLease(newId)",
    );
    expect(directTerminationContext("providerSessionId")).toContain(
      "await revokeCredentialLease(providerSessionId)",
    );
    expect(directTerminationContext("archivedSessionId")).toContain(
      "await revokeCredentialLease(archivedSessionId)",
    );
    expect(directTerminationContext("info\\.id")).toContain(
      "await revokeCredentialLease(info.id)",
    );
    expect(directTerminationContext("spawnedSessionId")).toContain(
      "await revokeCredentialLease(localSessionId)",
    );
    expect(directTerminationContext("conversationId")).toContain(
      "await revokeCredentialLease(conversationId)",
    );
    expect(directTerminationContext("sessionId")).toContain(
      "await revokeCredentialLease(sessionId)",
    );

    const deferredPromotion = directTerminationContext("servingSessionId");
    expect(deferredPromotion).toContain(
      "await this.terminateSession(servingSessionId",
    );
  });
});
