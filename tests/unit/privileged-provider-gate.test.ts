// ABOUTME: Pins the static provider boundary used by Privileged Matter Mode.
// ABOUTME: Covers the deny-by-default helper plus selector and send-path references.

import { describe, expect, it, vi } from "vitest";
import { readSource } from "./source-text";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/lib/browser-local-runtime", () => ({
  isLocalProviderRuntime: () => false,
  onRuntimeEvent: vi.fn(),
  runtimeInvoke: vi.fn(),
}));

vi.mock("@/lib/runtime", () => ({
  runtimeHasCapability: () => false,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: () => false,
}));

import {
  CONFIDENTIAL_SAFE_PROVIDERS,
  assertPrivilegedConversationProvider,
  isConfidentialSafeProvider,
} from "@/services/providers";

describe("Privileged Matter provider gate", () => {
  it("denies non-allowlisted providers and permits only loopback LM Studio", () => {
    expect(CONFIDENTIAL_SAFE_PROVIDERS).toEqual(["lmstudio"]);
    expect(
      isConfidentialSafeProvider("lmstudio", {
        lmStudioBaseUrl: "http://localhost:1234",
      }),
    ).toBe(true);
    expect(
      isConfidentialSafeProvider("lmstudio", {
        lmStudioBaseUrl: "https://remote.example.invalid",
      }),
    ).toBe(false);
    expect(() =>
      assertPrivilegedConversationProvider("p1", true, "openai"),
    ).toThrow("Privileged Matter Mode blocks openai");
    expect(() =>
      assertPrivilegedConversationProvider("p1", true, "lmstudio", {
        lmStudioBaseUrl: "http://127.0.0.1:1234",
      }),
    ).not.toThrow();
  });

  it("uses the same static allowlist in selector and send paths", () => {
    expect(readSource("src/components/chat/ModelSelector.tsx")).toContain(
      "isConfidentialSafeProvider",
    );
    expect(readSource("src/services/orchestrator.ts")).toContain(
      "assertPrivilegedConversationProvider",
    );
    expect(readSource("src/components/chat/ChatContent.tsx")).toContain(
      "assertPrivilegedConversationProvider",
    );
    expect(readSource("src/stores/agent.store.ts")).toContain(
      "assertPrivilegedConversationProvider",
    );
  });
});
