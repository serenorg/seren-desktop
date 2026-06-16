// ABOUTME: Frontend state for Rust-backed terminal buffers.
// ABOUTME: Tracks terminal buffer metadata; grid rendering state lives in TerminalBuffer.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore, produce } from "solid-js/store";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { fileTreeState } from "@/stores/fileTree";

export type TerminalStatus = "running" | "exited";
export type TerminalCliKind = "claude" | "codex";
export type TerminalLaunchMode = "normal" | "yolo";
export type TerminalSignal =
  | "interrupt"
  | "quit"
  | "hangup"
  | "terminate"
  | "kill";

const DEFAULT_CLI_LAUNCH_MODE_KEY = "seren:terminal-cli-launch-mode";

export interface TerminalBufferInfo {
  id: string;
  instanceId?: string | null;
  title: string;
  cwd?: string | null;
  command?: string | null;
  cliKind?: TerminalCliKind | null;
  launchMode: TerminalLaunchMode;
  /** Session id for this terminal's cliKind (Claude assigned / Codex captured). */
  sessionId?: string | null;
  /** True once the CLI has created a session that can be resumed by id. */
  sessionResumable: boolean;
  cols: number;
  rows: number;
  status: TerminalStatus;
  createdAt: number;
  updatedAt: number;
}

/** Durable record used to restore + resume a CLI-agent terminal after restart. */
export interface TerminalAgentDescriptor {
  id: string;
  title: string;
  cliKind: TerminalCliKind;
  launchMode: TerminalLaunchMode;
  cwd?: string | null;
  sessionId?: string | null;
  sessionResumable: boolean;
  autoRestore: boolean;
  createdAt: number;
  updatedAt: number;
}

interface TerminalExitEvent {
  bufferId: string;
}

interface TerminalState {
  buffers: Record<string, TerminalBufferInfo>;
  focusRequests: Record<string, number>;
  defaultCliLaunchMode: TerminalLaunchMode;
  initialized: boolean;
}

function normalizeLaunchMode(value: unknown): TerminalLaunchMode {
  return value === "yolo" ? "yolo" : "normal";
}

function browserLocalStorage(): Storage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function readDefaultCliLaunchMode(): TerminalLaunchMode {
  try {
    return normalizeLaunchMode(
      browserLocalStorage()?.getItem(DEFAULT_CLI_LAUNCH_MODE_KEY),
    );
  } catch {
    return "normal";
  }
}

function writeDefaultCliLaunchMode(launchMode: TerminalLaunchMode): void {
  try {
    browserLocalStorage()?.setItem(DEFAULT_CLI_LAUNCH_MODE_KEY, launchMode);
  } catch {
    // Non-critical preference; fall back to the in-memory value.
  }
}

const [state, setState] = createStore<TerminalState>({
  buffers: {},
  focusRequests: {},
  defaultCliLaunchMode: readDefaultCliLaunchMode(),
  initialized: false,
});

let exitUnlisten: UnlistenFn | null = null;

export function terminalTitleForCliLaunch(
  cliKind: TerminalCliKind,
  _launchMode: TerminalLaunchMode,
): string {
  return cliKind === "claude" ? "Claude Code CLI" : "Codex CLI";
}

export const terminalStore = {
  get buffers(): TerminalBufferInfo[] {
    return Object.values(state.buffers).sort(
      (a, b) => b.createdAt - a.createdAt,
    );
  },

  getBuffer(id: string | null): TerminalBufferInfo | null {
    if (!id) return null;
    return state.buffers[id] ?? null;
  },

  getFocusRequest(id: string | null): number {
    if (!id) return 0;
    return state.focusRequests[id] ?? 0;
  },

  get defaultCliLaunchMode(): TerminalLaunchMode {
    return state.defaultCliLaunchMode;
  },

  setDefaultCliLaunchMode(launchMode: TerminalLaunchMode): void {
    const normalized = normalizeLaunchMode(launchMode);
    setState("defaultCliLaunchMode", normalized);
    writeDefaultCliLaunchMode(normalized);
  },

  requestFocus(bufferId: string): void {
    setState(
      "focusRequests",
      bufferId,
      (state.focusRequests[bufferId] ?? 0) + 1,
    );
  },

  async init() {
    if (state.initialized) return;
    setState("initialized", true);
    if (!isTauriRuntime()) return;

    exitUnlisten = await listen<TerminalExitEvent>(
      "terminal://exit",
      (event) => {
        const { bufferId } = event.payload;
        if (!state.buffers[bufferId]) return;
        setState("buffers", bufferId, {
          ...state.buffers[bufferId],
          status: "exited",
          updatedAt: Date.now(),
        });
      },
    );

    const buffers = await invoke<TerminalBufferInfo[]>("terminal_list_buffers");
    for (const info of buffers) {
      setState("buffers", info.id, info);
    }
  },

  async createBuffer(options: {
    id?: string;
    title?: string;
    command?: string;
    cliKind?: TerminalCliKind;
    launchMode?: TerminalLaunchMode;
    cwd?: string | null;
    /** Resume an existing session rather than starting a fresh one. */
    resume?: boolean;
    /** Session id to resume (or, for a Claude fresh launch, assign). */
    sessionId?: string | null;
    sessionResumable?: boolean;
  }): Promise<TerminalBufferInfo> {
    await this.init();
    const launchMode =
      options.launchMode ??
      (options.cliKind ? state.defaultCliLaunchMode : "normal");
    const info = await invoke<TerminalBufferInfo>("terminal_create_buffer", {
      request: {
        id: options.id,
        title:
          options.title ??
          (options.cliKind
            ? terminalTitleForCliLaunch(options.cliKind, launchMode)
            : undefined),
        command: options.cliKind ? undefined : options.command,
        cliKind: options.cliKind ?? null,
        launchMode,
        resume: options.resume ?? false,
        sessionId: options.sessionId ?? undefined,
        sessionResumable: options.sessionResumable ?? undefined,
        cwd: options.cwd ?? fileTreeState.rootPath ?? undefined,
        cols: 100,
        rows: 28,
      },
    });
    setState("buffers", info.id, info);
    // Codex assigns its own session id (deferred until first activity); capture
    // it shortly after launch so a later toggle / app-restart can resume the
    // exact session. Best-effort and idempotent.
    if (info.cliKind === "codex" && !info.sessionId) {
      this.scheduleCodexSessionCapture(info.id);
    }
    return info;
  },

  async restartBuffer(
    bufferId: string,
    options: {
      title?: string;
      command?: string;
      cliKind?: TerminalCliKind;
      launchMode?: TerminalLaunchMode;
      cwd?: string | null;
    } = {},
  ): Promise<TerminalBufferInfo> {
    const current = state.buffers[bufferId];
    const cliKind = options.cliKind ?? current?.cliKind ?? undefined;
    const launchMode = options.launchMode ?? current?.launchMode ?? "normal";
    const info = await invoke<TerminalBufferInfo>("terminal_restart_buffer", {
      bufferId,
      request: {
        title:
          options.title ??
          (cliKind
            ? terminalTitleForCliLaunch(cliKind, launchMode)
            : undefined),
        command: cliKind ? undefined : options.command,
        cliKind: cliKind ?? null,
        launchMode,
        sessionId: current?.sessionId ?? undefined,
        expectedInstanceId: current?.instanceId ?? undefined,
        cwd: options.cwd ?? current?.cwd ?? undefined,
      },
    });
    setState("buffers", info.id, info);
    if (info.cliKind === "codex" && !info.sessionId) {
      this.scheduleCodexSessionCapture(info.id);
    }
    this.requestFocus(info.id);
    return info;
  },

  /** Capture the Codex session id from the live process (idempotent no-op for
   * Claude / already-captured / not-yet-written sessions). */
  async captureSessionId(bufferId: string): Promise<string | null> {
    if (!isTauriRuntime()) return null;
    const sessionId = await invoke<string | null>(
      "terminal_capture_session_id",
      { bufferId },
    );
    if (sessionId && state.buffers[bufferId]) {
      setState("buffers", bufferId, "sessionId", sessionId);
      setState("buffers", bufferId, "sessionResumable", true);
    }
    return sessionId;
  },

  /** Poll a few times for a Codex session id after launch — the rollout file is
   * created lazily on first activity, so it may not exist immediately. */
  scheduleCodexSessionCapture(bufferId: string): void {
    if (!isTauriRuntime()) return;
    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      const buffer = state.buffers[bufferId];
      if (buffer?.status !== "running" || buffer?.sessionId) return;
      const captured = await this.captureSessionId(bufferId).catch(() => null);
      if (!captured && attempts < 10) {
        setTimeout(() => void tick(), 3000);
      }
    };
    setTimeout(() => void tick(), 3000);
  },

  async listAgentDescriptors(): Promise<TerminalAgentDescriptor[]> {
    if (!isTauriRuntime()) return [];
    return invoke<TerminalAgentDescriptor[]>("terminal_list_agent_descriptors");
  },

  /** Drop the persisted descriptor so a closed terminal is not auto-restored. */
  async forgetAgent(bufferId: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("terminal_forget_agent", { bufferId });
  },

  /** Re-open and resume the CLI-agent terminals the user had open before the
   * app restarted. Each descriptor reuses its id (== thread id) and resumes its
   * session in its persisted mode (YOLO included, per design). Best-effort per
   * descriptor so one failure does not block the rest. */
  async restoreAgents(): Promise<void> {
    if (!isTauriRuntime()) return;
    const descriptors = await this.listAgentDescriptors().catch(() => []);
    for (const descriptor of descriptors) {
      if (!descriptor.autoRestore) continue;
      if (!descriptor.sessionResumable) {
        await this.forgetAgent(descriptor.id).catch(() => {});
        continue;
      }
      if (state.buffers[descriptor.id]) continue;
      try {
        await this.createBuffer({
          id: descriptor.id,
          title: descriptor.title,
          cliKind: descriptor.cliKind,
          launchMode: descriptor.launchMode,
          cwd: descriptor.cwd ?? undefined,
          resume: true,
          sessionId: descriptor.sessionId ?? undefined,
          sessionResumable: true,
        });
      } catch (error) {
        console.warn(
          `Failed to restore terminal agent ${descriptor.id}`,
          error,
        );
      }
    }
  },

  async write(bufferId: string, data: string): Promise<void> {
    await invoke("terminal_write", { bufferId, data });
  },

  async sendLine(bufferId: string, line: string): Promise<void> {
    await this.write(bufferId, `${line}\r`);
  },

  async resize(bufferId: string, cols: number, rows: number): Promise<void> {
    const info = await invoke<TerminalBufferInfo>("terminal_resize", {
      bufferId,
      cols,
      rows,
    });
    setState("buffers", info.id, info);
  },

  /**
   * Send a POSIX signal to the terminal's foreground process group when the
   * platform supports it (Unix). Falls back to the line-discipline control
   * byte (Ctrl-C, Ctrl-\\) where it doesn't (Windows ConPTY). Use this for
   * Ctrl-C and friends instead of writing `\\x03` directly so raw-mode TUIs
   * (vim, htop, claude, codex) actually receive the signal.
   */
  async signal(bufferId: string, signal: TerminalSignal): Promise<void> {
    await invoke("terminal_signal", { bufferId, signal });
  },

  async kill(bufferId: string): Promise<void> {
    await invoke("terminal_kill", { bufferId });
    if (state.buffers[bufferId]) {
      setState("buffers", bufferId, {
        ...state.buffers[bufferId],
        status: "exited",
        updatedAt: Date.now(),
      });
    }
  },

  /**
   * Update the displayed title for an existing buffer. Driven by OSC
   * 0/2 escape sequences captured in the Rust grid and shipped on
   * grid-diff events; the buffer header in TerminalBuffer reads this
   * field so the title visibly tracks `cd`, running command, etc.
   * No-op if the buffer is gone or the title is unchanged.
   */
  setBufferTitle(bufferId: string, title: string) {
    const buffer = state.buffers[bufferId];
    if (!buffer || buffer.title === title) return;
    setState("buffers", bufferId, {
      ...buffer,
      title,
      updatedAt: Date.now(),
    });
  },

  removeLocal(bufferId: string) {
    setState(
      produce((s: TerminalState) => {
        delete s.buffers[bufferId];
        delete s.focusRequests[bufferId];
      }),
    );
  },

  dispose() {
    exitUnlisten?.();
    exitUnlisten = null;
    setState("initialized", false);
  },

  /**
   * One-shot probe of `claude --version` (#2006). Returns the version
   * token shown by the binary (e.g. "2.1.148"), or null if the binary
   * is unavailable / the output isn't parseable. Cached at module
   * scope so the IPC round-trip happens at most once per session.
   */
  async getClaudeCliVersion(): Promise<string | null> {
    if (cachedClaudeVersion !== UNSET) return cachedClaudeVersion;
    try {
      const version = await invoke<string | null>("terminal_claude_version");
      cachedClaudeVersion = version ?? null;
    } catch {
      cachedClaudeVersion = null;
    }
    return cachedClaudeVersion;
  },
};

const UNSET: unique symbol = Symbol("unset");
let cachedClaudeVersion: string | null | typeof UNSET = UNSET;
