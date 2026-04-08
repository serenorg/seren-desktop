// ABOUTME: Main application component with project-centric thread-based layout.
// ABOUTME: Initializes auth, settings, wallet, and renders AppShell with global modals.

import { createEffect, onCleanup, onMount, Show, untrack } from "solid-js";
import { AboutDialog } from "@/components/common/AboutDialog";
import { LowBalanceModal } from "@/components/common/LowBalanceWarning";
import { OrganizationOtpModal } from "@/components/common/OrganizationOtpModal";
import { GatewayToolApproval } from "@/components/gateway/GatewayToolApproval";
import { AppShell } from "@/components/layout/AppShell";
import { X402PaymentApproval } from "@/components/mcp/X402PaymentApproval";
import { ShellApproval } from "@/components/shell/ShellApproval";
import { DailyClaimPopup } from "@/components/wallet/DailyClaimPopup";
import {
  connectLocalProviderRuntime,
  disconnectLocalProviderRuntime,
  listenForRuntimeRestart,
} from "@/lib/browser-local-runtime";
import { getRuntimeConfig } from "@/lib/runtime";
import { shortcuts } from "@/lib/shortcuts";
import { Phase3Playground } from "@/playground/Phase3Playground";
import { initAutoTopUp } from "@/services/autoTopUp";
import { syncMemories } from "@/services/memory";
import { telemetry } from "@/services/telemetry";
import { agentStore } from "@/stores/agent.store";
import {
  authStore,
  checkAuth,
  initAuthRuntimeBindings,
  logout,
  setAuthenticated,
} from "@/stores/auth.store";
import { autocompleteStore } from "@/stores/autocomplete.store";
import { chatStore } from "@/stores/chat.store";
import { fileTreeState, initDefaultRootIfNeeded } from "@/stores/fileTree";
import { providerStore } from "@/stores/provider.store";
import { loadAllSettings } from "@/stores/settings.store";
import { skillsStore } from "@/stores/skills.store";
import { threadStore } from "@/stores/thread.store";
import {
  checkDailyClaim,
  resetWalletState,
  startAutoRefresh,
  startDailyClaimPolling,
  stopAutoRefresh,
} from "@/stores/wallet.store";
import "./styles.css";

// Initialize telemetry early to capture startup errors
telemetry.init();

function App() {
  if (shouldRenderPhase3Playground()) {
    return <Phase3Playground />;
  }

  const runtime = getRuntimeConfig();

  onMount(async () => {
    await initAuthRuntimeBindings();
    await checkAuth();

    if (
      runtime.capabilities.agents &&
      !authStore.privateChatPolicy?.disable_local_agents &&
      (runtime.mode === "browser-local" || runtime.mode === "desktop-native")
    ) {
      try {
        await connectLocalProviderRuntime();
        void listenForRuntimeRestart();
      } catch (error) {
        console.error(
          "[App] Failed to connect to local provider runtime:",
          error,
        );
      }
    }

    if (runtime.capabilities.updater) {
      const { updaterStore } = await import("@/stores/updater.store");
      void updaterStore.initUpdater();
    }

    // Load all settings including app settings (chatDefaultModel, etc.) and MCP settings
    await loadAllSettings();

    // Load provider settings - this restores the last used model from previous session
    await providerStore.loadSettings();

    // Sync chatStore with the active model from provider store
    chatStore.setModel(providerStore.activeModel);

    // Initialize keyboard shortcuts
    shortcuts.init();

    // Set default project root if none is open
    if (runtime.capabilities.localFiles) {
      await initDefaultRootIfNeeded();
    }

    // Detect available agents (Claude, Codex)
    if (runtime.capabilities.agents) {
      if (!authStore.privateChatPolicy?.disable_local_agents) {
        await agentStore.initialize();
      }
    }

    // Load skills and threads after auth check completes
    await skillsStore.refresh();
    await threadStore.refresh();

    // Claude Code auto-memory interceptor — opt-in. If the user enabled it
    // but a precondition is missing (no SerenDB login, no active project) or
    // the start call fails, we surface an actionable error dialog so the
    // user knows what to fix. No silent failures.
    try {
      const { settingsStore } = await import("@/stores/settings.store");
      if (settingsStore.get("claudeMemoryInterceptEnabled")) {
        const { projectStore } = await import("@/stores/project.store");
        const { message: showMessageDialog } = await import(
          "@tauri-apps/plugin-dialog"
        );
        const reportError = async (msg: string) => {
          console.error(`[ClaudeMemory] ${msg}`);
          try {
            await showMessageDialog(msg, {
              title: "Claude Memory Interceptor",
              kind: "error",
            });
          } catch {
            // Dialog plugin unavailable (e.g. browser runtime) — the
            // console.error above is the fallback.
          }
        };
        if (!authStore.isAuthenticated) {
          await reportError(
            "Claude Code auto-memory interceptor is enabled but you are not logged in to SerenDB. Log in to start the interceptor, or turn it off in Settings → Code Indexing → Claude Code Auto-Memory.",
          );
        } else if (!projectStore.activeProject?.id) {
          await reportError(
            "Claude Code auto-memory interceptor is enabled but no active SerenDB project is selected. Select a project to start the interceptor, or turn it off in Settings → Code Indexing → Claude Code Auto-Memory.",
          );
        } else {
          const { startClaudeMemoryInterceptor, migrateExistingClaudeMemory } =
            await import("@/services/claudeMemory");
          try {
            await startClaudeMemoryInterceptor();
            if (settingsStore.get("claudeMemoryMigrateOnStartup")) {
              const report = await migrateExistingClaudeMemory();
              console.info(
                `[ClaudeMemory] startup migration: persisted=${report.persisted} failures=${report.failures}`,
              );
              if (report.failures > 0) {
                await reportError(
                  `Claude memory interceptor: ${report.failures} file${
                    report.failures === 1 ? "" : "s"
                  } could not be pushed to SerenDB on startup and were left on disk. Check your SerenDB connection and retry from Settings → Code Indexing → Claude Code Auto-Memory → Migrate Existing Files.`,
                );
              }
            }
          } catch (err) {
            await reportError(
              `Failed to start Claude memory interceptor: ${err}. Check your SerenDB login and project selection, then toggle the interceptor off and on again in Settings.`,
            );
          }
        }
      }
    } catch (error) {
      console.error(`[ClaudeMemory] boot hook crashed: ${error}`);
    }
  });

  // Periodically refresh available skills so newly published skills appear without restart.
  // Base interval: 5 min + up to 30s jitter. R2 serves the index with zero rate limits.
  const SKILLS_REFRESH_BASE = 5 * 60 * 1000;
  const skillsRefreshTimer = setInterval(
    () => void skillsStore.refresh(),
    SKILLS_REFRESH_BASE + Math.random() * 30 * 1000,
  );

  onCleanup(() => {
    clearInterval(skillsRefreshTimer);
    shortcuts.destroy();
    if (
      runtime.capabilities.agents &&
      !authStore.privateChatPolicy?.disable_local_agents &&
      (runtime.mode === "browser-local" || runtime.mode === "desktop-native")
    ) {
      disconnectLocalProviderRuntime();
    }
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
        startDailyClaimPolling();
        // Push any locally-cached memories that failed to reach cloud (e.g. cold start)
        void syncMemories();
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
    <>
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
        <Show when={runtime.capabilities.localMcp}>
          <GatewayToolApproval />
        </Show>
        <Show when={runtime.capabilities.terminal}>
          <ShellApproval />
        </Show>
        <Show when={runtime.mode === "desktop-native"}>
          <AboutDialog />
        </Show>
      </Show>
      <OrganizationOtpModal />
    </>
  );
}

export default App;

function shouldRenderPhase3Playground(): boolean {
  if (!import.meta.env.DEV) return false;
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("test") === "phase3";
}
