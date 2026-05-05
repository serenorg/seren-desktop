// ABOUTME: i3-style virtual workspace pills - numbered switchers + "+" appender.
// ABOUTME: Designed to slot into the titlebar (or any host) without imposing chrome.

import { type Component, For } from "solid-js";
import { workspaceStore } from "@/stores/workspace.store";

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPod|iPhone|iPad/.test(navigator.platform);
const MOD_LABEL = isMac ? "Cmd" : "Ctrl";

/** Tooltip hint for the keyboard shortcut. 0 maps to workspace 10. */
function shortcutHint(number: number): string | null {
  if (number < 1 || number > 10) return null;
  const digit = number === 10 ? "0" : String(number);
  return `${MOD_LABEL}${isMac ? "" : "+"}${digit}`;
}

export const WorkspaceBar: Component = () => {
  return (
    // The "+" button stays a sibling of the tablist (not a child) so
    // ARIA tablist children are all role=tab.
    <div class="flex items-center gap-1 select-none">
      <div
        class="flex items-center gap-1"
        role="tablist"
        aria-label="Workspaces"
      >
        <For each={workspaceStore.workspaces}>
          {(ws) => {
            const active = () => ws.number === workspaceStore.activeNumber;
            const populated = () => ws.windows.length > 0;
            const needsAttention = () => ws.needsAttention && !active();
            const hint = shortcutHint(ws.number);
            const tooltip = () => {
              const head = needsAttention()
                ? `Workspace ${ws.number} - awaiting input`
                : populated()
                  ? `Workspace ${ws.number}`
                  : `Workspace ${ws.number} (empty)`;
              return hint ? `${head}  -  ${hint}` : head;
            };
            return (
              <button
                type="button"
                role="tab"
                aria-selected={active()}
                aria-controls="workspace-content-panel"
                aria-label={`Workspace ${ws.number}`}
                title={tooltip()}
                onClick={() => workspaceStore.switchTo(ws.number)}
                class="relative inline-flex items-center justify-center min-w-[26px] h-[24px] px-2 rounded-[4px] text-[12px] leading-none font-mono tabular-nums transition-colors duration-75 cursor-pointer border"
                classList={{
                  "bg-primary/20 border-primary/40 text-primary": active(),
                  "bg-transparent border-border/70 text-foreground/70 hover:bg-surface-3 hover:text-foreground hover:border-border":
                    !active() && populated(),
                  "bg-transparent border-border/40 text-muted-foreground hover:bg-surface-3 hover:text-foreground/80":
                    !active() && !populated(),
                }}
              >
                {ws.number}
                {needsAttention() && (
                  <span
                    aria-hidden="true"
                    class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-primary"
                  />
                )}
              </button>
            );
          }}
        </For>
      </div>

      <button
        type="button"
        aria-label="New workspace"
        title="New workspace"
        onClick={() => workspaceStore.addWorkspace()}
        class="inline-flex items-center justify-center w-[24px] h-[24px] ml-0.5 rounded-[4px] text-[14px] leading-none font-mono text-muted-foreground border border-dashed border-border/50 hover:bg-surface-3 hover:text-foreground hover:border-border transition-colors duration-75 cursor-pointer"
      >
        +
      </button>
    </div>
  );
};
