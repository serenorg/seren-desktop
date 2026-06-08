// ABOUTME: Regression test for #2161 — a push-to-talk tap (stop before getUserMedia resolves) must not leak the mic.
// ABOUTME: Drives the real useVoiceInput hook with a controllable capture promise.

import { createRoot } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state: { resolve?: (value: unknown) => void } = {};
  const stopSpy = vi.fn(async () => "");
  const startMock = vi.fn(
    () =>
      new Promise((resolve) => {
        state.resolve = resolve;
      }),
  );
  return { state, stopSpy, startMock };
});

vi.mock("@/lib/audio/dictationCapture", () => ({
  startDictationCapture: h.startMock,
}));
vi.mock("@/services/dictation", () => ({
  cleanupDictationText: vi.fn(async (text: string) => text),
  transformSelection: vi.fn(),
  transcribePcm: vi.fn(),
}));
vi.mock("@/stores/provider.store", () => ({
  providerStore: { resolvedModel: () => "model" },
}));
vi.mock("@/stores/settings.store", () => ({
  settingsStore: { get: () => false },
}));

import { useVoiceInput } from "@/lib/audio/useVoiceInput";

describe("useVoiceInput push-to-talk tap race (#2161)", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn() },
      platform: "MacIntel",
    });
    h.startMock.mockClear();
    h.stopSpy.mockClear();
    h.state.resolve = undefined;
  });

  it("releases the mic when stop arrives before getUserMedia resolves", async () => {
    await createRoot(async (dispose) => {
      const voice = useVoiceInput(() => {});

      // Fast tap: start, then stop before the capture promise resolves.
      const startPromise = voice.startRecording();
      await voice.stopRecording();
      expect(voice.voiceState()).toBe("idle");

      // The mic finally becomes available — after the user already let go.
      h.state.resolve?.({ stop: h.stopSpy, level: () => 0 });
      await startPromise;

      // The pending handle must be torn down, never published.
      expect(h.stopSpy).toHaveBeenCalledTimes(1);
      expect(voice.level()).toBe(0);
      expect(voice.voiceState()).toBe("idle");
      dispose();
    });
  });

  it("ignores a second start while one is already acquiring the mic", async () => {
    await createRoot(async (dispose) => {
      const voice = useVoiceInput(() => {});

      const first = voice.startRecording();
      const second = voice.startRecording(); // guarded: must be a no-op
      h.state.resolve?.({ stop: h.stopSpy, level: () => 0.5 });
      await Promise.all([first, second]);

      expect(h.startMock).toHaveBeenCalledTimes(1);
      expect(voice.voiceState()).toBe("listening");
      dispose();
    });
  });
});
