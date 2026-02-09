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
  untrack,
} from "solid-js";
import { SignIn } from "@/components/auth/SignIn";
import { AgentChat } from "@/components/chat/AgentChat";
import { AgentModeToggle } from "@/components/chat/AgentModeToggle";
import { ChatContent } from "@/components/chat/ChatContent";
import { AboutDialog } from "@/components/common/AboutDialog";
import { Header, type Panel } from "@/components/common/Header";
import { LowBalanceModal } from "@/components/common/LowBalanceWarning";
import { ResizableLayout } from "@/components/common/ResizableLayout";
import { StatusBar } from "@/components/common/StatusBar";
import { EditorContent } from "@/components/editor/EditorContent";
import { GatewayToolApproval } from "@/components/gateway/GatewayToolApproval";
import { X402PaymentApproval } from "@/components/mcp/X402PaymentApproval";
import { OpenClawApprovalManager } from "@/components/settings/OpenClawApproval";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { ShellApproval } from "@/components/shell/ShellApproval";
import { DatabasePanel } from "@/components/sidebar/DatabasePanel";
import { FileExplorer } from "@/components/sidebar/FileExplorer";
import { DailyClaimPopup } from "@/components/wallet/DailyClaimPopup";
import { shortcuts } from "@/lib/shortcuts";
import { Phase3Playground } from "@/playground/Phase3Playground";
import { initAutoTopUp } from "@/services/autoTopUp";
import {
  startOpenClawAgent,
  stopOpenClawAgent,
} from "@/services/openclaw-agent";
import { telemetry } from "@/services/telemetry";
import { acpStore } from "@/stores/acp.store";
import {
  authStore,
  checkAuth,
  logout,
  setAuthenticated,
} from "@/stores/auth.store";
import { autocompleteStore } from "@/stores/autocomplete.store";
import { chatStore } from "@/stores/chat.store";
import { openclawStore } from "@/stores/openclaw.store";
import { providerStore } from "@/stores/provider.store";
import { loadAllSettings } from "@/stores/settings.store";
import { updaterStore } from "@/stores/updater.store";
import {
  checkDailyClaim,
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

  // Overlay panels (settings, database, account)
  const [overlayPanel, setOverlayPanel] = createSignal<Panel | null>(null);
  // Toggle explorer visibility (closed by default for more chat real estate)
  const [showExplorer, setShowExplorer] = createSignal(false);
  // Toggle editor visibility (opens when a file is clicked in explorer)
  const [showEditor, setShowEditor] = createSignal(false);

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
      // Toggle database panel
      setOverlayPanel((p) => (p === "database" ? null : "database"));
    });
    shortcuts.register("focusEditor", () => {
      // Editor is always visible, just close overlays
      setOverlayPanel(null);
    });
    shortcuts.register("closePanel", () => {
      // Escape closes overlay panels
      setOverlayPanel(null);
    });

    // Listen for slash command panel navigation
    const onOpenPanel = ((e: CustomEvent) => {
      const p = e.detail as string;
      if (p === "editor") {
        setShowEditor(true);
        setShowExplorer(true);
        setOverlayPanel(null);
      } else {
        handlePanelChange(p as Panel);
      }
    }) as EventListener;
    window.addEventListener("seren:open-panel", onOpenPanel);

    // Listen for OpenClaw settings open request (from sidebar status indicator)
    const onOpenSettings = () => setOverlayPanel("settings");
    window.addEventListener("seren:open-settings", onOpenSettings);

    // Initialize OpenClaw store (load setup state + event listeners) before agent
    openclawStore.init();

    // Start OpenClaw message agent
    startOpenClawAgent();
  });

  onCleanup(() => {
    shortcuts.destroy();
    stopOpenClawAgent();
    openclawStore.destroy();
  });

  // Store cleanup function for auto top-up
  let cleanupAutoTopUp: (() => void) | null = null;

  // Initialize wallet and AI features when authenticated
  createEffect((prev) => {
    const isAuth = authStore.isAuthenticated;

    // Only run if auth state actually changed
    if (isAuth === prev) return isAuth;

    if (isAuth) {
      console.log("[App] User authenticated, starting services...");

      // Use untrack to prevent reactive dependencies
      untrack(() => {
        startAutoRefresh();
        autocompleteStore.enable();
        // Store cleanup to prevent effect accumulation
        cleanupAutoTopUp = initAutoTopUp();
        checkDailyClaim();
      });
    } else {
      console.log("[App] User logged out, stopping services...");
      untrack(() => {
        // Clean up auto top-up effect
        if (cleanupAutoTopUp) {
          cleanupAutoTopUp();
          cleanupAutoTopUp = null;
        }
        stopAutoRefresh();
        resetWalletState();
        autocompleteStore.disable();
      });
    }

    return isAuth;
  }, authStore.isAuthenticated);

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
    if (panel === "chat") {
      setShowExplorer(false);
      setOverlayPanel(null);
    } else if (panel === "explorer") {
      setShowExplorer((prev) => !prev);
      setOverlayPanel(null);
    } else {
      // Settings, database, account are overlays
      setOverlayPanel(panel);
    }
  };

  // Get the "active" panel for header highlighting
  const activePanel = () => {
    const overlay = overlayPanel();
    if (overlay) return overlay;
    return showExplorer() ? "explorer" : "chat";
  };

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
            left={showExplorer() ? <FileExplorer /> : null}
            center={
              <div class="flex flex-col h-full">
                <div class="flex items-center justify-center py-1.5 border-b border-border">
                  <AgentModeToggle />
                </div>
                <div class="flex-1 overflow-hidden flex flex-col">
                  <Show
                    when={acpStore.agentModeEnabled}
                    fallback={<ChatContent onSignInClick={handleSignInClick} />}
                  >
                    <AgentChat />
                  </Show>
                </div>
              </div>
            }
            right={
              showEditor() ? (
                <EditorContent onClose={() => setShowEditor(false)} />
              ) : null
            }
            leftWidth={240}
            rightWidth={500}
            leftMinWidth={180}
            leftMaxWidth={400}
            rightMinWidth={400}
            rightMaxWidth={900}
          />

          {/* Overlay panels */}
          <Show when={overlayPanel()}>
            <div class="absolute inset-0 bg-[#0d1117] z-10">
              <Switch>
                <Match when={overlayPanel() === "database"}>
                  <DatabasePanel />
                </Match>
                <Match when={overlayPanel() === "settings"}>
                  <SettingsPanel onSignInClick={handleSignInClick} />
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
        <DailyClaimPopup />
        <X402PaymentApproval />
        <GatewayToolApproval />
        <ShellApproval />
        <OpenClawApprovalManager />
        <AboutDialog />
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
