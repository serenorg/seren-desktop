// ABOUTME: Main application component with layout and optional auth.
// ABOUTME: App is fully usable without login; auth unlocks AI features.

import { createSignal, createEffect, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { Header } from "@/components/common/Header";
import { Sidebar, Panel } from "@/components/common/Sidebar";
import { StatusBar } from "@/components/common/StatusBar";
import { SignIn } from "@/components/auth/SignIn";
import { ChatPanel } from "@/components/chat/ChatPanel";
import { EditorPanel } from "@/components/editor/EditorPanel";
import { LowBalanceModal } from "@/components/common/LowBalanceWarning";
import { Phase3Playground } from "@/playground/Phase3Playground";
import { SignInPlayground } from "@/playground/SignInPlayground";
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
import { initAutoTopUp } from "@/services/autoTopUp";
import "./App.css";

// Initialize telemetry early to capture startup errors
telemetry.init();

function App() {
  if (shouldRenderPhase3Playground()) {
    return <Phase3Playground />;
  }

  if (shouldRenderSignInPlayground()) {
    return <SignInPlayground />;
  }

  const [activePanel, setActivePanel] = createSignal<Panel>(getInitialPanel());

  onMount(() => {
    checkAuth();
    updaterStore.initUpdater();

    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const requestedPanel = params.get("panel") as Panel | null;
      if (requestedPanel) {
        setActivePanel(requestedPanel);
      }
    }
  });

  // Initialize wallet features when authenticated
  createEffect(() => {
    if (authStore.isAuthenticated) {
      // Start wallet balance refresh
      startAutoRefresh();

      // Initialize auto top-up monitoring
      const cleanupAutoTopUp = initAutoTopUp();

      onCleanup(() => {
        stopAutoRefresh();
        cleanupAutoTopUp();
      });
    } else {
      // Reset wallet state on logout
      resetWalletState();
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
          onLogout={handleLogout}
          onSignIn={handleSignInClick}
          isAuthenticated={authStore.isAuthenticated}
        />
        <div class="app-body">
          <Sidebar
            activePanel={activePanel()}
            onPanelChange={setActivePanel}
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
                <div class="panel-placeholder">Catalog Panel (Coming Soon)</div>
              </Match>
              <Match when={activePanel() === "settings"}>
                <div class="panel-placeholder">Settings Panel (Coming Soon)</div>
              </Match>
              <Match when={activePanel() === "account"}>
                <SignIn onSuccess={handleLoginSuccess} />
              </Match>
            </Switch>
          </main>
        </div>
        <StatusBar />
        <LowBalanceModal />
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

function shouldRenderSignInPlayground(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("test") === "signin";
}

function getInitialPanel(): Panel {
  if (typeof window === "undefined") {
    return "editor";
  }

  const params = new URLSearchParams(window.location.search);
  const requestedPanel = params.get("panel") as Panel | null;
  const validPanels: Panel[] = ["chat", "editor", "catalog", "settings", "account"];
  if (requestedPanel && validPanels.includes(requestedPanel)) {
    return requestedPanel;
  }
  return "editor";
}
