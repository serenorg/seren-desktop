// ABOUTME: Streaming webview microphone capture for dictation.
// ABOUTME: Transcribes ~1.5s chunks (or on silence) via transcribe_pcm and emits live partial text.

import { createRunningAudioContext } from "@/lib/audio/captureContext";
import { connectPulledScriptProcessor } from "@/lib/audio/scriptProcessor";
import { transcribePcm } from "@/services/dictation";

// Transcribe roughly every 1.5s of audio so text appears live as the user speaks.
const CHUNK_SECONDS = 1.5;
// A short run of quiet samples ends a phrase early so partials feel responsive.
const SILENCE_RMS = 0.012;
const SILENCE_FLUSH_SECONDS = 0.6;
// Never fire a chunk on a tiny sliver of audio (avoids empty/garbled partials).
const MIN_FLUSH_SECONDS = 0.4;

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
 * Begin streaming the microphone for dictation. Use the hardware context rate
 * and let Rust normalize frames before transcription. Each flushed chunk is
 * transcribed and surfaced through `onPartial`; transcripts are serialized so
 * the concatenated result stays in order.
 */
export async function startDictationCapture(
  onPartial: (text: string) => void,
): Promise<DictationCaptureHandle> {
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

  const chunkSamples = Math.floor(context.sampleRate * CHUNK_SECONDS);
  const silenceFlushSamples = Math.floor(
    context.sampleRate * SILENCE_FLUSH_SECONDS,
  );
  const minFlushSamples = Math.floor(context.sampleRate * MIN_FLUSH_SECONDS);

  let buffer: number[] = [];
  let quietSamples = 0;
  // True once the current buffer has seen any frame above the speech threshold.
  // Pure-silence buffers are dropped instead of uploaded — whisper-1 hallucinates
  // Korean MBC sign-offs and "Thank you." on non-speech audio (#2349).
  let bufferHasSpeech = false;
  // Serialized chain of transcription work; stop() awaits this before the tail.
  let pending: Promise<void> = Promise.resolve();
  let transcript = "";

  const queueTranscription = (frame: number[]) => {
    pending = pending.then(async () => {
      try {
        const text = await transcribePcm({
          samples: frame,
          channels: 1,
          // Report the context's real hardware rate so Rust can resample accurately.
          sampleRate: context.sampleRate,
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
    if (buffer.length < minFlushSamples) return;
    const frame = buffer;
    const hadSpeech = bufferHasSpeech;
    buffer = [];
    quietSamples = 0;
    bufferHasSpeech = false;
    if (!hadSpeech) return;
    queueTranscription(frame);
  };

  const processor = connectPulledScriptProcessor(context, source, (event) => {
    const channel = event.inputBuffer.getChannelData(0);
    floatToPcm16(channel, buffer);

    if (frameRms(channel) < SILENCE_RMS) {
      quietSamples += channel.length;
    } else {
      quietSamples = 0;
      bufferHasSpeech = true;
    }

    if (
      buffer.length >= chunkSamples ||
      (quietSamples >= silenceFlushSamples && buffer.length >= minFlushSamples)
    ) {
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

  const stop = async (): Promise<string> => {
    processor.onaudioprocess = null;
    // Flush whatever remains, even if shorter than the usual minimum — but only
    // when the tail buffer actually contains speech. Sending pure silence here
    // is the dominant source of the slow stop-to-result tail (#2349).
    if (buffer.length > 0 && bufferHasSpeech) {
      const frame = buffer;
      buffer = [];
      bufferHasSpeech = false;
      queueTranscription(frame);
    }
    processor.disconnect();
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
