// ABOUTME: SolidJS hook for streaming microphone dictation with live partial transcripts.
// ABOUTME: Drives transcribe_pcm chunking and the shared LLM cleanup engine, preserving its toggle API.

import { createSignal, onCleanup } from "solid-js";
import {
  type DictationCaptureHandle,
  startDictationCapture,
} from "@/lib/audio/dictationCapture";
import { cleanupDictationText } from "@/services/dictation";
import { providerStore } from "@/stores/provider.store";
import { settingsStore } from "@/stores/settings.store";

export type VoiceState = "idle" | "listening" | "transcribing" | "error";

/**
 * Get platform-appropriate instructions for enabling microphone access.
 */
function getMicrophonePermissionInstructions(): string {
  const platform = navigator.platform.toLowerCase();
  if (platform.includes("mac")) {
    return "System Settings > Privacy & Security > Microphone";
  }
  if (platform.includes("win")) {
    return "Settings > Privacy > Microphone";
  }
  // Linux or other
  return "your system settings";
}

export interface VoiceInputOptions {
  /** Fired with each transcribed chunk while listening (live partial text). */
  onPartial?: (text: string) => void;
}

/**
 * Stream microphone audio to the dictation pipeline. `onTranscript` receives
 * the final (optionally LLM-cleaned) text after the user stops; `onPartial`
 * (via options) receives live chunks as the user speaks.
 */
export function useVoiceInput(
  onTranscript: (text: string) => void,
  options: VoiceInputOptions = {},
) {
  const [voiceState, setVoiceState] = createSignal<VoiceState>("idle");
  const [error, setError] = createSignal<string | null>(null);

  let capture: DictationCaptureHandle | null = null;
  // A start is awaiting getUserMedia; `stopRequested` is set if a stop (a fast
  // push-to-talk tap, blur, or cleanup) arrives before that resolves so the
  // pending handle is torn down on arrival instead of leaking the live mic.
  let starting = false;
  let stopRequested = false;

  async function startRecording() {
    // Don't overwrite a live handle or launch a second concurrent start; either
    // would orphan a MediaStream with no stopper (the #2161 leak).
    if (starting || capture) return;
    starting = true;
    stopRequested = false;
    try {
      setError(null);

      if (!navigator.mediaDevices?.getUserMedia) {
        const instructions = getMicrophonePermissionInstructions();
        throw new Error(
          `Microphone access is not available. Please ensure the app has microphone permission in ${instructions}.`,
        );
      }

      const handle = await startDictationCapture((partial) => {
        options.onPartial?.(partial);
      });
      if (stopRequested) {
        // A stop landed while we were acquiring the mic: release it now and
        // never publish the handle, so the OS mic indicator goes dark.
        stopRequested = false;
        await handle.stop().catch(() => {});
        setVoiceState("idle");
        return;
      }
      capture = handle;
      setVoiceState("listening");
    } catch (err) {
      console.error("[VoiceInput] startRecording error:", err);
      let message: string;
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        const instructions = getMicrophonePermissionInstructions();
        message = `Microphone access denied. Please allow microphone access in ${instructions}.`;
      } else if (err instanceof DOMException && err.name === "NotFoundError") {
        message =
          "No microphone found. Please connect a microphone and try again.";
      } else if (err instanceof Error) {
        message = err.message;
      } else {
        message = "Failed to start recording";
      }
      setError(message);
      setVoiceState("error");
    } finally {
      starting = false;
    }
  }

  async function stopRecording() {
    if (starting && !capture) {
      // The start is still acquiring the mic; flag it so startRecording tears
      // the handle down on arrival rather than publishing a stream nobody stops.
      stopRequested = true;
      setVoiceState("idle");
      return;
    }
    const handle = capture;
    capture = null;
    if (!handle) {
      setVoiceState("idle");
      return;
    }

    setVoiceState("transcribing");
    try {
      const raw = await handle.stop();
      const trimmed = raw.trim();
      if (!trimmed) {
        setVoiceState("idle");
        return;
      }

      // Cleanup only polishes already-captured speech. If the LLM cleanup
      // throws (empty provider completion, a fail-closed tool/permission abort
      // on Codex/Gemini, or transport failure) or returns nothing, fall back to
      // the raw transcript — never discard the user's words because the polish
      // step failed. #2403.
      let transcript = trimmed;
      if (settingsStore.get("voiceCleanupEnabled")) {
        try {
          const cleaned = await cleanupDictationText(
            trimmed,
            providerStore.resolvedModel(),
            settingsStore.get("voiceCustomVocabulary"),
          );
          if (cleaned.trim()) {
            transcript = cleaned;
          }
        } catch (err) {
          console.warn(
            "[VoiceInput] cleanup failed; inserting raw transcript:",
            err,
          );
        }
      }

      if (transcript.trim()) {
        onTranscript(transcript.trim());
      }
      setVoiceState("idle");
    } catch (err) {
      console.error("[VoiceInput] transcription error:", err);
      setError(err instanceof Error ? err.message : "Transcription failed");
      setVoiceState("error");
    }
  }

  /** Current capture amplitude in 0..1 (0 when not listening). */
  function level(): number {
    return capture?.level() ?? 0;
  }

  function toggle() {
    const state = voiceState();
    if (state === "listening") {
      void stopRecording();
    } else if (state === "idle" || state === "error") {
      clearError();
      void startRecording();
    }
  }

  function clearError() {
    setError(null);
    setVoiceState("idle");
  }

  onCleanup(() => {
    // Also cancel a start that's still in flight, so an unmount mid-acquisition
    // releases the mic instead of leaking it.
    stopRequested = true;
    if (capture) {
      void capture.stop();
      capture = null;
    }
  });

  return {
    voiceState,
    error,
    toggle,
    clearError,
    startRecording,
    stopRecording,
    level,
  };
}
