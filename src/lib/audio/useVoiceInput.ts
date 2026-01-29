// ABOUTME: SolidJS hook for microphone recording and speech-to-text transcription.
// ABOUTME: Manages MediaRecorder lifecycle, audio capture, and Whisper API calls.

import { createSignal, onCleanup } from "solid-js";
import { transcribeAudio } from "@/services/seren-whisper";

export type VoiceState = "idle" | "recording" | "transcribing" | "error";

export function useVoiceInput(onTranscript: (text: string) => void) {
  const [voiceState, setVoiceState] = createSignal<VoiceState>("idle");
  const [error, setError] = createSignal<string | null>(null);

  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];

  async function startRecording() {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunks = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: "audio/webm" });
        chunks = [];

        if (blob.size === 0) {
          setVoiceState("idle");
          return;
        }

        setVoiceState("transcribing");
        try {
          const text = await transcribeAudio(blob);
          if (text.trim()) {
            onTranscript(text.trim());
          }
          setVoiceState("idle");
        } catch (err) {
          setError(err instanceof Error ? err.message : "Transcription failed");
          setVoiceState("error");
        }
      };

      recorder.start();
      setVoiceState("recording");
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access denied. Please allow microphone access in your browser settings."
          : err instanceof Error
            ? err.message
            : "Failed to start recording";
      setError(message);
      setVoiceState("error");
    }
  }

  function stopRecording() {
    if (recorder?.state === "recording") {
      recorder.stop();
    }
  }

  function toggle() {
    if (voiceState() === "recording") {
      stopRecording();
    } else {
      startRecording();
    }
  }

  function clearError() {
    setError(null);
    setVoiceState("idle");
  }

  onCleanup(() => {
    if (recorder?.state === "recording") {
      recorder.stream.getTracks().forEach((t) => t.stop());
      recorder.stop();
    }
  });

  return { voiceState, error, toggle, clearError };
}
