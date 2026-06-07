// ABOUTME: Webview microphone capture for the Meeting Mode "Me" stream.
// ABOUTME: Streams 16 kHz mono PCM frames to the Rust pipeline and exposes live amplitude.

import { pushCaptureFrame } from "@/services/meetings";

const TARGET_SAMPLE_RATE = 16_000;
// Flush roughly every 250 ms so the Rust chunker sees audio promptly.
const FLUSH_SAMPLES = TARGET_SAMPLE_RATE / 4;

export interface MeetingCaptureHandle {
  /** Current input amplitude in 0..1 for the recorder meter (0 on silence). */
  level: () => number;
  /** Stop capture, flush the tail, and release the microphone. */
  stop: () => Promise<void>;
}

function floatToPcm16(input: Float32Array, out: number[]): void {
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out.push(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff));
  }
}

/**
 * Begin capturing the microphone as the meeting "Me" stream. The browser
 * resamples to 16 kHz mono (the AudioContext rate), so frames are pipeline-ready.
 */
export async function startMeetingMicCapture(
  meetingId: string,
): Promise<MeetingCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const source = context.createMediaStreamSource(stream);

  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  const processor = context.createScriptProcessor(4096, 1, 1);
  // Route the processor through a muted gain so onaudioprocess fires without
  // playing the microphone back through the speakers.
  const mute = context.createGain();
  mute.gain.value = 0;

  let buffer: number[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const frame = buffer;
    buffer = [];
    void pushCaptureFrame({
      meetingId,
      speaker: "me",
      samples: frame,
      channels: 1,
      // Report the context's real rate; the WebView may ignore the 16 kHz
      // request and the Rust pipeline resamples whatever rate it receives.
      sampleRate: context.sampleRate,
    });
  };

  processor.onaudioprocess = (event) => {
    floatToPcm16(event.inputBuffer.getChannelData(0), buffer);
    if (buffer.length >= FLUSH_SAMPLES) {
      flush();
    }
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);

  const timeData = new Uint8Array(analyser.frequencyBinCount);
  const level = () => {
    analyser.getByteTimeDomainData(timeData);
    let sum = 0;
    for (let i = 0; i < timeData.length; i += 1) {
      const centered = (timeData[i] - 128) / 128;
      sum += centered * centered;
    }
    return Math.min(1, Math.sqrt(sum / timeData.length) * 3);
  };

  const stop = async () => {
    processor.onaudioprocess = null;
    flush();
    processor.disconnect();
    mute.disconnect();
    analyser.disconnect();
    source.disconnect();
    for (const track of stream.getTracks()) {
      track.stop();
    }
    await context.close();
  };

  return { level, stop };
}
