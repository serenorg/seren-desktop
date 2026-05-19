// ABOUTME: Root layout component with titlebar, thread sidebar, main content, and slide panel.
// ABOUTME: Thread list in left sidebar, content area routes to chat or agent views.

import {
  type Component,
  createEffect,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { SessionExpiredModal } from "@/components/auth/SessionExpiredModal";
import { SignIn } from "@/components/auth/SignIn";
import { BountyDetail } from "@/components/bounties/BountyDetail";
import { CatalogList } from "@/components/catalog/CatalogList";
import { ArchivedEmployeeDetail } from "@/components/employees/ArchivedEmployeeDetail";
import { EmployeeDetail } from "@/components/employees/EmployeeDetail";
import { InboxList } from "@/components/inbox/InboxList";
import { ThreadSidebar } from "@/components/layout/ThreadSidebar";
import { SessionPanel } from "@/components/session/SessionPanel";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import {
  type BountyDetailEventDetail,
  type BountyInheritFrom,
  CLOSE_BOUNTY_DETAIL_EVENT,
  OPEN_BOUNTY_DETAIL_EVENT,
} from "@/components/sidebar/BountiesSection";
import { DatabasePanel } from "@/components/sidebar/DatabasePanel";
import {
  CLOSE_CATALOG_EVENT,
  CLOSE_EMPLOYEE_DETAIL_EVENT,
  CLOSE_INBOX_EVENT,
  type EmployeeDetailEventDetail,
  OPEN_CATALOG_EVENT,
  OPEN_EMPLOYEE_DETAIL_EVENT,
  OPEN_INBOX_EVENT,
} from "@/components/sidebar/EmployeesSection";
import { PublishSkillModal } from "@/components/sidebar/PublishSkillModal";
import { PublishVersionModal } from "@/components/sidebar/PublishVersionModal";
import { SkillsExplorer } from "@/components/sidebar/SkillsExplorer";
import { AgentTasksPanel } from "@/components/tasks/AgentTasksPanel";
import { shortcuts } from "@/lib/shortcuts";
import type { InstalledSkill } from "@/lib/skills";
import {
  appearanceState,
  applyAppearanceToDocument,
  loadAppearance,
} from "@/stores/appearance.store";
import {
  initEditorSessionPersistence,
  pickEditorSessionForContext,
  restoreEditorSessions,
} from "@/stores/editor.sessions";
import { employeeStore } from "@/stores/employees.store";
import { fileTreeState } from "@/stores/fileTree";
import { skillPublishStore } from "@/stores/skill-publish.store";
import { skillsStore } from "@/stores/skills.store";
import { threadStore } from "@/stores/thread.store";
import { initWorkspaceStore, workspaceStore } from "@/stores/workspace.store";
import { SlidePanel } from "./SlidePanel";
import { ThreadContent } from "./ThreadContent";
import { Titlebar } from "./Titlebar";

export type SlidePanelView =
  | "settings"
  | "database"
  | "account"
  | "tasks"
  | "sessions"
  | "skills"
  | null;

const SLIDE_PANEL_KEY = "seren:slide_panel";

const PERSISTABLE_VIEWS: ReadonlySet<NonNullable<SlidePanelView>> = new Set([
  "settings",
  "database",
  "tasks",
  "sessions",
  "skills",
]);

function loadInitialSlidePanel(): SlidePanelView {
  // First launch (no stored preference) opens the skills panel by default
  // so users discover the catalog without having to hunt for it.
  try {
    const raw = localStorage.getItem(SLIDE_PANEL_KEY);
    if (raw === null) return "skills";
    if (raw === "null") return null;
    if (PERSISTABLE_VIEWS.has(raw as NonNullable<SlidePanelView>)) {
      return raw as SlidePanelView;
    }
  } catch {
    // localStorage unavailable - fall back to default
  }
  return "skills";
}

function persistSlidePanel(view: SlidePanelView): void {
  // Transient views (e.g. sign-in) must not overwrite the user's stored
  // preference. Otherwise opening sign-in once would force the next launch
  // to ignore a previously-closed or settings/database/etc. preference and
  // fall back to the "skills" default.
  if (view !== null && !PERSISTABLE_VIEWS.has(view)) return;
  try {
    localStorage.setItem(SLIDE_PANEL_KEY, view ?? "null");
  } catch {
    // Non-fatal
  }
}

function pathParent(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : "";
}

function pathBasename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function skillForPublishPath(
  skill: InstalledSkill,
  path: string,
): InstalledSkill {
  if (skill.path === path) return skill;
  const skillDir = pathParent(path);
  const skillsDir = pathParent(skillDir);
  const dirName = pathBasename(skillDir);
  if (!skillDir || !skillsDir || !dirName) {
    return { ...skill, path };
  }
  return { ...skill, path, skillsDir, dirName };
}

interface AppShellProps {
  onLoginSuccess: () => void;
  onLogout: () => void;
}

export const AppShell: Component<AppShellProps> = (props) => {
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [slidePanel, setSlidePanel] = createSignal<SlidePanelView>(
    loadInitialSlidePanel(),
  );
  const [activeEmployeeId, setActiveEmployeeId] = createSignal<string | null>(
    null,
  );
  const [activeBountyId, setActiveBountyId] = createSignal<string | null>(null);
  const [activeBountyInheritFrom, setActiveBountyInheritFrom] =
    createSignal<BountyInheritFrom | null>(null);
  const [catalogOpen, setCatalogOpen] = createSignal(false);
  const [inboxOpen, setInboxOpen] = createSignal(false);
  createEffect(() => {
    persistSlidePanel(slidePanel());
  });

  const handleOpenEmployeeDetail = (event: Event) => {
    const detail = (event as CustomEvent<EmployeeDetailEventDetail>).detail;
    if (detail?.employeeId) {
      setActiveEmployeeId(detail.employeeId);
      if (activeBountyId() !== null) {
        setActiveBountyId(null);
        setActiveBountyInheritFrom(null);
        window.dispatchEvent(new CustomEvent(CLOSE_BOUNTY_DETAIL_EVENT));
      }
      setCatalogOpen(false);
      setInboxOpen(false);
    }
  };

  const handleCloseEmployeeDetail = () => {
    setActiveEmployeeId(null);
  };

  const closeEmployeeDetailPane = () => {
    setActiveEmployeeId(null);
    window.dispatchEvent(new CustomEvent(CLOSE_EMPLOYEE_DETAIL_EVENT));
  };

  const handleOpenBountyDetail = (event: Event) => {
    const detail = (event as CustomEvent<BountyDetailEventDetail>).detail;
    if (detail?.bountyId) {
      setActiveBountyId(detail.bountyId);
      // Snapshot the binding the sidebar captured before clearing the
      // active thread. `BountyDetail.handleJoinBounty` consults this so
      // a user joining a bounty from a Codex thread lands in another
      // Codex thread instead of the global chat default.
      setActiveBountyInheritFrom(detail.inheritFrom ?? null);
      if (activeEmployeeId() !== null) {
        setActiveEmployeeId(null);
        window.dispatchEvent(new CustomEvent(CLOSE_EMPLOYEE_DETAIL_EVENT));
      }
      setCatalogOpen(false);
      setInboxOpen(false);
    }
  };

  const handleCloseBountyDetail = () => {
    setActiveBountyId(null);
    setActiveBountyInheritFrom(null);
  };

  const closeBountyDetailPane = () => {
    setActiveBountyId(null);
    setActiveBountyInheritFrom(null);
    window.dispatchEvent(new CustomEvent(CLOSE_BOUNTY_DETAIL_EVENT));
  };

  const handleOpenCatalog = () => {
    setCatalogOpen(true);
    if (activeEmployeeId() !== null) {
      setActiveEmployeeId(null);
      window.dispatchEvent(new CustomEvent(CLOSE_EMPLOYEE_DETAIL_EVENT));
    }
    if (activeBountyId() !== null) {
      setActiveBountyId(null);
      setActiveBountyInheritFrom(null);
      window.dispatchEvent(new CustomEvent(CLOSE_BOUNTY_DETAIL_EVENT));
    }
    setInboxOpen(false);
  };

  const handleCloseCatalog = () => {
    setCatalogOpen(false);
  };

  const handleOpenInbox = () => {
    setInboxOpen(true);
    if (activeEmployeeId() !== null) {
      setActiveEmployeeId(null);
      window.dispatchEvent(new CustomEvent(CLOSE_EMPLOYEE_DETAIL_EVENT));
    }
    if (activeBountyId() !== null) {
      setActiveBountyId(null);
      setActiveBountyInheritFrom(null);
      window.dispatchEvent(new CustomEvent(CLOSE_BOUNTY_DETAIL_EVENT));
    }
    setCatalogOpen(false);
  };

  const handleCloseInbox = () => {
    setInboxOpen(false);
  };

  createEffect(
    on(
      () => threadStore.activeThreadId,
      () => {
        if (activeEmployeeId() !== null) {
          closeEmployeeDetailPane();
        }
        if (activeBountyId() !== null) {
          closeBountyDetailPane();
        }
        setCatalogOpen(false);
        setInboxOpen(false);
      },
      { defer: true },
    ),
  );

  onMount(() => {
    window.addEventListener(
      OPEN_EMPLOYEE_DETAIL_EVENT,
      handleOpenEmployeeDetail,
    );
    window.addEventListener(
      CLOSE_EMPLOYEE_DETAIL_EVENT,
      handleCloseEmployeeDetail,
    );
    window.addEventListener(OPEN_BOUNTY_DETAIL_EVENT, handleOpenBountyDetail);
    window.addEventListener(CLOSE_BOUNTY_DETAIL_EVENT, handleCloseBountyDetail);
    window.addEventListener(OPEN_CATALOG_EVENT, handleOpenCatalog);
    window.addEventListener(CLOSE_CATALOG_EVENT, handleCloseCatalog);
    window.addEventListener(OPEN_INBOX_EVENT, handleOpenInbox);
    window.addEventListener(CLOSE_INBOX_EVENT, handleCloseInbox);

    // Reconcile the synchronously-hydrated appearance with the canonical
    // Tauri store; runs the one-shot migration from settings.app.theme on
    // first boot of this build.
    void loadAppearance();

    // When the appearance is set to "system" we follow the OS-level
    // preference. Re-apply on change so the user sees the switch live.
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = () => {
      if (appearanceState.appearance.theme === "system") {
        applyAppearanceToDocument(appearanceState.appearance);
      }
    };
    media.addEventListener("change", onSystemThemeChange);
    onCleanup(() => media.removeEventListener("change", onSystemThemeChange));
  });

  // Mirror every appearance mutation to the document. Keep DOM side effects
  // centralized here so load, reset, and future programmatic changes all flow
  // through one path.
  createEffect(() => {
    applyAppearanceToDocument(appearanceState.appearance);
  });

  onCleanup(() => {
    window.removeEventListener(OPEN_CATALOG_EVENT, handleOpenCatalog);
    window.removeEventListener(CLOSE_CATALOG_EVENT, handleCloseCatalog);
    window.removeEventListener(OPEN_INBOX_EVENT, handleOpenInbox);
    window.removeEventListener(CLOSE_INBOX_EVENT, handleCloseInbox);
    window.removeEventListener(
      OPEN_EMPLOYEE_DETAIL_EVENT,
      handleOpenEmployeeDetail,
    );
    window.removeEventListener(
      CLOSE_EMPLOYEE_DETAIL_EVENT,
      handleCloseEmployeeDetail,
    );
    window.removeEventListener(
      OPEN_BOUNTY_DETAIL_EVENT,
      handleOpenBountyDetail,
    );
    window.removeEventListener(
      CLOSE_BOUNTY_DETAIL_EVENT,
      handleCloseBountyDetail,
    );
  });

  const handleSignInClick = () => {
    setSlidePanel("account");
  };

  const handleToggleSettings = () => {
    setSlidePanel((v) => (v === "settings" ? null : "settings"));
  };

  const handleToggleSkills = () => {
    setSlidePanel((v) => (v === "skills" ? null : "skills"));
  };

  const handleCloseSlidePanel = () => {
    setSlidePanel(null);
  };

  const handleLoginSuccess = () => {
    props.onLoginSuccess();
    setSlidePanel(null);
  };

  /**
   * Refresh catalog/installed state after a publish completes so the row
   * flips from "Publishable" to "Yours" (and the rail's letter avatars
   * pick up the new published version) without a manual refresh.
   */
  const handleSkillPublishComplete = async () => {
    await skillsStore.refreshAvailable(true);
    await skillsStore.refreshOwnedSkills();
    await skillsStore.refreshInstalled();
  };

  const publishTargetForPath = (path: string): InstalledSkill | null => {
    const skill = skillsStore.installed.find(
      (s) => s.path === path || s.authoringPath === path,
    );
    return skill ? skillForPublishPath(skill, path) : null;
  };

  /**
   * Cmd+E semantics: focus the editor pane and pick the editor session that
   * matches the user's current context. Preference order:
   *   1. The active thread's projectRoot (so an open chat or skill brings
   *      the editor for THAT project to the front).
   *   2. The file-tree root.
   *   3. The most recently activated session.
   *   4. No sessions exist - just create an empty editor pane.
   */
  const focusEditorForContext = () => {
    const active = threadStore.activeThread;
    if (active?.kind === "editor") {
      // Already on this session; just refocus the pane.
      workspaceStore.bindEditorToWorkspace();
      return;
    }
    const contextRoot = active?.projectRoot ?? fileTreeState.rootPath ?? null;
    const target = pickEditorSessionForContext({ contextRoot });
    if (target) {
      threadStore.selectThread(target.id, "editor");
    } else {
      workspaceStore.bindEditorToWorkspace();
    }
  };

  // Expose panel controls to global events (for slash commands, etc.)
  const handleOpenPanel = ((e: CustomEvent) => {
    const p = e.detail as string;
    if (p === "chat") {
      setSlidePanel(null);
    } else if (p === "editor") {
      setSlidePanel(null);
      focusEditorForContext();
    } else if (p === "settings") {
      setSlidePanel("settings");
    } else if (p === "database") {
      setSlidePanel("database");
    } else if (p === "tasks") {
      setSlidePanel("tasks");
    } else if (p === "sessions") {
      setSlidePanel("sessions");
    } else if (p === "skills") {
      setSlidePanel("skills");
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
    const modShift = isMac
      ? e.metaKey && !e.ctrlKey && !e.altKey && e.shiftKey
      : e.ctrlKey && !e.metaKey && !e.altKey && e.shiftKey;
    if (modOnly && e.key >= "0" && e.key <= "9") {
      const number = e.key === "0" ? 10 : Number.parseInt(e.key, 10);
      e.preventDefault();
      workspaceStore.switchOrCreate(number);
      return;
    }
    // Tile chords: \ splits right, - splits down, Shift+W closes
    // focused pane. The Shift on close avoids Cmd+W's collision with
    // the native "Close Window" menu accelerator.
    if (modOnly) {
      if (e.key === "\\") {
        e.preventDefault();
        workspaceStore.splitFocusedPane("row");
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        workspaceStore.splitFocusedPane("column");
        return;
      }
    }
    if (modShift && (e.key === "w" || e.key === "W")) {
      e.preventDefault();
      workspaceStore.closeFocusedWindow();
      return;
    }
  };

  const handleOpenSettings = () => setSlidePanel("settings");

  // Per-workspace focus memory. Track focus as it changes so clicking
  // the workspace switcher does not overwrite the previous workspace's
  // last meaningful input with the tab button itself.
  const focusByWorkspace = new Map<number, WeakRef<HTMLElement>>();
  let restoreFocusFrame: number | null = null;
  let suppressFocusMemory = false;
  const isRestorableFocusTarget = (target: HTMLElement) => {
    if (target === document.body || target === document.documentElement) {
      return false;
    }
    if (target.matches(":disabled")) {
      return false;
    }
    if (target.closest("[data-workspace-focus-ignore='true']")) {
      return false;
    }
    if (target.closest("[aria-hidden='true']")) {
      return false;
    }
    return true;
  };
  const rememberFocus = (workspaceNumber = workspaceStore.activeNumber) => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && isRestorableFocusTarget(focused)) {
      focusByWorkspace.set(workspaceNumber, new WeakRef(focused));
    }
  };
  const focusWorkspacePanel = () => {
    const panel = document.getElementById("workspace-content-panel");
    if (panel instanceof HTMLElement) {
      suppressFocusMemory = true;
      panel.focus({ preventScroll: true });
      suppressFocusMemory = false;
    } else if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  };
  const focusDefaultWindowTarget = () => {
    if (workspaceStore.activeWorkspace.windows.length !== 1) return false;
    const panel = document.getElementById("workspace-content-panel");
    if (!(panel instanceof HTMLElement)) return false;

    const candidates = panel.querySelectorAll<HTMLElement>(
      "[data-workspace-default-focus='true']",
    );
    for (const candidate of candidates) {
      if (document.contains(candidate) && isRestorableFocusTarget(candidate)) {
        candidate.focus({ preventScroll: true });
        return true;
      }
    }
    return false;
  };
  const handleFocusIn = (event: FocusEvent) => {
    if (suppressFocusMemory) return;
    const target = event.target;
    if (target instanceof HTMLElement && isRestorableFocusTarget(target)) {
      focusByWorkspace.set(workspaceStore.activeNumber, new WeakRef(target));
    }
  };
  const unsubscribeWorkspaceRemoved = workspaceStore.onWorkspaceRemoved(
    (number) => {
      focusByWorkspace.delete(number);
    },
  );
  createEffect(
    on(
      () => workspaceStore.activeNumber,
      (current, previous) => {
        if (previous !== undefined) {
          rememberFocus(previous);
        }

        if (restoreFocusFrame !== null) {
          cancelAnimationFrame(restoreFocusFrame);
        }
        if (
          document.activeElement instanceof HTMLElement &&
          document.activeElement.closest("[aria-hidden='true']")
        ) {
          focusWorkspacePanel();
        }
        restoreFocusFrame = requestAnimationFrame(() => {
          restoreFocusFrame = null;
          if (workspaceStore.activeNumber !== current) return;

          const target = focusByWorkspace.get(current)?.deref();
          if (
            target &&
            document.contains(target) &&
            isRestorableFocusTarget(target)
          ) {
            target.focus({ preventScroll: true });
            return;
          }

          focusByWorkspace.delete(current);
          if (focusDefaultWindowTarget()) return;
          focusWorkspacePanel();
        });
      },
    ),
  );

  // Register global listeners and keyboard shortcuts
  onMount(() => {
    initWorkspaceStore();
    initEditorSessionPersistence();
    void restoreEditorSessions();

    window.addEventListener("seren:open-panel", handleOpenPanel);
    window.addEventListener("seren:open-settings", handleOpenSettings);
    document.addEventListener("focusin", handleFocusIn);
    // Capture phase so descendants calling stopPropagation (Monaco)
    // can't swallow the workspace-switch chord.
    window.addEventListener("keydown", handleKeyDown, true);

    shortcuts.register("focusChat", () => setSlidePanel(null));
    shortcuts.register("openSettings", () =>
      setSlidePanel((v) => (v === "settings" ? null : "settings")),
    );
    shortcuts.register("toggleSidebar", () => setSidebarCollapsed((v) => !v));
    shortcuts.register("closePanel", handleCloseSlidePanel);
    shortcuts.register("focusEditor", () => {
      setSlidePanel(null);
      focusEditorForContext();
    });
  });

  onCleanup(() => {
    unsubscribeWorkspaceRemoved();
    window.removeEventListener("seren:open-panel", handleOpenPanel);
    window.removeEventListener("seren:open-settings", handleOpenSettings);
    document.removeEventListener("focusin", handleFocusIn);
    window.removeEventListener("keydown", handleKeyDown, true);
    if (restoreFocusFrame !== null) {
      cancelAnimationFrame(restoreFocusFrame);
      restoreFocusFrame = null;
    }

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
        onToggleSkills={handleToggleSkills}
        onToggleSettings={handleToggleSettings}
      />

      <div class="flex flex-1 overflow-hidden relative">
        <ThreadSidebar
          collapsed={sidebarCollapsed()}
          onToggle={() => setSidebarCollapsed((v) => !v)}
        />

        <main class="flex-1 overflow-auto flex flex-col min-w-0">
          <Show
            when={inboxOpen()}
            fallback={
              <Show
                when={catalogOpen()}
                fallback={
                  <Show
                    when={activeEmployeeId()}
                    fallback={
                      <Show
                        when={activeBountyId()}
                        fallback={
                          <ThreadContent onSignInClick={handleSignInClick} />
                        }
                      >
                        {(id) => (
                          <BountyDetail
                            bountyId={id()}
                            inheritFrom={activeBountyInheritFrom()}
                          />
                        )}
                      </Show>
                    }
                  >
                    {(id) => (
                      <Show
                        when={
                          employeeStore.byId(id()) === undefined &&
                          employeeStore.archivedById(id()) !== undefined
                        }
                        fallback={
                          <EmployeeDetail
                            employeeId={id()}
                            onClose={closeEmployeeDetailPane}
                          />
                        }
                      >
                        <ArchivedEmployeeDetail
                          employeeId={id()}
                          onClose={closeEmployeeDetailPane}
                        />
                      </Show>
                    )}
                  </Show>
                }
              >
                <CatalogList />
              </Show>
            }
          >
            <InboxList />
          </Show>
        </main>

        <SlidePanel
          open={slidePanel() !== null}
          onClose={handleCloseSlidePanel}
          docked={slidePanel() === "skills"}
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
            <Match when={slidePanel() === "tasks"}>
              <AgentTasksPanel onClose={handleCloseSlidePanel} />
            </Match>
            <Match when={slidePanel() === "sessions"}>
              <SessionPanel onClose={handleCloseSlidePanel} />
            </Match>
            <Match when={slidePanel() === "skills"}>
              <SkillsExplorer panelMode />
            </Match>
            <Match when={slidePanel() === "account"}>
              <SignIn onSuccess={handleLoginSuccess} />
            </Match>
          </Switch>
        </SlidePanel>
      </div>

      <Show when={skillPublishStore.firstPublishPath}>
        {(path) => {
          const target = () => publishTargetForPath(path());
          return (
            <Show when={target()}>
              {(skill) => (
                <PublishSkillModal
                  skill={skill()}
                  onClose={() => skillPublishStore.clearFirstPublish()}
                  onPublished={() => void handleSkillPublishComplete()}
                />
              )}
            </Show>
          );
        }}
      </Show>
      <Show when={skillPublishStore.versionPublishPath}>
        {(path) => {
          const target = () => publishTargetForPath(path());
          const catalogVersion = (slug: string) =>
            skillsStore.available.find((s) => s.slug === slug)?.version;
          return (
            <Show when={target()}>
              {(skill) => (
                <PublishVersionModal
                  skill={skill()}
                  currentVersion={
                    catalogVersion(skill().slug) ?? skill().version
                  }
                  onClose={() => skillPublishStore.clearVersionPublish()}
                  onPublished={() => void handleSkillPublishComplete()}
                />
              )}
            </Show>
          );
        }}
      </Show>

      {/* Layout-level blocking sign-in modal — fires on mid-session expiry,
          refresh-token failure, and the /login slash command. Distinct from
          the passive titlebar Sign In button (always-on when unauthenticated)
          and from ChatContent's local pre-send gate. See #1661. */}
      <SessionExpiredModal />
    </div>
  );
};
