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
    let stream: MediaStream | null = null;
    try {
      setError(null);

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone access is not available. Please ensure the app has microphone permission in System Settings > Privacy & Security > Microphone.",
        );
      }

      activeMimeType = getSupportedMimeType();
      const options: MediaRecorderOptions = activeMimeType
        ? { mimeType: activeMimeType }
        : {};
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recorder = new MediaRecorder(stream, options);
      chunks = [];

      recorder.ondataavailable = (e) => {
        console.log("[VoiceInput] ondataavailable, size:", e.data.size);
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        console.log("[VoiceInput] onstop fired, chunks:", chunks.length);
        stream?.getTracks().forEach((t) => t.stop());
        const mimeType = activeMimeType || "audio/webm";
        const blob = new Blob(chunks, { type: mimeType });
        chunks = [];

        console.log("[VoiceInput] Blob size:", blob.size, "type:", mimeType);
        if (blob.size === 0) {
          console.log("[VoiceInput] Empty blob, returning to idle");
          setVoiceState("idle");
          return;
        }

        setVoiceState("transcribing");
        try {
          console.log("[VoiceInput] Sending blob for transcription");
          const text = await transcribeAudio(blob, mimeType);
          console.log("[VoiceInput] Transcription result:", JSON.stringify(text), "type:", typeof text);
          if (text?.trim()) {
            console.log("[VoiceInput] Calling onTranscript with:", text.trim());
            onTranscript(text.trim());
          } else {
            console.log("[VoiceInput] No text returned from transcription");
          }
          setVoiceState("idle");
        } catch (err) {
          console.error("[VoiceInput] Transcription error:", err);
          setError(err instanceof Error ? err.message : "Transcription failed");
          setVoiceState("error");
        }
      };

      recorder.start();
      console.log("[VoiceInput] Recording started, mimeType:", activeMimeType);
      setVoiceState("recording");
    } catch (err) {
      stream?.getTracks().forEach((t) => t.stop());
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
    console.log("[VoiceInput] stopRecording called, state:", recorder?.state);
    if (recorder?.state === "recording") {
      recorder.stop();
    }
  }

  function toggle() {
    console.log("[VoiceInput] toggle called, voiceState:", voiceState());
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
