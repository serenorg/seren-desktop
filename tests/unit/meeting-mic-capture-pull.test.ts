// ABOUTME: Regression coverage for #2221 macOS Meeting capture producing zero PCM.
// ABOUTME: Ensures the mic ScriptProcessor is pulled directly and reports hardware rate.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  pushCaptureFrame: vi.fn(async () => {}),
}));

vi.mock("@/services/meetings", () => ({
  pushCaptureFrame: m.pushCaptureFrame,
}));

import { startMeetingMicCapture } from "@/lib/audio/meetingCapture";

const instances: FakeAudioContext[] = [];

class FakeAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeAnalyser extends FakeAudioNode {
  fftSize = 0;
  frequencyBinCount = 4;
  getByteTimeDomainData = vi.fn((target: Uint8Array) => {
    target.fill(128);
  });
}

class FakeScriptProcessor extends FakeAudioNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;
}

class FakeAudioContext {
  options: AudioContextOptions | undefined;
  sampleRate = 48_000;
  state: AudioContextState = "suspended";
  destination = new FakeAudioNode();
  source = new FakeAudioNode();
  analyser = new FakeAnalyser();
  processor = new FakeScriptProcessor();
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {});
  createMediaStreamSource = vi.fn(() => this.source);
  createAnalyser = vi.fn(() => this.analyser);
  createScriptProcessor = vi.fn(() => this.processor);

  constructor(options?: AudioContextOptions) {
    this.options = options;
    instances.push(this);
  }
}

function audioProcessEvent(input: Float32Array, output: Float32Array) {
  return {
    inputBuffer: {
      getChannelData: vi.fn(() => input),
    },
    outputBuffer: {
      numberOfChannels: 1,
      getChannelData: vi.fn(() => output),
    },
  } as unknown as AudioProcessingEvent;
}

beforeEach(() => {
  instances.length = 0;
  m.pushCaptureFrame.mockClear();
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn() }],
      })),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startMeetingMicCapture", () => {
  it("pulls the processor directly to destination and flushes using the real sample rate", async () => {
    const handle = await startMeetingMicCapture("m1");
    const context = instances[0];
    const input = new Float32Array(4096).fill(0.5);
    const output = new Float32Array(4096).fill(0.25);

    expect(context.source.connect).toHaveBeenCalledWith(context.processor);
    expect(context.processor.connect).toHaveBeenCalledWith(context.destination);
    expect(context.options).toBeUndefined();

    for (let i = 0; i < 2; i += 1) {
      context.processor.onaudioprocess?.(audioProcessEvent(input, output));
    }
    expect(m.pushCaptureFrame).not.toHaveBeenCalled();

    context.processor.onaudioprocess?.(audioProcessEvent(input, output));

    expect([...output]).toEqual(Array(4096).fill(0));
    expect(m.pushCaptureFrame).toHaveBeenCalledOnce();
    const sent = m.pushCaptureFrame.mock.calls[0][0];
    expect(sent).toMatchObject({
      meetingId: "m1",
      speaker: "me",
      channels: 1,
      sampleRate: 48_000,
    });
    expect(sent.samples).toHaveLength(12_288);
    expect(sent.samples[0]).toBe(16_384);

    await handle.stop();
    expect(context.processor.onaudioprocess).toBeNull();
    expect(context.processor.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });
});
