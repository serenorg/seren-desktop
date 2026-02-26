// ABOUTME: Compact titlebar with app branding, project folder name, and user actions.
// ABOUTME: Replaces the old Header component with a cleaner, Codex-inspired design.

import { open } from "@tauri-apps/plugin-dialog";
import { type Component, Show } from "solid-js";
import { BalanceDisplay } from "@/components/common/BalanceDisplay";
import { authStore } from "@/stores/auth.store";
import { fileTreeState, setRootPath } from "@/stores/fileTree";
import { updaterStore } from "@/stores/updater.store";

interface TitlebarProps {
  onSignInClick: () => void;
  onSignOutClick: () => void;
  onToggleSettings: () => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
}

const DOWNLOAD_QUIPS = [
  "Warming up...",
  "Downloading fresh pixels...",
  "Fetching improvements...",
  "Installing awesomeness...",
  "Polishing bits...",
  "Almost there...",
  "Finalizing magic...",
  "99% done...",
];

const DISCORD_AUTOPROMPT =
  "Set up and start OpenClaw Discord in chat-only mode. If Discord is not connected, guide me through connecting it first, then confirm readiness for support-intake to send Discord chat/ticket.";

function startDiscordFlow() {
  window.dispatchEvent(new CustomEvent("seren:open-panel", { detail: "chat" }));
  setTimeout(() => {
    window.dispatchEvent(
      new CustomEvent("seren:set-chat-input", {
        detail: {
          text: DISCORD_AUTOPROMPT,
          autoSend: true,
          skipAuthGate: true,
          command: "discord",
        },
      }),
    );
  }, 0);
}

function quipForPercent(percent: number): string {
  const index = Math.floor((percent / 100) * (DOWNLOAD_QUIPS.length - 1));
  return DOWNLOAD_QUIPS[Math.min(index, DOWNLOAD_QUIPS.length - 1)];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

export const Titlebar: Component<TitlebarProps> = (props) => {
  const folderName = () => {
    const root = fileTreeState.rootPath;
    if (!root) return null;
    return root.split("/").pop() || root;
  };

  const handleOpenFolder = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (selected && typeof selected === "string") {
      setRootPath(selected);
    }
  };

  const handleSupportClick = () => {
    startDiscordFlow();
  };

  return (
    <div
      class="flex items-center justify-between h-[var(--titlebar-height,40px)] px-3 pl-[78px] bg-surface-1 border-b border-border shrink-0 select-none"
      style={{ "-webkit-app-region": "drag" }}
    >
      <div
        class="flex items-center gap-2"
        style={{ "-webkit-app-region": "no-drag" }}
      >
        <span class="font-bold text-[14px] text-foreground tracking-[0.06em] uppercase">
          Seren
        </span>
        <button
          type="button"
          class="flex items-center justify-center w-7 h-7 border-none rounded-md bg-transparent text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-surface-2 hover:text-foreground active:scale-95"
          onClick={props.onToggleSidebar}
          title={props.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            role="img"
            aria-label="Toggle sidebar"
          >
            <path
              d="M3 4h10M3 8h10M3 12h10"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <div class="flex items-center gap-1.5 flex-1 justify-center">
        <Show
          when={folderName()}
          fallback={
            <button
              type="button"
              class="text-xs text-muted-foreground opacity-60 bg-transparent border-none cursor-pointer transition-colors duration-100 hover:text-foreground"
              style={{ "-webkit-app-region": "no-drag" }}
              onClick={handleOpenFolder}
              title="Open a project folder"
            >
              Open Folder
            </button>
          }
        >
          <span class="text-[13px] text-muted-foreground/70 overflow-hidden text-ellipsis whitespace-nowrap">
            {folderName()}
          </span>
        </Show>
      </div>

      <div
        class="flex items-center gap-2"
        style={{ "-webkit-app-region": "no-drag" }}
      >
        {/* Update available button */}
        <Show when={updaterStore.state.status === "available"}>
          <button
            type="button"
            class="px-3 py-1 rounded-md bg-success/70 hover:bg-success/85 text-white text-xs font-medium flex items-center gap-1.5 transition-colors animate-pulse"
            onClick={() => updaterStore.installAvailableUpdate()}
            title={`Update to ${updaterStore.state.availableVersion}`}
          >
            <span>⬆</span>
            <span>Update {updaterStore.state.availableVersion}</span>
          </button>
        </Show>

        {/* Downloading progress */}
        <Show when={updaterStore.state.status === "downloading"}>
          <div class="flex flex-col gap-0.5 min-w-[140px]">
            <div class="flex justify-between text-[10px] text-foreground/70">
              <span>{quipForPercent(updaterStore.state.progressPercent)}</span>
              <span>{updaterStore.state.progressPercent}%</span>
            </div>
            <div
              class="w-full h-[4px] bg-white/10 rounded-full overflow-hidden"
              title={`${formatBytes(updaterStore.state.downloadedBytes)} / ${formatBytes(updaterStore.state.totalBytes)}`}
            >
              <div
                class="updater-bar-downloading h-full rounded-full transition-all duration-300"
                style={{
                  width: `${updaterStore.state.progressPercent}%`,
                }}
              />
            </div>
          </div>
        </Show>

        {/* Installing state */}
        <Show when={updaterStore.state.status === "installing"}>
          <div class="flex flex-col gap-0.5 min-w-[140px]">
            <div class="text-[10px] text-foreground/70">
              Installing update...
            </div>
            <div class="w-full h-[4px] bg-white/10 rounded-full overflow-hidden">
              <div class="updater-bar-installing w-full h-full rounded-full" />
            </div>
          </div>
        </Show>

        {/* Error state with retry */}
        <Show when={updaterStore.state.status === "error"}>
          <button
            type="button"
            class="px-3 py-1 rounded-md bg-destructive hover:bg-destructive/90 text-white text-xs font-medium flex items-center gap-1.5 transition-colors"
            onClick={() => updaterStore.checkForUpdates()}
            title={updaterStore.state.error || "Update failed"}
          >
            <span>⚠</span>
            <span>Update failed - Retry</span>
          </button>
        </Show>

        <Show when={authStore.isAuthenticated}>
          <BalanceDisplay />
        </Show>

        <button
          type="button"
          class="flex items-center justify-center w-7 h-7 border-none rounded-md bg-transparent text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-surface-2 hover:text-foreground active:scale-95"
          onClick={handleSupportClick}
          title="Support"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            role="img"
            aria-label="Support"
          >
            <path d="M4 14a8 8 0 1 1 16 0" />
            <path d="M18 14v4a2 2 0 0 1-2 2h-1v-6h3z" />
            <path d="M6 14v6H5a2 2 0 0 1-2-2v-4h3z" />
            <path d="M9 20h6" />
          </svg>
        </button>

        <button
          type="button"
          class="flex items-center justify-center w-7 h-7 border-none rounded-md bg-transparent text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-surface-2 hover:text-foreground active:scale-95"
          onClick={props.onToggleSettings}
          title="Settings"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            role="img"
            aria-label="Settings"
          >
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>

        <Show when={authStore.isAuthenticated}>
          <button
            type="button"
            class="flex items-center justify-center w-7 h-7 border-none rounded-md bg-transparent text-muted-foreground cursor-pointer transition-all duration-100 hover:bg-surface-2 hover:text-foreground active:scale-95"
            onClick={props.onSignOutClick}
            title="Sign out"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-label="Sign out icon"
              role="img"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </Show>

        <Show when={!authStore.isAuthenticated}>
          <button
            type="button"
            class="flex items-center justify-center h-7 px-3 border border-primary/30 rounded-md bg-primary/10 text-primary text-[13px] font-medium cursor-pointer transition-all duration-100 hover:bg-primary/20 hover:border-primary/50 active:scale-95"
            onClick={props.onSignInClick}
          >
            Sign In
          </button>
        </Show>
      </div>
    </div>
  );
};
