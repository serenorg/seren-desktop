// ABOUTME: Regression test for #2403 — a failed LLM cleanup must not discard captured dictation.
// ABOUTME: Drives the real useVoiceInput hook with cleanup enabled and a throwing cleanup call.

import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const stopSpy = vi.fn(async () => "um hello there");
  const startMock = vi.fn(async () => ({ stop: stopSpy, level: () => 0 }));
  const cleanupMock = vi.fn(async () => {
    throw new Error("provider one-shot returned no content");
  });
  return { stopSpy, startMock, cleanupMock };
});

vi.mock("@/lib/audio/dictationCapture", () => ({
  startDictationCapture: h.startMock,
}));
vi.mock("@/services/dictation", () => ({
  cleanupDictationText: h.cleanupMock,
  transformSelection: vi.fn(),
  transcribePcm: vi.fn(),
}));
vi.mock("@/stores/provider.store", () => ({
  providerStore: { resolvedModel: () => "model" },
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: {
    get: (key: string) =>
      key === "voiceCleanupEnabled"
        ? true
        : key === "voiceCustomVocabulary"
          ? []
          : false,
  },
}));

import { useVoiceInput } from "@/lib/audio/useVoiceInput";

describe("useVoiceInput cleanup failure (#2403)", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn() },
      platform: "MacIntel",
    });
    h.startMock.mockClear();
    h.stopSpy.mockClear();
    h.cleanupMock.mockClear();
  });

  it("inserts the raw transcript when LLM cleanup throws", async () => {
    await createRoot(async (dispose) => {
      const inserted: string[] = [];
      const voice = useVoiceInput((text) => inserted.push(text));

      await voice.startRecording();
      await voice.stopRecording();

      // Cleanup was attempted and threw, yet the captured speech survives.
      expect(h.cleanupMock).toHaveBeenCalledTimes(1);
      expect(inserted).toEqual(["um hello there"]);
      expect(voice.voiceState()).toBe("idle");
      dispose();
    });
  });
});
