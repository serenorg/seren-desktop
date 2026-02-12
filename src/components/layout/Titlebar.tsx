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
  onLogout: () => void;
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

  return (
    <div class="titlebar titlebar--drag">
      <div class="titlebar__left titlebar--no-drag">
        <span class="titlebar__brand">Seren</span>
        <button
          type="button"
          class="titlebar__btn"
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

      <div class="titlebar__center">
        <Show
          when={folderName()}
          fallback={
            <button
              type="button"
              class="titlebar__no-project titlebar__no-project--clickable titlebar--no-drag"
              onClick={handleOpenFolder}
              title="Open a project folder"
            >
              Open Folder
            </button>
          }
        >
          <span class="titlebar__folder">{folderName()}</span>
        </Show>
      </div>

      <div class="titlebar__right titlebar--no-drag">
        {/* Update available button */}
        <Show when={updaterStore.state.status === "available"}>
          <button
            type="button"
            class="px-3 py-1 rounded-md bg-[#238636] hover:bg-[#2ea043] text-white text-xs font-medium flex items-center gap-1.5 transition-colors animate-pulse"
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
            title={updaterStore.state.errorMessage || "Update failed"}
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
          class="titlebar__btn"
          onClick={props.onToggleSettings}
          title="Settings"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            role="img"
            aria-label="Settings"
          >
            <path
              d="M8 10a2 2 0 100-4 2 2 0 000 4z"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path
              d="M13.5 8a5.5 5.5 0 01-.4 2.1l1.3 1.3-1.4 1.4-1.3-1.3A5.5 5.5 0 018 13.5a5.5 5.5 0 01-2.1-.4l-1.3 1.3-1.4-1.4 1.3-1.3A5.5 5.5 0 012.5 8c0-.7.1-1.4.4-2.1L1.6 4.6 3 3.2l1.3 1.3A5.5 5.5 0 018 2.5c.7 0 1.4.1 2.1.4l1.3-1.3 1.4 1.4-1.3 1.3c.3.7.4 1.4.4 2.1z"
              stroke="currentColor"
              stroke-width="1.2"
            />
          </svg>
        </button>

        <Show
          when={authStore.isAuthenticated}
          fallback={
            <button
              type="button"
              class="titlebar__btn titlebar__btn--sign-in"
              onClick={props.onSignInClick}
            >
              Sign In
            </button>
          }
        >
          <button
            type="button"
            class="titlebar__btn"
            onClick={props.onLogout}
            title="Sign Out"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              role="img"
              aria-label="Sign out"
            >
              <path
                d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3M11 11l3-3-3-3M5.5 8H14"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </Show>
      </div>
    </div>
  );
};
