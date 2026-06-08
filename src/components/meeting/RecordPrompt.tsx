// ABOUTME: App-wide, non-modal prompt offering to record when a call app is detected.
// ABOUTME: Granola-style "Record this conversation?" — the capture entry point, not push-to-talk.

interface RecordPromptProps {
  /** Start recording the detected conversation. */
  onRecord: () => void;
  /** Dismiss; won't re-nag for the same running app this session. */
  onDismiss: () => void;
}

function MicGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-label="Record"
      role="img"
    >
      <path d="M8 10a2 2 0 0 0 2-2V4a2 2 0 1 0-4 0v4a2 2 0 0 0 2 2Z" />
      <path d="M4.5 7a.5.5 0 0 0-1 0 4.5 4.5 0 0 0 4 4.473V13.5H6a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H8.5v-2.027A4.5 4.5 0 0 0 12.5 7a.5.5 0 0 0-1 0 3.5 3.5 0 1 1-7 0Z" />
    </svg>
  );
}

export function RecordPrompt(props: RecordPromptProps) {
  return (
    <div class="pointer-events-none fixed bottom-6 right-6 z-50">
      <div class="pointer-events-auto flex items-center gap-3 rounded-xl border border-border bg-surface-2/95 px-4 py-3 shadow-lg backdrop-blur-sm animate-[fadeIn_200ms_ease]">
        <span class="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
          <span class="absolute h-2.5 w-2.5 rounded-full bg-accent animate-[voicePulse_1.4s_ease-in-out_infinite]" />
          <MicGlyph />
        </span>
        <div class="flex min-w-0 flex-col">
          <span class="text-[13px] font-medium text-foreground">
            Record this conversation?
          </span>
          <span class="text-[11px] text-muted-foreground">
            A call looks active — capture a transcript &amp; notes.
          </span>
        </div>
        <div class="ml-2 flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            class="h-7 rounded-md border border-accent/50 bg-accent/15 px-3 text-[12px] font-medium text-accent transition-colors hover:bg-accent/25"
            onClick={() => props.onRecord()}
          >
            Record
          </button>
          <button
            type="button"
            class="h-7 rounded-md px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground"
            onClick={() => props.onDismiss()}
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
