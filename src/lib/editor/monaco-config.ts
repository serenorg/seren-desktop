import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

// Configure Monaco to use locally bundled workers (avoids CDN + CSP issues)
self.MonacoEnvironment = {
  getWorker(_: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less")
      return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor")
      return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

let initialized = false;

/**
 * Initialize Monaco Editor with optimized configuration.
 * Call this once at app startup before rendering any editors.
 */
export async function initMonaco(): Promise<typeof monaco> {
  if (initialized) {
    return monaco;
  }

  initialized = true;
  registerThemes();

  return monaco;
}

/**
 * Get the Monaco instance. Throws if not initialized.
 */
export function getMonaco(): typeof monaco {
  if (!initialized) {
    throw new Error("Monaco not initialized. Call initMonaco() first.");
  }
  return monaco;
}

/**
 * Register custom editor themes matching Seren Desktop design.
 */
function registerThemes(): void {
  // Seren Dark Theme
  monaco.editor.defineTheme("seren-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6A9955", fontStyle: "italic" },
      { token: "keyword", foreground: "569CD6" },
      { token: "string", foreground: "CE9178" },
      { token: "number", foreground: "B5CEA8" },
      { token: "type", foreground: "4EC9B0" },
      { token: "function", foreground: "DCDCAA" },
      { token: "variable", foreground: "9CDCFE" },
    ],
    colors: {
      "editor.background": "#1e1e1e",
      "editor.foreground": "#d4d4d4",
      "editor.lineHighlightBackground": "#2d2d2d",
      "editor.selectionBackground": "#264f78",
      "editorCursor.foreground": "#ffffff",
      "editorLineNumber.foreground": "#858585",
      "editorLineNumber.activeForeground": "#c6c6c6",
      "editor.inactiveSelectionBackground": "#3a3d41",
    },
  });

  // Seren Light Theme
  monaco.editor.defineTheme("seren-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "008000", fontStyle: "italic" },
      { token: "keyword", foreground: "0000FF" },
      { token: "string", foreground: "A31515" },
      { token: "number", foreground: "098658" },
      { token: "type", foreground: "267F99" },
      { token: "function", foreground: "795E26" },
      { token: "variable", foreground: "001080" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#000000",
      "editor.lineHighlightBackground": "#f5f5f5",
      "editor.selectionBackground": "#add6ff",
      "editorCursor.foreground": "#000000",
      "editorLineNumber.foreground": "#999999",
      "editorLineNumber.activeForeground": "#000000",
    },
  });
}

/**
 * Default editor options for Seren Desktop.
 */
export const defaultEditorOptions: monaco.editor.IStandaloneEditorConstructionOptions =
  {
    theme: "seren-dark",
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontLigatures: true,
    lineNumbers: "on",
    minimap: { enabled: true, maxColumn: 80 },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    tabSize: 2,
    insertSpaces: true,
    wordWrap: "off",
    renderWhitespace: "selection",
    bracketPairColorization: { enabled: true },
    guides: {
      bracketPairs: true,
      indentation: true,
    },
    smoothScrolling: true,
    cursorBlinking: "smooth",
    cursorSmoothCaretAnimation: "on",
    padding: { top: 8, bottom: 8 },
  };

/**
 * Infer language from file extension.
 */
export function getLanguageFromPath(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const languageMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    html: "html",
    css: "css",
    scss: "scss",
    less: "less",
    md: "markdown",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    scala: "scala",
    sql: "sql",
    sh: "shell",
    bash: "shell",
    zsh: "shell",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    svg: "xml",
    dockerfile: "dockerfile",
    makefile: "makefile",
    gitignore: "ignore",
  };
  return languageMap[ext] || "plaintext";
}
