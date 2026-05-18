// ABOUTME: Appearance store: theme, font sizes, density. Drives :root class + CSS vars.
// ABOUTME: Persists to Tauri store; mirrors to localStorage for synchronous boot hydration.

import { createStore } from "solid-js/store";
import { isTauriRuntime } from "@/lib/tauri-bridge";

const APPEARANCE_STORE = "appearance.json";
const APPEARANCE_KEY = "appearance";
const BROWSER_APPEARANCE_KEY = "seren_appearance";

// The settings store used to own `theme`. On first boot under the new
// appearance store, we read this through the same backing file so the user's
// existing dark/light/system choice carries over. The migration writes the
// value into the appearance store and the legacy field becomes inert.
const LEGACY_SETTINGS_STORE = "settings.json";
const LEGACY_SETTINGS_KEY = "app";

export type Theme = "dark" | "light" | "system";
export type FontSizeStep = "s" | "m" | "l" | "xl";
export type Density = "compact" | "comfortable" | "spacious";

export interface Appearance {
  theme: Theme;
  chatFontSize: FontSizeStep;
  threadListFontSize: FontSizeStep;
  terminalFontSize: number;
  density: Density;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "dark",
  chatFontSize: "m",
  threadListFontSize: "m",
  terminalFontSize: 14,
  density: "comfortable",
};

export const TERMINAL_FONT_SIZE_MIN = 11;
export const TERMINAL_FONT_SIZE_MAX = 18;

export const CHAT_FONT_SIZE_PX: Record<FontSizeStep, number> = {
  s: 13,
  m: 15,
  l: 17,
  xl: 19,
};

export const THREAD_LIST_FONT_SIZE_PX: Record<FontSizeStep, number> = {
  s: 12,
  m: 13,
  l: 15,
  xl: 17,
};

const CHAT_FONT_SIZE_REM: Record<FontSizeStep, string> = {
  s: "0.8125rem",
  m: "0.9375rem",
  l: "1.0625rem",
  xl: "1.1875rem",
};

const THREAD_LIST_FONT_SIZE_REM: Record<FontSizeStep, string> = {
  s: "0.75rem",
  m: "0.8125rem",
  l: "0.9375rem",
  xl: "1.0625rem",
};

interface AppearanceState {
  appearance: Appearance;
}

const [appearanceState, setAppearanceState] = createStore<AppearanceState>({
  appearance: { ...DEFAULT_APPEARANCE },
});

let appearanceMutationVersion = 0;
let queuedStorageWrite: Appearance | null = null;
let storageWriteInFlight: Promise<void> | null = null;

function cloneAppearance(appearance: Appearance): Appearance {
  return { ...appearance };
}

function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light" || value === "system";
}

function isFontSizeStep(value: unknown): value is FontSizeStep {
  return value === "s" || value === "m" || value === "l" || value === "xl";
}

function isDensity(value: unknown): value is Density {
  return value === "compact" || value === "comfortable" || value === "spacious";
}

function normalizeTerminalFontSize(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < TERMINAL_FONT_SIZE_MIN || rounded > TERMINAL_FONT_SIZE_MAX) {
    return null;
  }
  return rounded;
}

function normalize(raw: unknown): Appearance {
  const out: Appearance = { ...DEFAULT_APPEARANCE };
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  if (isTheme(obj.theme)) out.theme = obj.theme;
  if (isFontSizeStep(obj.chatFontSize)) out.chatFontSize = obj.chatFontSize;
  if (isFontSizeStep(obj.threadListFontSize)) {
    out.threadListFontSize = obj.threadListFontSize;
  }
  const terminalFontSize = normalizeTerminalFontSize(obj.terminalFontSize);
  if (terminalFontSize !== null) out.terminalFontSize = terminalFontSize;
  if (isDensity(obj.density)) out.density = obj.density;
  return out;
}

async function getInvoke(): Promise<
  typeof import("@tauri-apps/api/core").invoke | null
> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

/**
 * Read the cached appearance JSON from localStorage and apply it to the
 * documentElement BEFORE the SolidJS tree mounts. Called from index.tsx so
 * theme + font sizes are correct on the very first paint.
 *
 * Returns the appearance value that was applied so callers can hand it to the
 * store. Falls back to defaults if no cache exists. The Tauri store is the
 * canonical persistence; this is just a hot path so we don't FOUC.
 */
export function hydrateAppearanceSync(): Appearance {
  let parsed: Appearance = { ...DEFAULT_APPEARANCE };
  try {
    const cached = localStorage.getItem(BROWSER_APPEARANCE_KEY);
    if (cached) parsed = normalize(JSON.parse(cached));
  } catch {
    // No cache or corrupt cache: defaults are fine.
  }
  applyAppearanceToDocument(parsed);
  setAppearanceState("appearance", parsed);
  return parsed;
}

/**
 * Resolve the effective dark/light choice. `"system"` reads the OS preference
 * once at apply-time; AppShell installs a media-query listener so the
 * documentElement class re-applies if the user changes their OS theme while
 * Seren Desktop is open.
 */
export function resolveEffectiveTheme(theme: Theme): "dark" | "light" {
  if (theme === "dark" || theme === "light") return theme;
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/**
 * Apply an appearance value to documentElement: toggles the dark/light class,
 * sets density class, and writes the font-size CSS variables. Idempotent.
 */
export function applyAppearanceToDocument(appearance: Appearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  const effective = resolveEffectiveTheme(appearance.theme);
  root.classList.toggle("dark", effective === "dark");
  root.classList.toggle("light", effective === "light");

  // Density class: presence of compact / spacious overrides the defaults in
  // styles.css; comfortable matches the default vars so we clear both.
  root.classList.toggle("density-compact", appearance.density === "compact");
  root.classList.toggle("density-spacious", appearance.density === "spacious");

  root.style.setProperty(
    "--chat-font-size",
    CHAT_FONT_SIZE_REM[appearance.chatFontSize],
  );
  root.style.setProperty(
    "--thread-list-font-size",
    THREAD_LIST_FONT_SIZE_REM[appearance.threadListFontSize],
  );
}

async function readLegacySettingsTheme(): Promise<Theme | null> {
  try {
    const invoke = await getInvoke();
    let stored: string | null = null;
    if (invoke) {
      stored = await invoke<string | null>("get_setting", {
        store: LEGACY_SETTINGS_STORE,
        key: LEGACY_SETTINGS_KEY,
      });
    } else {
      stored = localStorage.getItem("seren_settings");
    }
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    if (isTheme(parsed.theme)) return parsed.theme;
    return null;
  } catch {
    return null;
  }
}

async function readStoredAppearance(): Promise<Appearance | null> {
  try {
    const invoke = await getInvoke();
    let stored: string | null = null;
    if (invoke) {
      stored = await invoke<string | null>("get_setting", {
        store: APPEARANCE_STORE,
        key: APPEARANCE_KEY,
      });
    } else {
      stored = localStorage.getItem(BROWSER_APPEARANCE_KEY);
    }
    if (!stored) return null;
    return normalize(JSON.parse(stored));
  } catch {
    return null;
  }
}

function writeAppearanceCache(appearance: Appearance): void {
  const value = JSON.stringify(appearance);
  try {
    localStorage.setItem(BROWSER_APPEARANCE_KEY, value);
  } catch {
    // ignore: private mode, quota, etc.
  }
}

async function writeStoredAppearance(appearance: Appearance): Promise<void> {
  const value = JSON.stringify(appearance);
  try {
    const invoke = await getInvoke();
    if (invoke) {
      await invoke("set_setting", {
        store: APPEARANCE_STORE,
        key: APPEARANCE_KEY,
        value,
      });
    }
  } catch (error) {
    console.error("[appearance] Failed to persist appearance:", error);
  }
}

async function drainQueuedStorageWrites(): Promise<void> {
  while (queuedStorageWrite) {
    const next = queuedStorageWrite;
    queuedStorageWrite = null;
    await writeStoredAppearance(next);
  }
}

function persistAppearance(appearance: Appearance): Promise<void> {
  const snapshot = cloneAppearance(appearance);
  // Always mirror to localStorage first: this is the sync hot cache that
  // hydrateAppearanceSync reads on next boot, and the browser-fallback
  // persistence when running outside Tauri.
  writeAppearanceCache(snapshot);
  queuedStorageWrite = snapshot;
  if (!storageWriteInFlight) {
    storageWriteInFlight = drainQueuedStorageWrites().finally(() => {
      storageWriteInFlight = null;
    });
  }
  return storageWriteInFlight;
}

/**
 * Load appearance from canonical (Tauri) storage and reconcile with the
 * synchronously-hydrated value. Also runs the one-shot migration that lifts
 * the user's existing `settings.app.theme` into the appearance store.
 *
 * Call this once from AppShell's onMount after the sync hydration. If the
 * stored value differs from the cache, the store updates and the effect in
 * AppShell re-applies the document.
 */
export async function loadAppearance(): Promise<void> {
  const mutationVersionAtStart = appearanceMutationVersion;
  const stored = await readStoredAppearance();
  if (appearanceMutationVersion !== mutationVersionAtStart) return;
  if (stored) {
    setAppearanceState("appearance", stored);
    writeAppearanceCache(stored);
    return;
  }

  // First boot on this build: migrate the legacy settings.app.theme if any.
  const legacyTheme = await readLegacySettingsTheme();
  if (appearanceMutationVersion !== mutationVersionAtStart) return;
  const migrated: Appearance = {
    ...DEFAULT_APPEARANCE,
    theme: legacyTheme ?? DEFAULT_APPEARANCE.theme,
  };
  setAppearanceState("appearance", migrated);
  await persistAppearance(migrated);
}

export const appearanceStore = {
  get appearance(): Appearance {
    return appearanceState.appearance;
  },
  // Document application is owned by the createEffect in AppShell so every
  // state change has a single side-effect path. Persistence is queued so rapid
  // successive UI changes cannot write an older value after a newer one.
  set<K extends keyof Appearance>(key: K, value: Appearance[K]): void {
    appearanceMutationVersion += 1;
    setAppearanceState("appearance", key, value);
    void persistAppearance(appearanceState.appearance);
  },
  reset(): void {
    appearanceMutationVersion += 1;
    setAppearanceState("appearance", { ...DEFAULT_APPEARANCE });
    void persistAppearance(appearanceState.appearance);
  },
};

export { appearanceState };
