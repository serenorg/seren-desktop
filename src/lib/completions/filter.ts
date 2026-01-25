import { createSignal } from "solid-js";

/**
 * Languages where completions should be enabled by default.
 * These are programming/markup languages where AI completion is useful.
 */
const CODE_LANGUAGES = new Set([
  // Programming languages
  "typescript",
  "javascript",
  "python",
  "rust",
  "go",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "scala",
  "r",
  "julia",
  "lua",
  "perl",
  "haskell",
  "elixir",
  "clojure",
  "dart",
  "zig",
  "nim",
  "ocaml",
  "fsharp",
  "erlang",
  "fortran",
  "cobol",
  "assembly",

  // Web technologies
  "html",
  "css",
  "scss",
  "less",
  "sass",
  "vue",
  "svelte",

  // Data/config languages
  "json",
  "yaml",
  "toml",
  "xml",
  "graphql",
  "sql",

  // Shell/scripting
  "shell",
  "bash",
  "powershell",
  "dockerfile",
  "makefile",

  // Other
  "markdown",
  "latex",
]);

/**
 * Languages where completions should be disabled by default.
 */
const DISABLED_LANGUAGES = new Set([
  "plaintext",
  "log",
  "diff",
  "git-commit",
  "git-rebase",
  "ignore",
]);

// Custom language settings (user overrides)
const [customEnabled, setCustomEnabled] = createSignal<Set<string>>(new Set());
const [customDisabled, setCustomDisabled] = createSignal<Set<string>>(new Set());

/**
 * Check if completions should be enabled for a language.
 */
export function isLanguageEnabled(language: string): boolean {
  // Check custom overrides first
  if (customDisabled().has(language)) {
    return false;
  }
  if (customEnabled().has(language)) {
    return true;
  }

  // Check default lists
  if (DISABLED_LANGUAGES.has(language)) {
    return false;
  }
  if (CODE_LANGUAGES.has(language)) {
    return true;
  }

  // Default: enable for unknown languages (be permissive)
  return true;
}

/**
 * Enable completions for a specific language.
 */
export function enableLanguage(language: string): void {
  setCustomDisabled((prev) => {
    const next = new Set(prev);
    next.delete(language);
    return next;
  });
  setCustomEnabled((prev) => {
    const next = new Set(prev);
    next.add(language);
    return next;
  });
}

/**
 * Disable completions for a specific language.
 */
export function disableLanguage(language: string): void {
  setCustomEnabled((prev) => {
    const next = new Set(prev);
    next.delete(language);
    return next;
  });
  setCustomDisabled((prev) => {
    const next = new Set(prev);
    next.add(language);
    return next;
  });
}

/**
 * Reset a language to its default setting.
 */
export function resetLanguage(language: string): void {
  setCustomEnabled((prev) => {
    const next = new Set(prev);
    next.delete(language);
    return next;
  });
  setCustomDisabled((prev) => {
    const next = new Set(prev);
    next.delete(language);
    return next;
  });
}

/**
 * Get all languages with custom settings.
 */
export function getCustomSettings(): {
  enabled: string[];
  disabled: string[];
} {
  return {
    enabled: Array.from(customEnabled()),
    disabled: Array.from(customDisabled()),
  };
}

/**
 * Set custom settings (e.g., from persisted preferences).
 */
export function setCustomSettings(settings: {
  enabled?: string[];
  disabled?: string[];
}): void {
  if (settings.enabled) {
    setCustomEnabled(new Set(settings.enabled));
  }
  if (settings.disabled) {
    setCustomDisabled(new Set(settings.disabled));
  }
}

/**
 * Get list of default code languages.
 */
export function getDefaultCodeLanguages(): string[] {
  return Array.from(CODE_LANGUAGES).sort();
}

/**
 * Get list of default disabled languages.
 */
export function getDefaultDisabledLanguages(): string[] {
  return Array.from(DISABLED_LANGUAGES).sort();
}
