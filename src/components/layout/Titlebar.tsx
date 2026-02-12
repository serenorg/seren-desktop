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
        <Show when={updaterStore.state.status === "downloading"}>
          <span class="titlebar__update-badge">Updating...</span>
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
