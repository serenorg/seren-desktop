// ABOUTME: Verifies FIFO admission and capacity limits for local Claude sessions.
// ABOUTME: Covers queued positions, idempotent release, and release-driven progress.

import { describe, expect, it } from "vitest";
// @ts-expect-error — the browser-local admission module is plain ESM without declarations.
import { createAdmissionGate } from "../../bin/browser-local/session-admission.mjs";

describe("session admission gate", () => {
  it("respects the configured cap under concurrent acquires", async () => {
    const gate = createAdmissionGate({ limit: 2 });
    await gate.acquire("a");
    await gate.acquire("b");
    let thirdResolved = false;
    const third = gate.acquire("c").then(() => {
      thirdResolved = true;
    });

    expect(gate.activeCount()).toBe(2);
    expect(gate.pendingCount()).toBe(1);
    expect(thirdResolved).toBe(false);

    gate.release("a");
    await third;
    expect(gate.activeCount()).toBe(2);
    expect(gate.pendingCount()).toBe(0);
  });

  it("preserves FIFO order for queued sessions", async () => {
    const order: string[] = [];
    const gate = createAdmissionGate({ limit: 1 });
    await gate.acquire("a");
    const b = gate.acquire("b").then(() => order.push("b"));
    const c = gate.acquire("c").then(() => order.push("c"));
    const d = gate.acquire("d").then(() => order.push("d"));

    gate.release("a");
    await b;
    expect(order).toEqual(["b"]);
    gate.release("b");
    await c;
    expect(order).toEqual(["b", "c"]);
    gate.release("c");
    await d;
    expect(order).toEqual(["b", "c", "d"]);
  });

  it("release unblocks exactly the next waiter", async () => {
    const gate = createAdmissionGate({ limit: 1 });
    await gate.acquire("a");
    let bResolved = false;
    let cResolved = false;
    const b = gate.acquire("b").then(() => {
      bResolved = true;
    });
    const c = gate.acquire("c").then(() => {
      cResolved = true;
    });

    gate.release("a");
    await b;
    expect(bResolved).toBe(true);
    expect(cResolved).toBe(false);
    expect(gate.pendingCount()).toBe(1);

    gate.release("b");
    await c;
    expect(cResolved).toBe(true);
  });

  it("release is idempotent per session", async () => {
    const gate = createAdmissionGate({ limit: 1 });
    await gate.acquire("a");
    expect(gate.release("a")).toBe(true);
    expect(gate.release("a")).toBe(false);
    expect(gate.activeCount()).toBe(0);
  });

  it("reports queued positions", async () => {
    const queued: Array<[string, number]> = [];
    const gate = createAdmissionGate({
      limit: 1,
      onQueued(sessionId: string, position: number) {
        queued.push([sessionId, position]);
      },
    });
    await gate.acquire("a");
    const b = gate.acquire("b");
    const c = gate.acquire("c");

    expect(queued).toEqual([
      ["b", 1],
      ["c", 2],
    ]);

    gate.release("a");
    await b;
    gate.release("b");
    await c;
  });
});
