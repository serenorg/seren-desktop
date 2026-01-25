import {
  createSignal,
  createEffect,
  onMount,
  onCleanup,
  type Component,
} from "solid-js";
import type * as Monaco from "monaco-editor";
import {
  initMonaco,
  defaultEditorOptions,
  getLanguageFromPath,
} from "@/lib/editor";

export interface MonacoEditorProps {
  /** File path for language detection and display */
  filePath?: string;
  /** Initial content */
  value?: string;
  /** Callback when content changes */
  onChange?: (value: string) => void;
  /** Callback when dirty state changes */
  onDirtyChange?: (isDirty: boolean) => void;
  /** Language override (auto-detected from filePath if not provided) */
  language?: string;
  /** Theme override */
  theme?: "seren-dark" | "seren-light";
  /** Read-only mode */
  readOnly?: boolean;
  /** Additional editor options */
  options?: Monaco.editor.IStandaloneEditorConstructionOptions;
}

export const MonacoEditor: Component<MonacoEditorProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
  let model: Monaco.editor.ITextModel | undefined;

  const [isDirty, setIsDirty] = createSignal(false);
  const [originalValue, setOriginalValue] = createSignal(props.value || "");

  // Track dirty state
  createEffect(() => {
    const dirty = isDirty();
    props.onDirtyChange?.(dirty);
  });

  onMount(async () => {
    if (!containerRef) return;

    const monaco = await initMonaco();

    // Determine language
    const language =
      props.language ||
      (props.filePath ? getLanguageFromPath(props.filePath) : "plaintext");

    // Create model
    model = monaco.editor.createModel(
      props.value || "",
      language,
      props.filePath ? monaco.Uri.file(props.filePath) : undefined
    );

    // Create editor
    editor = monaco.editor.create(containerRef, {
      ...defaultEditorOptions,
      ...props.options,
      model,
      theme: props.theme || "seren-dark",
      readOnly: props.readOnly || false,
    });

    // Listen for content changes
    const disposable = model.onDidChangeContent(() => {
      const currentValue = model?.getValue() || "";
      props.onChange?.(currentValue);

      // Update dirty state
      setIsDirty(currentValue !== originalValue());
    });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      editor?.layout();
    });
    resizeObserver.observe(containerRef);

    onCleanup(() => {
      disposable.dispose();
      resizeObserver.disconnect();
      editor?.dispose();
      model?.dispose();
    });
  });

  // Update value from props (controlled mode)
  createEffect(() => {
    const newValue = props.value;
    if (newValue !== undefined && model && model.getValue() !== newValue) {
      model.setValue(newValue);
      setOriginalValue(newValue);
      setIsDirty(false);
    }
  });

  // Update language when filePath changes
  createEffect(() => {
    if (!model || !props.filePath) return;
    const monaco = editor?.getModel()
      ? (globalThis as unknown as { monaco: typeof Monaco }).monaco
      : null;
    if (monaco) {
      const language = props.language || getLanguageFromPath(props.filePath);
      monaco.editor.setModelLanguage(model, language);
    }
  });

  // Update theme when changed
  createEffect(() => {
    if (editor && props.theme) {
      editor.updateOptions({ theme: props.theme });
    }
  });

  // Update read-only state
  createEffect(() => {
    if (editor) {
      editor.updateOptions({ readOnly: props.readOnly || false });
    }
  });

  /**
   * Mark current content as saved (resets dirty state).
   */
  function markSaved(): void {
    if (model) {
      setOriginalValue(model.getValue());
      setIsDirty(false);
    }
  }

  /**
   * Get the editor instance for advanced operations.
   */
  function getEditor(): Monaco.editor.IStandaloneCodeEditor | undefined {
    return editor;
  }

  /**
   * Get the model instance.
   */
  function getModel(): Monaco.editor.ITextModel | undefined {
    return model;
  }

  /**
   * Focus the editor.
   */
  function focus(): void {
    editor?.focus();
  }

  // Expose methods via ref pattern if needed
  // For now, we return a simple div

  return (
    <div
      ref={containerRef}
      class="monaco-editor-container"
      style={{
        width: "100%",
        height: "100%",
        "min-height": "200px",
      }}
    />
  );
};

export default MonacoEditor;
