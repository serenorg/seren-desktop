// ABOUTME: Main application component with three-column resizable layout.
// ABOUTME: FileTree | Editor | Chat with draggable separators.

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
import { ChatContent } from "@/components/chat/ChatContent";
import { Header, type Panel } from "@/components/common/Header";
import { LowBalanceModal } from "@/components/common/LowBalanceWarning";
import { ResizableLayout } from "@/components/common/ResizableLayout";
import { StatusBar } from "@/components/common/StatusBar";
import { EditorContent } from "@/components/editor/EditorContent";
import { X402PaymentApproval } from "@/components/mcp/X402PaymentApproval";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { DatabasePanel } from "@/components/sidebar/DatabasePanel";
import { FileExplorer } from "@/components/sidebar/FileExplorer";
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
import "@/components/common/ResizableLayout.css";
import "./styles.css";

// Initialize telemetry early to capture startup errors
telemetry.init();

function App() {
  if (shouldRenderPhase3Playground()) {
    return <Phase3Playground />;
  }

  // Overlay panels (settings, catalog, database, account)
  const [overlayPanel, setOverlayPanel] = createSignal<Panel | null>(null);

  onMount(async () => {
    checkAuth();
    updaterStore.initUpdater();

    // Load all settings including app settings (chatDefaultModel, etc.) and MCP settings
    await loadAllSettings();

    // Load provider settings - this restores the last used model from previous session
    await providerStore.loadSettings();

    // Sync chatStore with the active model from provider store
    chatStore.setModel(providerStore.activeModel);

    // Initialize keyboard shortcuts
    shortcuts.init();
    shortcuts.register("focusChat", () => {
      // Chat is always visible, just focus it
      setOverlayPanel(null);
    });
    shortcuts.register("openSettings", () => setOverlayPanel("settings"));
    shortcuts.register("toggleSidebar", () => {
      // Toggle catalog panel
      setOverlayPanel((p) => (p === "catalog" ? null : "catalog"));
    });
    shortcuts.register("focusEditor", () => {
      // Editor is always visible, just close overlays
      setOverlayPanel(null);
    });
    shortcuts.register("closePanel", () => {
      // Escape closes overlay panels
      setOverlayPanel(null);
    });
  });

  onCleanup(() => {
    shortcuts.destroy();
  });

  // Initialize wallet and AI features when authenticated
  createEffect(() => {
    if (authStore.isAuthenticated) {
      startAutoRefresh();
      autocompleteStore.enable();
      const cleanupAutoTopUp = initAutoTopUp();

      onCleanup(() => {
        stopAutoRefresh();
        cleanupAutoTopUp();
      });
    } else {
      resetWalletState();
      autocompleteStore.disable();
    }
  });

  const handleLoginSuccess = () => {
    setAuthenticated({ id: "", email: "", name: "" });
    setOverlayPanel(null);
  };

  const handleLogout = async () => {
    await logout();
  };

  const handleSignInClick = () => {
    setOverlayPanel("account");
  };

  const handlePanelChange = (panel: Panel) => {
    // Main panels (chat, editor) are always visible in the three-column layout
    // Other panels (settings, catalog, database, account) are overlays
    if (panel === "chat" || panel === "editor") {
      setOverlayPanel(null);
    } else {
      setOverlayPanel(panel);
    }
  };

  // Get the "active" panel for header highlighting
  // If an overlay is open, show that; otherwise default to "editor"
  const activePanel = () => overlayPanel() ?? "editor";

  return (
    <Show
      when={!authStore.isLoading}
      fallback={
        <div class="flex flex-col items-center justify-center h-screen gap-4 text-muted-foreground">
          <div class="loading-spinner" />
          <p>Loading...</p>
        </div>
      }
    >
      <div class="flex flex-col h-full">
        <Header
          activePanel={activePanel()}
          onPanelChange={handlePanelChange}
          onLogout={handleLogout}
          isAuthenticated={authStore.isAuthenticated}
        />
        <main class="flex-1 overflow-hidden bg-transparent relative">
          {/* Three-column resizable layout (always visible) */}
          <ResizableLayout
            left={<FileExplorer />}
            center={<EditorContent />}
            right={<ChatContent onSignInClick={handleSignInClick} />}
            leftWidth={240}
            rightWidth={400}
            leftMinWidth={180}
            leftMaxWidth={400}
            rightMinWidth={300}
            rightMaxWidth={700}
          />

          {/* Overlay panels */}
          <Show when={overlayPanel()}>
            <div class="absolute inset-0 bg-[#0d1117] z-10">
              <Switch>
                <Match when={overlayPanel() === "catalog"}>
                  <CatalogPanel onSignInClick={handleSignInClick} />
                </Match>
                <Match when={overlayPanel() === "database"}>
                  <DatabasePanel />
                </Match>
                <Match when={overlayPanel() === "settings"}>
                  <SettingsPanel />
                </Match>
                <Match when={overlayPanel() === "account"}>
                  <SignIn onSuccess={handleLoginSuccess} />
                </Match>
              </Switch>
            </div>
          </Show>
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
