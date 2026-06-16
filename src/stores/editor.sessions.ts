// ABOUTME: Editor sessions derived from tabs. Each session is a (cwd, tabs) bundle.
// ABOUTME: Sessions surface in the project-rooted thread sidebar as kind="editor" entries.

import { createEffect, untrack } from "solid-js";
import { pathExists, readFile } from "@/lib/files/service";
import { isSupportedImageFile } from "@/lib/images/file-types";
import { log } from "@/lib/logger";
import {
  bumpSessionActiveAt,
  openTab,
  rememberSessionActiveTab,
  restoreSessionActiveAt,
  setActiveSessionByCwd,
  setActiveTab,
  type Tab,
  tabsState,
} from "@/stores/tabs";

const PERSIST_KEY = "seren:editor_sessions:v1";
const SAVE_DEBOUNCE_MS = 250;

interface PersistedTab {
  filePath: string;
  cwd: string;
}

interface PersistedState {
  tabs: PersistedTab[];
  /** filePath of the globally-active tab, or null. */
  activeFilePath: string | null;
  /** Per-cwd remembered active tab, keyed by filePath (not tab id, which is regenerated). */
  lastActiveByCwd: Record<string, string>;
  /** Per-cwd activation epoch so the sidebar's recency sort survives restart. */
  lastActiveAtByCwd: Record<string, number>;
}

/**
 * A grouping of open tabs that share a working directory. The cwd is the
 * canonical root the user is editing inside (a skill folder, a project root,
 * or a file's parent directory when opened ad-hoc).
 */
export interface EditorSession {
  /** Stable id used as a thread id in `threadStore`. */
  id: string;
  /** Canonical absolute path the session is rooted at. */
  cwd: string;
  /** Display label - basename(cwd), with disambiguation if needed. */
  label: string;
  /** Tabs in this session, in open order. */
  tabs: Tab[];
  /** Currently focused tab id within this session, if any. */
  activeTabId: string | null;
  /** Whether any tab in the session is unsaved. */
  isDirty: boolean;
  /** Most recent activation epoch used as a sort key in the sidebar. */
  lastActiveAt: number;
}

function basename(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  if (!trimmed) return "/";
  const idx = trimmed.lastIndexOf("/");
  return idx < 0 ? trimmed : trimmed.slice(idx + 1) || trimmed;
}

function disambiguate(cwds: string[]): Map<string, string> {
  const labels = new Map<string, string>();
  const collisions = new Map<string, string[]>();

  for (const cwd of cwds) {
    const name = basename(cwd);
    const bucket = collisions.get(name) ?? [];
    bucket.push(cwd);
    collisions.set(name, bucket);
  }

  for (const [name, members] of collisions) {
    if (members.length === 1) {
      labels.set(members[0], name);
      continue;
    }
    // Append the parent segment until each label is unique. Two skill dirs
    // named "examples" under different roots become "lead-finder/examples"
    // and "grid-trader/examples".
    for (const cwd of members) {
      const parts = cwd.split("/").filter(Boolean);
      let depth = 1;
      let label = parts.slice(-(depth + 1)).join("/") || name;
      while (
        members.some(
          (other) =>
            other !== cwd &&
            (other
              .split("/")
              .filter(Boolean)
              .slice(-(depth + 1))
              .join("/") || name) === label,
        )
      ) {
        depth += 1;
        label = parts.slice(-(depth + 1)).join("/") || name;
        if (depth > parts.length) break;
      }
      labels.set(cwd, label);
    }
  }

  return labels;
}

// Sessions are recomputed on every access. The cost is bounded by the number
// of open tabs (rarely above a couple dozen) and avoids the createMemo/root
// coupling that complicates tests. Solid still re-renders consumers on
// `tabsState` mutations because the access tracks the underlying store.
function computeSessions(): EditorSession[] {
  const byCwd = new Map<string, Tab[]>();
  for (const tab of tabsState.tabs) {
    const bucket = byCwd.get(tab.cwd) ?? [];
    bucket.push(tab);
    byCwd.set(tab.cwd, bucket);
  }

  const cwds = Array.from(byCwd.keys());
  const labels = disambiguate(cwds);

  const result: EditorSession[] = [];
  for (const [cwd, tabs] of byCwd) {
    const remembered = tabsState.lastActiveByCwd[cwd];
    const activeTabId = tabs.some((t) => t.id === remembered)
      ? remembered
      : (tabs[tabs.length - 1]?.id ?? null);
    result.push({
      id: `editor:${cwd}`,
      cwd,
      label: labels.get(cwd) ?? basename(cwd),
      tabs,
      activeTabId,
      isDirty: tabs.some((t) => t.isDirty),
      lastActiveAt: tabsState.lastActiveAtByCwd[cwd] ?? 0,
    });
  }
  return result;
}

function computeActiveSession(): EditorSession | null {
  const activeId = tabsState.activeTabId;
  if (!activeId) return null;
  const activeTab = tabsState.tabs.find((t) => t.id === activeId);
  if (!activeTab) return null;
  return computeSessions().find((s) => s.cwd === activeTab.cwd) ?? null;
}

export function sessionIdForCwd(cwd: string): string {
  return `editor:${cwd}`;
}

/**
 * Pick the editor session that best matches the user's current context
 * (their active thread's project root, or the file-tree root). Falls back
 * to the most recently activated session. Returns null when no sessions
 * exist - the caller should just open a fresh editor pane.
 *
 * This drives Cmd+E session targeting: the user gets the editor for the
 * project they're already working in, not whatever session happened to be
 * active most recently.
 */
export function pickEditorSessionForContext(opts: {
  contextRoot: string | null;
}): EditorSession | null {
  const sessions = computeSessions();
  if (sessions.length === 0) return null;

  if (opts.contextRoot) {
    const match = sessions.find((s) => s.cwd === opts.contextRoot);
    if (match) return match;
  }
  return sessions.reduce<EditorSession | null>(
    (best, s) =>
      best === null || s.lastActiveAt > best.lastActiveAt ? s : best,
    null,
  );
}

export const editorSessionStore = {
  /** All open editor sessions, derived from open tabs. */
  get sessions(): EditorSession[] {
    return computeSessions();
  },

  /** Session whose tab is currently focused, or null. */
  get activeSession(): EditorSession | null {
    return computeActiveSession();
  },

  /** Stable id of the active session. */
  get activeSessionId(): string | null {
    return computeActiveSession()?.id ?? null;
  },

  /** Find a session by its session id (`editor:<cwd>`). */
  findById(id: string): EditorSession | null {
    return computeSessions().find((s) => s.id === id) ?? null;
  },

  /** Find a session by its cwd, if one exists. */
  findByCwd(cwd: string): EditorSession | null {
    return computeSessions().find((s) => s.cwd === cwd) ?? null;
  },

  /**
   * Make `sessionId` the active session by activating its remembered tab.
   * Returns the session's active file path, or null if the session is empty.
   */
  activate(sessionId: string): string | null {
    const session = this.findById(sessionId);
    if (!session) return null;
    setActiveSessionByCwd(session.cwd);
    bumpSessionActiveAt(session.cwd);
    const refreshed = this.findById(sessionId);
    const tab = refreshed?.tabs.find((t) => t.id === refreshed.activeTabId);
    return tab?.filePath ?? null;
  },

  /** Bump session activity without changing focus (used on tab opens). */
  touch(cwd: string): void {
    bumpSessionActiveAt(cwd);
  },
};

function snapshotForPersistence(): PersistedState {
  const tabs: PersistedTab[] = tabsState.tabs.map((t) => ({
    filePath: t.filePath,
    cwd: t.cwd,
  }));
  const activeTab = tabsState.tabs.find((t) => t.id === tabsState.activeTabId);

  // lastActiveByCwd in tabsState is keyed by tab id; that id is freshly
  // generated on each restore, so we serialise by filePath instead.
  const idToPath = new Map(tabsState.tabs.map((t) => [t.id, t.filePath]));
  const lastActiveByCwd: Record<string, string> = {};
  for (const [cwd, tabId] of Object.entries(tabsState.lastActiveByCwd)) {
    const path = idToPath.get(tabId);
    if (path) lastActiveByCwd[cwd] = path;
  }

  return {
    tabs,
    activeFilePath: activeTab?.filePath ?? null,
    lastActiveByCwd,
    lastActiveAtByCwd: { ...tabsState.lastActiveAtByCwd },
  };
}

function readPersistedState(): PersistedState | null {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    if (!Array.isArray(parsed.tabs)) return null;
    return {
      tabs: parsed.tabs.filter(
        (t): t is PersistedTab =>
          typeof t?.filePath === "string" && typeof t?.cwd === "string",
      ),
      activeFilePath:
        typeof parsed.activeFilePath === "string"
          ? parsed.activeFilePath
          : null,
      lastActiveByCwd:
        parsed.lastActiveByCwd && typeof parsed.lastActiveByCwd === "object"
          ? (parsed.lastActiveByCwd as Record<string, string>)
          : {},
      lastActiveAtByCwd:
        parsed.lastActiveAtByCwd && typeof parsed.lastActiveAtByCwd === "object"
          ? (parsed.lastActiveAtByCwd as Record<string, number>)
          : {},
    };
  } catch (err) {
    log.warn("[EditorSessions] Failed to read persisted state", err);
    return null;
  }
}

function writePersistedState(state: PersistedState): void {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(state));
  } catch (err) {
    log.warn("[EditorSessions] Failed to persist state", err);
  }
}

let restored = false;

/**
 * Restore editor sessions from disk: re-read every previously-open file and
 * reopen it under its remembered cwd. Files that no longer exist are dropped
 * silently. Idempotent - safe to call once on app boot.
 */
export async function restoreEditorSessions(): Promise<void> {
  if (restored) return;
  restored = true;
  const persisted = readPersistedState();
  if (!persisted || persisted.tabs.length === 0) return;

  for (const tab of persisted.tabs) {
    try {
      // Image tabs are binary; reading them as text would throw. The viewer
      // loads the file itself, so reopen with empty content when it still
      // exists (matching the drop-if-missing behavior of the text path).
      if (isSupportedImageFile(tab.filePath)) {
        if (await pathExists(tab.filePath)) {
          openTab(tab.filePath, "", tab.cwd);
        }
        continue;
      }
      const content = await readFile(tab.filePath);
      openTab(tab.filePath, content, tab.cwd);
    } catch (err) {
      // The file moved or was deleted - drop it without surfacing an error.
      log.debug(
        "[EditorSessions] Skipping persisted tab (file unavailable):",
        tab.filePath,
        err,
      );
    }
  }

  // Restore per-cwd active-tab memory by mapping persisted file paths to
  // the freshly minted tab ids.
  const pathToId = new Map(tabsState.tabs.map((t) => [t.filePath, t.id]));
  for (const [cwd, filePath] of Object.entries(persisted.lastActiveByCwd)) {
    const tabId = pathToId.get(filePath);
    if (tabId) rememberSessionActiveTab(cwd, tabId);
  }

  for (const [cwd, ts] of Object.entries(persisted.lastActiveAtByCwd)) {
    if (typeof ts === "number") restoreSessionActiveAt(cwd, ts);
  }

  if (persisted.activeFilePath) {
    const activeId = pathToId.get(persisted.activeFilePath);
    if (activeId) setActiveTab(activeId);
  }
}

/**
 * Subscribe a save effect to tabs mutations. Must be called inside a Solid
 * root (e.g. from the AppShell's onMount). Saves are debounced so that
 * rapid open/close/switch sequences result in a single write.
 */
export function initEditorSessionPersistence(): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    // Track every persisted field. The reads must happen inside the
    // tracked closure; the write happens inside `untrack` to avoid the
    // snapshot subscribing the effect to itself.
    tabsState.tabs.length;
    tabsState.activeTabId;
    void tabsState.lastActiveByCwd;
    void tabsState.lastActiveAtByCwd;
    for (const tab of tabsState.tabs) {
      // Tabs change cwd is fixed at open time but include the read so
      // additions/removals fire the effect.
      void tab.cwd;
      void tab.filePath;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      untrack(() => writePersistedState(snapshotForPersistence()));
    }, SAVE_DEBOUNCE_MS);
  });
}
