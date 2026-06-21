// ABOUTME: Central keyboard shortcut registry with defaults and persisted user overrides.
// ABOUTME: Provides event matching, display formatting, and settings-panel mutation helpers.

import { createStore } from "solid-js/store";
import { isMacPlatform } from "@/lib/platform";
import { isTauriRuntime } from "@/lib/tauri-bridge";

const SETTINGS_STORE = "settings.json";
const KEYBINDINGS_SETTINGS_KEY = "keybindings";
const BROWSER_KEYBINDINGS_KEY = "seren_keybindings";

export type KeybindingPlatform = "mac" | "non-mac";
export type KeybindingContext = "all" | "terminal" | "non-terminal";

export type KeybindingGroup =
  | "Global"
  | "Workspaces"
  | "Panes"
  | "Terminal Panes";

export type KeybindingActionId =
  | "global.focusChat"
  | "global.openSettings"
  | "global.toggleSidebar"
  | "global.closePanel"
  | "global.focusEditor"
  | "global.openFiles"
  | "global.newChat"
  | "global.newTerminal"
  | "workspace.next"
  | "workspace.previous"
  | "workspace.switch1"
  | "workspace.switch2"
  | "workspace.switch3"
  | "workspace.switch4"
  | "workspace.switch5"
  | "workspace.switch6"
  | "workspace.switch7"
  | "workspace.switch8"
  | "workspace.switch9"
  | "workspace.switch10"
  | "pane.focusLeft"
  | "pane.focusRight"
  | "pane.focusUp"
  | "pane.focusDown"
  | "pane.focusPrevious"
  | "pane.focusNext"
  | "pane.splitRight"
  | "pane.splitDown"
  | "pane.close"
  | "pane.zoom"
  | "pane.resizeLeft"
  | "pane.resizeRight"
  | "pane.resizeUp"
  | "pane.resizeDown";

export interface KeyStroke {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export type KeybindingSequence = KeyStroke[];

export interface KeybindingBinding {
  sequence: KeybindingSequence;
  platform?: KeybindingPlatform;
  context?: KeybindingContext;
}

interface DefaultKeybinding extends KeybindingBinding {}

export interface KeybindingDefinition {
  id: KeybindingActionId;
  group: KeybindingGroup;
  label: string;
  description: string;
  defaults: DefaultKeybinding[];
}

interface KeybindingOverride {
  bindings: KeybindingBinding[] | null;
}

interface KeybindingSettings {
  overrides: Partial<Record<KeybindingActionId, KeybindingOverride>>;
}

interface KeybindingState {
  settings: KeybindingSettings;
  isLoading: boolean;
}

export interface KeybindingMatchContext {
  terminalPaneFocused?: boolean;
}

export type KeybindingMatchResult =
  | { kind: "matched"; action: KeybindingActionId }
  | { kind: "pending" }
  | { kind: "none" };

const isMac = isMacPlatform();

const keybindingDefinitions = [
  {
    id: "global.focusChat",
    group: "Global",
    label: "Focus chat",
    description: "Move focus to the chat workspace.",
    defaults: [{ sequence: [{ mod: true, key: "l" }] }],
  },
  {
    id: "global.openSettings",
    group: "Global",
    label: "Open settings",
    description: "Open or close the settings panel.",
    defaults: [{ sequence: [{ mod: true, key: "," }] }],
  },
  {
    id: "global.toggleSidebar",
    group: "Global",
    label: "Toggle sidebar",
    description: "Show or hide the left sidebar.",
    defaults: [{ sequence: [{ mod: true, key: "b" }] }],
  },
  {
    id: "global.closePanel",
    group: "Global",
    label: "Close panel",
    description: "Close the active slide-out panel.",
    defaults: [{ sequence: [{ key: "Escape" }] }],
  },
  {
    id: "global.focusEditor",
    group: "Global",
    label: "Focus editor",
    description: "Open or focus the editor pane for the current context.",
    defaults: [{ sequence: [{ mod: true, key: "e" }] }],
  },
  {
    id: "global.openFiles",
    group: "Global",
    label: "Open files",
    description: "Open files from disk.",
    defaults: [{ sequence: [{ mod: true, key: "o" }] }],
  },
  {
    id: "global.newChat",
    group: "Global",
    label: "New chat",
    description: "Start a new chat thread.",
    defaults: [{ sequence: [{ mod: true, key: "n" }] }],
  },
  {
    id: "global.newTerminal",
    group: "Global",
    label: "New terminal",
    description: "Open a new terminal thread.",
    defaults: [{ sequence: [{ mod: true, key: "t" }] }],
  },
  {
    id: "workspace.next",
    group: "Workspaces",
    label: "Next workspace",
    description: "Switch to the next workspace.",
    defaults: [
      { platform: "mac", sequence: [{ ctrl: true, key: "Tab" }] },
      { sequence: [{ mod: true, shift: true, key: "]" }] },
      { platform: "non-mac", sequence: [{ mod: true, key: "Tab" }] },
    ],
  },
  {
    id: "workspace.previous",
    group: "Workspaces",
    label: "Previous workspace",
    description: "Switch to the previous workspace.",
    defaults: [
      { platform: "mac", sequence: [{ ctrl: true, shift: true, key: "Tab" }] },
      { sequence: [{ mod: true, shift: true, key: "[" }] },
      {
        platform: "non-mac",
        sequence: [{ mod: true, shift: true, key: "Tab" }],
      },
    ],
  },
  ...Array.from({ length: 10 }, (_, index) => {
    const number = index + 1;
    const digit = number === 10 ? "0" : String(number);
    return {
      id: `workspace.switch${number}` as KeybindingActionId,
      group: "Workspaces" as const,
      label: `Switch to workspace ${number}`,
      description: `Switch to workspace ${number}, creating it if needed.`,
      defaults: [{ sequence: [{ mod: true, key: digit }] }],
    };
  }),
  {
    id: "pane.focusLeft",
    group: "Panes",
    label: "Focus pane left",
    description: "Move focus to the pane on the left.",
    defaults: [{ sequence: [{ mod: true, alt: true, key: "ArrowLeft" }] }],
  },
  {
    id: "pane.focusRight",
    group: "Panes",
    label: "Focus pane right",
    description: "Move focus to the pane on the right.",
    defaults: [{ sequence: [{ mod: true, alt: true, key: "ArrowRight" }] }],
  },
  {
    id: "pane.focusUp",
    group: "Panes",
    label: "Focus pane up",
    description: "Move focus to the pane above.",
    defaults: [{ sequence: [{ mod: true, alt: true, key: "ArrowUp" }] }],
  },
  {
    id: "pane.focusDown",
    group: "Panes",
    label: "Focus pane down",
    description: "Move focus to the pane below.",
    defaults: [{ sequence: [{ mod: true, alt: true, key: "ArrowDown" }] }],
  },
  {
    id: "pane.focusPrevious",
    group: "Panes",
    label: "Previous pane",
    description: "Cycle focus to the previous pane.",
    defaults: [{ sequence: [{ mod: true, key: "[" }] }],
  },
  {
    id: "pane.focusNext",
    group: "Panes",
    label: "Next pane",
    description: "Cycle focus to the next pane.",
    defaults: [{ sequence: [{ mod: true, key: "]" }] }],
  },
  {
    id: "pane.splitRight",
    group: "Panes",
    label: "Split right",
    description: "Split the focused pane to the right.",
    defaults: [
      { sequence: [{ mod: true, key: "\\" }] },
      {
        platform: "mac",
        sequence: [{ mod: true, key: "d" }],
      },
      {
        platform: "non-mac",
        sequence: [{ mod: true, shift: true, key: "d" }],
      },
      {
        platform: "non-mac",
        sequence: [{ mod: true, shift: true, key: "o" }],
      },
    ],
  },
  {
    id: "pane.splitDown",
    group: "Panes",
    label: "Split down",
    description: "Split the focused pane downward.",
    defaults: [
      { sequence: [{ mod: true, key: "-" }] },
      {
        platform: "mac",
        sequence: [{ mod: true, shift: true, key: "d" }],
      },
      {
        platform: "non-mac",
        sequence: [{ mod: true, shift: true, key: "e" }],
      },
    ],
  },
  {
    id: "pane.close",
    group: "Panes",
    label: "Close pane",
    description: "Close the focused pane.",
    defaults: [{ sequence: [{ mod: true, shift: true, key: "w" }] }],
  },
  {
    id: "pane.zoom",
    group: "Panes",
    label: "Zoom pane",
    description: "Toggle the focused pane to fill the workspace.",
    defaults: [{ sequence: [{ mod: true, shift: true, key: "Enter" }] }],
  },
  {
    id: "pane.resizeLeft",
    group: "Panes",
    label: "Shrink pane width",
    description: "Resize the focused pane toward the left.",
    defaults: [{ sequence: [{ mod: true, shift: true, key: "ArrowLeft" }] }],
  },
  {
    id: "pane.resizeRight",
    group: "Panes",
    label: "Grow pane width",
    description: "Resize the focused pane toward the right.",
    defaults: [{ sequence: [{ mod: true, shift: true, key: "ArrowRight" }] }],
  },
  {
    id: "pane.resizeUp",
    group: "Panes",
    label: "Shrink pane height",
    description: "Resize the focused pane upward.",
    defaults: [{ sequence: [{ mod: true, shift: true, key: "ArrowUp" }] }],
  },
  {
    id: "pane.resizeDown",
    group: "Panes",
    label: "Grow pane height",
    description: "Resize the focused pane downward.",
    defaults: [{ sequence: [{ mod: true, shift: true, key: "ArrowDown" }] }],
  },
] satisfies KeybindingDefinition[];

const definitionsById = new Map<KeybindingActionId, KeybindingDefinition>(
  keybindingDefinitions.map((definition) => [definition.id, definition]),
);

const [keybindingsState, setKeybindingsState] = createStore<KeybindingState>({
  settings: { overrides: {} },
  isLoading: true,
});

async function getInvoke(): Promise<
  typeof import("@tauri-apps/api/core").invoke | null
> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

function isKeybindingPlatform(value: unknown): value is KeybindingPlatform {
  return value === "mac" || value === "non-mac";
}

function isKeybindingContext(value: unknown): value is KeybindingContext {
  return value === "all" || value === "terminal" || value === "non-terminal";
}

function cleanStroke(raw: unknown): KeyStroke | null {
  if (!raw || typeof raw !== "object") return null;
  const stroke = raw as Partial<KeyStroke>;
  if (typeof stroke.key !== "string" || stroke.key.length === 0) return null;
  return {
    key: normalizeKey(stroke.key),
    ...(stroke.mod ? { mod: true } : {}),
    ...(stroke.shift ? { shift: true } : {}),
    ...(stroke.alt ? { alt: true } : {}),
    ...(stroke.ctrl ? { ctrl: true } : {}),
    ...(stroke.meta ? { meta: true } : {}),
  };
}

function cleanSequence(sequence: readonly unknown[]): KeybindingSequence {
  return sequence
    .map(cleanStroke)
    .filter((stroke): stroke is KeyStroke => stroke !== null)
    .slice(0, 2);
}

function bindingsEqual(
  left: KeybindingBinding,
  right: KeybindingBinding,
): boolean {
  return (
    left.platform === right.platform &&
    left.context === right.context &&
    keybindingSequencesEqual(left.sequence, right.sequence)
  );
}

function cleanBinding(raw: unknown): KeybindingBinding | null {
  if (!raw || typeof raw !== "object") return null;
  const binding = raw as Partial<KeybindingBinding>;
  if (!Array.isArray(binding.sequence)) return null;
  const sequence = cleanSequence(binding.sequence);
  if (sequence.length === 0) return null;
  const platform = isKeybindingPlatform(binding.platform)
    ? binding.platform
    : undefined;
  const context = isKeybindingContext(binding.context)
    ? binding.context
    : undefined;
  return {
    sequence,
    ...(platform ? { platform } : {}),
    ...(context ? { context } : {}),
  };
}

function cleanBindings(bindings: readonly unknown[]): KeybindingBinding[] {
  return bindings.reduce<KeybindingBinding[]>((acc, binding) => {
    const cleaned = cleanBinding(binding);
    if (!cleaned) return acc;
    if (!acc.some((candidate) => bindingsEqual(candidate, cleaned))) {
      acc.push(cleaned);
    }
    return acc;
  }, []);
}

function normalizeOverrides(
  raw: unknown,
): Partial<Record<KeybindingActionId, KeybindingOverride>> {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const out: Partial<Record<KeybindingActionId, KeybindingOverride>> = {};
  for (const definition of keybindingDefinitions) {
    const value = input[definition.id];
    if (!value || typeof value !== "object") continue;
    const override = value as {
      bindings?: unknown;
      sequence?: unknown;
      sequences?: unknown;
    };
    if (
      override.bindings === null ||
      override.sequences === null ||
      override.sequence === null
    ) {
      out[definition.id] = { bindings: null };
      continue;
    }

    if (Array.isArray(override.bindings)) {
      const bindings = cleanBindings(override.bindings as KeybindingBinding[]);
      if (bindings.length > 0) {
        out[definition.id] = { bindings };
      }
      continue;
    }

    if (Array.isArray(override.sequences)) {
      const bindings = cleanBindings(
        (override.sequences as KeybindingSequence[]).map((sequence) => ({
          sequence,
        })),
      );
      if (bindings.length > 0) {
        out[definition.id] = { bindings };
      }
      continue;
    }

    if (Array.isArray(override.sequence)) {
      const binding = cleanBinding({
        sequence: override.sequence as KeybindingSequence,
      });
      if (binding) {
        out[definition.id] = { bindings: [binding] };
      }
    }
  }
  return out;
}

async function persistKeybindings(): Promise<void> {
  try {
    const invoke = await getInvoke();
    const value = JSON.stringify(keybindingsState.settings);
    if (invoke) {
      await invoke("set_setting", {
        store: SETTINGS_STORE,
        key: KEYBINDINGS_SETTINGS_KEY,
        value,
      });
    } else if (globalThis.localStorage) {
      globalThis.localStorage.setItem(BROWSER_KEYBINDINGS_KEY, value);
    }
  } catch (error) {
    console.error("Failed to save keybindings:", error);
  }
}

export async function loadKeybindings(): Promise<void> {
  setKeybindingsState("isLoading", true);
  try {
    const invoke = await getInvoke();
    let stored: string | null = null;
    if (invoke) {
      stored = await invoke<string | null>("get_setting", {
        store: SETTINGS_STORE,
        key: KEYBINDINGS_SETTINGS_KEY,
      });
    } else {
      stored =
        globalThis.localStorage?.getItem(BROWSER_KEYBINDINGS_KEY) ?? null;
    }
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<KeybindingSettings>;
      setKeybindingsState("settings", {
        overrides: normalizeOverrides(parsed.overrides),
      });
    }
  } catch {
    setKeybindingsState("settings", { overrides: {} });
  } finally {
    setKeybindingsState("isLoading", false);
  }
}

function defaultApplies(
  binding: DefaultKeybinding,
  context: KeybindingMatchContext = {},
): boolean {
  if (binding.platform === "mac" && !isMac) return false;
  if (binding.platform === "non-mac" && isMac) return false;
  if (binding.context === "terminal" && !context.terminalPaneFocused) {
    return false;
  }
  if (binding.context === "non-terminal" && context.terminalPaneFocused) {
    return false;
  }
  return true;
}

export function getKeybindingDefinitions(): readonly KeybindingDefinition[] {
  return keybindingDefinitions;
}

export function getKeybindingDefinition(
  id: KeybindingActionId,
): KeybindingDefinition {
  const definition = definitionsById.get(id);
  if (!definition) {
    throw new Error(`Unknown keybinding action: ${id}`);
  }
  return definition;
}

export function getKeybindingSequences(
  id: KeybindingActionId,
  context: KeybindingMatchContext = {},
): KeybindingSequence[] {
  return getKeybindingBindings(id, context).map((binding) => binding.sequence);
}

export function getKeybindingBindings(
  id: KeybindingActionId,
  context: KeybindingMatchContext = {},
): KeybindingBinding[] {
  const override = keybindingsState.settings.overrides[id];
  if (override) {
    return override.bindings
      ? override.bindings.filter((binding) => defaultApplies(binding, context))
      : [];
  }
  const definition = getKeybindingDefinition(id);
  return definition.defaults
    .filter((binding) => defaultApplies(binding, context))
    .map((binding) => ({
      sequence: binding.sequence,
      ...(binding.platform ? { platform: binding.platform } : {}),
      ...(binding.context ? { context: binding.context } : {}),
    }));
}

export function getDefaultKeybindingSequences(
  id: KeybindingActionId,
  context: KeybindingMatchContext = {},
): KeybindingSequence[] {
  return getDefaultKeybindingBindings(id, context).map(
    (binding) => binding.sequence,
  );
}

export function getDefaultKeybindingBindings(
  id: KeybindingActionId,
  context: KeybindingMatchContext = {},
): KeybindingBinding[] {
  return getKeybindingDefinition(id)
    .defaults.filter((binding) => defaultApplies(binding, context))
    .map((binding) => ({
      sequence: binding.sequence,
      ...(binding.platform ? { platform: binding.platform } : {}),
      ...(binding.context ? { context: binding.context } : {}),
    }));
}

export function isKeybindingModified(id: KeybindingActionId): boolean {
  return keybindingsState.settings.overrides[id] !== undefined;
}

export function setKeybindingOverride(
  id: KeybindingActionId,
  sequence: KeybindingSequence,
): void {
  setKeybindingBindings(id, [{ sequence }]);
}

export function setKeybindingSequences(
  id: KeybindingActionId,
  sequences: KeybindingSequence[],
): void {
  setKeybindingBindings(
    id,
    sequences.map((sequence) => ({ sequence })),
  );
}

export function setKeybindingBindings(
  id: KeybindingActionId,
  bindings: KeybindingBinding[],
): void {
  const cleaned = cleanBindings(bindings);
  setKeybindingsState("settings", "overrides", id, {
    bindings: cleaned.length > 0 ? cleaned : null,
  });
  void persistKeybindings();
}

export function clearKeybinding(id: KeybindingActionId): void {
  setKeybindingsState("settings", "overrides", id, { bindings: null });
  void persistKeybindings();
}

export function resetKeybinding(id: KeybindingActionId): void {
  const nextOverrides = { ...keybindingsState.settings.overrides };
  delete nextOverrides[id];
  setKeybindingsState("settings", {
    ...keybindingsState.settings,
    overrides: nextOverrides,
  });
  void persistKeybindings();
}

export function resetAllKeybindings(): void {
  setKeybindingsState("settings", { overrides: {} });
  void persistKeybindings();
}

function normalizeKey(key: string): string {
  if (key.length === 1) {
    switch (key) {
      case "{":
        return "[";
      case "}":
        return "]";
      case "|":
        return "\\";
      case "_":
        return "-";
      default:
        return key.toLowerCase();
    }
  }
  if (key === "Esc") return "Escape";
  if (key === "Spacebar") return " ";
  return key;
}

export function eventToKeyStroke(event: KeyboardEvent): KeyStroke | null {
  if (!event.key) return null;
  if (["Alt", "Control", "Meta", "Shift"].includes(event.key)) return null;
  const modActive = isMac ? event.metaKey : event.ctrlKey;
  const explicitCtrl =
    !isMac && !event.ctrlKey ? false : isMac && event.ctrlKey;
  const explicitMeta =
    isMac && !event.metaKey ? false : !isMac && event.metaKey;
  return cleanStroke({
    key: normalizeKey(event.key),
    ...(modActive ? { mod: true } : {}),
    ...(event.shiftKey ? { shift: true } : {}),
    ...(event.altKey ? { alt: true } : {}),
    ...(explicitCtrl ? { ctrl: true } : {}),
    ...(explicitMeta ? { meta: true } : {}),
  });
}

function strokesEqual(left: KeyStroke, right: KeyStroke): boolean {
  return (
    normalizeKey(left.key) === normalizeKey(right.key) &&
    Boolean(left.mod) === Boolean(right.mod) &&
    Boolean(left.shift) === Boolean(right.shift) &&
    Boolean(left.alt) === Boolean(right.alt) &&
    Boolean(left.ctrl) === Boolean(right.ctrl) &&
    Boolean(left.meta) === Boolean(right.meta)
  );
}

export function keybindingSequencesEqual(
  left: KeybindingSequence,
  right: KeybindingSequence,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((stroke, index) => strokesEqual(stroke, right[index]));
}

function sequenceStartsWith(
  sequence: KeybindingSequence,
  prefix: KeybindingSequence,
): boolean {
  if (prefix.length > sequence.length) return false;
  return prefix.every((stroke, index) => strokesEqual(stroke, sequence[index]));
}

export function createKeybindingMatcher(
  actionIds: readonly KeybindingActionId[],
  getContext: () => KeybindingMatchContext = () => ({}),
) {
  let pending: KeybindingSequence = [];
  let pendingTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const clear = () => {
    pending = [];
    if (pendingTimer !== null) {
      globalThis.clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  };

  const armPending = (sequence: KeybindingSequence) => {
    pending = sequence;
    if (pendingTimer !== null) globalThis.clearTimeout(pendingTimer);
    pendingTimer = globalThis.setTimeout(clear, 1500);
  };

  const handleEvent = (event: KeyboardEvent): KeybindingMatchResult => {
    const eventStroke = eventToKeyStroke(event);
    if (!eventStroke) {
      clear();
      return { kind: "none" };
    }

    const context = getContext();
    const nextPrefix = [...pending, eventStroke];
    let hasLongerMatch = false;

    for (const actionId of actionIds) {
      for (const sequence of getKeybindingSequences(actionId, context)) {
        if (keybindingSequencesEqual(sequence, nextPrefix)) {
          clear();
          return { kind: "matched", action: actionId };
        }
        if (sequenceStartsWith(sequence, nextPrefix)) {
          hasLongerMatch = true;
        }
      }
    }

    if (hasLongerMatch) {
      armPending(nextPrefix);
      return { kind: "pending" };
    }

    clear();
    return { kind: "none" };
  };

  return { clear, handleEvent };
}

function allContextKeybindingSequences(
  id: KeybindingActionId,
): KeybindingSequence[] {
  return [
    ...getKeybindingSequences(id, { terminalPaneFocused: false }),
    ...getKeybindingSequences(id, { terminalPaneFocused: true }),
  ].reduce<KeybindingSequence[]>((acc, sequence) => {
    if (
      !acc.some((candidate) => keybindingSequencesEqual(candidate, sequence))
    ) {
      acc.push(sequence);
    }
    return acc;
  }, []);
}

export function keybindingConflicts(
  id: KeybindingActionId,
  sequence: KeybindingSequence,
): KeybindingDefinition[] {
  return keybindingDefinitions.filter((definition) => {
    if (definition.id === id) return false;
    return allContextKeybindingSequences(definition.id).some((candidate) =>
      keybindingSequencesEqual(candidate, sequence),
    );
  });
}

function formatKey(key: string): string {
  switch (key) {
    case " ":
      return "Space";
    case "Escape":
      return "Esc";
    case "ArrowLeft":
      return "Left";
    case "ArrowRight":
      return "Right";
    case "ArrowUp":
      return "Up";
    case "ArrowDown":
      return "Down";
    case "\\":
      return "\\";
    default:
      return key.length === 1 ? key.toUpperCase() : key;
  }
}

export function getKeybindingStrokeTokens(stroke: KeyStroke): string[] {
  const parts: string[] = [];
  if (stroke.mod) parts.push(isMac ? "Cmd" : "Ctrl");
  if (stroke.ctrl) parts.push("Ctrl");
  if (stroke.meta) parts.push("Meta");
  if (stroke.alt) parts.push(isMac ? "Option" : "Alt");
  if (stroke.shift) parts.push("Shift");
  parts.push(formatKey(stroke.key));
  return parts;
}

export function formatKeybindingSequence(sequence: KeybindingSequence): string {
  return sequence
    .map((stroke) => getKeybindingStrokeTokens(stroke).join("+"))
    .join(" ");
}

export function getKeybindingLabel(
  id: KeybindingActionId,
  context: KeybindingMatchContext = {},
): string {
  const sequences = getKeybindingSequences(id, context);
  return sequences.map(formatKeybindingSequence).join(" / ");
}

export function getDefaultKeybindingLabel(
  id: KeybindingActionId,
  context: KeybindingMatchContext = {},
): string {
  const sequences = getDefaultKeybindingSequences(id, context);
  return sequences.map(formatKeybindingSequence).join(" / ");
}

export { keybindingsState };
