// ABOUTME: Navigation sidebar with panel switching.
// ABOUTME: Provides navigation between Chat, Editor, Catalog, Settings, and Account.

import { type Component, createMemo, For } from "solid-js";

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
    <nav class="w-[200px] bg-popover border-r border-border flex flex-col">
      <ul class="list-none m-0 p-2">
        <For each={visibleItems()}>
          {(item) => (
            <li>
              <button
                class={`flex items-center gap-2 w-full py-2.5 px-3 text-[13px] bg-transparent border-none rounded cursor-pointer text-left transition-all duration-150 ${
                  props.activePanel === item.id
                    ? "text-primary-foreground bg-primary"
                    : "text-muted-foreground hover:text-foreground hover:bg-secondary"
                }`}
                onClick={() => props.onPanelChange(item.id)}
                title={item.label}
              >
                <span class="text-base">{item.icon}</span>
                <span class="flex-1">{item.label}</span>
              </button>
            </li>
          )}
        </For>
      </ul>
    </nav>
  );
};
