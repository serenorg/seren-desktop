// ABOUTME: Frontend service wrappers for the dictation Tauri commands.
// ABOUTME: Keeps PCM transcription and the shared LLM cleanup/transform IPC out of Solid components.

import { invoke } from "@tauri-apps/api/core";

export interface PcmChunk {
  samples: number[];
  channels: number;
  sampleRate: number;
}

/**
 * Transcribe a single dictation PCM chunk to text. Returns "" for silence.
 */
export function transcribePcm(chunk: PcmChunk): Promise<string> {
  return invoke("transcribe_pcm", {
    samples: chunk.samples,
    channels: chunk.channels,
    sampleRate: chunk.sampleRate,
  });
}

/**
 * Run raw dictation text through the shared Rust LLM cleanup engine.
 * Honors the active model and the user's custom vocabulary.
 */
export function cleanupDictationText(
  text: string,
  model: string,
  vocabulary: string[],
): Promise<string> {
  return invoke("cleanup_dictation_text", { text, model, vocabulary });
}
