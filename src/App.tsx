// ABOUTME: Main application component with layout and optional auth.
// ABOUTME: App is fully usable without login; auth unlocks AI features.

import { createSignal, createEffect, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Header, type Panel } from "@/components/common/Header";
import { StatusBar } from "@/components/common/StatusBar";
import { SignIn } from "@/components/auth/SignIn";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { EditorPanel } from "@/components/editor/EditorPanel";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { CatalogPanel } from "@/components/catalog";
import { DatabasePanel } from "@/components/sidebar/DatabasePanel";
import { LowBalanceModal } from "@/components/common/LowBalanceWarning";
import { X402PaymentApproval } from "@/components/mcp/X402PaymentApproval";
import { Phase3Playground } from "@/playground/Phase3Playground";
import {
  authStore,
  checkAuth,
  logout,
  setAuthenticated,
} from "@/stores/auth.store";
import { telemetry } from "@/services/telemetry";
import { updaterStore } from "@/stores/updater.store";
import {
  startAutoRefresh,
  stopAutoRefresh,
  resetWalletState,
} from "@/stores/wallet.store";
import { autocompleteStore } from "@/stores/autocomplete.store";
import { providerStore } from "@/stores/provider.store";
import { initAutoTopUp } from "@/services/autoTopUp";
import { shortcuts } from "@/lib/shortcuts";
import "./App.css";

// Initialize telemetry early to capture startup errors
telemetry.init();

function App() {
  if (shouldRenderPhase3Playground()) {
    return <Phase3Playground />;
  }

  const [activePanel, setActivePanel] = createSignal<Panel>("editor");

  // Reference to focus chat input
  let chatPanelRef: { focusInput?: () => void } | undefined;

  onMount(() => {
    checkAuth();
    updaterStore.initUpdater();
    providerStore.loadSettings();

    // Initialize keyboard shortcuts
    shortcuts.init();
    shortcuts.register("focusChat", () => {
      setActivePanel("chat");
      // Focus the chat input after panel switch
      setTimeout(() => chatPanelRef?.focusInput?.(), 0);
    });
    shortcuts.register("openSettings", () => setActivePanel("settings"));
    shortcuts.register("toggleSidebar", () => {
      // Toggle between current panel and a minimized state (future enhancement)
      // For now, cycle through main panels
      const panels: Panel[] = ["chat", "editor"];
      const currentIndex = panels.indexOf(activePanel());
      const nextIndex = (currentIndex + 1) % panels.length;
      setActivePanel(panels[nextIndex]);
    });
    shortcuts.register("focusEditor", () => setActivePanel("editor"));
    shortcuts.register("closePanel", () => {
      // Escape closes settings/account panels, returns to editor
      if (activePanel() === "settings" || activePanel() === "account") {
        setActivePanel("editor");
      }
    });
  });

  onCleanup(() => {
    shortcuts.destroy();
  });

  // Initialize wallet and AI features when authenticated
  createEffect(() => {
    if (authStore.isAuthenticated) {
      // Start wallet balance refresh
      startAutoRefresh();

      // Enable AI autocomplete
      autocompleteStore.enable();

      // Initialize auto top-up monitoring
      const cleanupAutoTopUp = initAutoTopUp();

      onCleanup(() => {
        stopAutoRefresh();
        cleanupAutoTopUp();
      });
    } else {
      // Reset wallet state and disable autocomplete on logout
      resetWalletState();
      autocompleteStore.disable();
    }
  });

  const handleLoginSuccess = () => {
    setAuthenticated({ id: "", email: "", name: "" });
    // Switch to chat panel after successful login
    setActivePanel("chat");
  };

  const handleLogout = async () => {
    await logout();
  };

  const handleSignInClick = () => {
    setActivePanel("account");
  };

  return (
    <Show
      when={!authStore.isLoading}
      fallback={
        <div class="app-loading">
          <div class="loading-spinner" />
          <p>Loading...</p>
        </div>
      }
    >
      <div class="app">
        <Header
          activePanel={activePanel()}
          onPanelChange={setActivePanel}
          onLogout={handleLogout}
          isAuthenticated={authStore.isAuthenticated}
        />
        <main class="app-main">
          <Switch fallback={<div class="panel-placeholder">Select a panel</div>}>
            <Match when={activePanel() === "chat"}>
              <ChatPanel onSignInClick={handleSignInClick} />
            </Match>
            <Match when={activePanel() === "editor"}>
              <EditorPanel />
            </Match>
            <Match when={activePanel() === "catalog"}>
              <CatalogPanel onSignInClick={handleSignInClick} />
            </Match>
            <Match when={activePanel() === "database"}>
              <DatabasePanel />
            </Match>
            <Match when={activePanel() === "settings"}>
              <SettingsPanel />
            </Match>
            <Match when={activePanel() === "account"}>
              <SignIn onSuccess={handleLoginSuccess} />
            </Match>
          </Switch>
        </main>
        <StatusBar />
        <LowBalanceModal />
        <X402PaymentApproval />
      </div>
    </Show>
  );
}

export default App;

function shouldRenderPhase3Playground(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("test") === "phase3";
}
