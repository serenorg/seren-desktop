// ABOUTME: Webview microphone capture for the Meeting Mode "Me" stream.
// ABOUTME: Streams microphone PCM frames to the Rust pipeline and exposes live amplitude.

import { createRunningAudioContext } from "@/lib/audio/captureContext";
import { connectPulledScriptProcessor } from "@/lib/audio/scriptProcessor";
import { pushCaptureFrame } from "@/services/meetings";

// Flush roughly every 250 ms so the Rust chunker sees audio promptly.
const FLUSH_SECONDS = 0.25;

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
 * Begin capturing the microphone as the meeting "Me" stream. Use the hardware
 * context rate and let Rust normalize frames to the pipeline's 16 kHz mono rate.
 */
export async function startMeetingMicCapture(
  meetingId: string,
): Promise<MeetingCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  let context: AudioContext;
  try {
    context = await createRunningAudioContext();
  } catch (error) {
    // Release the mic we just opened so a failed start can't leave it live.
    for (const track of stream.getTracks()) {
      track.stop();
    }
    throw error;
  }
  const source = context.createMediaStreamSource(stream);

  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  const flushSamples = Math.max(
    1,
    Math.floor(context.sampleRate * FLUSH_SECONDS),
  );

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
      // Report the context's real hardware rate so Rust can resample accurately.
      sampleRate: context.sampleRate,
    });
  };

  const processor = connectPulledScriptProcessor(context, source, (event) => {
    floatToPcm16(event.inputBuffer.getChannelData(0), buffer);
    if (buffer.length >= flushSamples) {
      flush();
    }
  });

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
    analyser.disconnect();
    source.disconnect();
    for (const track of stream.getTracks()) {
      track.stop();
    }
    await context.close();
  };

  return { level, stop };
}
