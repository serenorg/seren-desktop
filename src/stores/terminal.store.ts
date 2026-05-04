// ABOUTME: Frontend state for Rust-backed terminal buffers.
// ABOUTME: Mirrors the authoritative Rust output buffer via snapshot + seq-deduped chunk events.

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

// Versioned snapshot envelope. Stage 1 only emits the `raw-text` kind.
// Stage 2 will add a `grid` kind carrying parsed cell state, cursor, modes,
// and image placements; pattern-matching on `kind` here makes that addition
// non-breaking for callers that already dispatch on the discriminator.
type TerminalSnapshot = TerminalSnapshotRawText;

interface TerminalSnapshotRawText {
  seq: number;
  kind: "raw-text";
  payload: { data: string };
}

interface TerminalOutputEvent {
  bufferId: string;
  seq: number;
  data: string;
}

interface TerminalExitEvent {
  bufferId: string;
}

interface TerminalState {
  buffers: Record<string, TerminalBufferInfo>;
  output: Record<string, string>;
  // Highest seq applied to `output` per buffer; used to dedupe chunks against
  // a snapshot that was taken concurrently with in-flight events.
  lastSeq: Record<string, number>;
  initialized: boolean;
}

const [state, setState] = createStore<TerminalState>({
  buffers: {},
  output: {},
  lastSeq: {},
  initialized: false,
});

let outputUnlisten: UnlistenFn | null = null;
let exitUnlisten: UnlistenFn | null = null;

// Per-buffer chunk holding queues used while a snapshot is in flight. The
// listener can fire for chunks whose seq is older than what the in-flight
// snapshot will return (e.g. listener installed before any chunks, chunks 4-6
// arrive on top of empty output, then snapshot at seq=6 lands carrying the
// authoritative data1+...+data6). Without holding the early chunks aside,
// applySnapshot's seq guard would skip the snapshot since lastSeq has already
// advanced, and we'd silently lose data1-data3. Drained on snapshot arrival.
const pendingChunks = new Map<string, TerminalOutputEvent[]>();
const rehydrating = new Set<string>();
// Per-buffer in-flight rehydrate promise so concurrent calls chain instead of
// racing. Without this, a second rehydrateBuffer for the same id would replace
// the shared queue while the first was still pending; when the first finally
// fires it would clear `rehydrating`/`pendingChunks` even though the second
// snapshot is still in flight, allowing chunks to bypass parking and the
// later snapshot to unconditionally overwrite output with stale data.
const rehydratePromises = new Map<string, Promise<void>>();

// Rust caps its authoritative buffer at 200_000 chars. Mirror the cap on the
// live event path so a long-running TUI/build log can't grow JS memory and
// `<pre>` rendering cost without bound between rehydrations.
const MAX_BUFFER_CHARS = 200_000;

function trimToCap(s: string, cap: number): string {
  if (s.length <= cap) return s;
  let start = s.length - cap;
  // Don't split a UTF-16 surrogate pair: if the cut lands on a low surrogate,
  // step forward one code unit so the leading high surrogate goes with it.
  if (start > 0 && start < s.length) {
    const code = s.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start++;
  }
  return s.slice(start);
}

function appendChunk(bufferId: string, seq: number, data: string): void {
  const lastSeq = state.lastSeq[bufferId] ?? 0;
  if (seq <= lastSeq) return;
  setState(
    produce((s: TerminalState) => {
      const next = (s.output[bufferId] ?? "") + data;
      s.output[bufferId] = trimToCap(next, MAX_BUFFER_CHARS);
      s.lastSeq[bufferId] = seq;
    }),
  );
}

function applySnapshot(bufferId: string, snapshot: TerminalSnapshot): void {
  // Snapshots are authoritative for the prefix [0, snapshot.seq]. Replace the
  // output unconditionally; if the listener has already applied chunks past
  // snapshot.seq we will re-apply them from the holding queue below.
  // Dispatch on the envelope discriminator so Stage 2 grid snapshots can
  // route to the grid store without touching this raw-text path.
  if (snapshot.kind === "raw-text") {
    setState(
      produce((s: TerminalState) => {
        s.output[bufferId] = snapshot.payload.data;
        s.lastSeq[bufferId] = snapshot.seq;
      }),
    );
    return;
  }
  // Future kinds (grid, etc.) handled here; exhaustiveness is enforced by
  // the union type once Stage 2 widens TerminalSnapshot.
}

function rehydrateBuffer(bufferId: string): Promise<void> {
  // Chain on any in-flight rehydrate for this buffer so the parking state
  // (rehydrating + pendingChunks) is owned by exactly one rehydrate at a time.
  // A failed previous rehydrate doesn't block subsequent ones.
  const previous = rehydratePromises.get(bufferId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      rehydrating.add(bufferId);
      pendingChunks.set(bufferId, []);
      try {
        const snapshot = await invoke<TerminalSnapshot>("terminal_snapshot", {
          bufferId,
        });
        applySnapshot(bufferId, snapshot);
      } finally {
        rehydrating.delete(bufferId);
        const queued = pendingChunks.get(bufferId) ?? [];
        pendingChunks.delete(bufferId);
        // Drain in arrival order; appendChunk's seq guard drops anything
        // already covered by the snapshot we just applied.
        for (const event of queued) {
          appendChunk(event.bufferId, event.seq, event.data);
        }
      }
    });
  rehydratePromises.set(bufferId, next);
  // Clear the slot only if no newer rehydrate has registered, so the chain
  // shrinks when the most recent caller settles.
  next.finally(() => {
    if (rehydratePromises.get(bufferId) === next) {
      rehydratePromises.delete(bufferId);
    }
  });
  return next;
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

  getOutput(id: string | null): string {
    if (!id) return "";
    return state.output[id] ?? "";
  },

  async init() {
    if (state.initialized) return;
    setState("initialized", true);

    outputUnlisten = await listen<TerminalOutputEvent>(
      "terminal://output",
      (event) => {
        const { bufferId, seq, data } = event.payload;
        // If a snapshot is in flight for this buffer, park the chunk so it
        // can be replayed on top of the snapshot. Otherwise it could be
        // either older than the snapshot (drop on drain) or newer (apply on
        // drain), but we cannot know without seeing the snapshot's seq.
        if (rehydrating.has(bufferId)) {
          pendingChunks.get(bufferId)?.push(event.payload);
          return;
        }
        appendChunk(bufferId, seq, data);
      },
    );

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
    // Rehydrate output for any buffers that already exist on the Rust side
    // (e.g. after the user navigates back to a still-running terminal). The
    // snapshot's seq becomes the dedupe baseline against future chunk events;
    // chunks that arrive concurrently are parked in `pendingChunks` and
    // replayed on top of the snapshot to avoid losing the prefix.
    await Promise.all(
      buffers.map(async (info) => {
        try {
          await rehydrateBuffer(info.id);
        } catch {
          // Buffer may have been killed between list and snapshot; ignore.
        }
      }),
    );
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
    // The Rust reader thread can fire startup chunks (shell prompt, banner)
    // before this invoke resolves; the listener already routes them through
    // appendChunk against output[id]/lastSeq[id]. Rehydrating reconciles
    // those early chunks against the authoritative buffer (snapshot replaces
    // output, drains parked chunks newer than the snapshot's seq) instead of
    // an unconditional reset that would erase the prompt.
    await rehydrateBuffer(info.id);
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
   * Re-fetch the authoritative buffer from Rust. Useful after a focus change
   * or component remount when the local cache may have missed events. Routes
   * through the rehydrate path so concurrent chunk events are parked and
   * replayed on top of the snapshot rather than racing it.
   */
  async refreshSnapshot(bufferId: string): Promise<void> {
    try {
      await rehydrateBuffer(bufferId);
    } catch {
      // Buffer may have been removed; nothing to do.
    }
  },

  removeLocal(bufferId: string) {
    rehydrating.delete(bufferId);
    pendingChunks.delete(bufferId);
    setState(
      produce((s: TerminalState) => {
        delete s.buffers[bufferId];
        delete s.output[bufferId];
        delete s.lastSeq[bufferId];
      }),
    );
  },

  dispose() {
    outputUnlisten?.();
    exitUnlisten?.();
    outputUnlisten = null;
    exitUnlisten = null;
    rehydrating.clear();
    pendingChunks.clear();
    setState("initialized", false);
  },
};
