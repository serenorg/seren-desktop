import { onRuntimeEvent } from "@/lib/browser-local-runtime";
import {
  subscribeToAllEvents,
  subscribeToSession,
  type UnlistenFn,
} from "@/services/providers";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/browser-local-runtime", () => ({
  isLocalProviderRuntime: vi.fn(() => true),
  onRuntimeEvent: vi.fn(),
  runtimeInvoke: vi.fn(),
}));

const onRuntimeEventMock = vi.mocked(onRuntimeEvent);

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
    expect(onRuntimeEventMock).toHaveBeenCalledTimes(12);

    dispose();
    expect(unlisteners).toHaveLength(12);
    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("cleans up every registered session listener when any registration fails", async () => {
    const unlisteners = mockRuntimeSubscriptions(7);

    await expectAggregateError(subscribeToSession("session-1", vi.fn()));

    expect(onRuntimeEventMock).toHaveBeenCalledTimes(12);
    expect(unlisteners).toHaveLength(11);
    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("registers all global listeners before resolving and disposes them together", async () => {
    const unlisteners = mockRuntimeSubscriptions();

    const dispose = await subscribeToAllEvents(vi.fn());
    expect(onRuntimeEventMock).toHaveBeenCalledTimes(13);

    dispose();
    expect(unlisteners).toHaveLength(13);
    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });

  it("cleans up every registered global listener when any registration fails", async () => {
    const unlisteners = mockRuntimeSubscriptions(7);

    await expectAggregateError(subscribeToAllEvents(vi.fn()));

    expect(onRuntimeEventMock).toHaveBeenCalledTimes(13);
    expect(unlisteners).toHaveLength(12);
    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });
});
