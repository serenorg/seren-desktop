// ABOUTME: Verifies createRunningAudioContext resumes the context and fails loudly
// ABOUTME: when WKWebView leaves it suspended — the root cause of silent capture (#2194).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRunningAudioContext } from "@/lib/audio/captureContext";

let resumeTargetState: AudioContextState;
const instances: FakeAudioContext[] = [];

class FakeAudioContext {
  sampleRate: number;
  state: AudioContextState = "suspended";
  resume = vi.fn(async () => {
    this.state = resumeTargetState;
  });
  close = vi.fn(async () => {});

  constructor(options: { sampleRate: number }) {
    this.sampleRate = options.sampleRate;
    instances.push(this);
  }
}

beforeEach(() => {
  resumeTargetState = "running";
  instances.length = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRunningAudioContext", () => {
  it("resumes a suspended context and returns it running", async () => {
    const context = await createRunningAudioContext(16_000);

    expect(context.state).toBe("running");
    expect(context.sampleRate).toBe(16_000);
    const fake = context as unknown as FakeAudioContext;
    expect(fake.resume).toHaveBeenCalledOnce();
    expect(fake.close).not.toHaveBeenCalled();
  });

  it("throws and closes the context when it cannot leave suspended", async () => {
    resumeTargetState = "suspended";

    await expect(createRunningAudioContext(16_000)).rejects.toThrow(/suspended/);
    expect(instances).toHaveLength(1);
    expect(instances[0].close).toHaveBeenCalledOnce();
  });
});
