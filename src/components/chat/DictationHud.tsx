// ABOUTME: Bottom-center, audio-reactive dictation capsule with push-to-talk and edit-by-voice.
// ABOUTME: Streams live transcript into the active composer; hold right Option/Alt to talk.

import { createSignal, Index, onCleanup, onMount, Show } from "solid-js";
import {
  type DictationCaptureHandle,
  startDictationCapture,
} from "@/lib/audio/dictationCapture";
import { useVoiceInput } from "@/lib/audio/useVoiceInput";
import { transformSelection } from "@/services/dictation";
import { providerStore } from "@/stores/provider.store";
import { settingsStore } from "@/stores/settings.store";

// Right Option (macOS) / right Alt (Win/Linux) is the push-to-talk hold key.
const PUSH_TO_TALK_CODE = "AltRight";
const BAR_COUNT = 5;
// Edit-by-voice listens this long for a spoken instruction before transforming.
const EDIT_LISTEN_MS = 3500;

interface DictationHudProps {
  /** Resolve the composer textarea so transcripts write at the cursor. */
  getTextarea: () => HTMLTextAreaElement | undefined;
  /** Only the active/focused thread's HUD listens and renders. */
  active: boolean;
}

/**
 * Write `next` into the textarea and notify Solid via a native input event so
 * the composer's bound signal/store stays the source of truth.
 */
function writeTextarea(
  textarea: HTMLTextAreaElement,
  next: string,
  caret: number,
): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  setter?.call(textarea, next);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
  textarea.setSelectionRange(caret, caret);
}

function MicGlyph() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-label="Dictation"
      role="img"
    >
      <path d="M8 10a2 2 0 0 0 2-2V4a2 2 0 1 0-4 0v4a2 2 0 0 0 2 2Z" />
      <path d="M4.5 7a.5.5 0 0 0-1 0 4.5 4.5 0 0 0 4 4.473V13.5H6a.5.5 0 0 0 0 1h4a.5.5 0 0 0 0-1H8.5v-2.027A4.5 4.5 0 0 0 12.5 7a.5.5 0 0 0-1 0 3.5 3.5 0 1 1-7 0Z" />
    </svg>
  );
}

function WandGlyph() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-label="Edit by voice"
      role="img"
    >
      <path d="M9.5 1.5a.5.5 0 0 1 .5.5l.41 1.09L11.5 4a.5.5 0 0 1 0 .94l-1.09.41L10 6.5a.5.5 0 0 1-.94 0l-.41-1.09L7.5 4.94a.5.5 0 0 1 0-.94l1.15-.41L9.06 2A.5.5 0 0 1 9.5 1.5ZM3.05 6.5a.5.5 0 0 1 .7 0l5.75 5.75a.5.5 0 0 1 0 .7l-1.3 1.3a.5.5 0 0 1-.7 0L1.75 8.5a.5.5 0 0 1 0-.7l1.3-1.3Zm.35 1.4-.6.6L7.5 13.6l.6-.6L3.4 7.9Z" />
    </svg>
  );
}

export function DictationHud(props: DictationHudProps) {
  // 0..1 amplitudes for the reactive bars while listening.
  const [bars, setBars] = createSignal<number[]>(new Array(BAR_COUNT).fill(0));
  const [editing, setEditing] = createSignal(false);
  const [editError, setEditError] = createSignal<string | null>(null);

  let rafId: number | undefined;
  let holding = false;
  let editErrorTimer: ReturnType<typeof setTimeout> | undefined;
  // The edit-by-voice mic handle, tracked so onCleanup/onBlur can release it —
  // it is acquired outside useVoiceInput, so the #2161 guard doesn't cover it (#2173).
  let editCapture: DictationCaptureHandle | null = null;

  // Span [start, end) of the text this dictation session has written. Partials
  // grow `end`; the final cleaned text replaces the whole span (no double-insert).
  let sessionStart = 0;
  let sessionEnd = 0;
  let sessionLive = "";

  const beginSession = () => {
    const textarea = props.getTextarea();
    if (!textarea) return;
    sessionStart = textarea.selectionStart;
    sessionEnd = sessionStart;
    sessionLive = "";
  };

  const replaceSession = (text: string) => {
    const textarea = props.getTextarea();
    if (!textarea) return;
    const value = textarea.value;
    const next = value.slice(0, sessionStart) + text + value.slice(sessionEnd);
    sessionEnd = sessionStart + text.length;
    writeTextarea(textarea, next, sessionEnd);
  };

  const appendPartial = (partial: string) => {
    sessionLive = sessionLive ? `${sessionLive} ${partial}` : partial;
    replaceSession(sessionLive);
  };

  const settleFinal = (text: string) => {
    // Swap the live span for the cleaned final; if nothing changed, keep as-is.
    if (text) replaceSession(text);
  };

  const { voiceState, error, startRecording, stopRecording, level } =
    useVoiceInput(settleFinal, { onPartial: appendPartial });

  const isListening = () => voiceState() === "listening";

  const animate = () => {
    const amp = level();
    setBars((prev) => {
      const next = prev.slice(1);
      // Center bars taller than edges for a natural waveform shape.
      next.push(Math.min(1, amp * (0.6 + Math.random() * 0.8)));
      return next;
    });
    rafId = requestAnimationFrame(animate);
  };

  const stopAnimation = () => {
    if (rafId !== undefined) {
      cancelAnimationFrame(rafId);
      rafId = undefined;
    }
    setBars(new Array(BAR_COUNT).fill(0));
  };

  const beginHold = () => {
    if (holding || editing()) return;
    holding = true;
    beginSession();
    void startRecording();
    rafId = requestAnimationFrame(animate);
  };

  const endHold = () => {
    if (!holding) return;
    holding = false;
    stopAnimation();
    void stopRecording();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    // Only the active thread's HUD reacts, so one keypress drives one capture.
    if (!props.active) return;
    if (event.code !== PUSH_TO_TALK_CODE || event.repeat) return;
    beginHold();
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code !== PUSH_TO_TALK_CODE) return;
    endHold();
  };

  const releaseEditCapture = () => {
    if (editCapture) {
      void editCapture.stop().catch(() => {});
      editCapture = null;
    }
  };

  const onBlur = () => {
    // Window lost focus mid-hold or mid-edit: stop cleanly so the mic is released.
    if (holding) endHold();
    releaseEditCapture();
  };

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
    stopAnimation();
    clearTimeout(editErrorTimer);
    // Unmount during the edit-by-voice listen window: release the mic now
    // instead of waiting out EDIT_LISTEN_MS (#2173).
    releaseEditCapture();
  });

  const flashEditError = (message: string) => {
    setEditError(message);
    clearTimeout(editErrorTimer);
    editErrorTimer = setTimeout(() => setEditError(null), 3000);
  };

  // Edit-by-voice: capture a short spoken instruction, transform the current
  // textarea selection in place. Scoped to the chat composer textarea only.
  const runEditByVoice = async () => {
    // Bail if a push-to-talk hold is starting too: `holding` flips synchronously
    // in beginHold, before voiceState reaches "listening", so guarding on
    // isListening() alone leaves a window where both acquire the mic (#2173).
    if (editing() || isListening() || holding) return;
    const textarea = props.getTextarea();
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selection = textarea.value.slice(start, end);
    if (!selection.trim()) {
      flashEditError("Select text to edit by voice");
      return;
    }

    setEditing(true);
    setEditError(null);
    try {
      editCapture = await startDictationCapture(() => {});
      await new Promise((resolve) => setTimeout(resolve, EDIT_LISTEN_MS));
      // onBlur/onCleanup may have stopped and cleared the handle while we waited.
      const handle = editCapture;
      editCapture = null;
      if (!handle) return;
      const instruction = (await handle.stop()).trim();
      if (!instruction) {
        flashEditError("No instruction heard");
        return;
      }

      const replacement = await transformSelection(
        selection,
        instruction,
        providerStore.resolvedModel(),
        settingsStore.get("voiceCustomVocabulary"),
      );

      const value = textarea.value;
      const next = value.slice(0, start) + replacement + value.slice(end);
      writeTextarea(textarea, next, start + replacement.length);
    } catch (err) {
      console.error("[DictationHud] edit-by-voice failed:", err);
      flashEditError(
        err instanceof Error ? err.message : "Edit by voice failed",
      );
    } finally {
      // Released early (error during acquire/wait): make sure the mic is freed.
      releaseEditCapture();
      setEditing(false);
    }
  };

  const statusLabel = () => {
    if (editing()) return "Editing selection…";
    if (voiceState() === "transcribing") return "Transcribing…";
    if (isListening()) return "Listening…";
    if (voiceState() === "error") return error() || "Voice error";
    return "Hold ⌥ to dictate";
  };

  const busy = () => isListening() || editing();

  return (
    <Show when={props.active}>
      <div class="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
        <div
          class="pointer-events-auto flex items-center gap-2.5 rounded-full border border-border bg-surface-2/95 px-3.5 py-2 shadow-lg backdrop-blur-sm transition-colors duration-200"
          classList={{
            "border-accent/60 shadow-[0_4px_20px_var(--accent)]": isListening(),
            "border-success/60": editing(),
          }}
        >
          <span
            class="flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors"
            classList={{
              "bg-accent/15 text-accent": isListening(),
              "bg-success/15 text-success": editing(),
            }}
          >
            <Show
              when={voiceState() === "transcribing" || editing()}
              fallback={<MicGlyph />}
            >
              <span class="h-3 w-3 animate-spin rounded-full border-2 border-surface-3 border-t-current" />
            </Show>
          </span>

          <Show
            when={isListening()}
            fallback={
              <span
                class="text-xs font-medium text-muted-foreground transition-colors"
                classList={{ "text-success": editing() }}
              >
                {statusLabel()}
              </span>
            }
          >
            <div class="flex h-5 items-center gap-[3px]">
              <Index each={bars()}>
                {(amp) => (
                  <span
                    class="w-[3px] rounded-full bg-accent transition-[height] duration-75"
                    style={{ height: `${Math.max(10, amp() * 100)}%` }}
                  />
                )}
              </Index>
            </div>
          </Show>

          <button
            type="button"
            class="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-transparent text-muted-foreground transition-colors hover:bg-surface-3 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            classList={{ "border-success/60 text-success": editing() }}
            disabled={busy()}
            onClick={() => void runEditByVoice()}
            title="Edit selection by voice"
          >
            <WandGlyph />
          </button>

          <Show when={editError()}>
            <div class="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-xs text-destructive">
              {editError()}
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
