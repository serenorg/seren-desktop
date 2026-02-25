// ABOUTME: Main application component with project-centric thread-based layout.
// ABOUTME: Initializes auth, settings, wallet, and renders AppShell with global modals.

import { createEffect, onCleanup, onMount, Show, untrack } from "solid-js";
import { AboutDialog } from "@/components/common/AboutDialog";
import { LowBalanceModal } from "@/components/common/LowBalanceWarning";
import { GatewayToolApproval } from "@/components/gateway/GatewayToolApproval";
import { AppShell } from "@/components/layout/AppShell";
import { X402PaymentApproval } from "@/components/mcp/X402PaymentApproval";
import { OpenClawApprovalManager } from "@/components/settings/OpenClawApproval";
import { ShellApproval } from "@/components/shell/ShellApproval";
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
import { fileTreeState, initDefaultRootIfNeeded } from "@/stores/fileTree";
import { openclawStore } from "@/stores/openclaw.store";
import { providerStore } from "@/stores/provider.store";
import { loadAllSettings } from "@/stores/settings.store";
import { skillsStore } from "@/stores/skills.store";
import { threadStore } from "@/stores/thread.store";
import { updaterStore } from "@/stores/updater.store";
import {
  checkDailyClaim,
  resetWalletState,
  startAutoRefresh,
  stopAutoRefresh,
} from "@/stores/wallet.store";
import "./styles.css";

// Initialize telemetry early to capture startup errors
telemetry.init();

function App() {
  if (shouldRenderPhase3Playground()) {
    return <Phase3Playground />;
  }

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

    // Initialize OpenClaw store (load setup state + event listeners) before agent
    openclawStore.init();

    // Start OpenClaw message agent
    startOpenClawAgent();

    // Set default project root if none is open
    await initDefaultRootIfNeeded();

    // Detect available agents (Claude, Codex)
    await acpStore.initialize();

    // Load skills and threads after auth check completes
    await skillsStore.refresh();
    await threadStore.refresh();
  });

  // Periodically refresh available skills so newly published skills appear without restart.
  // Base interval: 10 min + up to 2 min jitter to avoid thundering herd across instances.
  const SKILLS_REFRESH_BASE = 10 * 60 * 1000;
  const skillsRefreshTimer = setInterval(
    () => void skillsStore.refresh(),
    SKILLS_REFRESH_BASE + Math.random() * 2 * 60 * 1000,
  );

  onCleanup(() => {
    clearInterval(skillsRefreshTimer);
    shortcuts.destroy();
    stopOpenClawAgent();
    openclawStore.destroy();
  });

  // Reload installed skill inventory when project root changes.
  createEffect((prevRoot: string | null | undefined) => {
    const root = fileTreeState.rootPath;
    if (root === prevRoot) return root;
    void skillsStore.refreshInstalled();
    void skillsStore.loadProjectConfig(root);
    return root;
  }, fileTreeState.rootPath);

  // Keep thread-level skill override cache in sync with selected thread.
  createEffect(() => {
    void skillsStore.ensureContextLoaded(
      fileTreeState.rootPath,
      threadStore.activeThreadId,
    );
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
  };

  const handleLogout = async () => {
    await logout();
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
      <AppShell onLoginSuccess={handleLoginSuccess} onLogout={handleLogout} />
      <LowBalanceModal />
      <DailyClaimPopup />
      <X402PaymentApproval />
      <GatewayToolApproval />
      <ShellApproval />
      <OpenClawApprovalManager />
      <AboutDialog />
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
