// ABOUTME: Streaming webview microphone capture for dictation.
// ABOUTME: Transcribes ~1.5s chunks (or on silence) via transcribe_pcm and emits live partial text.

import { transcribePcm } from "@/services/dictation";

const TARGET_SAMPLE_RATE = 16_000;
// Transcribe roughly every 1.5s of audio so text appears live as the user speaks.
const CHUNK_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 1.5);
// A short run of quiet samples ends a phrase early so partials feel responsive.
const SILENCE_RMS = 0.012;
const SILENCE_FLUSH_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.6);
// Never fire a chunk on a tiny sliver of audio (avoids empty/garbled partials).
const MIN_FLUSH_SAMPLES = Math.floor(TARGET_SAMPLE_RATE * 0.4);

export interface DictationCaptureHandle {
  /** Current input amplitude in 0..1 for the HUD meter (0 on silence). */
  level: () => number;
  /** Stop capture, flush the tail, release the mic, and return the full raw transcript. */
  stop: () => Promise<string>;
}

function floatToPcm16(input: Float32Array, out: number[]): void {
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out.push(Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff));
  }
}

function frameRms(input: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    sum += input[i] * input[i];
  }
  return Math.sqrt(sum / Math.max(1, input.length));
}

/**
 * Begin streaming the microphone for dictation. The browser resamples to
 * 16 kHz mono (the AudioContext rate), so frames are pipeline-ready. Each
 * flushed chunk is transcribed and surfaced through `onPartial`; transcripts
 * are serialized so the concatenated result stays in order.
 */
export async function startDictationCapture(
  onPartial: (text: string) => void,
): Promise<DictationCaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });

  const context = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const source = context.createMediaStreamSource(stream);

  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  const processor = context.createScriptProcessor(4096, 1, 1);
  // Route through a muted gain so onaudioprocess fires without echoing the mic.
  const mute = context.createGain();
  mute.gain.value = 0;

  let buffer: number[] = [];
  let quietSamples = 0;
  // Serialized chain of transcription work; stop() awaits this before the tail.
  let pending: Promise<void> = Promise.resolve();
  let transcript = "";

  const queueTranscription = (frame: number[]) => {
    pending = pending.then(async () => {
      try {
        const text = await transcribePcm({
          samples: frame,
          channels: 1,
          sampleRate: TARGET_SAMPLE_RATE,
        });
        const trimmed = text.trim();
        if (trimmed) {
          transcript = transcript ? `${transcript} ${trimmed}` : trimmed;
          onPartial(trimmed);
        }
      } catch (err) {
        console.error("[dictationCapture] transcribe chunk failed:", err);
      }
    });
  };

  const flush = () => {
    if (buffer.length < MIN_FLUSH_SAMPLES) return;
    const frame = buffer;
    buffer = [];
    quietSamples = 0;
    queueTranscription(frame);
  };

  processor.onaudioprocess = (event) => {
    const channel = event.inputBuffer.getChannelData(0);
    floatToPcm16(channel, buffer);

    if (frameRms(channel) < SILENCE_RMS) {
      quietSamples += channel.length;
    } else {
      quietSamples = 0;
    }

    if (
      buffer.length >= CHUNK_SAMPLES ||
      (quietSamples >= SILENCE_FLUSH_SAMPLES &&
        buffer.length >= MIN_FLUSH_SAMPLES)
    ) {
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

  const stop = async (): Promise<string> => {
    processor.onaudioprocess = null;
    // Flush whatever remains, even if shorter than the usual minimum.
    if (buffer.length > 0) {
      const frame = buffer;
      buffer = [];
      queueTranscription(frame);
    }
    processor.disconnect();
    mute.disconnect();
    analyser.disconnect();
    source.disconnect();
    for (const track of stream.getTracks()) {
      track.stop();
    }
    await context.close();
    // Wait for every queued chunk (including the tail) to resolve.
    await pending;
    return transcript;
  };

  return { level, stop };
}
