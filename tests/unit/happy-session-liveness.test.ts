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
  const eventHandlers = new Map<string, (...args: unknown[]) => void>();
  let archiveSignaled = false;
  let userMessageHandler:
    | ((message: Record<string, unknown>) => void | Promise<void>)
    | undefined;
  let fileEventHandler:
    | ((message: Record<string, unknown>) => void | Promise<void>)
    | undefined;
  const rpcHandlers = new Map<
    string,
    (payload: Record<string, unknown> | null) => unknown
  >();
  return {
    close: vi.fn(async () => {}),
    emit(event: string) {
      if (event === "archived") archiveSignaled = true;
      eventHandlers.get(event)?.();
    },
    hasArchiveSignal() {
      return archiveSignaled;
    },
    async dispatchUserMessage(message: Record<string, unknown>) {
      if (!userMessageHandler) throw new Error("Happy user-message handler is not registered");
      await userMessageHandler(message);
    },
    async dispatchFileEvent(message: Record<string, unknown>) {
      if (!fileEventHandler) throw new Error("Happy file-event handler is not registered");
      await fileEventHandler(message);
    },
    keepAlive: vi.fn(),
    lastSeq: 0,
    invokeRpc(name: string, payload: Record<string, unknown> | null) {
      const handler = rpcHandlers.get(name);
      if (!handler) throw new Error(`Happy RPC handler ${name} is not registered`);
      return handler(payload);
    },
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      eventHandlers.set(event, handler);
    }),
    onFileEvent: vi.fn(
      (handler: (message: Record<string, unknown>) => void | Promise<void>) => {
        fileEventHandler = handler;
      },
    ),
    onUserMessage: vi.fn(
      (handler: (message: Record<string, unknown>) => void | Promise<void>) => {
        userMessageHandler = handler;
      },
    ),
    rpcHandlerManager: {
      registerHandler: vi.fn(
        (
          name: string,
          handler: (payload: Record<string, unknown> | null) => unknown,
        ) => {
          rpcHandlers.set(name, handler);
        },
      ),
    },
    sendAgentMessage: vi.fn(),
    sendSessionDeath: vi.fn(),
    sendSessionEvent: vi.fn(),
    sendSessionProtocolMessage: vi.fn(),
    suppressNextArchiveSignal: vi.fn(),
    updateMetadata: vi.fn(),
  };
}

function createMemorySessionKeyStore() {
  type Binding = {
    state: "pending" | "ready" | "retiring";
    relayTag: string;
    key: Uint8Array;
    happySessionId?: string;
    providerRetired?: boolean;
    blockRevival?: boolean;
    conversationId?: string;
    agentSessionId?: string;
    processedThroughSeq?: number;
    legacyRelayRetired?: boolean;
  };
  const bindings = new Map<string, Binding>();
  let generation = 0;
  const copy = (binding: Binding) => ({
    ...binding,
    key: new Uint8Array(binding.key),
  });
  return {
    delete: vi.fn(async (sessionId: string) => bindings.delete(sessionId)),
    list: vi.fn(async () =>
      [...bindings].map(([sessionId, binding]) => ({ sessionId, ...copy(binding) })),
    ),
    getOrCreate: vi.fn(async (sessionId: string, relayTag: string) => {
      let binding = bindings.get(sessionId);
      if (!binding) {
        binding = {
          state: "pending",
          relayTag,
          key: new Uint8Array(32).fill(++generation),
        };
        bindings.set(sessionId, binding);
      }
      return copy(binding);
    }),
    markReady: vi.fn(async (sessionId: string, happySessionId: string) => {
      const binding = bindings.get(sessionId);
      if (!binding) throw new Error("missing binding");
      if (binding.state === "retiring") throw new Error("binding is retiring");
      if (binding.state === "ready" && binding.happySessionId !== happySessionId) {
        throw new Error("relay row changed");
      }
      if (binding.state === "ready") return copy(binding);
      binding.state = "ready";
      binding.happySessionId = happySessionId;
      binding.processedThroughSeq = 0;
      return copy(binding);
    }),
    markProcessedThroughSeq: vi.fn(async (sessionId: string, seq: number) => {
      const binding = bindings.get(sessionId);
      if (!binding || binding.state !== "ready") throw new Error("binding is not ready");
      binding.processedThroughSeq = Math.max(binding.processedThroughSeq ?? 0, seq);
      return copy(binding);
    }),
    markLegacyRelayRetired: vi.fn(async (sessionId: string) => {
      const binding = bindings.get(sessionId);
      if (!binding || (binding.state !== "pending" && binding.state !== "ready")) {
        throw new Error("binding is not active");
      }
      binding.legacyRelayRetired = true;
      return copy(binding);
    }),
    clearLegacyRelayRetired: vi.fn(async (sessionId: string) => {
      const binding = bindings.get(sessionId);
      if (!binding) throw new Error("missing binding");
      delete binding.legacyRelayRetired;
      return copy(binding);
    }),
    clearProcessedThroughSeq: vi.fn(async (sessionId: string) => {
      const binding = bindings.get(sessionId);
      if (!binding || binding.state !== "ready") throw new Error("binding is not ready");
      delete binding.processedThroughSeq;
    }),
    markRetiring: vi.fn(
      async (
        sessionId: string,
        happySessionId?: string,
        providerRetired = false,
        blockRevival = false,
        conversationId?: string,
        agentSessionId?: string,
      ) => {
      const binding = bindings.get(sessionId);
      if (!binding) throw new Error("missing binding");
      if (
        binding.happySessionId &&
        happySessionId &&
        binding.happySessionId !== happySessionId
      ) {
        throw new Error("relay row changed");
      }
      binding.state = "retiring";
      delete binding.legacyRelayRetired;
      binding.providerRetired = binding.providerRetired === true || providerRetired;
      binding.blockRevival = binding.blockRevival === true || blockRevival;
      if (happySessionId) binding.happySessionId = happySessionId;
      if (conversationId) binding.conversationId = conversationId;
      if (agentSessionId) binding.agentSessionId = agentSessionId;
      return copy(binding);
      },
    ),
    replacePendingTag: vi.fn(async (sessionId: string, relayTag: string) => {
      const binding = bindings.get(sessionId);
      if (!binding || binding.state !== "pending") throw new Error("binding is not pending");
      binding.relayTag = relayTag;
      return copy(binding);
    }),
  };
}

function createLayerHarness({
  archiveDuringClientConstruction = false,
  initialSessions = [],
  machineIdentity = {
    token: "test",
    machineId: "synthetic-machine",
    encryption: { type: "legacy", secret: Buffer.alloc(32).toString("base64") },
  },
  sessionKeyStore = createMemorySessionKeyStore(),
}: {
  archiveDuringClientConstruction?: boolean;
  initialSessions?: Array<Record<string, unknown>>;
  machineIdentity?: Record<string, unknown>;
  sessionKeyStore?: ReturnType<typeof createMemorySessionKeyStore>;
} = {}) {
  const client = createClient();
  let onMessageProcessed: ((seq: number) => void | Promise<void>) | undefined;
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
    deactivateSession: vi.fn(async () => true),
    getOrCreateMachine: vi.fn(async () => ({ id: "relay-machine" })),
    getOrCreateSession: vi.fn(async ({ metadata }: { metadata: Record<string, unknown> }) => ({
      id: "relay-session",
      metadata,
    })),
    machineSyncClient: vi.fn(() => machineClient),
    sessionSyncClient: vi.fn(
      (
        _session: Record<string, unknown>,
        options?: {
          resumeFromSeq?: number;
          onMessageProcessed?: (seq: number) => void | Promise<void>;
        },
      ) => {
        client.lastSeq = options?.resumeFromSeq ?? 0;
        onMessageProcessed = options?.onMessageProcessed;
        if (archiveDuringClientConstruction) client.emit("archived");
        return client;
      },
    ),
  };
  happyLib.createApiClient.mockResolvedValue(api);

  let publishProviderEvent: ((event: Record<string, unknown>) => void) | undefined;
  const source = {
    advertise: vi.fn(async () => ({ agents: [] })),
    cancel: vi.fn(async () => {}),
    listSessions: vi.fn(async () => initialSessions),
    respondToPermission: vi.fn(async () => {}),
    sendPrompt: vi.fn(async () => ({ accepted: true })),
    setPermissionMode: vi.fn(async () => {}),
    spawn: vi.fn(async (spec: Record<string, unknown>) => ({
      sessionId: String(spec.localSessionId),
      agentType: "codex",
      agentSessionId: "synthetic-native-session",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
      reused: false,
      owned: true,
    })),
    subscribe: vi.fn((handler: (event: Record<string, unknown>) => void) => {
      publishProviderEvent = handler;
      return () => {};
    }),
    terminate: vi.fn(async () => {}),
  };
  const supervisorCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "conversation_restore_candidates") return { candidates: [] };
    if (method === "conversation_migrate_happy_session") return { migrated: true };
    if (method === "conversation_lookup") {
      return { restorable: false, happyOrigin: false, retire: false };
    }
    if (method === "conversation_claim") return { archived: false };
    return {
      conversationId:
        method === "conversation_owner_lookup"
          ? params.providerSessionId
          : params.conversationId,
    };
  });
  const supervisorNotify = vi.fn();
  let supervisorNotificationHandler:
    | ((method: string, params: Record<string, unknown>) => void)
    | undefined;
  const layer = createHappyLayer({
    config: {
      machineIdentity,
      machineName: "liveness-test",
      relayUrl: "https://relay.invalid",
    },
    sessionKeyStore,
    source,
    supervisorChannel: {
      call: supervisorCall,
      notify: supervisorNotify,
      onNotification(handler: (method: string, params: Record<string, unknown>) => void) {
        supervisorNotificationHandler = handler;
        handler("roots_update", { roots: [SYNTHETIC_ROOT] });
        return () => {};
      },
    },
  });

  return {
    api,
    client,
    layer,
    async processUserMessage(message: Record<string, unknown>, seq: number) {
      await client.dispatchUserMessage(message);
      await onMessageProcessed?.(seq);
    },
    async processFileEvent(message: Record<string, unknown>, seq: number) {
      await client.dispatchFileEvent(message);
      await onMessageProcessed?.(seq);
    },
    publish(event: Record<string, unknown>) {
      if (!publishProviderEvent) throw new Error("provider subscription is not ready");
      publishProviderEvent(event);
    },
    spawn(options: Record<string, unknown>) {
      if (!machineHandlers) throw new Error("machine handlers are not ready");
      return machineHandlers.spawnSession(options);
    },
    source,
    supervisorCall,
    supervisorNotify,
    notifySupervisor(method: string, params: Record<string, unknown>) {
      if (!supervisorNotificationHandler) throw new Error("supervisor listener is not ready");
      supervisorNotificationHandler(method, params);
    },
    sessionKeyStore,
  };
}

describe("Happy session liveness", () => {
  it("retires an archive delivered while the session client is being constructed", async () => {
    const summary = {
      sessionId: "constructor-archive-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic constructor archive",
      status: "ready",
    };
    const harness = createLayerHarness({
      archiveDuringClientConstruction: true,
      initialSessions: [summary],
    });

    await harness.layer.start();

    await vi.waitFor(() =>
      expect(harness.source.terminate).toHaveBeenCalledWith(summary.sessionId),
    );
    await vi.waitFor(() =>
      expect(harness.api.deactivateSession).toHaveBeenCalledWith("relay-session"),
    );
    expect(harness.client.sendSessionEvent).not.toHaveBeenCalled();
    expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(1);

    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    await Promise.resolve();
    expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(1);
  });

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
    await vi.waitFor(() =>
      expect(harness.source.terminate).toHaveBeenCalledWith("local-session"),
    );
    await vi.waitFor(() => expect(harness.client.sendSessionDeath).toHaveBeenCalledTimes(1));
    expect(harness.api.deactivateSession).toHaveBeenCalledWith("relay-session");

    resolveClientClose?.();
    await vi.waitFor(() =>
      expect(harness.sessionKeyStore.delete).toHaveBeenCalledWith("local-session"),
    );
    expect(harness.supervisorCall).toHaveBeenCalledWith("conversation_archive", {
      conversationId: "local-session",
      providerSessionId: "local-session",
    });
    expect(harness.supervisorCall.mock.invocationCallOrder[0]).toBeLessThan(
      harness.source.terminate.mock.invocationCallOrder[0],
    );
    harness.publish({
      kind: "status",
      sessionId: "local-session",
      payload: { status: "ready" },
    });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(1);
    await harness.layer.close();
    expect(harness.client.close).toHaveBeenCalledTimes(1);
  });

  it("authenticates killSession and retires the tracked provider exactly once", async () => {
    vi.useFakeTimers();
    const summary = {
      sessionId: "kill-session",
      agentSessionId: "kill-native-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic kill session",
      status: "ready",
    };
    const harness = createLayerHarness({ initialSessions: [summary] });

    await harness.layer.start();
    expect(harness.client.keepAlive).toHaveBeenCalledTimes(1);

    await expect(harness.client.invokeRpc("killSession", null)).resolves.toEqual({
      success: false,
      message: "Unauthenticated kill request",
    });
    vi.advanceTimersByTime(2_000);
    expect(harness.client.keepAlive).toHaveBeenCalledTimes(2);
    expect(harness.source.terminate).not.toHaveBeenCalled();

    await expect(harness.client.invokeRpc("killSession", {})).resolves.toEqual({
      success: true,
      message: "Killing happy-cli process",
    });
    const stoppedAt = harness.client.keepAlive.mock.calls.length;
    vi.advanceTimersByTime(4_000);
    expect(harness.client.keepAlive).toHaveBeenCalledTimes(stoppedAt);

    await expect(harness.client.invokeRpc("killSession", {})).resolves.toEqual({
      success: true,
      message: "Killing happy-cli process",
    });
    await vi.waitFor(() =>
      expect(harness.source.terminate).toHaveBeenCalledWith(summary.sessionId),
    );
    expect(harness.source.terminate).toHaveBeenCalledTimes(1);
    expect(harness.supervisorCall).toHaveBeenCalledWith("conversation_archive", {
      conversationId: summary.sessionId,
      providerSessionId: summary.sessionId,
    });
    expect(harness.supervisorCall.mock.invocationCallOrder[0]).toBeLessThan(
      harness.source.terminate.mock.invocationCallOrder[0],
    );
    expect(harness.api.deactivateSession).toHaveBeenCalledWith("relay-session");
    await vi.waitFor(() =>
      expect(harness.sessionKeyStore.delete).toHaveBeenCalledWith(summary.sessionId),
    );

    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(1);
    await harness.layer.close();
    expect(harness.client.close).toHaveBeenCalledTimes(1);
  });

  it("archives the owning conversation after provider-session promotion", async () => {
    const summary = {
      sessionId: "promoted-runtime-session",
      agentSessionId: "native-provider-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic promoted session",
      status: "ready",
    };
    const harness = createLayerHarness({ initialSessions: [summary] });
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "conversation_owner_lookup") {
        return { conversationId: "owning-conversation" };
      }
      return { conversationId: params.conversationId };
    });

    await harness.layer.start();
    harness.client.emit("archived");

    await vi.waitFor(() =>
      expect(harness.supervisorCall).toHaveBeenCalledWith("conversation_archive", {
        conversationId: "owning-conversation",
        providerSessionId: summary.sessionId,
      }),
    );
    expect(harness.supervisorCall).toHaveBeenCalledWith("conversation_owner_lookup", {
      providerSessionId: summary.sessionId,
      agentSessionId: summary.agentSessionId,
    });
    expect(harness.sessionKeyStore.markRetiring).toHaveBeenCalledWith(
      summary.sessionId,
      "relay-session",
      false,
      true,
      "owning-conversation",
      summary.agentSessionId,
    );
    expect(harness.sessionKeyStore.markRetiring.mock.invocationCallOrder[1]).toBeLessThan(
      harness.supervisorCall.mock.invocationCallOrder.find(
        (_, index) =>
          harness.supervisorCall.mock.calls[index]?.[0] === "conversation_archive",
      ),
    );
    await vi.waitFor(() =>
      expect(harness.sessionKeyStore.delete).toHaveBeenCalledWith(summary.sessionId),
    );
    await harness.layer.close();
  });

  it("retires an unowned predictive standby through an exact provider fence", async () => {
    const summary = {
      sessionId: "unowned-standby",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic standby",
      status: "ready",
    };
    const harness = createLayerHarness({ initialSessions: [summary] });
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "conversation_owner_lookup") return {};
      return { conversationId: params.conversationId };
    });

    await harness.layer.start();
    harness.client.emit("archived");

    await vi.waitFor(() =>
      expect(harness.supervisorCall).toHaveBeenCalledWith(
        "provider_session_archive",
        { providerSessionId: summary.sessionId },
      ),
    );
    expect(harness.supervisorCall).not.toHaveBeenCalledWith(
      "conversation_archive",
      expect.anything(),
    );
    await vi.waitFor(() =>
      expect(harness.source.terminate).toHaveBeenCalledWith(summary.sessionId),
    );
    expect(harness.api.deactivateSession).toHaveBeenCalledWith("relay-session");
    await vi.waitFor(() =>
      expect(harness.sessionKeyStore.delete).toHaveBeenCalledWith(summary.sessionId),
    );
    await harness.layer.close();
  });

  it("durably retires the exact provider session fenced by desktop", async () => {
    const summary = {
      sessionId: "00000000-0000-4000-8000-000000000321",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic sibling session",
      status: "ready",
    };
    const harness = createLayerHarness({ initialSessions: [summary] });
    await harness.layer.start();

    harness.notifySupervisor("provider_session_retire", {
      providerSessionId: summary.sessionId,
    });

    await vi.waitFor(() =>
      expect(harness.sessionKeyStore.markRetiring).toHaveBeenCalledWith(
        summary.sessionId,
        "relay-session",
        false,
        true,
        undefined,
        undefined,
      ),
    );
    await vi.waitFor(() =>
      expect(harness.source.terminate).toHaveBeenCalledWith(summary.sessionId),
    );
    expect(
      harness.sessionKeyStore.markRetiring.mock.invocationCallOrder[0],
    ).toBeLessThan(harness.source.terminate.mock.invocationCallOrder[0]);
    expect(harness.supervisorCall).not.toHaveBeenCalledWith(
      "conversation_archive",
      expect.anything(),
    );
    await vi.waitFor(() =>
      expect(harness.sessionKeyStore.delete).toHaveBeenCalledWith(
        summary.sessionId,
      ),
    );
    await harness.layer.close();
  });

  it("uses a native agent id observed after the relay entry was created", async () => {
    const summary = {
      sessionId: "late-native-id-runtime",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic late native id session",
      status: "initializing",
    };
    const harness = createLayerHarness({ initialSessions: [summary] });
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "conversation_owner_lookup") {
        return { conversationId: "late-native-id-owner" };
      }
      return { conversationId: params.conversationId };
    });

    await harness.layer.start();
    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready", agentSessionId: "native-id-after-start" },
    });
    await vi.waitFor(() =>
      expect(harness.client.sendSessionProtocolMessage).toHaveBeenCalled(),
    );
    harness.client.emit("archived");

    await vi.waitFor(() =>
      expect(harness.supervisorCall).toHaveBeenCalledWith(
        "conversation_owner_lookup",
        {
          providerSessionId: summary.sessionId,
          agentSessionId: "native-id-after-start",
        },
      ),
    );
    expect(harness.supervisorCall).toHaveBeenCalledWith("conversation_archive", {
      conversationId: "late-native-id-owner",
      providerSessionId: summary.sessionId,
    });
    await harness.layer.close();
  });

  it("retries a promoted archive after a crash before owner resolution", async () => {
    const summary = {
      sessionId: "promoted-crash-runtime",
      agentSessionId: "native-crash-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic promoted crash session",
      status: "ready",
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    const interrupted = createLayerHarness({
      initialSessions: [summary],
      sessionKeyStore,
    });
    interrupted.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "conversation_owner_lookup") {
        throw new Error("synthetic interrupted lookup");
      }
      return { conversationId: params.conversationId };
    });

    await interrupted.layer.start();
    interrupted.client.emit("archived");
    await vi.waitFor(() =>
      expect(sessionKeyStore.markRetiring).toHaveBeenCalledWith(
        summary.sessionId,
        "relay-session",
        false,
        true,
        undefined,
        summary.agentSessionId,
      ),
    );
    expect(await sessionKeyStore.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: summary.sessionId,
          state: "retiring",
          blockRevival: true,
          agentSessionId: summary.agentSessionId,
        }),
      ]),
    );
    expect(interrupted.api.deactivateSession).not.toHaveBeenCalled();
    await interrupted.layer.close();

    sessionKeyStore.delete.mockClear();
    const restarted = createLayerHarness({
      initialSessions: [],
      sessionKeyStore,
    });
    restarted.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "conversation_owner_lookup") {
        expect(params).toEqual({
          providerSessionId: summary.sessionId,
          agentSessionId: summary.agentSessionId,
        });
        return { conversationId: "promoted-owning-conversation" };
      }
      return { conversationId: params.conversationId };
    });

    await restarted.layer.start();
    expect(restarted.supervisorCall).toHaveBeenCalledWith("conversation_archive", {
      conversationId: "promoted-owning-conversation",
      providerSessionId: summary.sessionId,
    });
    expect(restarted.api.deactivateSession).toHaveBeenCalledWith("relay-session");
    expect(restarted.source.terminate).not.toHaveBeenCalled();
    expect(sessionKeyStore.delete).toHaveBeenCalledWith(summary.sessionId);
    await restarted.layer.close();
  });

  it("reuses one persisted data-key row across a graceful bridge restart", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const summary = {
      sessionId: "local-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic session",
      status: "ready",
    };
    const machineIdentity = {
      token: "test",
      machineId: "synthetic-machine",
      encryption: {
        type: "dataKey",
        publicKey: Buffer.alloc(32, 3).toString("base64"),
        machineKey: Buffer.alloc(32, 7).toString("base64"),
      },
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    const first = createLayerHarness({
      initialSessions: [summary],
      machineIdentity,
      sessionKeyStore,
    });
    first.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "stable-relay-session",
      metadata,
      seq: 0,
    }));

    await first.layer.start();
    const firstOptions = first.api.getOrCreateSession.mock.calls[0]?.[0];
    expect(firstOptions.tag).toBe("seren-local-session");
    expect(firstOptions.encryptionKey).toBeInstanceOf(Uint8Array);
    expect(sessionKeyStore.markReady).toHaveBeenCalledWith(
      "local-session",
      "stable-relay-session",
    );
    await first.layer.close();
    expect(first.client.sendSessionDeath).not.toHaveBeenCalled();
    expect(first.api.deactivateSession).not.toHaveBeenCalled();
    expect(first.client.close).toHaveBeenCalledTimes(1);
    expect(sessionKeyStore.delete).not.toHaveBeenCalled();

    const restarted = createLayerHarness({
      initialSessions: [summary],
      machineIdentity,
      sessionKeyStore,
    });
    restarted.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "stable-relay-session",
      metadata,
      seq: 0,
    }));
    restarted.client.sendSessionDeath.mockImplementation(() => order.push("death"));
    restarted.api.deactivateSession.mockImplementation(async () => {
      order.push("deactivate");
      return true;
    });
    restarted.client.close.mockImplementation(async () => {
      order.push("close");
    });

    await restarted.layer.start();
    const restartedOptions = restarted.api.getOrCreateSession.mock.calls[0]?.[0];
    expect(restartedOptions.tag).toBe(firstOptions.tag);
    expect(Buffer.from(restartedOptions.encryptionKey)).toEqual(
      Buffer.from(firstOptions.encryptionKey),
    );
    expect(restarted.client.lastSeq).toBe(0);
    expect(restarted.client.suppressNextArchiveSignal).not.toHaveBeenCalled();
    expect(restarted.client.updateMetadata).not.toHaveBeenCalled();

    await restarted.layer.close();
    expect(order).toEqual(["close"]);
    expect(restarted.client.sendSessionDeath).not.toHaveBeenCalled();
    expect(restarted.api.deactivateSession).not.toHaveBeenCalled();
    const pulsesAtClose = restarted.client.keepAlive.mock.calls.length;
    vi.advanceTimersByTime(4_000);
    expect(restarted.client.keepAlive).toHaveBeenCalledTimes(pulsesAtClose);
  });

  it("restores an exact Happy provider and checkpoints only its accepted relay sequence", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000321";
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(providerSessionId, `seren-${providerSessionId}`);
    await sessionKeyStore.markReady(providerSessionId, "persisted-relay-session");
    await sessionKeyStore.markProcessedThroughSeq(providerSessionId, 4);
    const harness = createLayerHarness({ initialSessions: [], sessionKeyStore });
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "persisted-relay-session",
      metadata,
      seq: 9,
    }));
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "provider_session_archive_lookup") return { archived: false };
      if (method === "conversation_lookup") {
        expect(params).toEqual({
          providerSessionId,
          happySessionId: "persisted-relay-session",
        });
        return {
          restorable: true,
          happyOrigin: true,
          retire: false,
          archived: false,
          conversationId: providerSessionId,
          agentType: "codex",
          agentSessionId: "native-session-to-resume",
          agentModelId: "synthetic-model",
          agentPermissionMode: "ask",
          title: "Synthetic restored provider",
          cwd: SYNTHETIC_ROOT,
        };
      }
      if (method === "conversation_claim") return { archived: false };
      return { conversationId: params.conversationId };
    });

    await harness.layer.start();

    expect(harness.source.spawn).toHaveBeenCalledWith({
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      localSessionId: providerSessionId,
      resumeAgentSessionId: "native-session-to-resume",
      requireExactResume: true,
      suppressHistoryReplay: true,
      initialModelId: "synthetic-model",
      permissionMode: "ask",
      approvalPolicy: "on-failure",
    });
    expect(harness.supervisorCall).toHaveBeenCalledWith("conversation_claim", {
      conversationId: providerSessionId,
      providerSessionId,
      happySessionId: "persisted-relay-session",
      cwd: SYNTHETIC_ROOT,
      expectedAgentType: "codex",
      expectedAgentSessionId: "native-session-to-resume",
      expectedAgentPermissionMode: "ask",
      agentSessionId: "synthetic-native-session",
    });
    expect(harness.api.sessionSyncClient).toHaveBeenCalledWith(
      expect.objectContaining({ id: "persisted-relay-session" }),
      expect.objectContaining({ resumeFromSeq: 4 }),
    );

    let acceptPrompt: (() => void) | undefined;
    harness.source.sendPrompt.mockImplementationOnce(
      () => new Promise<{ accepted: true }>((resolve) => {
        acceptPrompt = () => resolve({ accepted: true });
      }),
    );
    sessionKeyStore.markProcessedThroughSeq.mockClear();
    harness.client.lastSeq = 99;
    const processing = harness.processUserMessage(
      { role: "user", content: { type: "text", text: "continue" } },
      5,
    );
    await vi.waitFor(() =>
      expect(harness.source.sendPrompt).toHaveBeenCalledWith(providerSessionId, "continue"),
    );
    expect(sessionKeyStore.markProcessedThroughSeq).not.toHaveBeenCalled();

    acceptPrompt?.();
    await processing;
    expect(sessionKeyStore.markProcessedThroughSeq).toHaveBeenCalledWith(
      providerSessionId,
      5,
    );
    expect(sessionKeyStore.markProcessedThroughSeq).not.toHaveBeenCalledWith(
      providerSessionId,
      99,
    );
    await harness.layer.close();
  });

  it("keeps buffered provider readiness inert until the restore claim succeeds", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000324";
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(providerSessionId, `seren-${providerSessionId}`);
    await sessionKeyStore.markReady(providerSessionId, "claim-gated-relay");
    const harness = createLayerHarness({ initialSessions: [], sessionKeyStore });
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "claim-gated-relay",
      metadata,
      seq: 0,
    }));
    harness.source.spawn.mockImplementation(async (spec) => ({
      sessionId: String(spec.localSessionId),
      agentType: "codex",
      agentSessionId: "claim-gated-native-session",
      cwd: SYNTHETIC_ROOT,
      status: "initializing",
      reused: true,
      owned: false,
    }));
    let releaseClaim: (() => void) | undefined;
    let claimReturned = false;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "provider_session_archive_lookup") return { archived: false };
      if (method === "conversation_lookup") {
        return {
          restorable: true,
          happyOrigin: true,
          retire: false,
          archived: false,
          conversationId: providerSessionId,
          agentType: "codex",
          agentSessionId: "claim-gated-native-session",
          cwd: SYNTHETIC_ROOT,
        };
      }
      if (method === "conversation_claim") {
        await claimGate;
        claimReturned = true;
        return { archived: false };
      }
      return { conversationId: params.conversationId };
    });
    harness.source.subscribe.mockImplementation((handler) => {
      expect(claimReturned).toBe(true);
      handler({
        kind: "status",
        sessionId: providerSessionId,
        payload: {
          status: "ready",
          agentSessionId: "claim-gated-native-session",
        },
      });
      return () => {};
    });

    const starting = harness.layer.start();
    await vi.waitFor(() =>
      expect(harness.supervisorCall).toHaveBeenCalledWith(
        "conversation_claim",
        expect.anything(),
      ),
    );
    expect(harness.source.subscribe).not.toHaveBeenCalled();
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(harness.client.onUserMessage).not.toHaveBeenCalled();
    expect(harness.source.sendPrompt).not.toHaveBeenCalled();

    releaseClaim?.();
    await starting;

    expect(harness.source.subscribe).toHaveBeenCalledTimes(1);
    expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(1);
    expect(harness.client.onUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.source.sendPrompt).not.toHaveBeenCalled();

    await harness.processUserMessage(
      { role: "user", content: { type: "text", text: "after claim" } },
      1,
    );
    expect(harness.source.sendPrompt).toHaveBeenCalledWith(
      providerSessionId,
      "after claim",
    );
    await harness.layer.close();
  });

  it("retires a reused provider when archive wins the startup ownership claim", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000322";
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(providerSessionId, `seren-${providerSessionId}`);
    await sessionKeyStore.markReady(providerSessionId, "archived-restore-relay");
    const harness = createLayerHarness({ initialSessions: [], sessionKeyStore });
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "archived-restore-relay",
      metadata,
      seq: 0,
    }));
    harness.source.spawn.mockImplementation(async (spec) => ({
      sessionId: String(spec.localSessionId),
      agentType: "codex",
      agentSessionId: "reused-restored-native-session",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
      reused: true,
      owned: false,
    }));
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "provider_session_archive_lookup") return { archived: false };
      if (method === "conversation_lookup") {
        return {
          restorable: true,
          happyOrigin: true,
          retire: false,
          archived: false,
          conversationId: providerSessionId,
          agentType: "codex",
          agentSessionId: "reused-restored-native-session",
          cwd: SYNTHETIC_ROOT,
        };
      }
      if (method === "conversation_claim") return { archived: true };
      return { conversationId: params.conversationId };
    });

    await harness.layer.start();

    expect(harness.source.terminate).toHaveBeenCalledWith(providerSessionId);
    expect(harness.api.deactivateSession).toHaveBeenCalledWith("archived-restore-relay");
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(harness.sessionKeyStore.delete).toHaveBeenCalledWith(providerSessionId);
    await harness.layer.close();
  });

  it("retires a reconfigured reused provider when its atomic restore claim is rejected", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000323";
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(providerSessionId, `seren-${providerSessionId}`);
    await sessionKeyStore.markReady(providerSessionId, "rejected-restore-relay");
    const harness = createLayerHarness({ initialSessions: [], sessionKeyStore });
    let rejectClaim: (() => void) | undefined;
    const claimGate = new Promise<never>((_resolve, reject) => {
      rejectClaim = () => reject(new Error("Happy restoration claim was rejected"));
    });
    harness.source.spawn.mockImplementation(async (spec) => ({
      sessionId: String(spec.localSessionId),
      agentType: "codex",
      agentSessionId: "reused-rejected-native-session",
      cwd: SYNTHETIC_ROOT,
      status: "initializing",
      reused: true,
      owned: false,
    }));
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "provider_session_archive_lookup") return { archived: false };
      if (method === "conversation_lookup") {
        return {
          restorable: true,
          happyOrigin: true,
          retire: false,
          archived: false,
          conversationId: providerSessionId,
          agentType: "codex",
          agentSessionId: "reused-rejected-native-session",
          agentPermissionMode: "bypassPermissions",
          cwd: SYNTHETIC_ROOT,
        };
      }
      if (method === "conversation_claim") {
        return claimGate;
      }
      return { conversationId: params.conversationId };
    });

    const starting = harness.layer.start();
    await vi.waitFor(() =>
      expect(harness.supervisorCall).toHaveBeenCalledWith(
        "conversation_claim",
        expect.anything(),
      ),
    );
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(harness.client.onUserMessage).not.toHaveBeenCalled();
    expect(harness.client.keepAlive).not.toHaveBeenCalled();
    expect(harness.source.sendPrompt).not.toHaveBeenCalled();
    rejectClaim?.();
    await expect(starting).rejects.toThrow(
      "Happy restoration claim was rejected",
    );

    expect(harness.source.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "bypassPermissions" }),
    );
    expect(harness.source.terminate).toHaveBeenCalledWith(providerSessionId);
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    await harness.layer.close();
  });

  it("does not treat a permission-only status as provider readiness", async () => {
    const summary = {
      sessionId: "permission-status-session",
      agentType: "claude-code",
      agentSessionId: "native-permission-status",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
    };
    const harness = createLayerHarness({ initialSessions: [summary] });
    let acceptFirst: (() => void) | undefined;
    harness.source.sendPrompt.mockImplementation(async (_sessionId, text) => {
      if (text === "first") {
        await new Promise<void>((resolve) => {
          acceptFirst = resolve;
        });
      }
      return { accepted: true };
    });
    await harness.layer.start();

    const first = harness.processUserMessage(
      { role: "user", content: { type: "text", text: "first" } },
      1,
    );
    await vi.waitFor(() =>
      expect(harness.source.sendPrompt).toHaveBeenCalledWith(summary.sessionId, "first"),
    );
    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready", readinessUnchanged: true },
    });
    acceptFirst?.();
    await first;

    const second = harness.processUserMessage(
      { role: "user", content: { type: "text", text: "second" } },
      2,
    );
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(harness.source.sendPrompt).toHaveBeenCalledTimes(1);

    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    await second;
    expect(harness.source.sendPrompt).toHaveBeenNthCalledWith(
      2,
      summary.sessionId,
      "second",
    );
    await harness.layer.close();
  });

  it("captures completion before slow startup work despite restore chatter", async () => {
    const active = {
      sessionId: "active-startup-session",
      agentType: "codex",
      agentSessionId: "active-startup-native",
      cwd: SYNTHETIC_ROOT,
      status: "prompting",
    };
    const harness = createLayerHarness({ initialSessions: [active] });
    let finishRelayLookup: (() => void) | undefined;
    harness.api.getOrCreateSession.mockImplementation(
      ({ metadata }: { metadata: Record<string, unknown> }) =>
        new Promise<Record<string, unknown>>((resolve) => {
          finishRelayLookup ??= () =>
            resolve({ id: "startup-race-relay", metadata });
        }),
    );

    const starting = harness.layer.start();
    await vi.waitFor(() => expect(harness.source.subscribe).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(harness.api.getOrCreateSession).toHaveBeenCalledTimes(1));
    harness.publish({
      kind: "turn-complete",
      sessionId: active.sessionId,
      payload: { stopReason: "completed" },
    });
    for (let index = 0; index < 40; index += 1) {
      harness.publish({
        kind: "status",
        sessionId: `restore-chatter-${index}`,
        payload: { status: "ready" },
      });
    }
    finishRelayLookup?.();
    await starting;

    expect(harness.api.getOrCreateSession).toHaveBeenCalledTimes(1);
    expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(1);
    expect(harness.client.onUserMessage).toHaveBeenCalledTimes(1);
    await harness.processUserMessage(
      { role: "user", content: { type: "text", text: "after restart" } },
      1,
    );
    await vi.waitFor(() =>
      expect(harness.source.sendPrompt).toHaveBeenCalledWith(
        active.sessionId,
        "after restart",
      ),
    );
    await harness.layer.close();
  });

  it("seeds a legacy ready binding at the relay snapshot exactly once", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000984";
    const summary = {
      sessionId: providerSessionId,
      agentType: "codex",
      agentSessionId: "native-existing",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(providerSessionId, `seren-${providerSessionId}`);
    await sessionKeyStore.markReady(providerSessionId, "legacy-cursor-relay");
    await sessionKeyStore.clearProcessedThroughSeq(providerSessionId);
    const harness = createLayerHarness({
      initialSessions: [summary],
      sessionKeyStore,
    });
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "legacy-cursor-relay",
      metadata,
      seq: 9,
    }));

    await harness.layer.start();

    expect(sessionKeyStore.markProcessedThroughSeq).toHaveBeenCalledTimes(1);
    expect(sessionKeyStore.markProcessedThroughSeq).toHaveBeenCalledWith(
      providerSessionId,
      9,
    );
    expect(harness.api.sessionSyncClient).toHaveBeenCalledWith(
      expect.objectContaining({ id: "legacy-cursor-relay" }),
      expect.objectContaining({ resumeFromSeq: 9 }),
    );
    await harness.layer.close();
  });

  it("seeds an unbound v3.72 relay snapshot before accepting only newer input", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000988";
    const summary = {
      sessionId: providerSessionId,
      agentType: "codex",
      agentSessionId: "native-existing",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    const harness = createLayerHarness({
      initialSessions: [summary],
      sessionKeyStore,
    });
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "v372-existing-relay",
      metadata,
      seq: 12,
    }));

    await harness.layer.start();

    expect(harness.api.sessionSyncClient).toHaveBeenCalledWith(
      expect.objectContaining({ id: "v372-existing-relay" }),
      expect.objectContaining({ resumeFromSeq: 12 }),
    );
    expect(sessionKeyStore.markProcessedThroughSeq).toHaveBeenCalledWith(
      providerSessionId,
      12,
    );
    expect(harness.source.sendPrompt).not.toHaveBeenCalled();

    await harness.processUserMessage(
      { role: "user", content: { type: "text", text: "new after upgrade" } },
      13,
    );
    expect(harness.source.sendPrompt).toHaveBeenCalledTimes(1);
    expect(harness.source.sendPrompt).toHaveBeenCalledWith(
      providerSessionId,
      "new after upgrade",
    );
    await harness.layer.close();
  });

  it("does not resurrect a current session after successful terminal retirement", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000987";
    const happySessionId = "current-terminal-relay";
    const summary = {
      sessionId: providerSessionId,
      agentType: "codex",
      agentSessionId: "current-terminal-native",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic current terminal thread",
      status: "ready",
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(providerSessionId, `seren-${providerSessionId}`);
    await sessionKeyStore.markReady(providerSessionId, happySessionId);
    let lifecycleRecorded = false;
    const restorationCandidates = () =>
      lifecycleRecorded
        ? []
        : [
            {
              conversationId: providerSessionId,
              happySessionId,
              agentType: summary.agentType,
              agentSessionId: summary.agentSessionId,
              cwd: summary.cwd,
              title: summary.title,
            },
          ];
    const first = createLayerHarness({
      initialSessions: [summary],
      sessionKeyStore,
    });
    first.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: happySessionId,
      metadata,
      seq: 0,
    }));
    first.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") {
        return { candidates: restorationCandidates() };
      }
      if (method === "conversation_migrate_happy_session") {
        expect(params).toEqual({
          conversationId: providerSessionId,
          expectedHappySessionId: happySessionId,
          replacementHappySessionId: happySessionId,
        });
        lifecycleRecorded = true;
        return { migrated: true };
      }
      if (method === "provider_session_archive_lookup") return { archived: false };
      return { conversationId: params.conversationId };
    });

    await first.layer.start();
    expect(lifecycleRecorded).toBe(true);
    expect(
      first.supervisorCall.mock.invocationCallOrder.find(
        (_, index) =>
          first.supervisorCall.mock.calls[index]?.[0] ===
          "conversation_migrate_happy_session",
      ),
    ).toBeLessThan(first.source.subscribe.mock.invocationCallOrder[0]);

    first.publish({
      kind: "status",
      sessionId: providerSessionId,
      payload: { status: "terminated" },
    });
    await vi.waitFor(() =>
      expect(sessionKeyStore.delete).toHaveBeenCalledWith(providerSessionId),
    );
    expect(await sessionKeyStore.list()).toEqual([]);
    await first.layer.close();

    const restarted = createLayerHarness({ initialSessions: [], sessionKeyStore });
    restarted.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") {
        return { candidates: restorationCandidates() };
      }
      if (method === "provider_session_archive_lookup") return { archived: false };
      return { conversationId: params.conversationId };
    });

    await restarted.layer.start();

    expect(restarted.api.getOrCreateSession).not.toHaveBeenCalled();
    expect(restarted.api.deactivateSession).not.toHaveBeenCalled();
    expect(restarted.source.spawn).not.toHaveBeenCalled();
    expect(restarted.api.sessionSyncClient).not.toHaveBeenCalled();
    await restarted.layer.close();
  });

  it("migrates a v3.72 Happy conversation with no binding or provider before restoring it", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000989";
    const legacyHappySessionId = "v372-lost-key-relay";
    const replacementHappySessionId = "v372-replacement-relay";
    let recordedHappySessionId = legacyHappySessionId;
    const sessionKeyStore = createMemorySessionKeyStore();
    const harness = createLayerHarness({ initialSessions: [], sessionKeyStore });
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: replacementHappySessionId,
      metadata,
      seq: 0,
    }));
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") {
        return {
          candidates: [
            {
              conversationId: providerSessionId,
              happySessionId: recordedHappySessionId,
              agentType: "codex",
              agentSessionId: "v372-native-session",
              cwd: SYNTHETIC_ROOT,
              title: "Synthetic v3.72 thread",
            },
          ],
        };
      }
      if (method === "conversation_migrate_happy_session") {
        expect(params).toEqual({
          conversationId: providerSessionId,
          expectedHappySessionId: legacyHappySessionId,
          replacementHappySessionId,
        });
        recordedHappySessionId = replacementHappySessionId;
        return { migrated: true };
      }
      if (method === "provider_session_archive_lookup") return { archived: false };
      if (method === "conversation_lookup") {
        expect(params).toEqual({
          providerSessionId,
          happySessionId: replacementHappySessionId,
        });
        return {
          restorable: true,
          happyOrigin: true,
          retire: false,
          archived: false,
          conversationId: providerSessionId,
          agentType: "codex",
          agentSessionId: "v372-native-session",
          cwd: SYNTHETIC_ROOT,
          title: "Synthetic v3.72 thread",
        };
      }
      if (method === "conversation_claim") return { archived: false };
      return { conversationId: params.conversationId };
    });

    await harness.layer.start();

    expect(harness.api.deactivateSession).toHaveBeenCalledWith(
      legacyHappySessionId,
    );
    expect(harness.supervisorCall.mock.invocationCallOrder.find((_, index) =>
      harness.supervisorCall.mock.calls[index]?.[0] ===
      "conversation_migrate_happy_session"
    )).toBeLessThan(harness.source.subscribe.mock.invocationCallOrder[0]);
    expect(harness.source.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        localSessionId: providerSessionId,
        resumeAgentSessionId: "v372-native-session",
        requireExactResume: true,
      }),
    );
    expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(1);
    expect(harness.api.sessionSyncClient).toHaveBeenCalledWith(
      expect.objectContaining({ id: replacementHappySessionId }),
      expect.anything(),
    );
    expect(await sessionKeyStore.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: providerSessionId,
          state: "ready",
          happySessionId: replacementHappySessionId,
          processedThroughSeq: 0,
        }),
      ]),
    );
    await harness.layer.close();
  });

  it("rotates a pending legacy tag before a listed v3.72 provider and survives the next cold restart", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000990";
    const legacyHappySessionId = "v372-pre-stable-relay";
    const replacementHappySessionId = "v372-listed-replacement";
    const summary = {
      sessionId: providerSessionId,
      agentType: "codex",
      agentSessionId: "v372-listed-native",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
    };
    let recordedHappySessionId = legacyHappySessionId;
    let migrationRecorded = false;
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(providerSessionId, `seren-${providerSessionId}`);

    const configureSupervisor = (harness: ReturnType<typeof createLayerHarness>) => {
      harness.supervisorCall.mockImplementation(async (method, params) => {
        if (method === "conversation_restore_candidates") {
          return {
            candidates: migrationRecorded
              ? []
              : [
                  {
                    conversationId: providerSessionId,
                    happySessionId: recordedHappySessionId,
                    agentType: "codex",
                    agentSessionId: "v372-listed-native",
                    cwd: SYNTHETIC_ROOT,
                    title: "Synthetic listed v3.72 thread",
                  },
                ],
          };
        }
        if (method === "conversation_migrate_happy_session") {
          expect(params.expectedHappySessionId).toBe(legacyHappySessionId);
          expect(params.replacementHappySessionId).toBe(replacementHappySessionId);
          recordedHappySessionId = replacementHappySessionId;
          migrationRecorded = true;
          return { migrated: true };
        }
        if (method === "provider_session_archive_lookup") return { archived: false };
        if (method === "conversation_lookup") {
          return {
            restorable: true,
            happyOrigin: true,
            retire: false,
            archived: false,
            conversationId: providerSessionId,
            agentType: "codex",
            agentSessionId: "v372-listed-native",
            cwd: SYNTHETIC_ROOT,
            title: "Synthetic listed v3.72 thread",
          };
        }
        if (method === "conversation_claim") return { archived: false };
        return { conversationId: params.conversationId };
      });
    };

    const upgraded = createLayerHarness({
      initialSessions: [summary],
      sessionKeyStore,
    });
    configureSupervisor(upgraded);
    upgraded.api.getOrCreateSession.mockImplementation(async ({ tag, metadata }) => {
      expect(tag).toMatch(/^seren-migrated-/);
      return { id: replacementHappySessionId, metadata, seq: 0 };
    });

    await upgraded.layer.start();

    expect(sessionKeyStore.replacePendingTag).toHaveBeenCalledWith(
      providerSessionId,
      expect.stringMatching(/^seren-migrated-/),
    );
    expect(upgraded.source.spawn).not.toHaveBeenCalled();
    expect(upgraded.api.sessionSyncClient).toHaveBeenCalledTimes(1);
    expect(upgraded.api.sessionSyncClient).toHaveBeenCalledWith(
      expect.objectContaining({ id: replacementHappySessionId }),
      expect.anything(),
    );
    await upgraded.layer.close();

    const restarted = createLayerHarness({ initialSessions: [], sessionKeyStore });
    configureSupervisor(restarted);
    restarted.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: replacementHappySessionId,
      metadata,
      seq: 0,
    }));
    await restarted.layer.start();

    expect(restarted.api.deactivateSession).not.toHaveBeenCalledWith(
      legacyHappySessionId,
    );
    expect(restarted.source.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        localSessionId: providerSessionId,
        resumeAgentSessionId: "v372-listed-native",
        requireExactResume: true,
      }),
    );
    expect(restarted.api.sessionSyncClient).toHaveBeenCalledTimes(1);
    await restarted.layer.close();
  });

  it("repairs a ready #3218 replacement whose SQLite marker was never migrated", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000991";
    const legacyHappySessionId = "intermediate-legacy-relay";
    const replacementHappySessionId = "intermediate-ready-relay";
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(providerSessionId, "seren-v2-intermediate");
    await sessionKeyStore.markReady(providerSessionId, replacementHappySessionId);
    const harness = createLayerHarness({ initialSessions: [], sessionKeyStore });
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: replacementHappySessionId,
      metadata,
      seq: 0,
    }));
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") {
        return {
          candidates: [
            {
              conversationId: providerSessionId,
              happySessionId: legacyHappySessionId,
              agentType: "codex",
              agentSessionId: "intermediate-native",
              cwd: SYNTHETIC_ROOT,
              title: "Synthetic intermediate thread",
            },
          ],
        };
      }
      if (method === "conversation_migrate_happy_session") {
        expect(params).toMatchObject({
          conversationId: providerSessionId,
          expectedHappySessionId: legacyHappySessionId,
          replacementHappySessionId,
        });
        return { migrated: true };
      }
      if (method === "provider_session_archive_lookup") return { archived: false };
      if (method === "conversation_lookup") {
        return {
          restorable: true,
          happyOrigin: true,
          retire: false,
          archived: false,
          conversationId: providerSessionId,
          agentType: "codex",
          agentSessionId: "intermediate-native",
          cwd: SYNTHETIC_ROOT,
        };
      }
      if (method === "conversation_claim") return { archived: false };
      return { conversationId: params.conversationId };
    });

    await harness.layer.start();

    expect(harness.api.deactivateSession).toHaveBeenCalledWith(
      legacyHappySessionId,
    );
    expect(sessionKeyStore.markLegacyRelayRetired).toHaveBeenCalledWith(
      providerSessionId,
    );
    expect(sessionKeyStore.clearLegacyRelayRetired).toHaveBeenCalledWith(
      providerSessionId,
    );
    expect(harness.source.spawn).toHaveBeenCalledTimes(1);
    await harness.layer.close();
  });

  it("fails startup when a persisted cursor exceeds the relay snapshot", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000985";
    const summary = {
      sessionId: providerSessionId,
      agentType: "codex",
      agentSessionId: "native-existing",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(providerSessionId, `seren-${providerSessionId}`);
    await sessionKeyStore.markReady(providerSessionId, "invalid-cursor-relay");
    await sessionKeyStore.markProcessedThroughSeq(providerSessionId, 10);
    const harness = createLayerHarness({
      initialSessions: [summary],
      sessionKeyStore,
    });
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "invalid-cursor-relay",
      metadata,
      seq: 9,
    }));

    await expect(harness.layer.start()).rejects.toThrow(
      "Persisted Happy processed sequence exceeds the relay snapshot",
    );
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(harness.supervisorNotify).toHaveBeenCalledWith("status_report", {
      state: "error",
      detail: "startup failed",
    });
    await harness.layer.close();
  });

  it.each([true, false])(
    "unwinds an earlier restore on later startup failure (owned: %s)",
    async (firstOwned) => {
    const firstProviderSessionId = "00000000-0000-4000-8000-000000000986";
    const failedProviderSessionId = "00000000-0000-4000-8000-000000000987";
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(
      firstProviderSessionId,
      `seren-${firstProviderSessionId}`,
    );
    await sessionKeyStore.markReady(firstProviderSessionId, "first-restore-relay");
    await sessionKeyStore.getOrCreate(
      failedProviderSessionId,
      `seren-${failedProviderSessionId}`,
    );
    await sessionKeyStore.markReady(failedProviderSessionId, "failed-restore-relay");
    const harness = createLayerHarness({ initialSessions: [], sessionKeyStore });
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "provider_session_archive_lookup") return { archived: false };
      if (method === "conversation_lookup") {
        return {
          restorable: true,
          happyOrigin: true,
          retire: false,
          archived: false,
          conversationId: params.providerSessionId,
          agentType: "codex",
          agentSessionId: `native-${params.providerSessionId}`,
          cwd: SYNTHETIC_ROOT,
        };
      }
      if (method === "conversation_claim") return { archived: false };
      return { conversationId: params.conversationId };
    });
    harness.source.spawn.mockImplementation(async (spec) => {
      if (spec.localSessionId === failedProviderSessionId) {
        throw new Error("synthetic exact-resume failure");
      }
      return {
        sessionId: firstProviderSessionId,
        agentType: "codex",
        agentSessionId: `native-${firstProviderSessionId}`,
        cwd: SYNTHETIC_ROOT,
        status: "ready",
        reused: !firstOwned,
        owned: firstOwned,
      };
    });
    harness.source.terminate.mockImplementation(async (sessionId) => {
      if (firstOwned && sessionId === firstProviderSessionId) {
        harness.publish({
          kind: "status",
          sessionId,
          payload: { status: "terminated" },
        });
      }
    });

    await expect(harness.layer.start()).rejects.toThrow("synthetic exact-resume failure");
    if (firstOwned) {
      expect(harness.source.terminate).toHaveBeenCalledWith(firstProviderSessionId);
    } else {
      expect(harness.source.terminate).not.toHaveBeenCalledWith(firstProviderSessionId);
    }
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(harness.supervisorNotify).toHaveBeenCalledWith("status_report", {
      state: "error",
      detail: "startup failed",
    });
    expect(harness.supervisorNotify).not.toHaveBeenCalledWith(
      "status_report",
      expect.objectContaining({ state: "connected" }),
    );
    await harness.layer.close();
    expect(harness.api.deactivateSession).not.toHaveBeenCalledWith(
      "first-restore-relay",
    );
    expect(harness.sessionKeyStore.delete).not.toHaveBeenCalledWith(
      firstProviderSessionId,
    );
    expect(await harness.sessionKeyStore.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: firstProviderSessionId,
          state: "ready",
          happySessionId: "first-restore-relay",
        }),
      ]),
    );
    },
  );

  it("claims a legacy fresh context before registering relay input and emits a reset notice", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000765";
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(providerSessionId, `seren-${providerSessionId}`);
    await sessionKeyStore.markReady(providerSessionId, "legacy-relay-session");
    const harness = createLayerHarness({ initialSessions: [], sessionKeyStore });
    const order: string[] = [];
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "legacy-relay-session",
      metadata,
      seq: 0,
    }));
    harness.source.spawn.mockImplementation(async (spec) => {
      order.push("spawn");
      return {
        sessionId: String(spec.localSessionId),
        agentType: "codex",
        agentSessionId: "fresh-native-session",
        cwd: SYNTHETIC_ROOT,
        status: "ready",
        freshContextReset: true,
        reused: false,
        owned: true,
      };
    });
    harness.api.sessionSyncClient.mockImplementation((session, options) => {
      order.push("register-relay-input");
      harness.client.lastSeq = options?.resumeFromSeq ?? 0;
      return harness.client;
    });
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "provider_session_archive_lookup") return { archived: false };
      if (method === "conversation_lookup") {
        return {
          restorable: true,
          happyOrigin: true,
          retire: false,
          archived: false,
          conversationId: providerSessionId,
          agentType: "codex",
          agentSessionId: null,
          cwd: SYNTHETIC_ROOT,
        };
      }
      if (method === "conversation_claim") {
        order.push("claim");
        expect(params.expectedAgentType).toBe("codex");
        expect(params.expectedAgentSessionId).toBeNull();
        expect(params.expectedAgentPermissionMode).toBeNull();
        expect(params.agentSessionId).toBe("fresh-native-session");
        return { archived: false };
      }
      return { conversationId: params.conversationId };
    });

    await harness.layer.start();

    expect(harness.source.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        localSessionId: providerSessionId,
        freshContextReset: true,
        suppressHistoryReplay: true,
      }),
    );
    expect(order).toEqual(["spawn", "claim", "register-relay-input"]);
    expect(harness.client.sendSessionProtocolMessage).toHaveBeenCalledTimes(1);
    await harness.layer.close();
  });

  it("starts a fresh ACP context when the saved native session cannot resume exactly", async () => {
    const providerSessionId = "00000000-0000-4000-8000-000000000766";
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(providerSessionId, `seren-${providerSessionId}`);
    await sessionKeyStore.markReady(providerSessionId, "legacy-acp-relay-session");
    const harness = createLayerHarness({ initialSessions: [], sessionKeyStore });
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "legacy-acp-relay-session",
      metadata,
      seq: 0,
    }));
    harness.source.spawn.mockImplementation(async (spec) => ({
      sessionId: String(spec.localSessionId),
      agentType: "gemini",
      agentSessionId: "fresh-acp-native-session",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
      freshContextReset: true,
      reused: false,
      owned: true,
    }));
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "provider_session_archive_lookup") return { archived: false };
      if (method === "conversation_lookup") {
        return {
          restorable: true,
          happyOrigin: true,
          retire: false,
          archived: false,
          conversationId: providerSessionId,
          agentType: "gemini",
          agentSessionId: "saved-acp-native-session",
          cwd: SYNTHETIC_ROOT,
        };
      }
      if (method === "conversation_claim") {
        expect(params).toMatchObject({
          expectedAgentType: "gemini",
          expectedAgentSessionId: "saved-acp-native-session",
          expectedAgentPermissionMode: null,
          agentSessionId: "fresh-acp-native-session",
        });
        return { archived: false };
      }
      return { conversationId: params.conversationId };
    });

    await harness.layer.start();

    expect(harness.source.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: "gemini",
        localSessionId: providerSessionId,
        freshContextReset: true,
        suppressHistoryReplay: true,
      }),
    );
    expect(harness.source.spawn).not.toHaveBeenCalledWith(
      expect.objectContaining({ requireExactResume: true }),
    );
    expect(harness.client.sendSessionProtocolMessage).toHaveBeenCalledTimes(1);
    await harness.layer.close();
  });

  it("suppresses provider history replay when reopening an existing relay row", async () => {
    const summary = {
      sessionId: "replay-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    const first = createLayerHarness({ initialSessions: [summary], sessionKeyStore });
    await first.layer.start();
    await first.layer.close();

    const restarted = createLayerHarness({ initialSessions: [summary], sessionKeyStore });
    await restarted.layer.start();
    restarted.client.sendSessionProtocolMessage.mockClear();
    restarted.client.sendAgentMessage.mockClear();

    restarted.publish({
      kind: "assistant-delta",
      sessionId: summary.sessionId,
      payload: { text: "historical", replay: true },
    });
    restarted.publish({
      kind: "turn-complete",
      sessionId: summary.sessionId,
      payload: { stopReason: "HistoryReplay", historyReplay: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(restarted.client.sendSessionProtocolMessage).not.toHaveBeenCalled();
    expect(restarted.client.sendAgentMessage).not.toHaveBeenCalled();

    restarted.publish({
      kind: "assistant-delta",
      sessionId: summary.sessionId,
      payload: { text: "live" },
    });
    restarted.publish({
      kind: "turn-complete",
      sessionId: summary.sessionId,
      payload: { stopReason: "completed" },
    });
    await vi.waitFor(() =>
      expect(restarted.client.sendSessionProtocolMessage).toHaveBeenCalled(),
    );
    await restarted.layer.close();
  });

  it("retires archived metadata before constructing a client on restart", async () => {
    const summary = {
      sessionId: "archived-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic archived session",
      status: "ready",
    };
    const machineIdentity = {
      token: "test",
      machineId: "synthetic-machine",
      encryption: {
        type: "dataKey",
        publicKey: Buffer.alloc(32, 3).toString("base64"),
        machineKey: Buffer.alloc(32, 7).toString("base64"),
      },
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    const harness = createLayerHarness({
      initialSessions: [summary],
      machineIdentity,
      sessionKeyStore,
    });
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "archived-relay-session",
      metadata: { ...metadata, lifecycleState: "archiveRequested" },
      seq: 0,
    }));

    await harness.layer.start();

    expect(harness.source.terminate).toHaveBeenCalledWith("archived-session");
    expect(harness.api.deactivateSession).toHaveBeenCalledWith("archived-relay-session");
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(harness.client.keepAlive).not.toHaveBeenCalled();
    expect(harness.supervisorCall).toHaveBeenCalledWith("conversation_archive", {
      conversationId: "archived-session",
      providerSessionId: "archived-session",
    });
    expect(sessionKeyStore.delete).toHaveBeenCalledWith("archived-session");
    await harness.layer.close();
  });

  it("retires a pre-stable Happy spawn row before creating its one-time replacement", async () => {
    const summary = {
      sessionId: "00000000-0000-4000-8000-000000000123",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic migrated session",
      status: "ready",
    };
    const order: string[] = [];
    const harness = createLayerHarness({ initialSessions: [summary] });
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "conversation_happy_session_lookup") {
        order.push("lookup");
        return { happySessionId: "pre-stable-relay-row" };
      }
      return { conversationId: params.conversationId };
    });
    harness.api.deactivateSession.mockImplementation(async (happySessionId) => {
      order.push(`deactivate:${happySessionId}`);
      return true;
    });
    harness.api.getOrCreateSession.mockImplementation(async ({ tag, metadata }) => {
      expect(tag).toMatch(/^seren-migrated-/);
      order.push("create-replacement");
      return { id: "replacement-relay-row", metadata, seq: 0 };
    });

    await harness.layer.start();

    expect(order.slice(0, 3)).toEqual([
      "lookup",
      "deactivate:pre-stable-relay-row",
      "create-replacement",
    ]);
    expect(harness.sessionKeyStore.markReady).toHaveBeenCalledWith(
      summary.sessionId,
      "replacement-relay-row",
    );
    expect(harness.sessionKeyStore.replacePendingTag).toHaveBeenCalledWith(
      summary.sessionId,
      expect.stringMatching(/^seren-migrated-/),
    );
    await harness.layer.close();
  });

  it("allows a naturally terminated provider to recover with the same desktop id", async () => {
    const summary = {
      sessionId: "00000000-0000-4000-8000-000000000992",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic recovering session",
      status: "ready",
    };
    const harness = createLayerHarness({ initialSessions: [summary] });
    let priorRelayRecorded = false;
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "conversation_happy_session_lookup") {
        return priorRelayRecorded
          ? { happySessionId: "natural-recovery-old-relay" }
          : {};
      }
      return { conversationId: params.conversationId };
    });
    harness.api.getOrCreateSession.mockImplementation(async ({ tag, metadata }) => {
      if (!priorRelayRecorded) {
        return { id: "natural-recovery-old-relay", metadata, seq: 0 };
      }
      if (tag === `seren-${summary.sessionId}`) {
        throw new Error("synthetic lost-key decrypt collision");
      }
      expect(tag).toMatch(/^seren-migrated-/);
      return { id: "natural-recovery-new-relay", metadata, seq: 0 };
    });
    await harness.layer.start();
    priorRelayRecorded = true;

    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "terminated" },
    });
    await vi.waitFor(() => expect(harness.sessionKeyStore.delete).toHaveBeenCalled());
    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    await vi.waitFor(() => expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(2));
    expect(harness.sessionKeyStore.replacePendingTag).toHaveBeenCalledWith(
      summary.sessionId,
      expect.stringMatching(/^seren-migrated-/),
    );

    await harness.layer.close();
  });

  it("retries a durable retirement before creating any client or heartbeat", async () => {
    const order: string[] = [];
    const summary = {
      sessionId: "terminal-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic terminal session",
      status: "ready",
    };
    const machineIdentity = {
      token: "test",
      machineId: "synthetic-machine",
      encryption: {
        type: "dataKey",
        publicKey: Buffer.alloc(32, 3).toString("base64"),
        machineKey: Buffer.alloc(32, 7).toString("base64"),
      },
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    const first = createLayerHarness({
      initialSessions: [summary],
      machineIdentity,
      sessionKeyStore,
    });
    first.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "terminal-relay-session",
      metadata,
      seq: 0,
    }));
    first.api.deactivateSession.mockImplementation(async () => {
      order.push("deactivate-failed");
      return false;
    });

    await first.layer.start();
    first.publish({
      kind: "status",
      sessionId: "terminal-session",
      payload: { status: "terminated" },
    });
    await vi.waitFor(() => expect(order).toContain("deactivate-failed"));
    expect(sessionKeyStore.markRetiring.mock.invocationCallOrder[0]).toBeLessThan(
      first.api.deactivateSession.mock.invocationCallOrder[0],
    );
    expect(sessionKeyStore.delete).not.toHaveBeenCalled();
    await first.layer.close();

    const restarted = createLayerHarness({
      initialSessions: [],
      machineIdentity,
      sessionKeyStore,
    });
    restarted.api.deactivateSession.mockResolvedValue(true);
    await restarted.layer.start();

    expect(restarted.api.deactivateSession).toHaveBeenCalledWith("terminal-relay-session");
    expect(sessionKeyStore.delete).toHaveBeenCalledWith("terminal-session");
    expect(restarted.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(restarted.client.keepAlive).not.toHaveBeenCalled();
    await restarted.layer.close();
  });

  it("consults the SQLite archive fence before reviving a persisted binding", async () => {
    const summary = {
      sessionId: "00000000-0000-4000-8000-000000000654",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic fenced restart",
      status: "ready",
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    const first = createLayerHarness({
      initialSessions: [summary],
      sessionKeyStore,
    });
    await first.layer.start();
    await first.layer.close();

    sessionKeyStore.markRetiring.mockClear();
    sessionKeyStore.delete.mockClear();
    const restarted = createLayerHarness({
      initialSessions: [summary],
      sessionKeyStore,
    });
    restarted.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "provider_session_archive_lookup") {
        return { archived: params.providerSessionId === summary.sessionId };
      }
      return { conversationId: params.conversationId };
    });

    await restarted.layer.start();

    expect(restarted.supervisorCall).toHaveBeenCalledWith(
      "provider_session_archive_lookup",
      { providerSessionId: summary.sessionId },
    );
    expect(sessionKeyStore.markRetiring).toHaveBeenCalledWith(
      summary.sessionId,
      "relay-session",
      false,
      true,
      undefined,
      undefined,
    );
    expect(restarted.source.terminate).toHaveBeenCalledWith(summary.sessionId);
    expect(restarted.api.sessionSyncClient).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(sessionKeyStore.delete).toHaveBeenCalledWith(summary.sessionId),
    );
    await restarted.layer.close();
  });

  it("keeps a ready binding through an empty cold-start list and resumes on the first event", async () => {
    const summary = {
      sessionId: "restored-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic restored session",
      status: "ready",
    };
    const machineIdentity = {
      token: "test",
      machineId: "synthetic-machine",
      encryption: {
        type: "dataKey",
        publicKey: Buffer.alloc(32, 3).toString("base64"),
        machineKey: Buffer.alloc(32, 7).toString("base64"),
      },
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    const seeded = createLayerHarness({
      initialSessions: [summary],
      machineIdentity,
      sessionKeyStore,
    });
    seeded.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "restored-relay-session",
      metadata,
      seq: 0,
    }));
    await seeded.layer.start();
    const originalOptions = seeded.api.getOrCreateSession.mock.calls[0]?.[0];
    await seeded.layer.close();
    sessionKeyStore.delete.mockClear();

    const restarted = createLayerHarness({
      initialSessions: [],
      machineIdentity,
      sessionKeyStore,
    });
    restarted.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "restored-relay-session",
      metadata,
      seq: 0,
    }));
    await restarted.layer.start();
    expect(restarted.api.getOrCreateSession).not.toHaveBeenCalled();
    expect(restarted.api.deactivateSession).not.toHaveBeenCalled();
    expect(sessionKeyStore.delete).not.toHaveBeenCalled();

    restarted.source.listSessions.mockResolvedValue([summary]);
    restarted.publish({
      kind: "status",
      sessionId: "restored-session",
      payload: { status: "ready" },
    });
    await vi.waitFor(() => expect(restarted.api.sessionSyncClient).toHaveBeenCalledTimes(1));
    const resumedOptions = restarted.api.getOrCreateSession.mock.calls[0]?.[0];
    expect(resumedOptions.tag).toBe(originalOptions.tag);
    expect(Buffer.from(resumedOptions.encryptionKey)).toEqual(
      Buffer.from(originalOptions.encryptionKey),
    );
    await restarted.layer.close();
  });

  it("terminates a late-restored retiring provider even after its root leaves scope", async () => {
    const summary = {
      sessionId: "late-retiring-session",
      agentType: "codex",
      cwd: `${SYNTHETIC_ROOT}-outside-advertised-roots`,
      title: "Synthetic late retiring session",
      status: "ready",
    };
    const machineIdentity = {
      token: "test",
      machineId: "synthetic-machine",
      encryption: {
        type: "dataKey",
        publicKey: Buffer.alloc(32, 3).toString("base64"),
        machineKey: Buffer.alloc(32, 7).toString("base64"),
      },
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    await sessionKeyStore.getOrCreate(summary.sessionId, `seren-${summary.sessionId}`);
    await sessionKeyStore.markReady(summary.sessionId, "late-retiring-relay");
    await sessionKeyStore.markRetiring(
      summary.sessionId,
      "late-retiring-relay",
      false,
      true,
    );
    sessionKeyStore.delete.mockClear();
    const harness = createLayerHarness({
      initialSessions: [],
      machineIdentity,
      sessionKeyStore,
    });
    harness.api.deactivateSession.mockResolvedValue(true);

    await harness.layer.start();
    expect(harness.api.deactivateSession).toHaveBeenCalledWith("late-retiring-relay");
    expect(sessionKeyStore.delete).toHaveBeenCalledWith(summary.sessionId);
    expect(harness.source.terminate).not.toHaveBeenCalled();
    expect(harness.supervisorCall).toHaveBeenCalledWith("conversation_archive", {
      conversationId: summary.sessionId,
      providerSessionId: summary.sessionId,
    });
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();

    harness.source.listSessions.mockResolvedValue([summary]);
    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    await vi.waitFor(() => expect(harness.source.terminate).toHaveBeenCalledWith(summary.sessionId));
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(harness.client.keepAlive).not.toHaveBeenCalled();
    expect(harness.api.getOrCreateSession).not.toHaveBeenCalled();
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    await harness.layer.close();
  });

  it("acknowledges identity reset only after every stored relay row is inactive", async () => {
    const summary = {
      sessionId: "reset-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic reset session",
      status: "ready",
    };
    const machineIdentity = {
      token: "test",
      machineId: "synthetic-machine",
      encryption: {
        type: "dataKey",
        publicKey: Buffer.alloc(32, 3).toString("base64"),
        machineKey: Buffer.alloc(32, 7).toString("base64"),
      },
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    const harness = createLayerHarness({
      initialSessions: [summary],
      machineIdentity,
      sessionKeyStore,
    });
    harness.api.getOrCreateSession.mockImplementation(async ({ metadata }) => ({
      id: "reset-relay-session",
      metadata,
      seq: 0,
    }));
    await harness.layer.start();

    harness.notifySupervisor("identity_reset", { requestId: "synthetic-reset-request" });
    await vi.waitFor(() =>
      expect(harness.supervisorNotify).toHaveBeenCalledWith("identity_reset_result", {
        requestId: "synthetic-reset-request",
        success: true,
      }),
    );
    expect(harness.api.deactivateSession).toHaveBeenCalledWith("reset-relay-session");
    // Rust deletes the credential and encrypted store transactionally only
    // after this acknowledgement; the bridge must not delete it early.
    expect(sessionKeyStore.delete).not.toHaveBeenCalled();
    // Once HTTP deactivation is confirmed, reset acknowledgement must not be
    // held behind an SDK socket/outbox close. Rust stops the child next.
    expect(harness.client.sendSessionDeath).not.toHaveBeenCalled();
    expect(harness.client.close).not.toHaveBeenCalled();
    await harness.layer.close();
  });

  it("rejects identity reset and retains bindings when relay retirement fails", async () => {
    const summary = {
      sessionId: "failed-reset-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic failed reset session",
      status: "ready",
    };
    const machineIdentity = {
      token: "test",
      machineId: "synthetic-machine",
      encryption: {
        type: "dataKey",
        publicKey: Buffer.alloc(32, 3).toString("base64"),
        machineKey: Buffer.alloc(32, 7).toString("base64"),
      },
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    const harness = createLayerHarness({
      initialSessions: [summary],
      machineIdentity,
      sessionKeyStore,
    });
    harness.api.deactivateSession.mockResolvedValue(false);
    await harness.layer.start();

    harness.notifySupervisor("identity_reset", { requestId: "failed-reset-request" });
    await vi.waitFor(() =>
      expect(harness.supervisorNotify).toHaveBeenCalledWith("identity_reset_result", {
        requestId: "failed-reset-request",
        success: false,
      }),
    );
    expect(sessionKeyStore.delete).not.toHaveBeenCalled();
    await harness.layer.close();
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

    let closeSettled = false;
    const close = harness.layer.close().then(() => {
      closeSettled = true;
    });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(closeSettled).toBe(false);
    resolveSession?.({});
    await close;

    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(harness.client.keepAlive).not.toHaveBeenCalled();
    expect(harness.api.deactivateSession).toHaveBeenCalledWith("late-relay-session");
  });

  it("waits for terminal retirement that removed its session before shutdown", async () => {
    const summary = {
      sessionId: "terminal-during-close",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic terminal close race",
      status: "ready",
    };
    const harness = createLayerHarness({ initialSessions: [summary] });
    await harness.layer.start();

    let resolveClientClose: (() => void) | undefined;
    harness.client.close.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveClientClose = resolve;
        }),
    );
    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "terminated" },
    });
    await vi.waitFor(() => expect(harness.client.close).toHaveBeenCalledTimes(1));

    let closeSettled = false;
    const close = harness.layer.close().then(() => {
      closeSettled = true;
    });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(closeSettled).toBe(false);
    resolveClientClose?.();
    await close;
    expect(harness.sessionKeyStore.delete).toHaveBeenCalledWith(summary.sessionId);
  });

  it("does not commit an entry when a terminal event overtakes relay creation", async () => {
    const summary = {
      sessionId: "terminal-create-race",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic terminal creation race",
      status: "ready",
    };
    const sessionKeyStore = createMemorySessionKeyStore();
    const harness = createLayerHarness({ sessionKeyStore });
    await harness.layer.start();
    harness.source.listSessions.mockResolvedValue([summary]);

    let resolveRelayLookup: (() => void) | undefined;
    const relayLookupStarted = new Promise<void>((resolveStarted) => {
      harness.api.getOrCreateSession.mockImplementation(
        ({ metadata }: { metadata: Record<string, unknown> }) => {
          resolveStarted();
          return new Promise((resolve) => {
            resolveRelayLookup = () =>
              resolve({ id: "terminal-create-race-relay", metadata, seq: 0 });
          });
        },
      );
    });
    const readBindings = sessionKeyStore.list.getMockImplementation();
    if (!readBindings) throw new Error("memory session store list implementation missing");
    let releaseTerminalBindingRead: (() => void) | undefined;
    let bindingReadCount = 0;
    const terminalBindingReadStarted = new Promise<void>((resolveStarted) => {
      sessionKeyStore.list.mockImplementation(async () => {
        bindingReadCount += 1;
        if (bindingReadCount === 2) {
          resolveStarted();
          await new Promise<void>((resolve) => {
            releaseTerminalBindingRead = resolve;
          });
        }
        return readBindings();
      });
    });

    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    await relayLookupStarted;
    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "terminated" },
    });
    await terminalBindingReadStarted;
    resolveRelayLookup?.();

    await vi.waitFor(() =>
      expect(harness.api.deactivateSession).toHaveBeenCalledWith(
        "terminal-create-race-relay",
      ),
    );
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(harness.client.keepAlive).not.toHaveBeenCalled();
    releaseTerminalBindingRead?.();
    await vi.waitFor(() =>
      expect(sessionKeyStore.delete).toHaveBeenCalledWith(summary.sessionId),
    );
    await harness.layer.close();
  });

  it("does not commit an entry whose root leaves scope during relay creation", async () => {
    const summary = {
      sessionId: "roots-create-race",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic roots creation race",
      status: "ready",
    };
    const harness = createLayerHarness();
    await harness.layer.start();
    harness.source.listSessions.mockResolvedValue([summary]);

    let resolveRelayLookup: (() => void) | undefined;
    const relayLookupStarted = new Promise<void>((resolveStarted) => {
      harness.api.getOrCreateSession.mockImplementation(
        ({ metadata }: { metadata: Record<string, unknown> }) => {
          resolveStarted();
          return new Promise((resolve) => {
            resolveRelayLookup = () =>
              resolve({ id: "roots-create-race-relay", metadata, seq: 0 });
          });
        },
      );
    });

    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    await relayLookupStarted;
    harness.notifySupervisor("roots_update", { roots: [] });
    resolveRelayLookup?.();

    await vi.waitFor(() =>
      expect(harness.api.deactivateSession).toHaveBeenCalledWith(
        "roots-create-race-relay",
      ),
    );
    expect(harness.api.sessionSyncClient).not.toHaveBeenCalled();
    expect(harness.client.keepAlive).not.toHaveBeenCalled();
    expect(harness.sessionKeyStore.delete).not.toHaveBeenCalled();
    await harness.layer.close();
  });

  it("waits for and unwinds a provider spawn that resolves during shutdown", async () => {
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
    let closeSettled = false;
    const close = harness.layer.close().then(() => {
      closeSettled = true;
    });
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(closeSettled).toBe(false);

    resolveSpawn?.({
      sessionId: "late-provider-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
    });
    await close;
    await expect(result).resolves.toEqual({
      type: "error",
      errorMessage: "Happy session closed during provider spawn",
    });
    expect(harness.source.terminate).toHaveBeenCalledWith("late-provider-session");
    expect(harness.source.terminate).toHaveBeenCalledTimes(1);
    expect(harness.client.close).toHaveBeenCalledTimes(1);
    expect(harness.sessionKeyStore.delete).toHaveBeenCalledTimes(1);
  });

  it("retires a persisted relay binding when remote entry construction fails", async () => {
    const harness = createLayerHarness();
    harness.api.sessionSyncClient.mockImplementation(() => {
      throw new Error("synthetic client construction failure");
    });
    await harness.layer.start();

    await expect(harness.spawn({ directory: SYNTHETIC_ROOT, agent: "codex" })).resolves.toEqual({
      type: "error",
      errorMessage: "synthetic client construction failure",
    });

    expect(harness.api.deactivateSession).toHaveBeenCalledWith("relay-session");
    expect(harness.source.spawn).not.toHaveBeenCalled();
    expect(await harness.sessionKeyStore.list()).toEqual([]);
    expect(harness.sessionKeyStore.delete).toHaveBeenCalledTimes(1);
    await harness.layer.close();
  });

  it("clears pending permission state when entry registration fails before retry", async () => {
    const summary = {
      sessionId: "entry-registration-retry",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic entry registration retry",
      status: "ready",
      pendingPermissions: [
        {
          requestId: "stale-request",
          options: [{ optionId: "allow_once", kind: "allow_once" }],
        },
      ],
    };
    const harness = createLayerHarness();
    await harness.layer.start();
    harness.source.listSessions.mockResolvedValue([summary]);
    harness.client.sendSessionEvent.mockImplementationOnce(() => {
      throw new Error("synthetic registration failure");
    });

    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    await vi.waitFor(() =>
      expect(harness.api.deactivateSession).toHaveBeenCalledWith("relay-session"),
    );

    const refreshTrigger = {
      sessionId: "out-of-scope-refresh-trigger",
      agentType: "codex",
      cwd: `${SYNTHETIC_ROOT}-outside-advertised-roots`,
      title: "Synthetic refresh trigger",
      status: "ready",
    };
    harness.source.listSessions.mockResolvedValue([
      { ...summary, pendingPermissions: [] },
      refreshTrigger,
    ]);
    harness.publish({
      kind: "status",
      sessionId: refreshTrigger.sessionId,
      payload: { status: "ready" },
    });
    await vi.waitFor(() =>
      expect(harness.source.listSessions).toHaveBeenCalledTimes(3),
    );
    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    await vi.waitFor(() =>
      expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(2),
    );

    await expect(
      harness.client.invokeRpc("permission", {
        requestId: "stale-request",
        optionId: "allow_once",
      }),
    ).resolves.toEqual({ ok: false });
    expect(harness.source.respondToPermission).not.toHaveBeenCalled();
    await harness.layer.close();
  });

  it("serializes entry retry behind failed registration cleanup", async () => {
    const summary = {
      sessionId: "serialized-registration-retry",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      title: "Synthetic serialized retry",
      status: "ready",
    };
    const harness = createLayerHarness();
    await harness.layer.start();
    harness.source.listSessions.mockResolvedValue([summary]);
    harness.client.sendSessionEvent.mockImplementationOnce(() => {
      throw new Error("synthetic registration failure");
    });
    let resolveCleanup: (() => void) | undefined;
    harness.client.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );

    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    await vi.waitFor(() => expect(harness.client.close).toHaveBeenCalledTimes(1));
    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(1);

    resolveCleanup?.();
    await vi.waitFor(() =>
      expect(harness.api.deactivateSession).toHaveBeenCalledWith("relay-session"),
    );
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    harness.publish({
      kind: "status",
      sessionId: summary.sessionId,
      payload: { status: "ready" },
    });
    await vi.waitFor(() =>
      expect(harness.api.sessionSyncClient).toHaveBeenCalledTimes(2),
    );
    await harness.layer.close();
  });

  it("uses one stable id for a remotely spawned relay row, conversation, and provider", async () => {
    const harness = createLayerHarness();
    await harness.layer.start();

    await expect(harness.spawn({ directory: SYNTHETIC_ROOT, agent: "codex" })).resolves.toEqual({
      type: "success",
      sessionId: "relay-session",
    });

    const relayTag = harness.api.getOrCreateSession.mock.calls[0]?.[0]?.tag;
    const conversationId = harness.supervisorCall.mock.calls.find(
      ([method]) => method === "conversation_create",
    )?.[1]?.conversationId;
    const providerId = harness.source.spawn.mock.calls[0]?.[0]?.localSessionId;
    expect(typeof conversationId).toBe("string");
    expect(relayTag).toBe(`seren-${String(conversationId)}`);
    expect(providerId).toBe(conversationId);
    expect(harness.supervisorCall).toHaveBeenCalledWith("conversation_claim", {
      conversationId,
      providerSessionId: conversationId,
      happySessionId: "relay-session",
      cwd: SYNTHETIC_ROOT,
      expectedAgentType: "codex",
      expectedAgentSessionId: null,
      expectedAgentPermissionMode: null,
      agentSessionId: "synthetic-native-session",
    });

    await harness.layer.close();
  });

  it("replays Claude readiness only after the remote spawn owns its conversation", async () => {
    let finishClaim: (() => void) | undefined;
    const claimGate = new Promise<void>((resolve) => {
      finishClaim = resolve;
    });
    const harness = createLayerHarness();
    harness.source.spawn.mockImplementation(async (spec) => ({
      sessionId: String(spec.localSessionId),
      agentType: "claude-code",
      agentSessionId: "synthetic-native-session",
      cwd: SYNTHETIC_ROOT,
      status: "initializing",
      reused: false,
      owned: true,
    }));
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "conversation_lookup") {
        return { restorable: false, happyOrigin: false, retire: false };
      }
      if (method === "conversation_claim") {
        await claimGate;
        return { archived: false };
      }
      return { conversationId: params.conversationId };
    });
    await harness.layer.start();

    const spawning = harness.spawn({ directory: SYNTHETIC_ROOT, agent: "claude" });
    await vi.waitFor(() => expect(harness.source.spawn).toHaveBeenCalled());
    const providerSessionId = String(
      harness.source.spawn.mock.calls[0]?.[0]?.localSessionId,
    );
    const processing = harness.processUserMessage(
      { role: "user", content: { type: "text", text: "after claim" } },
      1,
    );
    harness.publish({
      kind: "status",
      sessionId: providerSessionId,
      payload: { status: "ready", agentSessionId: "synthetic-native-session" },
    });
    await Promise.resolve();
    expect(harness.source.sendPrompt).not.toHaveBeenCalled();

    finishClaim?.();
    await expect(spawning).resolves.toMatchObject({ type: "success" });
    await processing;
    expect(harness.source.sendPrompt).toHaveBeenCalledWith(
      providerSessionId,
      "after claim",
    );
    await harness.layer.close();
  });

  it("preserves an archive that wins the remote spawn ownership claim", async () => {
    const harness = createLayerHarness();
    harness.source.spawn.mockImplementation(async (spec) => ({
      sessionId: String(spec.localSessionId),
      agentType: "codex",
      agentSessionId: "reused-native-session",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
      reused: true,
      owned: false,
    }));
    harness.supervisorCall.mockImplementation(async (method, params) => {
      if (method === "conversation_restore_candidates") return { candidates: [] };
      if (method === "conversation_lookup") {
        return { restorable: false, happyOrigin: false, retire: false };
      }
      if (method === "conversation_claim") return { archived: true };
      return { conversationId: params.conversationId };
    });
    await harness.layer.start();

    await expect(harness.spawn({ directory: SYNTHETIC_ROOT, agent: "codex" })).resolves.toEqual({
      type: "error",
      errorMessage: "Happy conversation was archived during provider spawn",
    });

    const conversationId = harness.supervisorCall.mock.calls.find(
      ([method]) => method === "conversation_create",
    )?.[1]?.conversationId;
    expect(harness.source.terminate).toHaveBeenCalledWith(conversationId);
    expect(harness.supervisorCall).not.toHaveBeenCalledWith(
      "conversation_delete",
      expect.anything(),
    );
    expect(harness.sessionKeyStore.delete).toHaveBeenCalledWith(conversationId);
    await harness.layer.close();
  });

  it("retries cleanup of a provider returned under an unexpected id", async () => {
    const harness = createLayerHarness();
    harness.source.spawn.mockResolvedValue({
      sessionId: "unexpected-provider-session",
      agentType: "codex",
      cwd: SYNTHETIC_ROOT,
      status: "ready",
    });
    harness.source.terminate
      .mockRejectedValueOnce(new Error("synthetic terminate interruption"))
      .mockResolvedValueOnce(undefined);
    await harness.layer.start();

    await expect(harness.spawn({ directory: SYNTHETIC_ROOT, agent: "codex" })).resolves.toEqual({
      type: "error",
      errorMessage: "provider did not preserve the preallocated session id",
    });

    expect(harness.source.terminate).toHaveBeenCalledTimes(2);
    expect(harness.source.terminate).toHaveBeenNthCalledWith(
      1,
      "unexpected-provider-session",
    );
    expect(harness.source.terminate).toHaveBeenNthCalledWith(
      2,
      "unexpected-provider-session",
    );
    expect(await harness.sessionKeyStore.list()).toEqual([]);
    await harness.layer.close();
  });

  it("rolls back the preallocated conversation when remote provider spawn fails", async () => {
    const harness = createLayerHarness();
    harness.source.spawn.mockRejectedValue(
      Object.assign(new Error("synthetic spawn failure"), {
        providerRequestRejected: true,
      }),
    );
    await harness.layer.start();

    await expect(harness.spawn({ directory: SYNTHETIC_ROOT, agent: "codex" })).resolves.toEqual({
      type: "error",
      errorMessage: "synthetic spawn failure",
    });

    const createCall = harness.supervisorCall.mock.calls.find(
      ([method]) => method === "conversation_create",
    );
    const deleteCall = harness.supervisorCall.mock.calls.find(
      ([method]) => method === "conversation_delete",
    );
    expect(deleteCall?.[1]?.conversationId).toBe(createCall?.[1]?.conversationId);
    expect(harness.api.deactivateSession).toHaveBeenCalledWith("relay-session");
    expect(harness.source.terminate).not.toHaveBeenCalled();
    expect(harness.sessionKeyStore.delete).toHaveBeenCalledWith(
      createCall?.[1]?.conversationId,
    );
    await harness.layer.close();
  });
});
