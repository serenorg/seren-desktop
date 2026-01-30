// ABOUTME: Microphone button for voice-to-text input in chat panels.
// ABOUTME: Captures audio via MediaRecorder and transcribes via Seren Whisper publisher.

import { createEffect, onCleanup, Show } from "solid-js";
import { useVoiceInput } from "@/lib/audio/useVoiceInput";
import { settingsStore } from "@/stores/settings.store";
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

  const autoSubmit = () => settingsStore.get("voiceAutoSubmit");

  const toggleAutoSubmit = (e: MouseEvent) => {
    e.stopPropagation();
    settingsStore.set("voiceAutoSubmit", !autoSubmit());
  };

  return (
    <div class="voice-input-group">
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
      <button
        type="button"
        class="voice-auto-submit-toggle"
        classList={{ active: autoSubmit() }}
        onClick={toggleAutoSubmit}
        data-tooltip={autoSubmit() ? "Auto-send on" : "Auto-send off"}
      >
        <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-label="Auto-send toggle" role="img">
          <path d="M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13.402 5.744a1.13 1.13 0 0 1 0 2.076L1.913 14.782a1.343 1.343 0 0 1-1.85-1.463L.99 8Zm.603-5.288L2.38 7.25h4.87a.75.75 0 0 1 0 1.5H2.38l-.788 4.538L13.929 8Z" />
        </svg>
      </button>
    </div>
  );
}
