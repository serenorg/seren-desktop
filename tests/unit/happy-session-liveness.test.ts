// ABOUTME: Guards Happy liveness pulses for desktop sessions exposed to mobile.
// ABOUTME: Tracks busy state and stops the pulse when a relay entry is torn down.

import { afterEach, describe, expect, it, vi } from "vitest";

const happyLib = vi.hoisted(() => ({
  createApiClient: vi.fn(),
  configuration: {} as { serverUrl?: string },
}));

vi.mock("happy/lib", () => ({
  ApiClient: { create: happyLib.createApiClient },
  configuration: happyLib.configuration,
}));

const SYNTHETIC_ROOT = process.cwd();

// @ts-expect-error — the bridge layer is plain ESM without declarations.
import { createHappyLayer } from "../../bin/happy-bridge/happy-layer.mjs";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createClient() {
  const eventHandlers = new Map<string, () => void>();
  return {
    close: vi.fn(async () => {}),
    emit(event: string) {
      eventHandlers.get(event)?.();
    },
    keepAlive: vi.fn(),
    on: vi.fn((event: string, handler: () => void) => {
      eventHandlers.set(event, handler);
    }),
    onUserMessage: vi.fn(),
    rpcHandlerManager: { registerHandler: vi.fn() },
    sendAgentMessage: vi.fn(),
    sendSessionEvent: vi.fn(),
    sendSessionProtocolMessage: vi.fn(),
  };
}

function createLayerHarness({ initialSessions = [] }: { initialSessions?: Array<Record<string, unknown>> } = {}) {
  const client = createClient();
  let machineHandlers:
    | { spawnSession(options: Record<string, unknown>): Promise<Record<string, unknown>> }
    | undefined;
  const machineClient = {
    connect: vi.fn(),
    setRPCHandlers: vi.fn((handlers) => {
      machineHandlers = handlers;
    }),
    shutdown: vi.fn(),
    updateMachineMetadata: vi.fn(async () => {}),
  };
  const api = {
    getOrCreateMachine: vi.fn(async () => ({ id: "relay-machine" })),
    getOrCreateSession: vi.fn(async ({ metadata }: { metadata: Record<string, unknown> }) => ({
      id: "relay-session",
      metadata,
    })),
    machineSyncClient: vi.fn(() => machineClient),
    sessionSyncClient: vi.fn(() => client),
  };
  happyLib.createApiClient.mockResolvedValue(api);

  let publishProviderEvent: ((event: Record<string, unknown>) => void) | undefined;
  const source = {
    advertise: vi.fn(async () => ({ agents: [] })),
    cancel: vi.fn(async () => {}),
    listSessions: vi.fn(async () => initialSessions),
    spawn: vi.fn(async () => ({
      sessionId: "spawned-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
    })),
    subscribe: vi.fn((handler: (event: Record<string, unknown>) => void) => {
      publishProviderEvent = handler;
      return () => {};
    }),
    terminate: vi.fn(async () => {}),
  };
  const layer = createHappyLayer({
    config: {
      machineIdentity: {
        token: "test",
        machineId: "synthetic-machine",
        encryption: { type: "legacy", secret: Buffer.alloc(32).toString("base64") },
      },
      machineName: "liveness-test",
      relayUrl: "https://relay.invalid",
    },
    source,
    supervisorChannel: {
      call: vi.fn(async () => ({ conversationId: "synthetic-conversation" })),
      notify: vi.fn(),
      onNotification(handler: (method: string, params: Record<string, unknown>) => void) {
        handler("roots_update", { roots: [SYNTHETIC_ROOT] });
        return () => {};
      },
    },
  });

  return {
    api,
    client,
    layer,
    publish(event: Record<string, unknown>) {
      if (!publishProviderEvent) throw new Error("provider subscription is not ready");
      publishProviderEvent(event);
    },
    spawn(options: Record<string, unknown>) {
      if (!machineHandlers) throw new Error("machine handlers are not ready");
      return machineHandlers.spawnSession(options);
    },
    source,
  };
}

describe("Happy session liveness", () => {
  it("wires provider status into pulses and stops an entry archived from mobile", async () => {
    vi.useFakeTimers();
    const summary = {
      sessionId: "local-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic session",
      status: "ready",
    };
    const harness = createLayerHarness({ initialSessions: [summary] });

    await harness.layer.start();
    expect(harness.client.keepAlive).toHaveBeenCalledWith(false, "remote");
    vi.advanceTimersByTime(2_000);
    expect(harness.client.keepAlive).toHaveBeenCalledTimes(2);

    harness.publish({
      kind: "status",
      sessionId: "local-session",
      payload: { status: "busy" },
    });
    await vi.waitFor(() => {
      expect(harness.client.keepAlive).toHaveBeenLastCalledWith(true, "remote");
    });
    const busyPulseAt = harness.client.keepAlive.mock.calls.length;
    vi.advanceTimersByTime(2_000);
    expect(harness.client.keepAlive).toHaveBeenCalledTimes(busyPulseAt + 1);
    expect(harness.client.keepAlive).toHaveBeenLastCalledWith(true, "remote");

    let resolveClientClose: (() => void) | undefined;
    harness.client.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClientClose = resolve;
        }),
    );
    harness.client.emit("archived");
    const stoppedAt = harness.client.keepAlive.mock.calls.length;
    vi.advanceTimersByTime(4_000);
    expect(harness.client.keepAlive).toHaveBeenCalledTimes(stoppedAt);
    harness.publish({
      kind: "status",
      sessionId: "local-session",
      payload: { status: "ready" },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(1);
    expect(harness.source.terminate).toHaveBeenCalledWith("local-session");

    let layerClosed = false;
    const close = harness.layer.close().then(() => {
      layerClosed = true;
    });
    await Promise.resolve();
    expect(layerClosed).toBe(false);
    resolveClientClose?.();
    await close;
    expect(harness.client.close).toHaveBeenCalledTimes(1);
  });

  it("does not start a pulse when a relay lookup finishes after shutdown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const summary = {
      sessionId: "late-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Late synthetic session",
      status: "ready",
    };
    const harness = createLayerHarness();
    await harness.layer.start();

    harness.source.listSessions.mockResolvedValue([summary]);
    let resolveLookupStarted: (() => void) | undefined;
    const lookupStarted = new Promise<void>((resolve) => {
      resolveLookupStarted = resolve;
    });
    let resolveSession: ((session: Record<string, unknown>) => void) | undefined;
    harness.api.getOrCreateSession.mockImplementation(
      ({ metadata }: { metadata: Record<string, unknown> }) => {
        resolveLookupStarted?.();
        return new Promise((resolve) => {
          resolveSession = () => resolve({ id: "late-relay-session", metadata });
        });
      },
    );
    vi.setSystemTime(1_001);
    harness.publish({
      kind: "status",
      sessionId: "late-session",
      payload: { status: "ready" },
    });
    await lookupStarted;

    await harness.layer.close();
    resolveSession?.({});
    await Promise.resolve();
    await Promise.resolve();

    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(harness.client.keepAlive).not.toHaveBeenCalled();
  });

  it("terminates a provider whose spawn resolves after layer shutdown", async () => {
    vi.useFakeTimers();
    const harness = createLayerHarness();
    await harness.layer.start();

    let resolveSpawn: ((session: Record<string, unknown>) => void) | undefined;
    const spawnStarted = new Promise<void>((resolveStarted) => {
      harness.source.spawn.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSpawn = resolve;
            resolveStarted();
          }),
      );
    });
    const result = harness.spawn({ directory: SYNTHETIC_ROOT, agent: "codex" });
    await spawnStarted;
    await harness.layer.close();

    resolveSpawn?.({
      sessionId: "late-provider-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
    });
    await expect(result).resolves.toEqual({
      type: "error",
      errorMessage: "Happy session closed during provider spawn",
    });
    expect(harness.source.terminate).toHaveBeenCalledWith("late-provider-session");
    expect(harness.client.close).toHaveBeenCalledTimes(1);
  });
});
