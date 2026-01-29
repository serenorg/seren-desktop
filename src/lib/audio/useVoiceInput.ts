// ABOUTME: SolidJS hook for microphone recording and speech-to-text transcription.
// ABOUTME: Manages MediaRecorder lifecycle, audio capture, and Whisper API calls.

import { createSignal, onCleanup } from "solid-js";
import { transcribeAudio } from "@/services/seren-whisper";

export type VoiceState = "idle" | "recording" | "transcribing" | "error";

const MIME_PREFERENCES = ["audio/webm", "audio/mp4", "audio/ogg"];

function getSupportedMimeType(): string {
  for (const mime of MIME_PREFERENCES) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return "";
}

export function useVoiceInput(onTranscript: (text: string) => void) {
  const [voiceState, setVoiceState] = createSignal<VoiceState>("idle");
  const [error, setError] = createSignal<string | null>(null);

  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let activeMimeType = "";

  async function startRecording() {
    try {
      setError(null);
      activeMimeType = getSupportedMimeType();
      const options: MediaRecorderOptions = activeMimeType
        ? { mimeType: activeMimeType }
        : {};
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorder = new MediaRecorder(stream, options);
      chunks = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const mimeType = activeMimeType || "audio/webm";
        const blob = new Blob(chunks, { type: mimeType });
        chunks = [];

        if (blob.size === 0) {
          setVoiceState("idle");
          return;
        }

        setVoiceState("transcribing");
        try {
          const text = await transcribeAudio(blob, mimeType);
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
    } else if (voiceState() === "idle" || voiceState() === "error") {
      clearError();
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
