// ABOUTME: Global keyboard shortcuts registration and management.
// ABOUTME: Provides Cmd+L (chat), Cmd+, (settings), Cmd+B (sidebar toggle), Escape (close panels).

export type ShortcutAction =
  | "focusChat"
  | "openSettings"
  | "toggleSidebar"
  | "closePanel"
  | "focusEditor"
  | "openFiles";

export interface ShortcutHandler {
  action: ShortcutAction;
  callback: () => void;
}

interface ShortcutDefinition {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  action: ShortcutAction;
}

// Define keyboard shortcuts
// On macOS: metaKey = Cmd, on Windows/Linux: ctrlKey = Ctrl
const SHORTCUTS: ShortcutDefinition[] = [
  { key: "l", metaKey: true, action: "focusChat" },
  { key: ",", metaKey: true, action: "openSettings" },
  { key: "b", metaKey: true, action: "toggleSidebar" },
  { key: "Escape", action: "closePanel" },
  { key: "e", metaKey: true, action: "focusEditor" },
  { key: "o", metaKey: true, action: "openFiles" },
];

// Platform detection
const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);

class ShortcutManager {
  private handlers: Map<ShortcutAction, () => void> = new Map();
  private enabled = true;
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
  }

  /**
   * Register a handler for a shortcut action.
   */
  register(action: ShortcutAction, callback: () => void): void {
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
  }

  /**
   * Check if shortcuts are currently enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!this.enabled) return;

    // Don't trigger shortcuts when typing in input fields (except Escape)
    const target = e.target as HTMLElement;
    const isInputField =
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable;

    for (const shortcut of SHORTCUTS) {
      if (this.matchesShortcut(e, shortcut)) {
        // Allow Escape even in input fields
        if (isInputField && shortcut.key !== "Escape") {
          continue;
        }

        const handler = this.handlers.get(shortcut.action);
        if (handler) {
          e.preventDefault();
          handler();
          return;
        }
      }
    }
  }

  private matchesShortcut(
    e: KeyboardEvent,
    shortcut: ShortcutDefinition,
  ): boolean {
    // Key match (case-insensitive for letters)
    const keyMatch =
      e.key.toLowerCase() === shortcut.key.toLowerCase() ||
      e.key === shortcut.key;

    if (!keyMatch) return false;

    // Meta/Ctrl key check - use metaKey on Mac, ctrlKey on Windows/Linux
    const requiresMeta = shortcut.metaKey || shortcut.ctrlKey;
    if (requiresMeta) {
      const hasModifier = isMac ? e.metaKey : e.ctrlKey;
      if (!hasModifier) return false;
    }

    // Shift key check
    if (shortcut.shiftKey && !e.shiftKey) return false;

    return true;
  }
}

// Singleton instance
export const shortcuts = new ShortcutManager();

/**
 * Get a human-readable label for a shortcut.
 */
export function getShortcutLabel(action: ShortcutAction): string {
  const shortcut = SHORTCUTS.find((s) => s.action === action);
  if (!shortcut) return "";

  const parts: string[] = [];

  if (shortcut.metaKey || shortcut.ctrlKey) {
    parts.push(isMac ? "⌘" : "Ctrl");
  }
  if (shortcut.shiftKey) {
    parts.push(isMac ? "⇧" : "Shift");
  }

  // Format the key nicely
  let keyLabel = shortcut.key;
  if (keyLabel === "Escape") keyLabel = "Esc";
  else if (keyLabel === ",") keyLabel = ",";
  else keyLabel = keyLabel.toUpperCase();

  parts.push(keyLabel);

  return parts.join(isMac ? "" : "+");
}
