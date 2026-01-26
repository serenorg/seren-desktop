import type * as Monaco from "monaco-editor";
import { getMonaco } from "./monaco-config";

export interface CodeAction {
  id: string;
  label: string;
  contextMenuGroupId: string;
  contextMenuOrder: number;
  keybindings?: number[];
  run: (editor: Monaco.editor.ICodeEditor) => void;
}

// Handler for explain code action
type ExplainCodeHandler = (
  code: string,
  language: string,
  filePath: string,
) => void;
let explainCodeHandler: ExplainCodeHandler | null = null;

/**
 * Set the handler for the "Explain Code" action.
 * This will be called with the selected code when the action is triggered.
 */
export function setExplainCodeHandler(handler: ExplainCodeHandler): void {
  explainCodeHandler = handler;
}

/**
 * Register the "Explain Code" context menu action.
 */
export function registerExplainCodeAction(): Monaco.IDisposable {
  const monaco = getMonaco();

  return monaco.editor.addEditorAction({
    id: "seren.explainCode",
    label: "Explain Code",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.5,
    keybindings: [
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE,
    ],
    precondition: "editorHasSelection",
    run: (editor) => {
      const selection = editor.getSelection();
      if (!selection) return;

      const model = editor.getModel();
      if (!model) return;

      const selectedText = model.getValueInRange(selection);
      if (!selectedText.trim()) return;

      const language = model.getLanguageId();
      const filePath = model.uri.path || model.uri.toString();

      if (explainCodeHandler) {
        explainCodeHandler(selectedText, language, filePath);
      }
    },
  });
}

/**
 * Register the "Improve Code" context menu action.
 */
type ImproveCodeHandler = (
  code: string,
  language: string,
  filePath: string,
) => void;
let improveCodeHandler: ImproveCodeHandler | null = null;

export function setImproveCodeHandler(handler: ImproveCodeHandler): void {
  improveCodeHandler = handler;
}

export function registerImproveCodeAction(): Monaco.IDisposable {
  const monaco = getMonaco();

  return monaco.editor.addEditorAction({
    id: "seren.improveCode",
    label: "Improve Code",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.6,
    keybindings: [
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyI,
    ],
    precondition: "editorHasSelection",
    run: (editor) => {
      const selection = editor.getSelection();
      if (!selection) return;

      const model = editor.getModel();
      if (!model) return;

      const selectedText = model.getValueInRange(selection);
      if (!selectedText.trim()) return;

      const language = model.getLanguageId();
      const filePath = model.uri.path || model.uri.toString();

      if (improveCodeHandler) {
        improveCodeHandler(selectedText, language, filePath);
      }
    },
  });
}

/**
 * Register the "Add to Chat" context menu action.
 */
type AddToChatHandler = (
  code: string,
  language: string,
  filePath: string,
) => void;
let addToChatHandler: AddToChatHandler | null = null;

export function setAddToChatHandler(handler: AddToChatHandler): void {
  addToChatHandler = handler;
}

export function registerAddToChatAction(): Monaco.IDisposable {
  const monaco = getMonaco();

  return monaco.editor.addEditorAction({
    id: "seren.addToChat",
    label: "Add to Chat",
    contextMenuGroupId: "navigation",
    contextMenuOrder: 1.7,
    keybindings: [
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyC,
    ],
    precondition: "editorHasSelection",
    run: (editor) => {
      const selection = editor.getSelection();
      if (!selection) return;

      const model = editor.getModel();
      if (!model) return;

      const selectedText = model.getValueInRange(selection);
      if (!selectedText.trim()) return;

      const language = model.getLanguageId();
      const filePath = model.uri.path || model.uri.toString();

      if (addToChatHandler) {
        addToChatHandler(selectedText, language, filePath);
      }
    },
  });
}

/**
 * Register all Seren code actions.
 * Returns a disposable that cleans up all actions.
 */
export function registerAllCodeActions(): Monaco.IDisposable {
  const disposables = [
    registerExplainCodeAction(),
    registerImproveCodeAction(),
    registerAddToChatAction(),
  ];

  return {
    dispose: () => {
      disposables.forEach((d) => d.dispose());
    },
  };
}
