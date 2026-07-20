import { onRuntimeEvent } from "@/lib/browser-local-runtime";
import {
  pairedSpawnConfigFromStatus,
  subscribeToAllEvents,
  subscribeToSession,
  supportsConversationFork,
  supportsNativeProviderFork,
  type AgentType,
  type PairedStatus,
  type UnlistenFn,
} from "@/services/providers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/browser-local-runtime", () => ({
  isLocalProviderRuntime: vi.fn(() => true),
  onRuntimeEvent: vi.fn(),
  runtimeInvoke: vi.fn(),
}));

const onRuntimeEventMock = vi.mocked(onRuntimeEvent);

describe("provider fork capabilities", () => {
  it("supports conversation branches for every desktop agent type", () => {
    const agentTypes: AgentType[] = [
      "claude-code",
      "codex",
      "gemini",
      "grok",
      "claude-codex",
      "lmstudio",
    ];

    expect(agentTypes.every(supportsConversationFork)).toBe(true);
    expect(agentTypes.filter(supportsNativeProviderFork)).toEqual([
      "claude-code",
    ]);
  });

  it("copies explicit paired role pins into a fresh-session config", () => {
    const paired = {
      state: "idle",
      activeRole: null,
      planner: {
        role: "planner",
        label: "Claude",
        agentType: "claude-code",
        defaultModelLabel: "Claude Default",
        pinnedModelId: "planner-model",
        pinnedEffort: "high",
      },
      executor: {
        role: "executor",
        label: "Codex",
        agentType: "codex",
        defaultModelLabel: "Codex Recommended",
        pinnedModelId: "executor-model",
        pinnedEffort: "medium",
        pinnedServiceTier: "fast",
      },
    } satisfies PairedStatus;

    expect(pairedSpawnConfigFromStatus(paired)).toEqual({
      planner: { modelId: "planner-model", effort: "high" },
      executor: {
        modelId: "executor-model",
        effort: "medium",
        serviceTier: "fast",
      },
    });
  });
});

function mockRuntimeSubscriptions(failOnCall?: number) {
  const unlisteners: Array<ReturnType<typeof vi.fn>> = [];
  let callCount = 0;

  onRuntimeEventMock.mockImplementation((): UnlistenFn => {
    callCount += 1;
    if (callCount === failOnCall) {
      throw new Error(`subscribe ${callCount} failed`);
    }

    const unlisten = vi.fn();
    unlisteners.push(unlisten);
    return unlisten;
  });

  return unlisteners;
}

async function expectAggregateError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({
      message: "Failed to subscribe to runtime events",
    });
    return;
  }

  throw new Error("Expected subscription to reject");
}

describe("provider runtime event subscriptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers all session listeners before resolving and disposes them together", async () => {
    const unlisteners = mockRuntimeSubscriptions();

    const dispose = await subscribeToSession("session-1", vi.fn());
    expect(onRuntimeEventMock).toHaveBeenCalledTimes(16);

    dispose();
    expect(unlisteners).toHaveLength(16);
    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("cleans up every registered session listener when any registration fails", async () => {
    const unlisteners = mockRuntimeSubscriptions(7);

    await expectAggregateError(subscribeToSession("session-1", vi.fn()));

    expect(onRuntimeEventMock).toHaveBeenCalledTimes(16);
    expect(unlisteners).toHaveLength(15);
    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("registers all global listeners before resolving and disposes them together", async () => {
    const unlisteners = mockRuntimeSubscriptions();

    const dispose = await subscribeToAllEvents(vi.fn());
    expect(onRuntimeEventMock).toHaveBeenCalledTimes(17);

    dispose();
    expect(unlisteners).toHaveLength(17);
    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("cleans up every registered global listener when any registration fails", async () => {
    const unlisteners = mockRuntimeSubscriptions(7);

    await expectAggregateError(subscribeToAllEvents(vi.fn()));

    expect(onRuntimeEventMock).toHaveBeenCalledTimes(17);
    expect(unlisteners).toHaveLength(16);
    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });
});
