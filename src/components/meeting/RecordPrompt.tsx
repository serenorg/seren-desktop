// ABOUTME: Compact titlebar prompt offering to record when input activity is detected.
// ABOUTME: Capture entry point for meeting mode, not push-to-talk.

interface RecordPromptProps {
  /** Start recording the detected conversation. */
  onRecord: () => void;
  /** Dismiss; won't re-nag for the same running app this session. */
  onDismiss: () => void;
  /** Best-effort app label from the native audio activity probe. */
  sourceApp?: string | null;
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
  const appLabel = () => props.sourceApp?.trim() || "Voice app";

  return (
    <div
      class="flex h-9 w-[clamp(300px,42vw,440px)] min-w-0 items-center gap-2 rounded-lg border border-accent/55 bg-popover px-2 shadow-[0_0_0_1px_rgba(56,189,248,0.12),0_8px_24px_rgba(0,0,0,0.32)] backdrop-blur-sm animate-[fadeIn_200ms_ease]"
      aria-label="Record detected conversation"
    >
      <span class="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <span class="absolute h-2 w-2 rounded-full bg-accent-foreground/75 animate-[voicePulse_1.4s_ease-in-out_infinite]" />
        <MicGlyph />
      </span>
      <div class="flex min-w-0 flex-1 flex-col leading-tight">
        <span class="truncate text-[12px] font-medium text-foreground">
          Call detected
        </span>
        <span class="truncate text-[10px] text-muted-foreground">
          {appLabel()}
        </span>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          class="h-7 rounded-md border border-accent bg-accent px-2.5 text-[11px] font-medium text-accent-foreground transition-colors hover:bg-primary-hover"
          onClick={() => props.onRecord()}
        >
          Take notes
        </button>
        <button
          type="button"
          class="h-7 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent/15 hover:text-foreground"
          onClick={() => props.onDismiss()}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
