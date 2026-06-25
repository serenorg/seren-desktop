// ABOUTME: Global keyboard shortcut registration and dispatch.
// ABOUTME: Uses the centralized keybinding registry so settings and runtime stay in sync.

import {
  createKeybindingMatcher,
  getKeybindingLabel,
  type KeybindingActionId,
} from "@/stores/keybindings.store";

export type ShortcutAction =
  | "global.focusChat"
  | "global.openSettings"
  | "global.toggleSidebar"
  | "global.closePanel"
  | "global.focusEditor"
  | "global.openFiles"
  | "global.newChat"
  | "global.newTerminal";

/**
 * A shortcut handler may return `false` to signal it did not consume the key,
 * so the manager leaves the browser default intact (e.g. Escape only closes a
 * panel when one is open; otherwise it passes through to terminals/editors).
 */
export type ShortcutCallback = () => unknown;

export interface ShortcutHandler {
  action: ShortcutAction;
  callback: ShortcutCallback;
}

const GLOBAL_SHORTCUT_ACTIONS: readonly ShortcutAction[] = [
  "global.focusChat",
  "global.openSettings",
  "global.toggleSidebar",
  "global.closePanel",
  "global.focusEditor",
  "global.openFiles",
  "global.newChat",
  "global.newTerminal",
];

/**
 * Keys that move or extend the text caret inside an editable field. Inside a
 * text input these must always perform native cursor movement / selection
 * (e.g. Cmd/Ctrl+Shift+Arrow) and never be consumed by an app shortcut.
 */
export const CARET_MOVEMENT_KEYS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** True when the event originates from a text-editing element. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable)
  );
}

/**
 * True when a keydown must be left to the browser's native text editing
 * (caret movement / selection) rather than consumed by an app shortcut —
 * i.e. a caret-movement key fired while focus is in an editable field.
 */
export function isNativeTextEditingKey(event: KeyboardEvent): boolean {
  return CARET_MOVEMENT_KEYS.has(event.key) && isEditableTarget(event.target);
}

class ShortcutManager {
  private handlers: Map<ShortcutAction, ShortcutCallback> = new Map();
  private enabled = true;
  private matcher = createKeybindingMatcher(GLOBAL_SHORTCUT_ACTIONS);
  private boundHandler: (e: KeyboardEvent) => void;

  constructor() {
    this.boundHandler = this.handleKeyDown.bind(this);
  }

  /**
   * Initialize the shortcut manager and start listening for keyboard events.
   */
  init(): void {
    if (typeof window === "undefined") return;
    window.addEventListener("keydown", this.boundHandler);
  }

  /**
   * Clean up event listeners.
   */
  destroy(): void {
    if (typeof window === "undefined") return;
    window.removeEventListener("keydown", this.boundHandler);
    this.matcher.clear();
  }

  /**
   * Register a handler for a shortcut action.
   */
  register(action: ShortcutAction, callback: ShortcutCallback): void {
    this.handlers.set(action, callback);
  }

  /**
   * Unregister a handler for a shortcut action.
   */
  unregister(action: ShortcutAction): void {
    this.handlers.delete(action);
  }

  /**
   * Enable or disable all shortcuts.
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.matcher.clear();
  }

  /**
   * Check if shortcuts are currently enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.enabled) return;
    if (document.body.dataset.keybindingRecording === "true") {
      this.matcher.clear();
      return;
    }

    const result = this.matcher.handleEvent(e);
    if (result.kind === "none") return;

    const isInputField = isEditableTarget(e.target);

    if (result.kind === "pending") {
      if (!isInputField) e.preventDefault();
      return;
    }

    if (isInputField && result.action !== "global.closePanel") {
      return;
    }

    const handler = this.handlers.get(result.action as ShortcutAction);
    if (handler) {
      // Only swallow the key if the handler actually consumed it. Returning
      // false (e.g. closePanel with no panel open) lets the default through.
      const consumed = handler();
      if (consumed !== false) e.preventDefault();
    }
  }
}

export const shortcuts = new ShortcutManager();

/**
 * Get a human-readable label for a shortcut.
 */
export function getShortcutLabel(action: ShortcutAction): string {
  return getKeybindingLabel(action as KeybindingActionId);
}
