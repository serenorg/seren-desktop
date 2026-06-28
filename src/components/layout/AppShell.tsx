// ABOUTME: Root layout component with titlebar, thread sidebar, main content, and slide panel.
// ABOUTME: Thread list in left sidebar, content area routes to chat or agent views.

import {
  type Component,
  createEffect,
  createSignal,
  ErrorBoundary,
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
import { InterviewLanding } from "@/components/interview/InterviewLanding";
import {
  CLOSE_INTERVIEW_LANDING_EVENT,
  type InterviewLandingEventDetail,
  OPEN_INTERVIEW_LANDING_EVENT,
} from "@/components/interview/interviewLandingEvents";
import { ThreadSidebar } from "@/components/layout/ThreadSidebar";
import { AudioPrimingDialog } from "@/components/meeting/AudioPrimingDialog";
import { MeetingPanel } from "@/components/meeting/MeetingPanel";
import { RecordingIndicator } from "@/components/meeting/RecordingIndicator";
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
import { openFolder } from "@/lib/files/service";
import { isMeetingProcessingStatus } from "@/lib/meeting-format";
import { isNativeTextEditingKey, shortcuts } from "@/lib/shortcuts";
import type { InstalledSkill } from "@/lib/skills";
import { listenForInterviewLaunch } from "@/lib/tauri-bridge";
import { telemetry } from "@/services/telemetry";
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
import {
  createKeybindingMatcher,
  type KeybindingActionId,
} from "@/stores/keybindings.store";
import { meetingStore } from "@/stores/meeting.store";
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
  | "meetings"
  | "skills"
  | null;

const WORKSPACE_KEYBINDING_ACTIONS: readonly KeybindingActionId[] = [
  "workspace.switch1",
  "workspace.switch2",
  "workspace.switch3",
  "workspace.switch4",
  "workspace.switch5",
  "workspace.switch6",
  "workspace.switch7",
  "workspace.switch8",
  "workspace.switch9",
  "workspace.switch10",
  "workspace.next",
  "workspace.previous",
  "pane.focusLeft",
  "pane.focusRight",
  "pane.focusUp",
  "pane.focusDown",
  "pane.focusPrevious",
  "pane.focusNext",
  "pane.splitRight",
  "pane.splitDown",
  "pane.close",
  "pane.zoom",
  "pane.resizeLeft",
  "pane.resizeRight",
  "pane.resizeUp",
  "pane.resizeDown",
];

const SLIDE_PANEL_KEY = "seren:slide_panel";

const PERSISTABLE_VIEWS: ReadonlySet<NonNullable<SlidePanelView>> = new Set([
  "settings",
  "database",
  "tasks",
  "sessions",
  "meetings",
  "skills",
]);

function loadInitialSlidePanel(): SlidePanelView {
  try {
    const raw = localStorage.getItem(SLIDE_PANEL_KEY);
    if (raw === null) return null;
    if (raw === "null") return null;
    if (PERSISTABLE_VIEWS.has(raw as NonNullable<SlidePanelView>)) {
      return raw as SlidePanelView;
    }
  } catch {
    // localStorage unavailable - fall back to default
  }
  return null;
}

// Strong startup default: the Seren Employee intake landing is the canonical
// startup surface. Closing it is session-only — the next launch shows it
// again. This intentionally ignores the legacy
// `seren:interview_landing_dismissed` key.
function loadInitialInterviewLanding(): boolean {
  return true;
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
  onLoginSuccess: () => Promise<void> | void;
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
  const [interviewLandingOpen, setInterviewLandingOpen] = createSignal(
    loadInitialInterviewLanding(),
  );
  const [interviewEmployeeSlug, setInterviewEmployeeSlug] = createSignal<
    string | null
  >(null);
  createEffect(() => {
    persistSlidePanel(slidePanel());
  });

  const reportInterviewInterest = (
    employeeSlug: string | null,
    source: string,
    event = "interview-launched",
  ) => {
    void telemetry.recordEmployeeInterest({
      employeeSlug,
      event,
      source,
    });
  };

  const openInterviewLanding = (
    employeeSlug?: string | null,
    source?: string,
  ) => {
    setInterviewEmployeeSlug(employeeSlug ?? null);
    setInterviewLandingOpen(true);
    setActiveEmployeeId(null);
    if (activeBountyId() !== null) {
      setActiveBountyId(null);
      setActiveBountyInheritFrom(null);
      window.dispatchEvent(new CustomEvent(CLOSE_BOUNTY_DETAIL_EVENT));
    }
    setCatalogOpen(false);
    setInboxOpen(false);
    if (source) {
      reportInterviewInterest(employeeSlug ?? null, source);
    }
  };

  const handleOpenInterviewLanding = (event: Event) => {
    const detail = (event as CustomEvent<InterviewLandingEventDetail>).detail;
    openInterviewLanding(detail?.employee ?? null, detail?.source);
  };

  const closeInterviewLanding = () => {
    setInterviewLandingOpen(false);
    setInterviewEmployeeSlug(null);
    window.dispatchEvent(new CustomEvent(CLOSE_INTERVIEW_LANDING_EVENT));
  };

  const handleCloseInterviewLanding = () => {
    setInterviewLandingOpen(false);
    setInterviewEmployeeSlug(null);
  };

  const handleOpenEmployeeDetail = (event: Event) => {
    const detail = (event as CustomEvent<EmployeeDetailEventDetail>).detail;
    if (detail?.employeeId) {
      setActiveEmployeeId(detail.employeeId);
      setInterviewLandingOpen(false);
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
      setInterviewLandingOpen(false);
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
    setInterviewLandingOpen(false);
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
    setInterviewLandingOpen(false);
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
        setInterviewLandingOpen(false);
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
    window.addEventListener(
      OPEN_INTERVIEW_LANDING_EVENT,
      handleOpenInterviewLanding,
    );
    window.addEventListener(
      CLOSE_INTERVIEW_LANDING_EVENT,
      handleCloseInterviewLanding,
    );
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

    let cleanupInterviewLaunch: (() => void) | null = null;
    void listenForInterviewLaunch((payload) => {
      openInterviewLanding(payload.employee ?? null, "desktop-deep-link");
    }).then((unlisten) => {
      cleanupInterviewLaunch = unlisten;
    });
    onCleanup(() => cleanupInterviewLaunch?.());
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
    window.removeEventListener(
      OPEN_INTERVIEW_LANDING_EVENT,
      handleOpenInterviewLanding,
    );
    window.removeEventListener(
      CLOSE_INTERVIEW_LANDING_EVENT,
      handleCloseInterviewLanding,
    );
  });

  const handleSignInClick = () => {
    setSlidePanel("account");
  };

  const handleToggleSettings = () => {
    setSlidePanel((v) => (v === "settings" ? null : "settings"));
  };

  const handleToggleMeetings = () => {
    setSlidePanel((v) => (v === "meetings" ? null : "meetings"));
  };

  const handleToggleSkills = () => {
    setSlidePanel((v) => (v === "skills" ? null : "skills"));
  };

  const handleCloseSlidePanel = () => {
    // Report whether a panel was actually closed so the shortcut manager only
    // swallows Escape when there is something to dismiss.
    if (!slidePanel()) return false;
    setSlidePanel(null);
    return true;
  };

  const handleLoginSuccess = async () => {
    await props.onLoginSuccess();
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
    } else if (p === "meetings") {
      setSlidePanel("meetings");
    } else if (p === "skills") {
      setSlidePanel("skills");
    }
  }) as EventListener;

  const handleSearchTranscripts = ((e: CustomEvent) => {
    setSlidePanel("meetings");
    meetingStore.requestSearchFocus(String(e.detail ?? ""));
  }) as EventListener;

  const workspaceKeybindingMatcher = createKeybindingMatcher(
    WORKSPACE_KEYBINDING_ACTIONS,
    () => ({
      terminalPaneFocused:
        workspaceStore.activeWindow === null ||
        workspaceStore.activeWindow.kind === null ||
        workspaceStore.activeWindow.kind === "terminal",
    }),
  );

  const handleKeyDown = (e: KeyboardEvent) => {
    if (document.body.dataset.keybindingRecording === "true") {
      workspaceKeybindingMatcher.clear();
      return;
    }

    const target = e.target;
    if (
      target instanceof HTMLElement &&
      target.closest("[data-keybinding-recorder='true']")
    ) {
      return;
    }

    // Inside a text field, caret-movement keys must perform native cursor
    // movement and selection (e.g. Cmd/Ctrl+Shift+Arrow). The arrow-based
    // pane keybindings collide with that chord, so never let this capture-phase
    // handler swallow them. Terminal surfaces are non-editable, so pane resize
    // still works there.
    if (isNativeTextEditingKey(e)) {
      workspaceKeybindingMatcher.clear();
      return;
    }

    const result = workspaceKeybindingMatcher.handleEvent(e);
    if (result.kind === "none") return;

    e.preventDefault();
    if (result.kind === "pending") return;

    const action = result.action;
    if (action.startsWith("workspace.switch")) {
      const number = Number(action.replace("workspace.switch", ""));
      workspaceStore.switchOrCreate(number);
      return;
    }
    if (action === "workspace.next") {
      workspaceStore.cycleWorkspace(1);
      return;
    }
    if (action === "workspace.previous") {
      workspaceStore.cycleWorkspace(-1);
      return;
    }

    if (action === "pane.focusLeft") {
      workspaceStore.focusPaneInDirection("left");
      return;
    }
    if (action === "pane.focusRight") {
      workspaceStore.focusPaneInDirection("right");
      return;
    }
    if (action === "pane.focusUp") {
      workspaceStore.focusPaneInDirection("up");
      return;
    }
    if (action === "pane.focusDown") {
      workspaceStore.focusPaneInDirection("down");
      return;
    }
    if (action === "pane.focusPrevious") {
      workspaceStore.focusPreviousPane();
      return;
    }
    if (action === "pane.focusNext") {
      workspaceStore.focusNextPane();
      return;
    }
    if (action === "pane.splitRight") {
      workspaceStore.splitFocusedPane("row");
      return;
    }
    if (action === "pane.splitDown") {
      workspaceStore.splitFocusedPane("column");
      return;
    }
    if (action === "pane.close") {
      e.preventDefault();
      workspaceStore.closeFocusedWindow();
      return;
    }
    if (action === "pane.zoom") {
      workspaceStore.toggleZoomFocusedPane();
      return;
    }
    if (action === "pane.resizeLeft") {
      workspaceStore.resizeFocusedPane("left");
      return;
    }
    if (action === "pane.resizeRight") {
      workspaceStore.resizeFocusedPane("right");
      return;
    }
    if (action === "pane.resizeUp") {
      workspaceStore.resizeFocusedPane("up");
      return;
    }
    if (action === "pane.resizeDown") {
      workspaceStore.resizeFocusedPane("down");
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

    // Meeting capture lifecycle lives here, in the always-mounted shell, so the
    // tray toggle and transcript listeners survive the
    // MeetingPanel unmounting when its slide panel closes. Started once per app
    // session; torn down on shell cleanup.
    void meetingStore.startMeetingEventListeners();
    // Fail any meeting left `capturing` by a crash/force-quit so it can't block
    // every future capture (#2160).
    void meetingStore.reconcileStaleCaptures();
    meetingStore.startAutoDetect();

    window.addEventListener("seren:open-panel", handleOpenPanel);
    window.addEventListener(
      "seren:search-transcripts",
      handleSearchTranscripts,
    );
    window.addEventListener("seren:open-settings", handleOpenSettings);
    document.addEventListener("focusin", handleFocusIn);
    // Capture phase so descendants calling stopPropagation (Monaco)
    // can't swallow the workspace-switch chord.
    window.addEventListener("keydown", handleKeyDown, true);

    shortcuts.register("global.focusChat", () => setSlidePanel(null));
    shortcuts.register("global.openSettings", () =>
      setSlidePanel((v) => (v === "settings" ? null : "settings")),
    );
    shortcuts.register("global.toggleSidebar", () =>
      setSidebarCollapsed((v) => !v),
    );
    shortcuts.register("global.closePanel", handleCloseSlidePanel);
    shortcuts.register("global.focusEditor", () => {
      setSlidePanel(null);
      focusEditorForContext();
    });
    shortcuts.register("global.openFiles", () => {
      void openFolder();
    });
    shortcuts.register("global.newChat", () => {
      setSlidePanel(null);
      void threadStore.createChatThread();
    });
    shortcuts.register("global.newTerminal", () => {
      setSlidePanel(null);
      void threadStore.createTerminalThread({ title: "Terminal" });
    });
    shortcuts.register("global.searchMeetings", () => {
      setSlidePanel("meetings");
      meetingStore.requestSearchFocus();
    });
  });

  onCleanup(() => {
    workspaceKeybindingMatcher.clear();
    unsubscribeWorkspaceRemoved();
    meetingStore.stopMeetingEventListeners();
    meetingStore.stopAutoDetect();
    window.removeEventListener("seren:open-panel", handleOpenPanel);
    window.removeEventListener(
      "seren:search-transcripts",
      handleSearchTranscripts,
    );
    window.removeEventListener("seren:open-settings", handleOpenSettings);
    document.removeEventListener("focusin", handleFocusIn);
    window.removeEventListener("keydown", handleKeyDown, true);
    if (restoreFocusFrame !== null) {
      cancelAnimationFrame(restoreFocusFrame);
      restoreFocusFrame = null;
    }

    shortcuts.unregister("global.focusChat");
    shortcuts.unregister("global.openSettings");
    shortcuts.unregister("global.toggleSidebar");
    shortcuts.unregister("global.closePanel");
    shortcuts.unregister("global.focusEditor");
    shortcuts.unregister("global.openFiles");
    shortcuts.unregister("global.newChat");
    shortcuts.unregister("global.newTerminal");
    shortcuts.unregister("global.searchMeetings");
  });

  const recordPromptVisible = () =>
    meetingStore.state.autoDetectSuggested &&
    !meetingStore.state.primingRequest &&
    !meetingStore.state.meetings.some(
      (meeting) => meeting.status === "capturing",
    );

  // Live-capture signal for the titlebar so a recording stays visible after the
  // meeting drawer is closed (#2335). The capture lifecycle lives in this shell,
  // so the indicator persists for the whole session, not just while the panel is open.
  const meetingRecording = () =>
    meetingStore.state.meetings.some(
      (meeting) => meeting.status === "capturing",
    );
  const meetingProcessing = () =>
    meetingStore.state.meetings.some((meeting) =>
      isMeetingProcessingStatus(meeting.status),
    );
  const meetingReady = () => meetingStore.state.reviewReadyMeetingId !== null;

  return (
    <div class="flex flex-col h-screen bg-background text-foreground">
      <Titlebar
        onSignInClick={handleSignInClick}
        onToggleMeetings={handleToggleMeetings}
        onToggleSkills={handleToggleSkills}
        onToggleSettings={handleToggleSettings}
        meetingRecording={meetingRecording()}
        meetingProcessing={meetingProcessing()}
        meetingReady={meetingReady()}
        recordPromptVisible={recordPromptVisible()}
        recordPromptSourceApp={meetingStore.state.autoDetectSourceApp}
        onRecordConversation={() => void meetingStore.acceptAutoDetect()}
        onDismissRecordPrompt={() => meetingStore.dismissAutoDetect()}
      />

      <div class="flex flex-1 overflow-hidden relative">
        <ThreadSidebar
          collapsed={sidebarCollapsed()}
          onToggle={() => setSidebarCollapsed((v) => !v)}
          onOpenCatalog={handleOpenCatalog}
          onOpenInbox={handleOpenInbox}
        />

        <main class="flex-1 overflow-auto flex flex-col min-w-0">
          <Show
            when={interviewLandingOpen()}
            fallback={
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
                              <ThreadContent
                                onSignInClick={handleSignInClick}
                              />
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
                    <ErrorBoundary
                      fallback={(error) => {
                        telemetry.reportError(
                          error instanceof Error
                            ? error
                            : new Error(String(error)),
                          { surface: "agent_catalog" },
                        );
                        return (
                          <div class="flex h-full min-h-[320px] flex-col items-center justify-center gap-3 p-6 text-center">
                            <div class="text-sm font-semibold text-foreground">
                              Agent catalog is recovering.
                            </div>
                            <div class="max-w-md text-[13px] text-muted-foreground">
                              The catalog view hit an unexpected entry, but the
                              rest of Seren is still available.
                            </div>
                            <button
                              type="button"
                              class="rounded border border-border bg-card px-3 py-1.5 text-[12px] font-medium text-foreground hover:bg-surface-2"
                              onClick={handleCloseCatalog}
                            >
                              Back to workspace
                            </button>
                          </div>
                        );
                      }}
                    >
                      <CatalogList />
                    </ErrorBoundary>
                  </Show>
                }
              >
                <InboxList />
              </Show>
            }
          >
            <InterviewLanding
              initialEmployeeSlug={interviewEmployeeSlug()}
              onClose={closeInterviewLanding}
              onSelectEmployee={(employeeSlug) => {
                reportInterviewInterest(
                  employeeSlug,
                  "desktop-role-selection",
                  "role-selected",
                );
              }}
              onStartInterview={(employeeSlug) => {
                reportInterviewInterest(
                  employeeSlug,
                  "desktop-interview-start",
                  "interview-started",
                );
              }}
            />
          </Show>
        </main>

        <SlidePanel
          open={slidePanel() !== null}
          onClose={handleCloseSlidePanel}
          docked={slidePanel() === "skills"}
          reader={slidePanel() === "meetings"}
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
              <AgentTasksPanel />
            </Match>
            <Match when={slidePanel() === "sessions"}>
              <SessionPanel />
            </Match>
            <Match when={slidePanel() === "meetings"}>
              <MeetingPanel />
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

      {/* First-run audio-permission explainer, surfaced app-wide so non-panel
          start paths (tray, auto-detect) gate on it too. Driven by the meeting
          store's pending priming request. */}
      <Show when={meetingStore.state.primingRequest}>
        <AudioPrimingDialog
          onContinue={() => void meetingStore.confirmPriming()}
          onCancel={() => void meetingStore.cancelPriming()}
        />
      </Show>

      {/* Always-visible recording indicator while a capture is live (auto- or
          manually-started): elapsed time + Stop / Pause / Resume / Delete. */}
      <RecordingIndicator />

      {/* Layout-level blocking sign-in modal — fires on mid-session expiry,
          refresh-token failure, and the /login slash command. Distinct from
          the passive titlebar Sign In button (always-on when unauthenticated)
          and from ChatContent's local pre-send gate. See #1661. */}
      <SessionExpiredModal />
    </div>
  );
};
