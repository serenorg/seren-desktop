import type * as monaco from "monaco-editor";
import {
  type Component,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import {
  defaultEditorOptions,
  getLanguageFromPath,
  getMonaco,
  initMonaco,
  registerAllCodeActions,
} from "@/lib/editor";

// Track if global actions have been registered (Monaco actions are global, not per-editor)
let actionsRegistered = false;

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
  options?: monaco.editor.IStandaloneEditorConstructionOptions;
}

export const MonacoEditor: Component<MonacoEditorProps> = (props) => {
  let containerRef: HTMLDivElement | undefined;
  let editor: monaco.editor.IStandaloneCodeEditor | undefined;
  let model: monaco.editor.ITextModel | undefined;
  let ownsModel = false; // Track if we created the model vs reused existing

  const [isDirty, setIsDirty] = createSignal(false);
  const [originalValue, setOriginalValue] = createSignal(props.value || "");
  // Track Monaco initialization to trigger re-render of value effect
  const [isMonacoReady, setIsMonacoReady] = createSignal(false);

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

    // Create or reuse model - check if one already exists with this URI
    const uri = props.filePath ? monaco.Uri.file(props.filePath) : undefined;
    const existingModel = uri ? monaco.editor.getModel(uri) : null;

    if (existingModel) {
      // Reuse existing model, update its content if different
      model = existingModel;
      ownsModel = false;
      if (props.value !== undefined && model.getValue() !== props.value) {
        model.setValue(props.value);
      }
    } else {
      // Create new model
      model = monaco.editor.createModel(props.value || "", language, uri);
      ownsModel = true;
    }

    // Create editor
    editor = monaco.editor.create(containerRef, {
      ...defaultEditorOptions,
      ...props.options,
      model,
      theme: props.theme || "seren-dark",
      readOnly: props.readOnly || false,
    });

    // Signal that Monaco is ready - this triggers effects that depend on model
    setIsMonacoReady(true);

    // Register global code actions once (Cmd+K, context menu items, etc.)
    if (!actionsRegistered) {
      registerAllCodeActions();
      actionsRegistered = true;
    }

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
      // Only dispose model if we created it (not if reused from another editor)
      if (ownsModel) {
        model?.dispose();
      }
    });
  });

  // Update value from props (controlled mode)
  // isMonacoReady() is accessed to re-run this effect when Monaco initializes
  createEffect(() => {
    const ready = isMonacoReady();
    const newValue = props.value;
    if (
      ready &&
      newValue !== undefined &&
      model &&
      model.getValue() !== newValue
    ) {
      model.setValue(newValue);
      setOriginalValue(newValue);
      setIsDirty(false);
    }
  });

  // Update language when filePath changes
  createEffect(() => {
    if (!model || !props.filePath || !isMonacoReady()) return;
    const m = getMonaco();
    const language = props.language || getLanguageFromPath(props.filePath);
    m.editor.setModelLanguage(model, language);
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
   * TODO: Expose via ref pattern when needed by parent components.
   */
  function _markSaved(): void {
    if (model) {
      setOriginalValue(model.getValue());
      setIsDirty(false);
    }
  }

  /**
   * Get the editor instance for advanced operations.
   * TODO: Expose via ref pattern when needed by parent components.
   */
  function _getEditor(): monaco.editor.IStandaloneCodeEditor | undefined {
    return editor;
  }

  /**
   * Get the model instance.
   * TODO: Expose via ref pattern when needed by parent components.
   */
  function _getModel(): monaco.editor.ITextModel | undefined {
    return model;
  }

  /**
   * Focus the editor.
   * TODO: Expose via ref pattern when needed by parent components.
   */
  function _focus(): void {
    editor?.focus();
  }
  // These methods are prefixed with _ to suppress unused warnings.
  // They will be exposed via ref pattern when parent components need them.
  void _markSaved;
  void _getEditor;
  void _getModel;
  void _focus;

  return <div ref={containerRef} class="w-full h-full min-h-[200px]" />;
};

export default MonacoEditor;
