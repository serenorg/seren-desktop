// ABOUTME: Opt-in runtime console breadcrumbs for normal success paths.
// ABOUTME: Keeps production console output focused on actionable warnings/errors.

export const RUNTIME_VERBOSE_CONSOLE_KEY = "seren.debug.verboseConsole";

type DebugStorage = Pick<Storage, "getItem">;

function runtimeConsoleStorage(): DebugStorage | null {
  if (typeof window === "undefined") return null;

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isEnabled(value: string | null): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export function shouldLogVerboseRuntimeConsole(
  storage: DebugStorage | null = runtimeConsoleStorage(),
): boolean {
  return isEnabled(storage?.getItem(RUNTIME_VERBOSE_CONSOLE_KEY) ?? null);
}

export const verboseRuntimeConsole = {
  debug(...args: unknown[]): void {
    if (shouldLogVerboseRuntimeConsole()) {
      console.debug(...args);
    }
  },

  debugWithStorage(storage: DebugStorage | null, ...args: unknown[]): void {
    if (shouldLogVerboseRuntimeConsole(storage)) {
      console.debug(...args);
    }
  },
};
