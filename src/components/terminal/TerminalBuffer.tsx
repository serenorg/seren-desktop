// ABOUTME: Minimal UI for Rust-backed terminal buffers.
// ABOUTME: Renders PTY output and sends line-oriented input to the active buffer.

import {
  type Component,
  createEffect,
  createMemo,
  createSignal,
  onMount,
  Show,
} from "solid-js";
import { terminalStore } from "@/stores/terminal.store";
import { threadStore } from "@/stores/thread.store";

function stripAnsi(value: string): string {
  let output = "";
  let skipping = false;
  for (const char of value) {
    if (char === "\x1b") {
      skipping = true;
      continue;
    }
    if (!skipping) {
      output += char;
      continue;
    }
    if (char >= "@" && char <= "~") {
      skipping = false;
    }
  }
  return output;
}

export const TerminalBuffer: Component = () => {
  const [input, setInput] = createSignal("");
  let outputRef: HTMLPreElement | undefined;

  onMount(async () => {
    await terminalStore.init();
    const id = threadStore.activeThreadId;
    if (id) await terminalStore.refreshSnapshot(id);
  });

  const buffer = createMemo(() =>
    terminalStore.getBuffer(threadStore.activeThreadId),
  );
  const output = createMemo(() =>
    stripAnsi(terminalStore.getOutput(threadStore.activeThreadId)),
  );

  createEffect(() => {
    output();
    queueMicrotask(() => {
      if (outputRef) outputRef.scrollTop = outputRef.scrollHeight;
    });
  });

  const sendLine = async () => {
    const current = buffer();
    const value = input();
    if (!current || current.status !== "running" || !value.trim()) return;
    setInput("");
    await terminalStore.sendLine(current.id, value);
  };

  const sendInterrupt = async () => {
    const current = buffer();
    if (!current || current.status !== "running") return;
    // Use the foreground process group signal path so raw-mode TUIs (vim,
    // htop, claude, codex) actually receive SIGINT rather than just seeing
    // a 0x03 byte the line discipline ignores.
    await terminalStore.signal(current.id, "interrupt");
  };

  const kill = async () => {
    const current = buffer();
    if (!current || current.status !== "running") return;
    await terminalStore.kill(current.id);
  };

  return (
    <div class="flex flex-col h-full min-h-0 bg-surface-0">
      <Show
        when={buffer()}
        fallback={
          <div class="flex items-center justify-center h-full text-sm text-muted-foreground">
            Terminal buffer not found
          </div>
        }
      >
        {(current) => (
          <>
            <div class="flex items-center gap-2 px-3 py-2 border-b border-border bg-card">
              <div class="flex-1 min-w-0">
                <div class="text-[13px] font-medium text-foreground truncate">
                  {current().title}
                </div>
                <div class="text-[11px] text-muted-foreground truncate">
                  {current().cwd || "Current environment"} - {current().status}
                </div>
              </div>
              <button
                type="button"
                class="px-2 py-1 text-[12px] rounded-md border border-border bg-transparent text-muted-foreground hover:text-foreground hover:bg-surface-2"
                onClick={sendInterrupt}
                disabled={current().status !== "running"}
              >
                Ctrl+C
              </button>
              <button
                type="button"
                class="px-2 py-1 text-[12px] rounded-md border border-border bg-transparent text-muted-foreground hover:text-foreground hover:bg-surface-2"
                onClick={kill}
                disabled={current().status !== "running"}
              >
                Stop
              </button>
            </div>

            <pre
              ref={outputRef}
              class="flex-1 min-h-0 overflow-auto m-0 p-3 bg-[#090b0f] text-[#d7dde8] text-[12px] leading-[1.45] font-mono whitespace-pre-wrap break-words"
            >
              {output() || "\n"}
            </pre>

            <form
              class="flex items-center gap-2 p-2 border-t border-border bg-card"
              onSubmit={(event) => {
                event.preventDefault();
                void sendLine();
              }}
            >
              <span class="text-[12px] text-muted-foreground font-mono">$</span>
              <input
                value={input()}
                onInput={(event) => setInput(event.currentTarget.value)}
                class="flex-1 min-w-0 bg-surface-1 border border-border rounded-md px-2 py-1.5 text-[13px] text-foreground font-mono focus:outline-none focus:border-primary"
                disabled={current().status !== "running"}
                autocomplete="off"
                spellcheck={false}
              />
              <button
                type="submit"
                class="px-3 py-1.5 text-[13px] font-medium rounded-md border border-primary/20 bg-primary/10 text-primary hover:bg-primary/15 disabled:opacity-50"
                disabled={current().status !== "running"}
              >
                Send
              </button>
            </form>
          </>
        )}
      </Show>
    </div>
  );
};
