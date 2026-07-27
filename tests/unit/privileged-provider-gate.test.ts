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
    expect(CONFIDENTIAL_SAFE_PROVIDERS).toEqual(["lmstudio", "seren-private"]);
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
    ).toThrow("Privacy Mode blocks openai");
    expect(() =>
      assertPrivilegedConversationProvider("p1", true, "lmstudio", {
        lmStudioBaseUrl: "http://127.0.0.1:1234",
      }),
    ).not.toThrow();
  });

  it("permits Seren Private Models only with a verified no-training/no-retention attestation", () => {
    // Allowed only when the org policy attests no-training/no-retention.
    expect(
      isConfidentialSafeProvider("seren-private", {
        serenPrivateModelsAttested: true,
      }),
    ).toBe(true);
    // Fails closed when the attestation is absent or unverified.
    expect(isConfidentialSafeProvider("seren-private", {})).toBe(false);
    expect(
      isConfidentialSafeProvider("seren-private", {
        serenPrivateModelsAttested: false,
      }),
    ).toBe(false);
    // The gate lets an attested private model through and blocks it otherwise.
    expect(() =>
      assertPrivilegedConversationProvider("p1", true, "seren-private", {
        serenPrivateModelsAttested: true,
      }),
    ).not.toThrow();
    expect(() =>
      assertPrivilegedConversationProvider("p1", true, "seren-private", {
        serenPrivateModelsAttested: false,
      }),
    ).toThrow("Privacy Mode blocks seren-private");
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
