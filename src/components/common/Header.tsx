// ABOUTME: Application header with horizontal navigation, balance, and user actions.
// ABOUTME: Provides navigation between Chat, Editor, Catalog, Settings with Cursor-like styling.

import { type Component, For, Show } from "solid-js";
import { BalanceDisplay } from "./BalanceDisplay";
import { updaterStore } from "@/stores/updater.store";

export type Panel =
  | "chat"
  | "editor"
  | "catalog"
  | "database"
  | "skills"
  | "settings"
  | "account";

interface NavItem {
  id: Panel;
  label: string;
  icon: string;
  showWhenAuthenticated?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "editor", label: "Editor", icon: "📝" },
  { id: "catalog", label: "Catalog", icon: "📚" },
  { id: "database", label: "Database", icon: "🗄️" },
  { id: "skills", label: "Skills", icon: "🧩" },
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
