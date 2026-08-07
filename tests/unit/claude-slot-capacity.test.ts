// ABOUTME: Protects Claude admission-slot accounting against the #3727 split-brain.
// ABOUTME: Covers gate introspection, paired planner attribution, and capacity backpressure.

import { describe, expect, it } from "vitest";
// @ts-expect-error — the browser-local admission module is plain ESM without declarations.
import { createAdmissionGate } from "../../bin/browser-local/session-admission.mjs";

/**
 * The frontend used to infer Claude capacity from its own session map, which
 * cannot see a paired thread's inner planner or a queued spawn. The gate is
 * now the single source of truth, so it must report *who* holds a slot — not
 * just how many are held. #3727.
 */
describe("admission gate capacity introspection", () => {
  it("reports the limit and the identity of every slot holder", async () => {
    const gate = createAdmissionGate({ limit: 2 });
    await gate.acquire("planner-a");
    await gate.acquire("solo-b");

    expect(gate.limit).toBe(2);
    expect(gate.activeIds().sort()).toEqual(["planner-a", "solo-b"]);
    expect(gate.pendingIds()).toEqual([]);
  });

  it("reports queued session ids in FIFO order so a queue is diagnosable", async () => {
    const gate = createAdmissionGate({ limit: 1, acquireTimeoutMs: 50_000 });
    await gate.acquire("holder");
    const queued = [
      gate.acquire("waiter-1").catch(() => {}),
      gate.acquire("waiter-2").catch(() => {}),
    ];

    expect(gate.activeIds()).toEqual(["holder"]);
    expect(gate.pendingIds()).toEqual(["waiter-1", "waiter-2"]);

    // A released holder must hand the slot to the head of the queue, and the
    // reported queue must shrink accordingly.
    gate.release("holder");
    await queued[0];
    expect(gate.activeIds()).toEqual(["waiter-1"]);
    expect(gate.pendingIds()).toEqual(["waiter-2"]);

    gate.release("waiter-1");
    await queued[1];
    expect(gate.activeIds()).toEqual(["waiter-2"]);
    gate.release("waiter-2");
  });

  it("drops a cancelled spawn out of the reported queue", async () => {
    const gate = createAdmissionGate({ limit: 1, acquireTimeoutMs: 50_000 });
    await gate.acquire("holder");
    const abandoned = gate.acquire("abandoned").catch(() => "cancelled");

    expect(gate.pendingIds()).toEqual(["abandoned"]);
    gate.release("abandoned");

    await expect(abandoned).resolves.toBe("cancelled");
    expect(gate.pendingIds()).toEqual([]);
    // The holder still holds; cancelling a waiter must not free a slot.
    expect(gate.activeIds()).toEqual(["holder"]);
  });
});

/**
 * The captured failure: a paired `claude-codex` spawn died with
 * "Timed out after 110000ms waiting for a local Claude session slot" because
 * nothing on the frontend side knew a paired thread consumes a Claude slot.
 */
describe("claude capacity error classification", () => {
  // Mirrors `isClaudeCapacityError` in the agent store. Kept as an explicit
  // contract test because the gate owns the wording: if the gate's message
  // changes, backpressure silently degrades back to a terminal spawn error.
  const isClaudeCapacityError = (message: string) =>
    message.toLowerCase().includes("waiting for a local claude session slot");

  it("matches the exact message the admission gate produces on timeout", async () => {
    const gate = createAdmissionGate({ limit: 1, acquireTimeoutMs: 10 });
    await gate.acquire("holder");

    const rejection = await gate
      .acquire("late")
      .then(() => null)
      .catch((error: Error) => error);

    expect(rejection).toBeInstanceOf(Error);
    expect(isClaudeCapacityError((rejection as Error).message)).toBe(true);
  });

  it("does not classify an unrelated spawn failure as capacity pressure", () => {
    expect(isClaudeCapacityError("Claude CLI exited with code 1")).toBe(false);
    expect(
      isClaudeCapacityError("timed out waiting for claude control request initialize"),
    ).toBe(false);
  });
});
