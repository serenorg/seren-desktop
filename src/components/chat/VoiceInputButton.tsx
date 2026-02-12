// ABOUTME: Microphone button for voice-to-text input in chat panels.
// ABOUTME: Captures audio via MediaRecorder and transcribes via Seren Whisper publisher.

import { createEffect, onCleanup, Show } from "solid-js";
import { useVoiceInput } from "@/lib/audio/useVoiceInput";
import { settingsStore } from "@/stores/settings.store";

interface VoiceInputButtonProps {
  onTranscript: (text: string) => void;
  mode?: "chat" | "agent";
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
    <div class="flex items-center gap-0.5 relative">
      <button
        type="button"
        class="flex items-center justify-center w-8 h-8 border-none rounded-md bg-transparent text-muted-foreground cursor-pointer transition-all duration-150 relative shrink-0 hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        classList={{
          "text-destructive bg-[rgba(248,113,113,0.1)]":
            voiceState() === "recording",
          "text-muted-foreground cursor-wait": voiceState() === "transcribing",
          "text-destructive": voiceState() === "error",
        }}
        onClick={toggle}
        disabled={voiceState() === "transcribing"}
        title={title()}
      >
        <Show when={voiceState() === "transcribing"} fallback={<MicIcon />}>
          <div class="w-4 h-4 border-2 border-surface-3 border-t-muted-foreground rounded-full animate-spin" />
        </Show>
        <Show when={voiceState() === "recording"}>
          <div class="absolute top-1 right-1 w-2 h-2 rounded-full bg-destructive animate-[voicePulse_1s_ease-in-out_infinite]" />
        </Show>
        <Show when={voiceState() === "error" && error()}>
          <div class="absolute bottom-[calc(100%+8px)] right-0 bg-surface-2 border border-surface-3 rounded-md px-2.5 py-1.5 text-xs text-destructive whitespace-nowrap pointer-events-none z-[100]">
            {error()}
          </div>
        </Show>
      </button>
      <button
        type="button"
        class="voice-auto-submit-toggle flex items-center justify-center w-5 h-5 border-none rounded bg-transparent text-status-idle cursor-pointer transition-all duration-150 p-0 shrink-0 hover:bg-surface-2 hover:text-muted-foreground"
        classList={{
          "active text-success hover:bg-[rgba(52,211,153,0.1)] hover:text-success":
            autoSubmit(),
        }}
        onClick={toggleAutoSubmit}
        data-tooltip={
          autoSubmit()
            ? `Auto-send voice to ${props.mode ?? "chat"} on`
            : `Auto-send voice to ${props.mode ?? "chat"} off`
        }
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="currentColor"
          aria-label="Auto-send toggle"
          role="img"
        >
          <path d="M.989 8 .064 2.68a1.342 1.342 0 0 1 1.85-1.462l13.402 5.744a1.13 1.13 0 0 1 0 2.076L1.913 14.782a1.343 1.343 0 0 1-1.85-1.463L.99 8Zm.603-5.288L2.38 7.25h4.87a.75.75 0 0 1 0 1.5H2.38l-.788 4.538L13.929 8Z" />
        </svg>
      </button>
    </div>
  );
}
