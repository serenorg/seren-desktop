// ABOUTME: Reactive editor state for sharing selections between editor and chat.
// ABOUTME: Supports pending actions (explain, improve) for context menu integration.

import { createStore } from "solid-js/store";

interface SelectionRange {
  startLine: number;
  endLine: number;
}

/**
 * Pending action to execute with the selected code.
 * - "add-to-chat": Just add as context (no auto-send)
 * - "explain": Add as context and send "explain this code" prompt
 * - "improve": Add as context and send "improve this code" prompt
 */
export type PendingAction = "add-to-chat" | "explain" | "improve" | null;

interface EditorState {
  selectedText: string;
  selectedFile: string | null;
  selectedRange: SelectionRange | null;
  pendingAction: PendingAction;
  language: string | null;
}

const [state, setState] = createStore<EditorState>({
  selectedText: "",
  selectedFile: null,
  selectedRange: null,
  pendingAction: null,
  language: null,
});

export const editorStore = {
  get selectedText() {
    return state.selectedText;
  },
  get selectedFile() {
    return state.selectedFile;
  },
  get selectedRange() {
    return state.selectedRange;
  },
  get pendingAction() {
    return state.pendingAction;
  },
  get language() {
    return state.language;
  },

  /**
   * Set selected code as context for chat.
   */
  setSelection(
    text: string,
    file: string,
    range: SelectionRange,
    language?: string,
  ) {
    setState({
      selectedText: text,
      selectedFile: file,
      selectedRange: range,
      language: language ?? null,
    });
  },

  /**
   * Set a pending action to execute with the selection.
   * ChatPanel will watch for this and auto-send the appropriate prompt.
   */
  setPendingAction(action: PendingAction) {
    setState("pendingAction", action);
  },

  /**
   * Set selection and immediately trigger an action.
   * Convenience method for context menu handlers.
   */
  setSelectionWithAction(
    text: string,
    file: string,
    range: SelectionRange,
    language: string,
    action: PendingAction,
  ) {
    setState({
      selectedText: text,
      selectedFile: file,
      selectedRange: range,
      language,
      pendingAction: action,
    });
  },

  /**
   * Clear the pending action after it's been processed.
   */
  clearPendingAction() {
    setState("pendingAction", null);
  },

  /**
   * Clear all selection state.
   */
  clearSelection() {
    setState({
      selectedText: "",
      selectedFile: null,
      selectedRange: null,
      pendingAction: null,
      language: null,
    });
  },
};
