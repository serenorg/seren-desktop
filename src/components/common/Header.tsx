// ABOUTME: Application header with horizontal navigation, balance, and user actions.
// ABOUTME: Provides navigation between Chat, Editor, Database, Settings with Cursor-like styling.

import { type Component, For, Show } from "solid-js";
import { updaterStore } from "@/stores/updater.store";
import { BalanceDisplay } from "./BalanceDisplay";

const DOWNLOAD_QUIPS = [
  "Warming up the flux capacitor...",
  "Downloading fresh pixels...",
  "Convincing the bits to move faster...",
  "Bribing the electrons...",
  "Polishing the new version...",
  "Almost there, hang tight...",
  "Wrapping things up...",
];

function quipForPercent(percent: number): string {
  if (percent < 5) return DOWNLOAD_QUIPS[0];
  if (percent < 20) return DOWNLOAD_QUIPS[1];
  if (percent < 40) return DOWNLOAD_QUIPS[2];
  if (percent < 60) return DOWNLOAD_QUIPS[3];
  if (percent < 80) return DOWNLOAD_QUIPS[4];
  if (percent < 95) return DOWNLOAD_QUIPS[5];
  return DOWNLOAD_QUIPS[6];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type Panel = "chat" | "explorer" | "database" | "settings" | "account";

interface NavItem {
  id: Panel;
  label: string;
  icon: string;
  showWhenAuthenticated?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "explorer", label: "Explorer", icon: "📁" },
  { id: "database", label: "Database", icon: "🗄️" },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

interface HeaderProps {
  activePanel?: Panel;
  onPanelChange?: (panel: Panel) => void;
  onLogout?: () => void;
  onSignIn?: () => void;
  isAuthenticated?: boolean;
}

export const Header: Component<HeaderProps> = (props) => {
  return (
    <header class="flex items-center justify-between h-10 px-3 bg-card border-b border-border [-webkit-app-region:drag]">
      <div class="flex items-center gap-4 [-webkit-app-region:no-drag]">
        <h1 class="text-[13px] font-medium text-gray-400 m-0 tracking-tight">
          Seren
        </h1>
        <nav class="flex items-center gap-0.5">
          <For each={NAV_ITEMS}>
            {(item) => (
              <button
                type="button"
                class={`flex items-center gap-1.5 py-1.5 px-2.5 text-[13px] font-normal bg-transparent border-none rounded cursor-pointer transition-all duration-100 [-webkit-app-region:no-drag] ${
                  props.activePanel === item.id
                    ? "text-white bg-white/10"
                    : "text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]"
                }`}
                onClick={() => props.onPanelChange?.(item.id)}
              >
                <span class="text-sm leading-none">{item.icon}</span>
                <span class="leading-none">{item.label}</span>
              </button>
            )}
          </For>
        </nav>
      </div>
      <div class="flex items-center gap-2 [-webkit-app-region:no-drag]">
        <Show
          when={props.isAuthenticated}
          fallback={
            <button
              type="button"
              class={`flex items-center gap-1.5 py-1.5 px-2.5 ml-1 text-[13px] font-normal bg-transparent border-none rounded cursor-pointer transition-all duration-100 ${
                props.activePanel === "account"
                  ? "text-white bg-white/10"
                  : "text-gray-400 hover:text-gray-200 hover:bg-white/[0.06]"
              }`}
              data-testid="header-signin-button"
              onClick={() => props.onPanelChange?.("account")}
            >
              <span class="text-sm leading-none">👤</span>
              <span class="leading-none">Sign In</span>
            </button>
          }
        >
          <Show when={updaterStore.state.status === "available"}>
            <button
              type="button"
              class="flex items-center gap-1.5 py-1 px-2.5 text-[12px] font-medium text-white bg-[#238636] border-none rounded cursor-pointer transition-all duration-100 hover:bg-[#2ea043] animate-pulse"
              onClick={() => updaterStore.installAvailableUpdate()}
            >
              <span class="leading-none">⬆</span>
              <span class="leading-none">
                Update {updaterStore.state.availableVersion}
              </span>
            </button>
          </Show>
          <Show
            when={
              updaterStore.state.status === "downloading" ||
              updaterStore.state.status === "installing"
            }
          >
            <div
              class="flex items-center gap-2 py-1 px-2.5 text-[11px] font-medium text-blue-300"
              title={
                updaterStore.state.totalBytes > 0
                  ? `${formatBytes(updaterStore.state.downloadedBytes)} / ${formatBytes(updaterStore.state.totalBytes)}`
                  : "Downloading update..."
              }
            >
              <div class="flex flex-col gap-0.5 min-w-[140px]">
                <div class="flex justify-between text-[10px]">
                  <span class="text-blue-300/80 truncate max-w-[110px]">
                    {updaterStore.state.status === "installing"
                      ? "Installing..."
                      : quipForPercent(updaterStore.state.progressPercent)}
                  </span>
                  <span class="text-blue-400 font-mono tabular-nums">
                    {updaterStore.state.progressPercent}%
                  </span>
                </div>
                <div class="w-full h-[4px] bg-white/10 rounded-full overflow-hidden">
                  <div
                    class={`h-full rounded-full transition-all duration-300 ease-out ${
                      updaterStore.state.status === "installing"
                        ? "updater-bar-installing"
                        : "updater-bar-downloading"
                    }`}
                    style={{ width: `${updaterStore.state.progressPercent}%` }}
                  />
                </div>
              </div>
            </div>
          </Show>
          <Show when={updaterStore.state.status === "error"}>
            <button
              type="button"
              class="flex items-center gap-1.5 py-1 px-2.5 text-[12px] font-medium text-white bg-red-700 border-none rounded cursor-pointer transition-all duration-100 hover:bg-red-600"
              onClick={() => updaterStore.checkForUpdates(true)}
              title={updaterStore.state.error ?? "Update failed"}
            >
              <span class="leading-none">⚠</span>
              <span class="leading-none">Update failed — retry</span>
            </button>
          </Show>
          <BalanceDisplay />
          {props.onLogout && (
            <button
              type="button"
              class="py-1.5 px-2.5 text-xs font-normal text-gray-400 bg-transparent border border-white/10 rounded cursor-pointer transition-all duration-100 hover:text-gray-200 hover:border-white/20 hover:bg-white/5"
              onClick={props.onLogout}
            >
              Logout
            </button>
          )}
        </Show>
      </div>
    </header>
  );
};
