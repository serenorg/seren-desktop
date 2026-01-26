// ABOUTME: Navigation sidebar with panel switching.
// ABOUTME: Provides navigation between Chat, Editor, Catalog, Settings, and Account.

import { type Component, createMemo, For } from "solid-js";
import "./Sidebar.css";

export type Panel =
  | "chat"
  | "editor"
  | "catalog"
  | "database"
  | "settings"
  | "account";

interface SidebarProps {
  activePanel: Panel;
  onPanelChange: (panel: Panel) => void;
  isAuthenticated?: boolean;
}

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
  { id: "account", label: "Sign In", icon: "👤", showWhenAuthenticated: false },
];

export const Sidebar: Component<SidebarProps> = (props) => {
  const visibleItems = createMemo(() =>
    NAV_ITEMS.filter((item) => {
      if (item.showWhenAuthenticated === undefined) return true;
      return item.showWhenAuthenticated === !!props.isAuthenticated;
    }),
  );

  return (
    <nav class="sidebar">
      <ul class="sidebar-nav">
        <For each={visibleItems()}>
          {(item) => (
            <li>
              <button
                class={`sidebar-item ${props.activePanel === item.id ? "active" : ""}`}
                onClick={() => props.onPanelChange(item.id)}
                title={item.label}
              >
                <span class="sidebar-icon">{item.icon}</span>
                <span class="sidebar-label">{item.label}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </nav>
  );
};
