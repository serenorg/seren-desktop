// ABOUTME: Frontend logging bridge that writes to the Tauri log file.
// ABOUTME: Falls back to console when running outside Tauri (browser dev).

import { isTauriRuntime } from "@/lib/tauri-bridge";

type LogFn = (message: string) => Promise<void>;

let tauriError: LogFn | null = null;
let tauriWarn: LogFn | null = null;
let tauriInfo: LogFn | null = null;
let tauriDebug: LogFn | null = null;
let initialized = false;

async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;

  if (!isTauriRuntime()) return;

  try {
    const mod = await import("@tauri-apps/plugin-log");
    tauriError = mod.error;
    tauriWarn = mod.warn;
    tauriInfo = mod.info;
    tauriDebug = mod.debug;
  } catch {
    // Plugin not available, stay with console fallback
  }
}

function stringify(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

export const log = {
  async error(...args: unknown[]): Promise<void> {
    const msg = stringify(args);
    console.error(...args);
    await init();
    if (tauriError) await tauriError(msg).catch(() => {});
  },

  async warn(...args: unknown[]): Promise<void> {
    const msg = stringify(args);
    console.warn(...args);
    await init();
    if (tauriWarn) await tauriWarn(msg).catch(() => {});
  },

  async info(...args: unknown[]): Promise<void> {
    const msg = stringify(args);
    console.info(...args);
    await init();
    if (tauriInfo) await tauriInfo(msg).catch(() => {});
  },

  async debug(...args: unknown[]): Promise<void> {
    const msg = stringify(args);
    console.debug(...args);
    await init();
    if (tauriDebug) await tauriDebug(msg).catch(() => {});
  },
};
