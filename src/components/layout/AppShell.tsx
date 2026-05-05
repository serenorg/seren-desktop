// ABOUTME: Root layout component with titlebar, thread sidebar, main content, and slide panel.
// ABOUTME: Thread list in left sidebar, content area routes to chat or agent views.

import {
  type Component,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Switch,
} from "solid-js";
import { SessionExpiredModal } from "@/components/auth/SessionExpiredModal";
import { SignIn } from "@/components/auth/SignIn";
import { StatusBar } from "@/components/common/StatusBar";
import { EditorContent } from "@/components/editor/EditorContent";
import { ThreadSidebar } from "@/components/layout/ThreadSidebar";
import { SessionPanel } from "@/components/session/SessionPanel";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { DatabasePanel } from "@/components/sidebar/DatabasePanel";
import { AgentTasksPanel } from "@/components/tasks/AgentTasksPanel";
import { shortcuts } from "@/lib/shortcuts";
import { initWorkspaceStore, workspaceStore } from "@/stores/workspace.store";
import { SlidePanel } from "./SlidePanel";
import { ThreadContent } from "./ThreadContent";
import { Titlebar } from "./Titlebar";

export type SlidePanelView =
  | "settings"
  | "database"
  | "editor"
  | "account"
  | "tasks"
  | "sessions"
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
    if (p === "chat") {
      setSlidePanel(null);
    } else if (p === "editor") {
      setSlidePanel("editor");
    } else if (p === "settings") {
      setSlidePanel("settings");
    } else if (p === "database") {
      setSlidePanel("database");
    } else if (p === "tasks") {
      setSlidePanel("tasks");
    } else if (p === "sessions") {
      setSlidePanel("sessions");
    }
  }) as EventListener;

  // Cmd on macOS, Ctrl elsewhere; Super/Win is OS-reserved.
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPod|iPhone|iPad/.test(navigator.platform);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && slidePanel()) {
      setSlidePanel(null);
      return;
    }

    // Workspace switch: Cmd/Ctrl + digit, with 0 mapping to 10.
    // Modifier-bearing chords fire regardless of focus - inputs only
    // own bare keystrokes.
    const modOnly = isMac
      ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      : e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (modOnly && e.key >= "0" && e.key <= "9") {
      const number = e.key === "0" ? 10 : Number.parseInt(e.key, 10);
      e.preventDefault();
      workspaceStore.switchOrCreate(number);
    }
  };

  const handleOpenSettings = () => setSlidePanel("settings");

  // Register global listeners and keyboard shortcuts
  onMount(() => {
    initWorkspaceStore();

    window.addEventListener("seren:open-panel", handleOpenPanel);
    window.addEventListener("seren:open-settings", handleOpenSettings);
    // Capture phase so descendants calling stopPropagation (Monaco)
    // can't swallow the workspace-switch chord.
    window.addEventListener("keydown", handleKeyDown, true);

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
    window.removeEventListener("keydown", handleKeyDown, true);

    shortcuts.unregister("focusChat");
    shortcuts.unregister("openSettings");
    shortcuts.unregister("toggleSidebar");
    shortcuts.unregister("closePanel");
    shortcuts.unregister("focusEditor");
  });

  return (
    <div class="flex flex-col h-screen bg-background text-foreground">
      <Titlebar
        onSignInClick={handleSignInClick}
        onToggleSettings={handleToggleSettings}
      />

      <div class="flex flex-1 overflow-hidden relative">
        <ThreadSidebar
          collapsed={sidebarCollapsed()}
          onToggle={() => setSidebarCollapsed((v) => !v)}
        />

        <main class="flex-1 overflow-hidden flex flex-col min-w-0">
          <ThreadContent onSignInClick={handleSignInClick} />
        </main>

        <SlidePanel
          open={slidePanel() !== null}
          onClose={handleCloseSlidePanel}
          wide={slidePanel() === "settings"}
        >
          <Switch>
            <Match when={slidePanel() === "settings"}>
              <SettingsPanel
                onSignInClick={handleSignInClick}
                onLogout={props.onLogout}
              />
            </Match>
            <Match when={slidePanel() === "database"}>
              <DatabasePanel />
            </Match>
            <Match when={slidePanel() === "editor"}>
              <EditorContent onClose={handleCloseSlidePanel} />
            </Match>
            <Match when={slidePanel() === "tasks"}>
              <AgentTasksPanel onClose={handleCloseSlidePanel} />
            </Match>
            <Match when={slidePanel() === "sessions"}>
              <SessionPanel onClose={handleCloseSlidePanel} />
            </Match>
            <Match when={slidePanel() === "account"}>
              <SignIn onSuccess={handleLoginSuccess} />
            </Match>
          </Switch>
        </SlidePanel>
      </div>

      <StatusBar />

      {/* Layout-level blocking sign-in modal — fires on mid-session expiry,
          refresh-token failure, and the /login slash command. Distinct from
          the passive titlebar Sign In button (always-on when unauthenticated)
          and from ChatContent's local pre-send gate. See #1661. */}
      <SessionExpiredModal />
    </div>
  );
};
