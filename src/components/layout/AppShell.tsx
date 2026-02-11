// ABOUTME: Root layout component with titlebar, thread sidebar, main content, and slide panel.
// ABOUTME: Replaces the old three-column ResizableLayout with a project-centric thread-based design.

import {
  type Component,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Switch,
} from "solid-js";
import { SignIn } from "@/components/auth/SignIn";
import { StatusBar } from "@/components/common/StatusBar";
import { EditorContent } from "@/components/editor/EditorContent";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { DatabasePanel } from "@/components/sidebar/DatabasePanel";
import { shortcuts } from "@/lib/shortcuts";
import { SlidePanel } from "./SlidePanel";
import { ThreadContent } from "./ThreadContent";
import { ThreadSidebar } from "./ThreadSidebar";
import { Titlebar } from "./Titlebar";
import "./AppShell.css";

export type SlidePanelView =
  | "settings"
  | "database"
  | "editor"
  | "account"
  | null;

interface AppShellProps {
  onLoginSuccess: () => void;
  onLogout: () => void;
}

export const AppShell: Component<AppShellProps> = (props) => {
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [slidePanel, setSlidePanel] = createSignal<SlidePanelView>(null);

  const handleSignInClick = () => {
    setSlidePanel("account");
  };

  const handleToggleSettings = () => {
    setSlidePanel((v) => (v === "settings" ? null : "settings"));
  };

  const handleCloseSlidePanel = () => {
    setSlidePanel(null);
  };

  const handleLoginSuccess = () => {
    props.onLoginSuccess();
    setSlidePanel(null);
  };

  // Expose panel controls to global events (for slash commands, etc.)
  const handleOpenPanel = ((e: CustomEvent) => {
    const p = e.detail as string;
    if (p === "editor") {
      setSlidePanel("editor");
    } else if (p === "settings") {
      setSlidePanel("settings");
    } else if (p === "database") {
      setSlidePanel("database");
    }
  }) as EventListener;

  // Keyboard: Escape closes slide panel
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && slidePanel()) {
      setSlidePanel(null);
    }
  };

  const handleOpenSettings = () => setSlidePanel("settings");

  // Register global listeners and keyboard shortcuts
  onMount(() => {
    window.addEventListener("seren:open-panel", handleOpenPanel);
    window.addEventListener("seren:open-settings", handleOpenSettings);
    window.addEventListener("keydown", handleKeyDown);

    shortcuts.register("focusChat", () => setSlidePanel(null));
    shortcuts.register("openSettings", () =>
      setSlidePanel((v) => (v === "settings" ? null : "settings")),
    );
    shortcuts.register("toggleSidebar", () => setSidebarCollapsed((v) => !v));
    shortcuts.register("closePanel", handleCloseSlidePanel);
    shortcuts.register("focusEditor", () => setSlidePanel("editor"));
  });

  onCleanup(() => {
    window.removeEventListener("seren:open-panel", handleOpenPanel);
    window.removeEventListener("seren:open-settings", handleOpenSettings);
    window.removeEventListener("keydown", handleKeyDown);

    shortcuts.unregister("focusChat");
    shortcuts.unregister("openSettings");
    shortcuts.unregister("toggleSidebar");
    shortcuts.unregister("closePanel");
    shortcuts.unregister("focusEditor");
  });

  return (
    <div class="app-shell">
      <Titlebar
        onSignInClick={handleSignInClick}
        onLogout={props.onLogout}
        onToggleSettings={handleToggleSettings}
      />

      <div class="app-shell__body">
        <ThreadSidebar
          collapsed={sidebarCollapsed()}
          onToggle={() => setSidebarCollapsed((v) => !v)}
        />

        <main class="app-shell__main">
          <ThreadContent onSignInClick={handleSignInClick} />
        </main>

        <SlidePanel
          open={slidePanel() !== null}
          onClose={handleCloseSlidePanel}
        >
          <Switch>
            <Match when={slidePanel() === "settings"}>
              <SettingsPanel onSignInClick={handleSignInClick} />
            </Match>
            <Match when={slidePanel() === "database"}>
              <DatabasePanel />
            </Match>
            <Match when={slidePanel() === "editor"}>
              <EditorContent onClose={handleCloseSlidePanel} />
            </Match>
            <Match when={slidePanel() === "account"}>
              <SignIn onSuccess={handleLoginSuccess} />
            </Match>
          </Switch>
        </SlidePanel>
      </div>

      <StatusBar />
    </div>
  );
};
