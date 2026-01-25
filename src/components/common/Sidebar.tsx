// ABOUTME: Navigation sidebar with panel switching.
// ABOUTME: Provides navigation between Chat, Editor, Catalog, and Settings.

import { Component, For } from "solid-js";
import "./Sidebar.css";

export type Panel = "chat" | "editor" | "catalog" | "settings";

interface SidebarProps {
  activePanel: Panel;
  onPanelChange: (panel: Panel) => void;
}

const NAV_ITEMS: Array<{ id: Panel; label: string; icon: string }> = [
  { id: "chat", label: "Chat", icon: "💬" },
  { id: "editor", label: "Editor", icon: "📝" },
  { id: "catalog", label: "Catalog", icon: "📚" },
  { id: "settings", label: "Settings", icon: "⚙️" },
];

export const Sidebar: Component<SidebarProps> = (props) => {
  return (
    <nav class="sidebar">
      <ul class="sidebar-nav">
        <For each={NAV_ITEMS}>
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
