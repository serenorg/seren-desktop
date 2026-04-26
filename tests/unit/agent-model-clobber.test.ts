// ABOUTME: Guards against a regression where stale sessionStatus frames clobber
// ABOUTME: the user-selected model. See issue #1670.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const agentStoreSource = readFileSync(
  resolve("src/stores/agent.store.ts"),
  "utf-8",
);

describe("model selector clobber race (issue #1670)", () => {
  it("declares pendingModelId on the session type", () => {
    expect(agentStoreSource).toContain("pendingModelId?: string");
  });

  it("setModel writes pendingModelId before the IPC call", () => {
    const setMarker = 'setState("sessions", sessionId, "pendingModelId", modelId)';
    const ipcMarker = "await providerService.setModel(sessionId, modelId)";
    const setIdx = agentStoreSource.indexOf(setMarker);
    const ipcIdx = agentStoreSource.indexOf(ipcMarker);
    expect(setIdx).toBeGreaterThan(-1);
    expect(ipcIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeLessThan(ipcIdx);
  });

  it("sessionStatus handler guards currentModelId on pendingModelId", () => {
    expect(agentStoreSource).toContain(
      "const pending = state.sessions[sessionId]?.pendingModelId",
    );
    expect(agentStoreSource).toContain(
      "if (!pending || pending === models.currentModelId)",
    );
  });

  it("sessionStatus handler clears pendingModelId on ack", () => {
    expect(agentStoreSource).toContain(
      'setState("sessions", sessionId, "pendingModelId", undefined)',
    );
  });
});
