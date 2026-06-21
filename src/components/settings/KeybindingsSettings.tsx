// ABOUTME: Editable keyboard shortcut settings backed by the central keybinding registry.
// ABOUTME: Renders key-cap chips, live recording, conflict hints, search, and per-row reset.

import {
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import {
  eventToKeyStroke,
  getDefaultKeybindingBindings,
  getKeybindingBindings,
  getKeybindingDefinition,
  getKeybindingSequences,
  getKeybindingStrokeTokens,
  isKeybindingModified,
  type KeybindingActionId,
  type KeybindingBinding,
  type KeybindingDefinition,
  type KeybindingSequence,
  type KeyStroke,
  keybindingConflicts,
  keybindingSequencesEqual,
  resetAllKeybindings,
  resetKeybinding,
  setKeybindingBindings,
} from "@/stores/keybindings.store";

interface ShortcutSectionConfig {
  title: string;
  description: string;
  layout: "rows" | "grid";
  ids: KeybindingActionId[];
}

const WORKSPACE_SWITCH_IDS = Array.from(
  { length: 10 },
  (_, index) => `workspace.switch${index + 1}` as KeybindingActionId,
);

const SHORTCUT_SECTIONS: ShortcutSectionConfig[] = [
  {
    title: "App",
    description: "Top-level navigation, panels, and file actions.",
    layout: "rows",
    ids: [
      "global.focusChat",
      "global.openSettings",
      "global.toggleSidebar",
      "global.closePanel",
      "global.focusEditor",
      "global.openFiles",
      "global.newChat",
      "global.newTerminal",
    ],
  },
  {
    title: "Workspace Switching",
    description: "Cycle workspaces or jump to a numbered one. 0 maps to 10.",
    layout: "grid",
    ids: ["workspace.next", "workspace.previous", ...WORKSPACE_SWITCH_IDS],
  },
  {
    title: "Pane Navigation",
    description: "Move focus between panes without changing their layout.",
    layout: "grid",
    ids: [
      "pane.focusLeft",
      "pane.focusRight",
      "pane.focusUp",
      "pane.focusDown",
      "pane.focusPrevious",
      "pane.focusNext",
    ],
  },
  {
    title: "Pane Layout",
    description:
      "Split, zoom, resize, or close panes. Terminal panes include terminal-app aliases.",
    layout: "rows",
    ids: [
      "pane.splitRight",
      "pane.splitDown",
      "pane.zoom",
      "pane.resizeLeft",
      "pane.resizeRight",
      "pane.resizeUp",
      "pane.resizeDown",
      "pane.close",
    ],
  },
];

function uniqueSequences(
  sequences: KeybindingSequence[],
): KeybindingSequence[] {
  return sequences.reduce<KeybindingSequence[]>((acc, sequence) => {
    if (
      !acc.some((candidate) => keybindingSequencesEqual(candidate, sequence))
    ) {
      acc.push(sequence);
    }
    return acc;
  }, []);
}

function bindingsEqual(
  left: KeybindingBinding,
  right: KeybindingBinding,
): boolean {
  return (
    left.context === right.context &&
    left.platform === right.platform &&
    keybindingSequencesEqual(left.sequence, right.sequence)
  );
}

function uniqueBindings(bindings: KeybindingBinding[]): KeybindingBinding[] {
  return bindings.reduce<KeybindingBinding[]>((acc, binding) => {
    if (!acc.some((candidate) => bindingsEqual(candidate, binding))) {
      acc.push(binding);
    }
    return acc;
  }, []);
}

function settingsSequences(id: KeybindingActionId): KeybindingSequence[] {
  return uniqueSequences([
    ...getKeybindingSequences(id, { terminalPaneFocused: false }),
    ...getKeybindingSequences(id, { terminalPaneFocused: true }),
  ]);
}

function settingsBindings(id: KeybindingActionId): KeybindingBinding[] {
  return uniqueBindings([
    ...getKeybindingBindings(id, { terminalPaneFocused: false }),
    ...getKeybindingBindings(id, { terminalPaneFocused: true }),
  ]);
}

function defaultSettingsBindings(id: KeybindingActionId): KeybindingBinding[] {
  return uniqueBindings([
    ...getDefaultKeybindingBindings(id, { terminalPaneFocused: false }),
    ...getDefaultKeybindingBindings(id, { terminalPaneFocused: true }),
  ]);
}

function bindingScopeLabel(binding: KeybindingBinding): string | null {
  if (binding.context === "terminal") return "Terminal panes";
  if (binding.context === "non-terminal") return "Non-terminal panes";
  return null;
}

/** One physical key rendered as a raised key-cap. */
function KeyCap(props: { children: JSX.Element; tone?: "default" | "accent" }) {
  return (
    <kbd
      class={`inline-flex h-[1.45rem] min-w-[1.45rem] items-center justify-center rounded-[5px] border border-b-2 px-1.5 font-sans text-[0.72rem] font-medium leading-none ${
        props.tone === "accent"
          ? "border-accent/60 bg-accent/15 text-foreground"
          : "border-border-strong bg-surface-3 text-foreground"
      }`}
    >
      {props.children}
    </kbd>
  );
}

/** A full chord (or multi-stroke sequence) rendered as key-caps. */
function KeyCombo(props: {
  sequence: KeybindingSequence;
  tone?: "default" | "accent";
}) {
  return (
    <span class="inline-flex flex-wrap items-center gap-1">
      <For each={props.sequence}>
        {(stroke, strokeIndex) => (
          <>
            <Show when={strokeIndex() > 0}>
              <span class="px-0.5 text-[0.68rem] uppercase tracking-wide text-muted-foreground">
                then
              </span>
            </Show>
            <span class="inline-flex items-center gap-[3px]">
              <For each={getKeybindingStrokeTokens(stroke)}>
                {(token, tokenIndex) => (
                  <>
                    <Show when={tokenIndex() > 0}>
                      <span class="text-[0.6rem] text-muted-foreground">+</span>
                    </Show>
                    <KeyCap tone={props.tone}>{token}</KeyCap>
                  </>
                )}
              </For>
            </span>
          </>
        )}
      </For>
    </span>
  );
}

type RecordingIndex = number | "new";

interface RecordingTarget {
  id: KeybindingActionId;
  index: RecordingIndex;
}

export function KeybindingsSettings() {
  const [recordingTarget, setRecordingTarget] =
    createSignal<RecordingTarget | null>(null);
  const [pendingStroke, setPendingStroke] = createSignal<KeyStroke | null>(
    null,
  );
  const [query, setQuery] = createSignal("");
  let captureTimer: number | null = null;

  const normalizedQuery = createMemo(() => query().trim().toLowerCase());

  const matchesQuery = (definition: KeybindingDefinition): boolean => {
    const q = normalizedQuery();
    if (!q) return true;
    if (definition.label.toLowerCase().includes(q)) return true;
    if (definition.description.toLowerCase().includes(q)) return true;
    if (definition.group.toLowerCase().includes(q)) return true;
    return settingsSequences(definition.id).some((sequence) =>
      sequence.some((stroke) =>
        getKeybindingStrokeTokens(stroke).join(" ").toLowerCase().includes(q),
      ),
    );
  };

  const sections = createMemo(() =>
    SHORTCUT_SECTIONS.map((section) => ({
      ...section,
      definitions: section.ids
        .map(getKeybindingDefinition)
        .filter(matchesQuery),
    })).filter((section) => section.definitions.length > 0),
  );

  const clearCaptureTimer = () => {
    if (captureTimer !== null) {
      window.clearTimeout(captureTimer);
      captureTimer = null;
    }
  };

  const setRecordingFlag = (active: boolean) => {
    if (active) {
      document.body.dataset.keybindingRecording = "true";
    } else {
      delete document.body.dataset.keybindingRecording;
    }
  };

  const stopRecording = () => {
    clearCaptureTimer();
    setPendingStroke(null);
    setRecordingTarget(null);
    setRecordingFlag(false);
  };

  const isRecording = (id: KeybindingActionId, index: RecordingIndex) => {
    const target = recordingTarget();
    return target?.id === id && target.index === index;
  };

  const saveSequence = (
    target: RecordingTarget,
    sequence: KeybindingSequence,
  ) => {
    const current = settingsBindings(target.id);
    const next =
      target.index === "new"
        ? [...current, { sequence }]
        : current.map((binding, index) =>
            index === target.index ? { ...binding, sequence } : binding,
          );
    setKeybindingBindings(target.id, next);
    stopRecording();
  };

  const beginRecording = (id: KeybindingActionId, index: RecordingIndex) => {
    stopRecording();
    setRecordingTarget({ id, index });
    setRecordingFlag(true);
  };

  const handleRecorderKeyDown = (
    event: KeyboardEvent,
    id: KeybindingActionId,
    index: RecordingIndex,
  ) => {
    const target = recordingTarget();
    if (target?.id !== id || target.index !== index) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopRecording();
      return;
    }
    const stroke = eventToKeyStroke(event);
    if (!stroke) return;

    const pending = pendingStroke();
    if (pending) {
      saveSequence(target, [pending, stroke]);
      return;
    }

    setPendingStroke(stroke);
    clearCaptureTimer();
    captureTimer = window.setTimeout(() => {
      saveSequence(target, [stroke]);
    }, 900);
  };

  const handleWindowRecorderKeyDown = (event: KeyboardEvent) => {
    const target = recordingTarget();
    if (!target) return;
    handleRecorderKeyDown(event, target.id, target.index);
  };

  const activeConflictLabels = (id: KeybindingActionId): string[] => {
    const conflicts = new Set<string>();
    for (const sequence of settingsSequences(id)) {
      for (const conflict of keybindingConflicts(id, sequence)) {
        conflicts.add(conflict.label);
      }
    }
    return Array.from(conflicts);
  };

  const RecorderFace = () => (
    <span class="inline-flex items-center gap-2">
      <span class="relative inline-flex h-2 w-2" aria-hidden="true">
        <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/70" />
        <span class="relative inline-flex h-2 w-2 rounded-full bg-accent" />
      </span>
      <Show
        when={pendingStroke()}
        fallback={<span class="text-foreground">Press keys...</span>}
      >
        {(stroke) => <KeyCombo sequence={[stroke()]} tone="accent" />}
      </Show>
      <span class="text-[0.68rem] text-muted-foreground">Esc cancels</span>
    </span>
  );

  const ShortcutEditor = (props: {
    definition: KeybindingDefinition;
    compact?: boolean;
  }) => {
    const current = () => settingsBindings(props.definition.id);
    const defaults = () => defaultSettingsBindings(props.definition.id);
    const conflicts = () => activeConflictLabels(props.definition.id);
    const modified = () => isKeybindingModified(props.definition.id);

    const removeBinding = (indexToRemove: number) => {
      stopRecording();
      if (current().length <= 1 && defaults().length > 0) {
        if (isKeybindingModified(props.definition.id)) {
          resetKeybinding(props.definition.id);
        }
        return;
      }

      const next = current().filter((_, index) => index !== indexToRemove);
      setKeybindingBindings(props.definition.id, next);
    };

    const removeButtonState = () => {
      if (current().length <= 1 && defaults().length > 0) {
        return {
          disabled: !isKeybindingModified(props.definition.id),
          title: isKeybindingModified(props.definition.id)
            ? "Reset shortcut to default"
            : "Default shortcut cannot be removed",
        };
      }

      return {
        disabled: false,
        title: "Remove shortcut",
      };
    };

    const AddShortcutButton = () => (
      <button
        type="button"
        data-keybinding-recorder="true"
        class={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-transparent transition-colors ${
          isRecording(props.definition.id, "new")
            ? "border-accent bg-accent/10 text-foreground"
            : "border-dashed border-border-strong text-muted-foreground hover:border-accent/70 hover:text-foreground"
        }`}
        title="Add shortcut"
        aria-label={`Add shortcut for ${props.definition.label}`}
        onClick={() => {
          beginRecording(props.definition.id, "new");
        }}
        onKeyDown={(event) =>
          handleRecorderKeyDown(event, props.definition.id, "new")
        }
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 12 12"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          stroke-width="1.4"
          stroke-linecap="round"
        >
          <path d="M6 2.5v7M2.5 6h7" />
        </svg>
      </button>
    );

    const ShortcutRecorder = (recorderProps: {
      index: RecordingIndex;
      sequence?: KeybindingSequence;
      placeholder?: boolean;
    }) => (
      <button
        type="button"
        data-keybinding-recorder="true"
        aria-label={`${props.definition.label} shortcut. Click to record a new key combination.`}
        class={`group inline-flex min-h-9 w-full items-center rounded-md border px-2.5 py-1.5 text-left transition-colors ${
          isRecording(props.definition.id, recorderProps.index)
            ? "border-accent bg-accent/10"
            : recorderProps.placeholder
              ? "border-dashed border-border-strong bg-transparent hover:border-accent/70"
              : "border-border-strong bg-surface-3/60 hover:border-accent/70 hover:bg-surface-3"
        }`}
        onClick={() => beginRecording(props.definition.id, recorderProps.index)}
        onKeyDown={(event) =>
          handleRecorderKeyDown(event, props.definition.id, recorderProps.index)
        }
      >
        <Show
          when={isRecording(props.definition.id, recorderProps.index)}
          fallback={
            recorderProps.sequence ? (
              <KeyCombo sequence={recorderProps.sequence} />
            ) : (
              <span class="text-muted-foreground">Press keys...</span>
            )
          }
        >
          <RecorderFace />
        </Show>
      </button>
    );

    const ShortcutBindings = () => (
      <div class="flex w-full flex-col gap-2">
        <For
          each={current()}
          fallback={
            <div class="grid grid-cols-[minmax(0,1fr)_2rem_2rem] items-center gap-2">
              <span class="flex-1 rounded-md border border-dashed border-border bg-surface-2/30 px-2.5 py-1.5 text-[0.8rem] text-muted-foreground">
                No shortcut assigned
              </span>
              <span aria-hidden="true" />
              <AddShortcutButton />
            </div>
          }
        >
          {(binding, index) => {
            const scopeLabel = () => bindingScopeLabel(binding);
            return (
              <div class="grid grid-cols-[minmax(0,1fr)_2rem_2rem] items-start gap-2">
                <div class="min-w-0 flex-1">
                  <ShortcutRecorder
                    index={index()}
                    sequence={binding.sequence}
                  />
                  <Show when={scopeLabel()}>
                    {(label) => (
                      <div class="mt-1 inline-flex items-center gap-1 text-[0.7rem] text-muted-foreground">
                        <span class="inline-block h-1 w-1 rounded-full bg-muted-foreground/60" />
                        {label()}
                      </div>
                    )}
                  </Show>
                </div>
                <button
                  type="button"
                  class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-strong bg-transparent text-muted-foreground transition-colors hover:border-warning/50 hover:bg-warning/10 hover:text-warning disabled:opacity-40 disabled:hover:border-border-strong disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  disabled={removeButtonState().disabled}
                  title={removeButtonState().title}
                  aria-label={removeButtonState().title}
                  onClick={() => removeBinding(index())}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                  >
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </button>
                <Show when={index() === current().length - 1}>
                  <AddShortcutButton />
                </Show>
                <Show when={index() !== current().length - 1}>
                  <span class="h-8 w-8" aria-hidden="true" />
                </Show>
              </div>
            );
          }}
        </For>
        <Show when={isRecording(props.definition.id, "new")}>
          <div class="grid grid-cols-[minmax(0,1fr)_2rem_2rem] items-start gap-2">
            <div class="min-w-0 flex-1">
              <ShortcutRecorder index="new" placeholder />
            </div>
            <button
              type="button"
              class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border-strong bg-transparent text-muted-foreground transition-colors hover:bg-border hover:text-foreground"
              title="Cancel shortcut recording"
              aria-label="Cancel shortcut recording"
              onClick={stopRecording}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 12 12"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linecap="round"
              >
                <path d="M3 3l6 6M9 3l-6 6" />
              </svg>
            </button>
            <span class="h-8 w-8" aria-hidden="true" />
          </div>
        </Show>
      </div>
    );

    const ShortcutMeta = () => (
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-[0.95rem] font-medium text-foreground">
            {props.definition.label}
          </span>
          <Show when={modified()}>
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-[0.68rem] font-medium text-accent transition-colors hover:bg-accent/20"
              title="Reset shortcut to default"
              onClick={() => resetKeybinding(props.definition.id)}
            >
              Customized
              <svg
                width="11"
                height="11"
                viewBox="0 0 12 12"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                stroke-width="1.3"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M9.5 4.5a4 4 0 1 0 .5 3.5" />
                <path d="M9.5 2v2.5H7" />
              </svg>
            </button>
          </Show>
        </div>
        <div class="mt-0.5 text-[0.8rem] leading-normal text-muted-foreground">
          {props.definition.description}
        </div>
        <Show when={modified() && defaults().length > 0}>
          <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[0.72rem] text-muted-foreground">
            <span>Default:</span>
            <For each={defaults()}>
              {(binding) => (
                <span class="opacity-70">
                  <KeyCombo sequence={binding.sequence} />
                </span>
              )}
            </For>
          </div>
        </Show>
        <Show when={conflicts().length > 0}>
          <div class="mt-2 inline-flex items-start gap-1.5 text-[0.74rem] text-warning">
            <svg
              width="13"
              height="13"
              viewBox="0 0 14 14"
              aria-hidden="true"
              class="mt-px shrink-0"
              fill="none"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M7 1.5 13 12H1L7 1.5Z" />
              <path d="M7 5.5v3M7 10.2v.1" />
            </svg>
            <span>Also assigned to {conflicts().join(", ")}</span>
          </div>
        </Show>
      </div>
    );

    if (props.compact) {
      return (
        <div
          class={`flex flex-col gap-3 rounded-lg border bg-surface-2/30 p-3 transition-colors ${
            modified() ? "border-accent/40" : "border-border/70"
          }`}
        >
          <ShortcutMeta />
          <ShortcutBindings />
        </div>
      );
    }

    return (
      <div class="grid grid-cols-1 gap-3 border-b border-border py-4 last:border-b-0 sm:grid-cols-[11.5rem_minmax(0,1fr)] sm:items-start sm:gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <ShortcutMeta />
        <ShortcutBindings />
      </div>
    );
  };

  onMount(() => {
    window.addEventListener("keydown", handleWindowRecorderKeyDown, true);
  });

  onCleanup(() => {
    window.removeEventListener("keydown", handleWindowRecorderKeyDown, true);
    stopRecording();
  });

  return (
    <section>
      <h3 class="m-0 mb-2 text-[1.3rem] font-semibold">Keyboard Shortcuts</h3>
      <p class="m-0 mb-5 leading-normal text-muted-foreground">
        Click any shortcut to record a replacement, add a second binding, or
        remove it. Two-key sequences are supported - press the first chord, then
        the second.
      </p>

      <div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div class="relative flex-1">
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            aria-hidden="true"
            class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            fill="none"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          >
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 14 14" />
          </svg>
          <input
            type="text"
            value={query()}
            onInput={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search shortcuts..."
            class="w-full rounded-md border border-border-strong bg-surface-3/60 py-2 pl-9 pr-3 text-[0.85rem] text-foreground placeholder:text-muted-foreground focus:border-accent focus:outline-none"
          />
        </div>
        <button
          type="button"
          class="shrink-0 rounded-md border border-border-strong bg-transparent px-3 py-2 text-[0.85rem] text-muted-foreground transition-colors hover:bg-border hover:text-foreground"
          onClick={resetAllKeybindings}
        >
          Reset all
        </button>
      </div>

      <Show
        when={sections().length > 0}
        fallback={
          <div class="rounded-lg border border-dashed border-border bg-surface-2/20 px-4 py-10 text-center text-[0.85rem] text-muted-foreground">
            No shortcuts match "{query()}".
          </div>
        }
      >
        <For each={sections()}>
          {(entry) => (
            <section class="mb-8 last:mb-0">
              <div class="mb-3 border-b border-border-medium pb-2">
                <h4 class="m-0 text-base font-semibold text-foreground">
                  {entry.title}
                </h4>
                <p class="m-0 mt-1 text-[0.8rem] leading-normal text-muted-foreground">
                  {entry.description}
                </p>
              </div>
              <Show
                when={entry.layout === "grid"}
                fallback={
                  <div class="flex flex-col">
                    <For each={entry.definitions}>
                      {(definition) => (
                        <ShortcutEditor definition={definition} />
                      )}
                    </For>
                  </div>
                }
              >
                <div class="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
                  <For each={entry.definitions}>
                    {(definition) => (
                      <ShortcutEditor definition={definition} compact />
                    )}
                  </For>
                </div>
              </Show>
            </section>
          )}
        </For>
      </Show>
    </section>
  );
}
