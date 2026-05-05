// ABOUTME: Frontend state for Rust-backed terminal buffers.
// ABOUTME: Tracks terminal buffer metadata; grid rendering state lives in TerminalBuffer.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore, produce } from "solid-js/store";
import { fileTreeState } from "@/stores/fileTree";

export type TerminalStatus = "running" | "exited";
export type TerminalSignal =
  | "interrupt"
  | "quit"
  | "hangup"
  | "terminate"
  | "kill";

export interface TerminalBufferInfo {
  id: string;
  title: string;
  cwd?: string | null;
  command?: string | null;
  cols: number;
  rows: number;
  status: TerminalStatus;
  createdAt: number;
  updatedAt: number;
}

interface TerminalExitEvent {
  bufferId: string;
}

interface TerminalState {
  buffers: Record<string, TerminalBufferInfo>;
  focusRequests: Record<string, number>;
  initialized: boolean;
}

const [state, setState] = createStore<TerminalState>({
  buffers: {},
  focusRequests: {},
  initialized: false,
});

let exitUnlisten: UnlistenFn | null = null;

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
    title?: string;
    command?: string;
    cwd?: string | null;
  }): Promise<TerminalBufferInfo> {
    await this.init();
    const info = await invoke<TerminalBufferInfo>("terminal_create_buffer", {
      request: {
        title: options.title,
        command: options.command,
        cwd: options.cwd ?? fileTreeState.rootPath ?? undefined,
        cols: 100,
        rows: 28,
      },
    });
    setState("buffers", info.id, info);
    return info;
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
};
