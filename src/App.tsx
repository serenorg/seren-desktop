// ABOUTME: Main application component with layout and optional auth.
// ABOUTME: App is fully usable without login; auth unlocks AI features.

import {
  createEffect,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { SignIn } from "@/components/auth/SignIn";
import { CatalogPanel } from "@/components/catalog";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { Header, type Panel } from "@/components/common/Header";
import { LowBalanceModal } from "@/components/common/LowBalanceWarning";
import { StatusBar } from "@/components/common/StatusBar";
import { EditorPanel } from "@/components/editor/EditorPanel";
import { X402PaymentApproval } from "@/components/mcp/X402PaymentApproval";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { DatabasePanel } from "@/components/sidebar/DatabasePanel";
import { shortcuts } from "@/lib/shortcuts";
import { Phase3Playground } from "@/playground/Phase3Playground";
import { initAutoTopUp } from "@/services/autoTopUp";
import { telemetry } from "@/services/telemetry";
import {
  authStore,
  checkAuth,
  logout,
  setAuthenticated,
} from "@/stores/auth.store";
import { autocompleteStore } from "@/stores/autocomplete.store";
import { chatStore } from "@/stores/chat.store";
import { providerStore } from "@/stores/provider.store";
import { loadAllSettings } from "@/stores/settings.store";
import { updaterStore } from "@/stores/updater.store";
import {
  resetWalletState,
  startAutoRefresh,
  stopAutoRefresh,
} from "@/stores/wallet.store";
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

  onMount(async () => {
    checkAuth();
    updaterStore.initUpdater();

    // Load all settings including app settings (chatDefaultModel, etc.) and MCP settings
    await loadAllSettings();

    // Load provider settings - this restores the last used model from previous session
    await providerStore.loadSettings();

    // Sync chatStore with the active model from provider store
    // (providerStore already loaded the persisted activeModel)
    chatStore.setModel(providerStore.activeModel);

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
          <Switch
            fallback={<div class="panel-placeholder">Select a panel</div>}
          >
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
