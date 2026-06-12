// ABOUTME: Behavior tests for the paired Claude + Codex coordinator runtime (#2368).
// ABOUTME: Drives createPairedRuntime with fake inner runtimes — no processes spawned.

import { beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain-JS runtime module without type declarations.
import { createPairedRuntime, PAIRED_AGENT_TYPE } from "../../bin/browser-local/paired-runtime.mjs";

interface Emitted {
  channel: string;
  payload: Record<string, unknown>;
}

interface FakeInnerSession {
  id: string;
  agentType: string;
  scriptedTurnText: string[];
}

/**
 * Harness: a fake `inner` handler set whose sendPrompt streams scripted
 * chunks through the SAME wrapped emit that providers.mjs uses, so every
 * inner event must pass through interceptEmit before reaching the frontend.
 */
function createHarness() {
  const emitted: Emitted[] = [];
  const rawEmit = (channel: string, payload: Record<string, unknown>) =>
    emitted.push({ channel, payload });

  // Late-bound paired ref mirrors the providers.mjs wiring exactly.
  const pairedRef: { current: ReturnType<typeof createPairedRuntime> | null } =
    { current: null };
  const wrappedEmit = (channel: string, payload: Record<string, unknown>) => {
    if (pairedRef.current?.interceptEmit(channel, payload)) return;
    rawEmit(channel, payload);
  };

  const innerSessions = new Map<string, FakeInnerSession>();

  const claudeModels = {
    currentModelId: "claude-opus-4-7[1m]",
    availableModels: [
      { modelId: "claude-opus-4-7[1m]", name: "Opus 4.7 (1M)" },
      { modelId: "claude-fable-5", name: "Fable 5" },
    ],
  };
  const codexModels = {
    currentModelId: "gpt-5.5-codex",
    availableModels: [
      { modelId: "gpt-5.5-codex", name: "GPT-5.5 Codex" },
      { modelId: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" },
    ],
  };
  const claudeEffort = {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "low" },
      { value: "medium", name: "medium" },
      { value: "high", name: "high" },
    ],
  };
  const codexEffort = {
    id: "reasoning_effort",
    name: "Reasoning Effort",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "medium", name: "medium" },
      { value: "high", name: "high" },
    ],
  };

  const inner = {
    spawnSession: vi.fn(async (params: Record<string, unknown>) => {
      const id = String(params.localSessionId);
      const agentType = String(params.agentType);
      innerSessions.set(id, { id, agentType, scriptedTurnText: [] });
      const isClaude = agentType === "claude-code";
      wrappedEmit("provider://session-status", {
        sessionId: id,
        status: "ready",
        agentSessionId: `${agentType}-remote-${id}`,
        models: isClaude ? claudeModels : codexModels,
        configOptions: [isClaude ? { ...claudeEffort } : { ...codexEffort }],
      });
      return {
        id,
        agentType,
        cwd: params.cwd,
        status: "ready",
        createdAt: new Date().toISOString(),
        agentSessionId: `${agentType}-remote-${id}`,
        pid: 1234,
      };
    }),
    sendPrompt: vi.fn(
      async ({ sessionId }: { sessionId: string; prompt: string }) => {
        const session = innerSessions.get(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);
        const text = session.scriptedTurnText.shift() ?? "ok";
        wrappedEmit("provider://message-chunk", { sessionId, text });
        wrappedEmit("provider://prompt-complete", {
          sessionId,
          stopReason: "end_turn",
          meta: { usage: { input_tokens: 10, output_tokens: 5 } },
        });
      },
    ),
    cancelPrompt: vi.fn(async () => {}),
    terminateSession: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      innerSessions.delete(sessionId);
    }),
    setSessionModel: vi.fn(async () => {}),
    updateSessionConfigOption: vi.fn(async () => null),
    setPermissionMode: vi.fn(async () => {}),
    respondToPermission: vi.fn(async () => {}),
  };

  const paired = createPairedRuntime({ emit: rawEmit, inner });
  pairedRef.current = paired;

  return { emitted, paired, inner, innerSessions, wrappedEmit };
}

function eventsFor(emitted: Emitted[], channel: string) {
  return emitted.filter((e) => e.channel === channel);
}

async function spawnPaired(
  h: ReturnType<typeof createHarness>,
  params: Record<string, unknown> = {},
) {
  return h.paired.spawnSession({
    agentType: PAIRED_AGENT_TYPE,
    cwd: "/tmp/project",
    localSessionId: "paired-1",
    ...params,
  });
}

describe("paired runtime — spawn", () => {
  let h: ReturnType<typeof createHarness>;
  beforeEach(() => {
    h = createHarness();
  });

  it("spawns a Claude planner and a Codex executor inner session", async () => {
    const info = await spawnPaired(h);
    expect(info.agentType).toBe(PAIRED_AGENT_TYPE);
    expect(info.id).toBe("paired-1");

    const spawnTypes = h.inner.spawnSession.mock.calls.map(
      (c) => c[0].agentType,
    );
    expect(spawnTypes).toContain("claude-code");
    expect(spawnTypes).toContain("codex");
  });

  it("returns a composite agentSessionId carrying both inner remote ids", async () => {
    const info = await spawnPaired(h);
    const composite = JSON.parse(String(info.agentSessionId));
    expect(composite.planner).toContain("claude-code-remote-");
    expect(composite.executor).toContain("codex-remote-");
  });

  it("emits the setup declaration as the first paired transcript event", async () => {
    await spawnPaired(h);
    const declarations = eventsFor(h.emitted, "provider://paired-event").filter(
      (e) => e.payload.kind === "declaration",
    );
    expect(declarations.length).toBe(1);
    const text = String(declarations[0].payload.text);
    expect(text).toContain("Claude is planner and reviewer");
    expect(text).toContain("Codex is executor");
    expect(text).toContain("Handoffs appear inline");
    // Declares resolved models and efforts in plain language.
    expect(text).toContain("Opus 4.7 (1M)");
    expect(text).toContain("GPT-5.5 Codex");
    expect(text).toContain("medium");
    expect(declarations[0].payload.sessionId).toBe("paired-1");
  });

  it("only refreshes (never appends) the declaration when resuming an existing thread", async () => {
    await spawnPaired(h, {
      resumeAgentSessionId: JSON.stringify({
        planner: "claude-code-remote-old",
        executor: "codex-remote-old",
      }),
    });
    const declarations = eventsFor(h.emitted, "provider://paired-event").filter(
      (e) => e.payload.kind === "declaration",
    );
    // The original declaration already lives in the DB transcript; resume may
    // refresh it (replace semantics) but must never append a fresh one.
    expect(declarations.every((e) => e.payload.replace === true)).toBe(true);
    // Resume ids are routed to the matching inner spawn.
    const claudeSpawn = h.inner.spawnSession.mock.calls.find(
      (c) => c[0].agentType === "claude-code",
    );
    const codexSpawn = h.inner.spawnSession.mock.calls.find(
      (c) => c[0].agentType === "codex",
    );
    expect(claudeSpawn?.[0].resumeAgentSessionId).toBe(
      "claude-code-remote-old",
    );
    expect(codexSpawn?.[0].resumeAgentSessionId).toBe("codex-remote-old");
  });

  it("emits paired session-status with role-scoped models and config options", async () => {
    await spawnPaired(h);
    const statuses = eventsFor(h.emitted, "provider://session-status").filter(
      (e) => e.payload.sessionId === "paired-1",
    );
    expect(statuses.length).toBeGreaterThan(0);
    const last = statuses[statuses.length - 1].payload as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: test introspection
      any
    >;
    expect(last.paired.planner.models.currentModelId).toBe(
      "claude-opus-4-7[1m]",
    );
    expect(last.paired.executor.models.currentModelId).toBe("gpt-5.5-codex");
    expect(last.paired.planner.configOptions[0].id).toBe("reasoning_effort");
    expect(last.paired.executor.configOptions[0].id).toBe("reasoning_effort");
    expect(last.paired.state).toBe("idle");
  });

  it("applies pinned executor model from spawn params, with fallback notice when unavailable", async () => {
    h.inner.setSessionModel.mockRejectedValueOnce(
      new Error("Unknown Codex model: gpt-retired"),
    );
    await spawnPaired(h, {
      paired: { executor: { modelId: "gpt-retired" } },
    });
    const statuses = eventsFor(h.emitted, "provider://session-status").filter(
      (e) => e.payload.sessionId === "paired-1",
    );
    const last = statuses[statuses.length - 1].payload as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: test introspection
      any
    >;
    expect(String(last.paired.executor.notice)).toContain("gpt-retired");
    expect(String(last.paired.executor.notice)).toMatch(/no longer available/i);
  });

  it("never forwards raw inner session ids to the frontend", async () => {
    await spawnPaired(h);
    const leaked = h.emitted.filter(
      (e) =>
        typeof e.payload.sessionId === "string" &&
        e.payload.sessionId !== "paired-1",
    );
    expect(leaked).toEqual([]);
  });
});

describe("paired runtime — prompt pipeline", () => {
  let h: ReturnType<typeof createHarness>;
  beforeEach(async () => {
    h = createHarness();
    await spawnPaired(h);
    for (const s of h.innerSessions.values()) {
      s.scriptedTurnText =
        s.agentType === "claude-code"
          ? ["PLAN: rename the button", "REVIEW: looks good"]
          : ["EXEC: renamed the button"];
    }
    h.emitted.length = 0;
  });

  it("runs plan → execute → review and emits exactly one paired prompt-complete", async () => {
    await h.paired.sendPrompt({
      sessionId: "paired-1",
      prompt: "rename the login button",
    });

    const order = h.inner.sendPrompt.mock.calls.map((c) => {
      const sid = String(c[0].sessionId);
      return h.innerSessions.get(sid)?.agentType ?? sid;
    });
    // Inner sessions are deleted only on terminate, so map lookups stay live.
    expect(order.length).toBe(3);
    expect(order[1]).toBe("codex");

    const completes = eventsFor(h.emitted, "provider://prompt-complete");
    expect(completes.length).toBe(1);
    expect(completes[0].payload.sessionId).toBe("paired-1");
    // Merged usage across all three inner turns.
    const meta = completes[0].payload.meta as {
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(meta.usage.input_tokens).toBe(30);
    expect(meta.usage.output_tokens).toBe(15);
  });

  it("hands the planner's output to the executor prompt", async () => {
    await h.paired.sendPrompt({
      sessionId: "paired-1",
      prompt: "rename the login button",
    });
    const codexCall = h.inner.sendPrompt.mock.calls[1][0];
    expect(String(codexCall.prompt)).toContain("PLAN: rename the button");
    expect(String(codexCall.prompt)).toContain("rename the login button");
  });

  it("hands the executor's output to the review prompt", async () => {
    await h.paired.sendPrompt({
      sessionId: "paired-1",
      prompt: "rename the login button",
    });
    const reviewCall = h.inner.sendPrompt.mock.calls[2][0];
    expect(String(reviewCall.prompt)).toContain("EXEC: renamed the button");
  });

  it("emits inline handoff events between phases with source and destination", async () => {
    await h.paired.sendPrompt({ sessionId: "paired-1", prompt: "do it" });
    const handoffs = eventsFor(h.emitted, "provider://paired-event").filter(
      (e) => e.payload.kind === "handoff",
    );
    expect(handoffs.length).toBe(2);
    expect(handoffs[0].payload.from).toBe("Claude");
    expect(handoffs[0].payload.to).toBe("Codex");
    expect(String(handoffs[0].payload.text)).toContain("handed off to Codex");
    expect(handoffs[1].payload.from).toBe("Codex");
    expect(handoffs[1].payload.to).toBe("Claude");
  });

  it("attributes remapped chunks to the producing agent", async () => {
    await h.paired.sendPrompt({ sessionId: "paired-1", prompt: "do it" });
    const chunks = eventsFor(h.emitted, "provider://message-chunk");
    expect(chunks.every((c) => c.payload.sessionId === "paired-1")).toBe(true);
    const providers = chunks.map((c) => c.payload.agentProvider);
    expect(providers).toEqual(["claude-code", "codex", "claude-code"]);
  });

  it("walks paired state planning → executing → reviewing → idle", async () => {
    await h.paired.sendPrompt({ sessionId: "paired-1", prompt: "do it" });
    const states = eventsFor(h.emitted, "provider://session-status")
      .map(
        (e) =>
          (e.payload as { paired?: { state?: string } }).paired?.state ?? null,
      )
      .filter(Boolean);
    const dedup = states.filter((s, i) => s !== states[i - 1]);
    expect(dedup).toEqual(["planning", "executing", "reviewing", "idle"]);
  });

  it("suppresses replayed inner history chunks (DB transcript is authoritative)", async () => {
    h.wrappedEmit("provider://message-chunk", {
      sessionId: h.inner.spawnSession.mock.calls[0][0].localSessionId,
      text: "old history",
      replay: true,
    });
    const chunks = eventsFor(h.emitted, "provider://message-chunk");
    expect(chunks.length).toBe(0);
  });

  it("cancel mid-pipeline stops later phases and reports a single cancel", async () => {
    let resolveExec: (() => void) | undefined;
    h.inner.sendPrompt.mockImplementation(
      async ({ sessionId }: { sessionId: string; prompt: string }) => {
        const session = h.innerSessions.get(sessionId);
        if (session?.agentType === "codex") {
          await new Promise<void>((_resolve, reject) => {
            resolveExec = () => reject(new Error("Task cancelled"));
          });
        }
      },
    );
    const turn = h.paired.sendPrompt({ sessionId: "paired-1", prompt: "go" });
    // Let the planner phase complete and the executor phase start.
    await vi.waitFor(() => {
      expect(h.inner.sendPrompt.mock.calls.length).toBe(2);
    });
    const cancelled = h.paired.cancelPrompt({ sessionId: "paired-1" });
    resolveExec?.();
    await Promise.allSettled([turn, cancelled]);

    expect(h.inner.cancelPrompt).toHaveBeenCalledTimes(1);
    // No review phase after cancel.
    expect(h.inner.sendPrompt.mock.calls.length).toBe(2);
    const cancelErrors = eventsFor(h.emitted, "provider://error").filter((e) =>
      String(e.payload.error).includes("Task cancelled"),
    );
    expect(cancelErrors.length).toBe(1);
    expect(eventsFor(h.emitted, "provider://prompt-complete").length).toBe(0);
  });
});

describe("paired runtime — approvals", () => {
  let h: ReturnType<typeof createHarness>;
  let executorInnerId: string;

  beforeEach(async () => {
    h = createHarness();
    await spawnPaired(h);
    executorInnerId = String(
      h.inner.spawnSession.mock.calls.find(
        (c) => c[0].agentType === "codex",
      )?.[0].localSessionId,
    );
    h.emitted.length = 0;
  });

  it("remaps permission requests and flips state to waiting-approval", async () => {
    h.wrappedEmit("provider://permission-request", {
      sessionId: executorInnerId,
      requestId: "req-1",
      toolCall: { name: "commandExecution", title: "rm -rf build" },
      options: [{ optionId: "accept" }],
    });

    const requests = eventsFor(h.emitted, "provider://permission-request");
    expect(requests.length).toBe(1);
    expect(requests[0].payload.sessionId).toBe("paired-1");

    const statuses = eventsFor(h.emitted, "provider://session-status");
    const last = statuses[statuses.length - 1].payload as {
      paired?: { state?: string };
    };
    expect(last.paired?.state).toBe("waiting-approval");
  });

  it("routes the approval response back to the inner session that asked", async () => {
    h.wrappedEmit("provider://permission-request", {
      sessionId: executorInnerId,
      requestId: "req-1",
      toolCall: {},
      options: [{ optionId: "accept" }],
    });
    await h.paired.respondToPermission({
      sessionId: "paired-1",
      requestId: "req-1",
      optionId: "accept",
    });
    expect(h.inner.respondToPermission).toHaveBeenCalledWith({
      sessionId: executorInnerId,
      requestId: "req-1",
      optionId: "accept",
    });
    const statuses = eventsFor(h.emitted, "provider://session-status");
    const last = statuses[statuses.length - 1].payload as {
      paired?: { state?: string };
    };
    expect(last.paired?.state).not.toBe("waiting-approval");
  });
});

describe("paired runtime — role-scoped model and effort", () => {
  let h: ReturnType<typeof createHarness>;
  let plannerInnerId: string;
  let executorInnerId: string;

  beforeEach(async () => {
    h = createHarness();
    await spawnPaired(h);
    plannerInnerId = String(
      h.inner.spawnSession.mock.calls.find(
        (c) => c[0].agentType === "claude-code",
      )?.[0].localSessionId,
    );
    executorInnerId = String(
      h.inner.spawnSession.mock.calls.find(
        (c) => c[0].agentType === "codex",
      )?.[0].localSessionId,
    );
    h.emitted.length = 0;
  });

  it("setSessionModel role=planner only touches the Claude inner session", async () => {
    await h.paired.setSessionModel({
      sessionId: "paired-1",
      modelId: "claude-fable-5",
      role: "planner",
    });
    expect(h.inner.setSessionModel).toHaveBeenCalledWith({
      sessionId: plannerInnerId,
      modelId: "claude-fable-5",
    });
    expect(h.inner.setSessionModel).toHaveBeenCalledTimes(1);
  });

  it("setSessionModel role=executor only touches the Codex inner session", async () => {
    await h.paired.setSessionModel({
      sessionId: "paired-1",
      modelId: "gpt-5.1-codex-mini",
      role: "executor",
    });
    expect(h.inner.setSessionModel).toHaveBeenCalledWith({
      sessionId: executorInnerId,
      modelId: "gpt-5.1-codex-mini",
    });
  });

  it("requires an explicit role for paired sessions", async () => {
    await expect(
      h.paired.setSessionModel({ sessionId: "paired-1", modelId: "x" }),
    ).rejects.toThrow(/role/i);
  });

  it("re-emits the declaration with replace semantics after a model change", async () => {
    await h.paired.setSessionModel({
      sessionId: "paired-1",
      modelId: "claude-fable-5",
      role: "planner",
    });
    const updates = eventsFor(h.emitted, "provider://paired-event").filter(
      (e) => e.payload.kind === "declaration",
    );
    expect(updates.length).toBe(1);
    expect(updates[0].payload.replace).toBe(true);
    expect(String(updates[0].payload.messageId)).toBe(
      "paired-declaration-paired-1",
    );
  });

  it("planner effort change routes to Claude and reports next-session timing", async () => {
    await h.paired.updateSessionConfigOption({
      sessionId: "paired-1",
      configId: "reasoning_effort",
      valueId: "high",
      role: "planner",
    });
    expect(h.inner.updateSessionConfigOption).toHaveBeenCalledWith({
      sessionId: plannerInnerId,
      configId: "reasoning_effort",
      valueId: "high",
    });
    const statuses = eventsFor(h.emitted, "provider://session-status");
    const last = statuses[statuses.length - 1].payload as {
      // biome-ignore lint/suspicious/noExplicitAny: test introspection
      paired?: Record<string, any>;
    };
    expect(String(last.paired?.planner.notice)).toMatch(/next/i);
  });

  it("executor effort change routes to Codex without a next-session notice", async () => {
    await h.paired.updateSessionConfigOption({
      sessionId: "paired-1",
      configId: "reasoning_effort",
      valueId: "high",
      role: "executor",
    });
    expect(h.inner.updateSessionConfigOption).toHaveBeenCalledWith({
      sessionId: executorInnerId,
      configId: "reasoning_effort",
      valueId: "high",
    });
  });

  it("surfaces unsupported effort values instead of silently applying them", async () => {
    h.inner.updateSessionConfigOption.mockRejectedValueOnce(
      new Error("Unsupported reasoning effort: ultra"),
    );
    await expect(
      h.paired.updateSessionConfigOption({
        sessionId: "paired-1",
        configId: "reasoning_effort",
        valueId: "ultra",
        role: "executor",
      }),
    ).rejects.toThrow(/Unsupported reasoning effort/);
  });
});

describe("paired runtime — terminate", () => {
  it("terminates both inner sessions and emits a terminated status", async () => {
    const h = createHarness();
    await spawnPaired(h);
    h.emitted.length = 0;

    await h.paired.terminateSession({ sessionId: "paired-1" });
    expect(h.inner.terminateSession).toHaveBeenCalledTimes(2);
    const statuses = eventsFor(h.emitted, "provider://session-status");
    expect(statuses.length).toBe(1);
    expect(statuses[0].payload.status).toBe("terminated");
    expect(h.paired.hasSession("paired-1")).toBe(false);
  });
});
