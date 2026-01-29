// ABOUTME: Microphone button for voice-to-text input in chat panels.
// ABOUTME: Captures audio via MediaRecorder and transcribes via Seren Whisper publisher.

import { createEffect, onCleanup, Show } from "solid-js";
import { useVoiceInput } from "@/lib/audio/useVoiceInput";
import "./VoiceInputButton.css";

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
}

function MicIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-label="Microphone"
      role="img"
    >
      <path d="M8 10a2 2 0 0 0 2-2V4a2 2 0 1 0-4 0v4a2 2 0 0 0 2 2Z" />
      <path d="M4.5 7a.5.5 0 0 0-1 0 4.5 4.5 0 0 0 4 4.473V13.5H6a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H8.5v-2.027A4.5 4.5 0 0 0 12.5 7a.5.5 0 0 0-1 0 3.5 3.5 0 1 1-7 0Z" />
    </svg>
  );
}

export function VoiceInputButton(props: VoiceInputButtonProps) {
  const { voiceState, error, toggle, clearError } = useVoiceInput(
    props.onTranscript,
  );

  let errorTimer: ReturnType<typeof setTimeout> | undefined;

  createEffect(() => {
    if (voiceState() === "error") {
      clearTimeout(errorTimer);
      errorTimer = setTimeout(clearError, 3000);
    }
  });

  onCleanup(() => clearTimeout(errorTimer));

  const title = (): string => {
    const state = voiceState();
    if (state === "recording") return "Stop recording";
    if (state === "transcribing") return "Transcribing...";
    if (state === "error") return error() || "Voice input error";
    return "Voice input";
  };

  return (
    <button
      type="button"
      class="voice-input-btn"
      data-state={voiceState()}
      onClick={toggle}
      disabled={voiceState() === "transcribing"}
      title={title()}
    >
      <Show when={voiceState() === "transcribing"} fallback={<MicIcon />}>
        <div class="voice-spinner" />
      </Show>
      <Show when={voiceState() === "recording"}>
        <div class="voice-recording-dot" />
      </Show>
      <Show when={voiceState() === "error" && error()}>
        <div class="voice-error-tooltip">{error()}</div>
      </Show>
    </button>
  );
}
