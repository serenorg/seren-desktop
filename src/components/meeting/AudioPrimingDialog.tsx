// ABOUTME: First-run pre-permission explainer for Meeting Mode audio capture.
// ABOUTME: Tells the user why Seren needs system audio + mic before the OS prompt.

import type { Component } from "solid-js";

interface AudioPrimingDialogProps {
  onContinue: () => void;
  onCancel: () => void;
}

function SystemAudioGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="currentColor"
      role="img"
      aria-label="System audio"
    >
      <path d="M8.5 2.2a.6.6 0 0 0-.96-.47L4.7 4H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.7l2.84 2.27a.6.6 0 0 0 .96-.47V2.2Z" />
      <path d="M11 5.4a.5.5 0 0 1 .7.07A4 4 0 0 1 11.7 10.5a.5.5 0 1 1-.78-.62 3 3 0 0 0 0-3.76.5.5 0 0 1 .08-.72Z" />
    </svg>
  );
}

function MicGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="currentColor"
      role="img"
      aria-label="Microphone"
    >
      <path d="M8 10a2 2 0 0 0 2-2V4a2 2 0 1 0-4 0v4a2 2 0 0 0 2 2Z" />
      <path d="M4.5 7a.5.5 0 0 0-1 0 4.5 4.5 0 0 0 4 4.47V13.5H6a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H8.5v-2.03A4.5 4.5 0 0 0 12.5 7a.5.5 0 0 0-1 0 3.5 3.5 0 1 1-7 0Z" />
    </svg>
  );
}

export const AudioPrimingDialog: Component<AudioPrimingDialogProps> = (
  props,
) => {
  const handleBackdropClick = (event: MouseEvent) => {
    if (event.target === event.currentTarget) {
      props.onCancel();
    }
  };

  return (
    <div
      class="fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] animate-[fadeIn_0.15s_ease-out]"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
      aria-label="Before we start recording"
    >
      <div class="bg-surface-1 border border-border rounded-lg w-[420px] max-w-[90vw] shadow-xl animate-[slideUp_0.2s_ease-out]">
        <div class="px-5 pt-5 pb-4 border-b border-border">
          <h2 class="m-0 text-[15px] font-semibold text-foreground">
            Before we start recording
          </h2>
          <p class="mt-1.5 text-[13px] text-muted-foreground leading-relaxed">
            Seren captures both sides of the conversation so notes cover what
            everyone said. Your system will ask for permission next.
          </p>
        </div>

        <div class="p-5 space-y-3">
          <div class="flex items-start gap-3">
            <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-foreground">
              <SystemAudioGlyph />
            </span>
            <div class="min-w-0">
              <div class="text-[13px] font-medium text-foreground">
                System audio
              </div>
              <div class="text-[12px] text-muted-foreground leading-relaxed">
                Records what the other participants say through your speakers.
              </div>
            </div>
          </div>
          <div class="flex items-start gap-3">
            <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-surface-2 text-foreground">
              <MicGlyph />
            </span>
            <div class="min-w-0">
              <div class="text-[13px] font-medium text-foreground">
                Microphone
              </div>
              <div class="text-[12px] text-muted-foreground leading-relaxed">
                Records your voice. Audio is transcribed and never stored.
              </div>
            </div>
          </div>
        </div>

        <div class="flex justify-end gap-2 px-5 py-4 border-t border-border">
          <button
            type="button"
            class="h-8 px-3 rounded-md border border-border bg-surface-2 text-[12px] text-foreground hover:bg-surface-3 transition-colors"
            onClick={props.onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            class="h-8 px-3 rounded-md border border-primary/40 bg-primary/10 text-[12px] text-primary hover:bg-primary/15 transition-colors"
            onClick={props.onContinue}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
};
