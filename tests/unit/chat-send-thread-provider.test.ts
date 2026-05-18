// ABOUTME: Pins the per-thread provider-binding contract on chat sends.
// ABOUTME: sendMessage/streamMessage take an explicit provider arg; the
// ABOUTME: global providerStore must not silently override the caller.

import { describe, expect, it, vi } from "vitest";

const sendProviderMessageMock = vi.hoisted(() => vi.fn());
const streamProviderMessageMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/providers", () => ({
  buildChatRequest: vi.fn((content: string, model: string) => ({
    messages: [{ role: "user", content }],
    model,
  })),
  sendProviderMessage: sendProviderMessageMock,
  streamProviderMessage: streamProviderMessageMock,
}));

// providerStore is still imported by services/chat for other call sites
// (getActiveProvider / private-chat gating). The send paths must not
// fall back to its value when an explicit provider is passed.
vi.mock("@/stores/provider.store", () => ({
  providerStore: {
    activeProvider: "seren",
    activeModel: "anthropic/claude-sonnet-4",
  },
}));

vi.mock("@/stores/auth.store", () => ({
  authStore: { isAuthenticated: false, privateChatPolicy: null },
}));
vi.mock("@/stores/conversation.store", () => ({
  conversationStore: { conversations: [] },
}));
vi.mock("@/stores/fileTree", () => ({
  fileTreeState: { rootPath: null },
}));
vi.mock("@/stores/project.store", () => ({
  projectStore: { activeProject: null },
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: { get: () => false },
  getActiveToolsetPublishers: () => [],
}));
vi.mock("@/stores/skills.store", () => ({
  skillsStore: { getThreadSkills: () => [] },
}));
vi.mock("@/services/memory", () => ({
  storeAssistantResponse: vi.fn(),
}));
vi.mock("@/services/mcp-gateway", () => ({
  getCallablePublisherSlugs: () => [],
  getGatewayTools: () => [],
  isGatewayInitInFlight: () => false,
  isGatewayInitialized: () => true,
  waitForGatewayReady: vi.fn(),
}));
vi.mock("@/lib/indexing/context-retrieval", () => ({
  retrieveCodeContext: vi.fn(),
}));
vi.mock("@/lib/images/attachments", () => ({
  isTextMime: () => false,
  toDataUrl: () => "",
}));
vi.mock("@/lib/tools", () => ({
  executeTools: vi.fn(),
  getAllTools: () => [],
}));
vi.mock("@/lib/providers/seren", () => ({
  sendMessageWithTools: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { sendMessage, streamMessage } from "@/services/chat";

describe("chat send paths route to the explicitly-passed provider", () => {
  it("sendMessage routes to the provider argument, ignoring global default", async () => {
    sendProviderMessageMock.mockResolvedValueOnce("reply");

    await sendMessage(
      "hello",
      "anthropic/claude-sonnet-4",
      "seren-private",
    );

    expect(sendProviderMessageMock).toHaveBeenCalledWith(
      "seren-private",
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4",
      }),
    );
  });

  it("streamMessage routes to the provider argument, ignoring global default", async () => {
    streamProviderMessageMock.mockReturnValueOnce(
      (async function* () {
        yield "chunk";
      })(),
    );

    const gen = streamMessage(
      "hello",
      "anthropic/claude-sonnet-4",
      "seren-private",
    );
    // Consume the generator to trigger the call.
    for await (const _ of gen) {
      void _;
    }

    expect(streamProviderMessageMock).toHaveBeenCalledWith(
      "seren-private",
      expect.objectContaining({
        model: "anthropic/claude-sonnet-4",
        stream: true,
      }),
    );
  });
});
