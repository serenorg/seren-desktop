// ABOUTME: Application header with horizontal navigation, balance, and user actions.
// ABOUTME: Provides navigation between Chat, Editor, Catalog, Settings with Cursor-like styling.

import { Component, For, Show } from "solid-js";
import { BalanceDisplay } from "./BalanceDisplay";
import "./Header.css";

export type Panel = "chat" | "editor" | "catalog" | "database" | "settings" | "account";

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
    <header class="header">
      <div class="header-left">
        <h1 class="header-title">Seren</h1>
        <nav class="header-nav">
          <For each={NAV_ITEMS}>
            {(item) => (
              <button
                type="button"
                class="header-nav-item"
                classList={{ active: props.activePanel === item.id }}
                onClick={() => props.onPanelChange?.(item.id)}
              >
                <span class="nav-icon">{item.icon}</span>
                <span class="nav-label">{item.label}</span>
              </button>
            )}
          </For>
        </nav>
      </div>
      <div class="header-actions">
        <Show
          when={props.isAuthenticated}
          fallback={
            <button
              type="button"
              class="header-nav-item signin"
              classList={{ active: props.activePanel === "account" }}
              data-testid="header-signin-button"
              onClick={() => props.onPanelChange?.("account")}
            >
              <span class="nav-icon">👤</span>
              <span class="nav-label">Sign In</span>
            </button>
          }
        >
          <BalanceDisplay />
          {props.onLogout && (
            <button type="button" class="header-logout" onClick={props.onLogout}>
              Logout
            </button>
          )}
        </Show>
      </div>
    </header>
  );
};
