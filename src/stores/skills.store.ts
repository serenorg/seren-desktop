// ABOUTME: Skills store for managing skills state in the UI.
// ABOUTME: Handles available skills, installed skills, and thread/project/global resolution.

import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import { untrack } from "solid-js";
import { createStore } from "solid-js/store";
import { log } from "@/lib/logger";
import { queryClient } from "@/lib/query-client";
import { verboseRuntimeConsole } from "@/lib/runtime-console";
import {
  filterHostCompatibleCatalog,
  type InstalledSkill,
  isSkillCompatibleWithHost,
  type Skill,
  type SkillInstallOptions,
  type SkillScope,
  type SkillSyncStatus,
  type SkillsState,
} from "@/lib/skills";
import {
  type EnabledSkillsContentOptions,
  isAuthStatus,
  isUpstreamManagedSkill,
  type ProjectSkillsConfig,
  SkillsApiError,
  skills,
} from "@/services/skills";
import { skillsCatalogQueryKey } from "@/services/skills-query";
import { getFileTreeState } from "@/stores/fileTree";

const ENABLED_SKILLS_KEY = "seren:enabled_skills";
const HIDDEN_SKILLS_KEY = "seren:hidden_skills";

/**
 * Summary returned by refresh() so callers can display user feedback.
 */
export interface RefreshSummary {
  updated: number;
  alreadyCurrent: number;
  failed: number;
}

export interface RefreshInstalledOptions {
  /**
   * Also inspect upstream sync status after the installed inventory has been
   * re-read. This is intentionally opt-in because the full refresh path already
   * performs its own auto-sync sweep.
   */
  inspectSyncStatuses?: boolean;
}

/** Concurrency guard: in-flight refresh promise so concurrent calls coalesce. */
let activeRefreshPromise: Promise<RefreshSummary> | null = null;

/**
 * Concurrency guard: in-flight install promises keyed by scope+slug so a
 * concurrent click + drag (or two drags) on the same skill cannot push two
 * duplicate entries into state.installed.
 */
const activeInstallPromises = new Map<string, Promise<InstalledSkill>>();

/**
 * Load enabled skills state from localStorage.
 */
function loadEnabledState(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(ENABLED_SKILLS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

/**
 * Save enabled skills state to localStorage.
 */
function saveEnabledState(state: Record<string, boolean>): void {
  try {
    localStorage.setItem(ENABLED_SKILLS_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage errors
  }
}

function loadHiddenSkills(): string[] {
  try {
    const stored = localStorage.getItem(HIDDEN_SKILLS_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    // Ignore parse errors
  }
  return [];
}

function saveHiddenSkills(slugs: string[]): void {
  try {
    localStorage.setItem(HIDDEN_SKILLS_KEY, JSON.stringify(slugs));
  } catch {
    // Ignore storage errors
  }
}

function makeProjectConfig(enabled: string[]): ProjectSkillsConfig {
  return {
    version: 1,
    skills: {
      enabled,
    },
  };
}

function skillRef(skill: Pick<InstalledSkill, "scope" | "slug">): string {
  return `${skill.scope}:${skill.slug}`;
}

function applyAvailableCatalog(all: Skill[]): void {
  const available = filterHostCompatibleCatalog(all);
  const excluded = all.length - available.length;
  setState("available", available);
  verboseRuntimeConsole.debug(
    "[SkillsStore] Loaded",
    available.length,
    "available skills",
    excluded > 0 ? `(${excluded} host-excluded)` : "",
  );
}

// Merge a partial catalog view (e.g. paginated browse results) into
// state.available without dropping entries supplied by the bulk catalog
// fetch. The paginated source only ever covers a slice of the catalog,
// so a plain replace would shrink consumers like the thread launcher and
// the skill-drag fallback resolver.
//
// The existing read is untracked: callers run inside SkillsExplorer's
// createEffect, so a tracked read of state.available would resubscribe
// the same effect that's about to write it and spin into an infinite
// merge loop that freezes the UI when the panel mounts.
function mergeAvailableCatalog(partial: Skill[]): void {
  const filtered = filterHostCompatibleCatalog(partial);
  const existing = untrack(() => state.available);
  const byId = new Map<string, Skill>();
  for (const skill of existing) {
    byId.set(skill.id, skill);
  }
  for (const next of filtered) {
    byId.set(next.id, next);
  }
  setState("available", Array.from(byId.values()));
}

function normalizeRefs(refs: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of refs) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    next.push(trimmed);
  }
  return next;
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

function threadKey(projectRoot: string, threadId: string): string {
  return JSON.stringify([projectRoot, threadId]);
}

function parseThreadKey(
  key: string,
): { projectRoot: string; threadId: string } | null {
  try {
    const parsed = JSON.parse(key);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === "string" &&
      typeof parsed[1] === "string"
    ) {
      return { projectRoot: parsed[0], threadId: parsed[1] };
    }
  } catch {
    // Ignore invalid keys
  }
  return null;
}

const [state, setState] = createStore<SkillsState>({
  available: [],
  installed: [],
  selectedId: null,
  isLoading: false,
  error: null,
});

/**
 * Track enabled state separately (not part of the skill data).
 */
const enabledState: Record<string, boolean> = loadEnabledState();
let hiddenSkillSlugs: string[] = loadHiddenSkills();

/**
 * Project defaults cache.
 * - `undefined`: not loaded yet
 * - `null`: no project config (falls back to global defaults)
 * - `string[]`: explicit project defaults
 */
const [projectConfigState, setProjectConfigState] = createStore<
  Record<string, string[] | null | undefined>
>({});

/**
 * Thread override cache keyed by JSON stringified tuple [projectRoot, threadId].
 * - `undefined`: not loaded yet
 * - `null`: no thread override (falls back to project defaults)
 * - `string[]`: explicit thread override, including [] (no skills)
 */
const [threadSkillsState, setThreadSkillsState] = createStore<
  Record<string, string[] | null | undefined>
>({});

/**
 * Sync-status cache keyed by installed skill path. Single source of truth so
 * every surface (the Skills catalog panel and the composer Sync button) reads
 * the same verdict and never disagrees about whether a skill needs syncing.
 * - `undefined`: not inspected yet
 * - `null`: not upstream-managed (nothing to sync)
 * - `SkillSyncStatus`: last inspected verdict
 */
const [syncStatusState, setSyncStatusState] = createStore<
  Record<string, SkillSyncStatus | null | undefined>
>({});

/** Per-skill (by path) in-flight flag for a sync-status inspection or refresh. */
const [syncLoadingState, setSyncLoadingState] = createStore<
  Record<string, boolean>
>({});

/**
 * Outcome of {@link skillsStore.syncInstalledSkill}. The action owns the
 * overwrite confirmation popup; callers map the outcome to surface-specific
 * messaging (an alert in the catalog, a silent button update in the composer).
 */
export interface SyncSkillResult {
  outcome: "synced" | "cancelled" | "untracked" | "error";
  syncStatus: SkillSyncStatus | null | undefined;
  /** Human-readable detail for the `error`/`untracked` outcomes. */
  message?: string;
}

/** Short revision label for confirmation copy; null collapses to "current". */
function shortRevision(sha: string | null): string {
  if (!sha) return "current";
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

/**
 * Confirmation body for {@link skillsStore.syncInstalledSkill}, adapted to the
 * verdict so the user sees what will happen before they apply it:
 * - local edits → list the diverging files and warn about the overwrite
 * - update available → name the revision jump
 * - first sync → explain the bootstrap download
 */
function syncConfirmationMessage(
  skill: InstalledSkill,
  status: SkillSyncStatus,
): string {
  if (status.hasLocalChanges) {
    const changed = [
      ...status.changedLocalFiles,
      ...status.missingManagedFiles,
    ];
    const list = changed.slice(0, 8).join("\n");
    const more =
      changed.length > 8 ? `\n...and ${changed.length - 8} more` : "";
    return `Local changes were detected in ${skill.name}.\n\n${list}${more}\n\nOverwrite local skill files with upstream?`;
  }

  if (status.state === "bootstrap-required") {
    return `${skill.name} needs an initial sync to download its skill files. Sync now?`;
  }

  if (status.updateAvailable) {
    const target = shortRevision(status.remoteRevision?.sha ?? null);
    return `An update is available for ${skill.name} (${shortRevision(
      status.syncedRevision,
    )} → ${target}).\n\nSync now to update to the latest published version?`;
  }

  return `${skill.name} is already up to date. Re-download the latest skill files anyway?`;
}

/**
 * Skills store with reactive state and actions.
 */
export const skillsStore = {
  /**
   * Get all available skills.
   */
  get available(): Skill[] {
    return state.available;
  },

  /**
   * Get all installed skills.
   */
  get installed(): InstalledSkill[] {
    return state.installed;
  },

  /**
   * Get the currently selected skill ID.
   */
  get selectedId(): string | null {
    return state.selectedId;
  },

  /**
   * Get the currently selected skill.
   */
  get selected(): Skill | InstalledSkill | null {
    if (!state.selectedId) return null;

    // First check installed skills
    const installed = state.installed.find((s) => s.id === state.selectedId);
    if (installed) return installed;

    // Then check available skills
    return state.available.find((s) => s.id === state.selectedId) || null;
  },

  /**
   * Get loading state.
   */
  get isLoading(): boolean {
    return state.isLoading;
  },

  /**
   * Get error message.
   */
  get error(): string | null {
    return state.error;
  },

  setAvailableCatalog(all: Skill[]): void {
    mergeAvailableCatalog(all);
    setState("error", null);
  },

  setAvailableError(error: unknown): void {
    const message =
      error instanceof Error ? error.message : "Failed to load skills";
    setState("error", message);
  },

  resetRemoteCatalog(): void {
    setState("available", []);
    setState("selectedId", null);
    setState("error", null);
  },

  /**
   * Check if a skill is installed.
   * A slug match alone is not sufficient when the installed skill's dirName
   * differs from its slug and has no sync state — that indicates a stale
   * skill whose name-derived slug happens to collide with the repo skill.
   */
  isInstalled(skillId: string): boolean {
    const skill = state.available.find((s) => s.id === skillId);
    if (!skill) return false;
    return state.installed.some((s) => {
      if (s.slug !== skill.slug) return false;
      // dirName matches slug — genuine install
      if (s.dirName === s.slug) return true;
      // dirName differs but has upstream sync state linking to this source — genuine install
      if (s.syncState && s.upstreamSourceUrl) return true;
      // dirName differs, no sync state — stale skill with coincidental slug collision
      return false;
    });
  },

  /**
   * Check if a skill is enabled.
   */
  isEnabled(skillId: string): boolean {
    const skill = state.installed.find((s) => s.id === skillId);
    if (!skill) return false;
    return skill.enabled !== false; // Default to enabled
  },

  /**
   * Get globally enabled skills (tier 3 defaults).
   */
  get enabledSkills(): InstalledSkill[] {
    return state.installed.filter((s) => s.enabled !== false);
  },

  /**
   * Get thread skills state map.
   */
  get threadSkills(): Record<string, string[] | null | undefined> {
    return threadSkillsState;
  },

  // --------------------------------------------------------------------------
  // Config loading
  // --------------------------------------------------------------------------

  /**
   * Load project config from `{project}/.seren/config.json` into cache.
   */
  async loadProjectConfig(
    projectRoot: string | null,
    force = false,
  ): Promise<void> {
    if (!projectRoot) return;
    if (!force && projectConfigState[projectRoot] !== undefined) return;

    try {
      const config = await skills.readProjectConfig(projectRoot);
      const refs = config ? normalizeRefs(config.skills.enabled) : null;
      setProjectConfigState(projectRoot, refs);
    } catch (error) {
      console.warn("[SkillsStore] Failed to load project config:", error);
      setProjectConfigState(projectRoot, null);
    }
  },

  /**
   * Load thread override from SQLite into cache.
   */
  async loadThreadSkills(
    projectRoot: string | null,
    threadId: string | null,
    force = false,
  ): Promise<void> {
    if (!projectRoot || !threadId) return;
    const key = threadKey(projectRoot, threadId);
    if (!force && threadSkillsState[key] !== undefined) return;

    try {
      const refs = await skills.getThreadSkills(projectRoot, threadId);
      setThreadSkillsState(key, refs ? normalizeRefs(refs) : null);
    } catch (error) {
      console.warn("[SkillsStore] Failed to load thread skills:", error);
      setThreadSkillsState(key, null);
    }
  },

  /**
   * Ensure cache for current context is loaded.
   */
  async ensureContextLoaded(
    projectRoot: string | null,
    threadId: string | null,
  ): Promise<void> {
    await this.loadProjectConfig(projectRoot);
    await this.loadThreadSkills(projectRoot, threadId);
  },

  // --------------------------------------------------------------------------
  // Resolution helpers
  // --------------------------------------------------------------------------

  /**
   * Resolve refs to installed skills.
   * Supports backwards compatibility with full skill paths.
   */
  resolveRefs(refs: string[]): InstalledSkill[] {
    const set = new Set(refs);
    return state.installed.filter((installed) => {
      const ref = skillRef(installed);
      return set.has(ref) || set.has(installed.path);
    });
  },

  /**
   * Get global default skill refs.
   */
  getGlobalRefs(): string[] {
    return this.enabledSkills.map((s) => skillRef(s));
  },

  /**
   * Persist project refs:
   * - if equal to global defaults, clear project config (fallback)
   * - otherwise write explicit project config
   */
  async persistProjectRefs(projectRoot: string, refs: string[]): Promise<void> {
    const normalized = normalizeRefs(refs);
    const globalRefs = this.getGlobalRefs();

    if (sameSet(normalized, globalRefs)) {
      await skills.clearProjectConfig(projectRoot);
      setProjectConfigState(projectRoot, null);
      return;
    }

    await skills.writeProjectConfig(projectRoot, makeProjectConfig(normalized));
    setProjectConfigState(projectRoot, normalized);
  },

  // --------------------------------------------------------------------------
  // Project-level defaults
  // --------------------------------------------------------------------------

  /**
   * Get the effective project defaults (tier 2 → tier 3).
   */
  getProjectSkills(projectRoot: string | null): InstalledSkill[] {
    if (!projectRoot) {
      return this.enabledSkills;
    }

    const refs = projectConfigState[projectRoot];
    if (!Array.isArray(refs)) {
      return this.enabledSkills;
    }

    return this.resolveRefs(refs);
  },

  /**
   * Check if project defaults diverge from global defaults.
   */
  hasProjectOverride(projectRoot: string | null): boolean {
    if (!projectRoot) return false;
    const refs = projectConfigState[projectRoot];
    if (!Array.isArray(refs)) return false;
    return !sameSet(refs, this.getGlobalRefs());
  },

  /**
   * Toggle a single skill in project defaults.
   */
  async toggleProjectSkill(
    projectRoot: string,
    skillPath: string,
  ): Promise<void> {
    await this.loadProjectConfig(projectRoot);

    const installed = state.installed.find((s) => s.path === skillPath);
    if (!installed) return;
    const target = skillRef(installed);

    const currentRefs = projectConfigState[projectRoot];
    const base = Array.isArray(currentRefs)
      ? [...currentRefs]
      : this.getGlobalRefs();

    const next = base.includes(target)
      ? base.filter((r) => r !== target)
      : [...base, target];

    await this.persistProjectRefs(projectRoot, next);
  },

  /**
   * Reset project defaults to global defaults.
   */
  async resetProjectSkills(projectRoot: string): Promise<void> {
    await skills.clearProjectConfig(projectRoot);
    setProjectConfigState(projectRoot, null);
  },

  /**
   * Get formatted project-level skills content for prompt injection.
   */
  async getProjectSkillsContent(projectRoot: string | null): Promise<string> {
    await this.loadProjectConfig(projectRoot);
    return skills.getEnabledSkillsContent(this.getProjectSkills(projectRoot));
  },

  // --------------------------------------------------------------------------
  // Thread-level overrides
  // --------------------------------------------------------------------------

  /**
   * Get effective thread skills (tier 1 → tier 2 → tier 3).
   */
  getThreadSkills(
    projectRoot: string | null,
    threadId: string | null,
  ): InstalledSkill[] {
    if (!projectRoot || !threadId) {
      return [];
    }

    const key = threadKey(projectRoot, threadId);
    const refs = threadSkillsState[key];

    // Explicit thread override (including empty [] = "no skills")
    // Fail-closed on host exclusion: a skill that declares excludeHosts
    // including "seren-desktop" is never resolved, even if a stale
    // project config or cached ref still points at it.
    // Spec: serenorg/seren-desktop#1496
    // Also fail-closed on payload validation (#1917): a skill whose
    // referenced files didn't make it onto disk must never reach the
    // agent's system prompt — otherwise the agent ls's the empty
    // runtime directory and tries to scaffold from scratch.
    if (Array.isArray(refs)) {
      return this.resolveRefs(refs).filter(
        (skill) =>
          isSkillCompatibleWithHost(skill) && skill.payloadStatus !== "failed",
      );
    }

    // No override yet — fall back to project/global defaults so existing
    // threads don't lose their skills on upgrade. New threads get an
    // explicit empty override when the user first toggles a skill.
    return this.getProjectSkills(projectRoot).filter(
      (skill) =>
        isSkillCompatibleWithHost(skill) && skill.payloadStatus !== "failed",
    );
  },

  /**
   * Whether this thread has an explicit override.
   */
  hasThreadOverride(
    projectRoot: string | null,
    threadId: string | null,
  ): boolean {
    if (!projectRoot || !threadId) return false;
    const refs = threadSkillsState[threadKey(projectRoot, threadId)];
    return Array.isArray(refs);
  },

  /**
   * Toggle a single skill for a specific thread.
   */
  async toggleThreadSkill(
    projectRoot: string,
    threadId: string,
    skillPath: string,
  ): Promise<void> {
    await this.loadProjectConfig(projectRoot);
    await this.loadThreadSkills(projectRoot, threadId);

    const installed = state.installed.find((s) => s.path === skillPath);
    if (!installed) return;
    const target = skillRef(installed);

    const key = threadKey(projectRoot, threadId);
    const current = threadSkillsState[key];
    const base = Array.isArray(current) ? [...current] : [];

    const isAdding = !base.includes(target);
    const next = isAdding
      ? [...base, target]
      : base.filter((r) => r !== target);

    // Auto-refresh stale upstream-managed skill when activating on a thread.
    if (isAdding && isUpstreamManagedSkill(installed)) {
      try {
        const status = await skills.inspectSyncStatus(installed);
        // inspectSyncStatus may return null for non-upstream-managed skills;
        // the gate above guarantees it isn't, but the type is honest about it.
        setSyncStatusState(installed.path, status);
        if (status?.updateAvailable) {
          const refreshed = await skills.refreshInstalledSkill(installed);
          setSyncStatusState(refreshed.installed.path, refreshed.syncStatus);
          await this.refreshInstalled();
          log.info(
            "[SkillsStore] Refreshed stale skill on toggle-on:",
            installed.slug,
          );
        }
      } catch (err) {
        log.warn(
          "[SkillsStore] Upstream check failed on toggle-on:",
          installed.slug,
          err,
        );
      }
    }

    const normalized = normalizeRefs(next);
    await skills.setThreadSkills(projectRoot, threadId, normalized);
    setThreadSkillsState(key, normalized);
  },

  /**
   * Clear thread override (revert to project defaults).
   */
  async resetThreadSkills(
    projectRoot: string,
    threadId: string,
  ): Promise<void> {
    await skills.clearThreadSkills(projectRoot, threadId);
    setThreadSkillsState(threadKey(projectRoot, threadId), null);
  },

  /**
   * Detach a single skill from a thread's effective context.
   *
   * Materializes the currently-resolved effective skills (which may be
   * inherited from project or global defaults), removes the targeted
   * skill, and saves the remainder as the thread override. Without
   * this, calling toggleThreadSkill on a thread with no override would
   * start from `[]` and detach every other inherited skill too.
   */
  async detachSkillFromThread(
    projectRoot: string,
    threadId: string,
    skillPath: string,
  ): Promise<void> {
    await this.loadProjectConfig(projectRoot);
    await this.loadThreadSkills(projectRoot, threadId);

    const effective = this.getThreadSkills(projectRoot, threadId);
    const remaining = effective.filter((skill) => skill.path !== skillPath);
    const refs = normalizeRefs(remaining.map((skill) => skillRef(skill)));

    await skills.setThreadSkills(projectRoot, threadId, refs);
    setThreadSkillsState(threadKey(projectRoot, threadId), refs);
  },

  /**
   * Attach a single skill to a thread's effective context.
   *
   * Materializes the currently-resolved effective skills, adds the
   * targeted skill if not already present, and saves the union as the
   * thread override. Idempotent. Same materialization rationale as
   * detachSkillFromThread.
   */
  async attachSkillToThread(
    projectRoot: string,
    threadId: string,
    skillPath: string,
  ): Promise<void> {
    await this.loadProjectConfig(projectRoot);
    await this.loadThreadSkills(projectRoot, threadId);

    const target = state.installed.find((s) => s.path === skillPath);
    if (!target) return;

    const effective = this.getThreadSkills(projectRoot, threadId);
    if (effective.some((skill) => skill.path === skillPath)) return;

    const next = [...effective, target];
    const refs = normalizeRefs(next.map((skill) => skillRef(skill)));

    await skills.setThreadSkills(projectRoot, threadId, refs);
    setThreadSkillsState(threadKey(projectRoot, threadId), refs);
  },

  /**
   * Get formatted thread-effective skills content for prompt injection.
   */
  async getThreadSkillsContent(
    projectRoot: string | null,
    threadId: string | null,
    opts?: EnabledSkillsContentOptions,
  ): Promise<string> {
    await this.ensureContextLoaded(projectRoot, threadId);
    return skills.getEnabledSkillsContent(
      this.getThreadSkills(projectRoot, threadId),
      opts,
    );
  },

  // --------------------------------------------------------------------------
  // Selection and global management
  // --------------------------------------------------------------------------

  /**
   * Set the selected skill.
   */
  setSelected(id: string | null): void {
    setState("selectedId", id);
  },

  /**
   * Toggle a skill's global enabled state.
   */
  toggleEnabled(skillId: string): void {
    const skill = state.installed.find((s) => s.id === skillId);
    if (!skill) return;

    const currentlyEnabled = enabledState[skill.path] !== false;
    enabledState[skill.path] = !currentlyEnabled;
    saveEnabledState(enabledState);

    // Update the installed skill's enabled state
    setState(
      "installed",
      (s) => s.id === skillId,
      "enabled",
      !currentlyEnabled,
    );

    log.info(
      "[SkillsStore] Toggled skill",
      skill.slug,
      "to",
      !currentlyEnabled ? "enabled" : "disabled",
    );
  },

  /**
   * Refresh available skills from the index and publishers.
   * Pass skipCache=true to bypass the localStorage cache (e.g. user-triggered refresh).
   */
  async refreshAvailable(skipCache = false): Promise<void> {
    setState("isLoading", true);
    setState("error", null);

    try {
      const all = await skills.fetchAllSkills(skipCache);
      applyAvailableCatalog(all);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load skills";
      setState("error", message);
      log.error("[SkillsStore] Error loading available skills:", err);
    } finally {
      setState("isLoading", false);
    }
  },

  /**
   * Merge the authenticated user's owned skills (any visibility tier) into
   * state.available. The default catalog endpoint only returns public
   * records, so without this the UI cannot detect ownership of private
   * skills the user just published and the manage actions never surface.
   *
   * Auth errors (401/403) are swallowed so an unauthenticated session does
   * not poison the public catalog state. Other failures (5xx, network) are
   * logged at error level so genuine server problems are not masked.
   */
  async refreshOwnedSkills(): Promise<void> {
    const { authStore } = await import("@/stores/auth.store");
    if (!authStore.isAuthenticated) {
      log.debug("[SkillsStore] Owned-skills refresh skipped (signed out)");
      return;
    }

    try {
      const owned = await skills.fetchOwnedSkills();
      if (owned.length > 0) {
        mergeAvailableCatalog(owned);
      }
    } catch (err) {
      if (err instanceof SkillsApiError && isAuthStatus(err.status)) {
        log.debug("[SkillsStore] Owned-skills refresh skipped (unauth)");
        return;
      }
      log.error("[SkillsStore] Owned-skills refresh failed:", err);
    }
  },

  /**
   * Refresh installed skills from the file system.
   */
  async refreshInstalled(options: RefreshInstalledOptions = {}): Promise<void> {
    setState("isLoading", true);
    setState("error", null);

    try {
      const fileTree = getFileTreeState();
      const projectRoot = fileTree.rootPath;

      const all = await skills.listAllInstalled(projectRoot);

      // Drop host-excluded skills (CLI-only skills installed by mistake
      // from the claude/ scope). They never show up in the UI and cannot
      // be resolved via getThreadSkills.
      // Spec: serenorg/seren-desktop#1496
      const installed = all.filter((skill) => isSkillCompatibleWithHost(skill));
      const excluded = all.length - installed.length;
      if (excluded > 0) {
        verboseRuntimeConsole.debug(
          "[SkillsStore]",
          excluded,
          "installed skill(s) host-excluded from Desktop",
        );
      }

      // Apply enabled state from localStorage
      for (const skill of installed) {
        skill.enabled = enabledState[skill.path] !== false;
      }

      setState("installed", installed);
      verboseRuntimeConsole.debug(
        "[SkillsStore] Loaded",
        installed.length,
        "installed skills",
      );
      if (options.inspectSyncStatuses) {
        await this.refreshAllSyncStatuses();
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to load installed skills";
      setState("error", message);
      log.error("[SkillsStore] Error loading installed skills:", err);
    } finally {
      setState("isLoading", false);
    }
  },

  /**
   * Refresh all skills (available and installed).
   * Pass skipCache=true for user-triggered refreshes that should bypass cache.
   * Concurrent calls coalesce — the second caller gets the first caller's result.
   */
  async refresh(skipCache = false): Promise<RefreshSummary> {
    if (activeRefreshPromise) {
      log.info("[SkillsStore] Refresh already in progress, coalescing");
      return activeRefreshPromise;
    }

    const promise = this._refreshInner(skipCache);
    activeRefreshPromise = promise;
    try {
      return await promise;
    } finally {
      activeRefreshPromise = null;
    }
  },

  /** @internal — the actual refresh logic, called only by refresh(). */
  async _refreshInner(skipCache: boolean): Promise<RefreshSummary> {
    const summary: RefreshSummary = {
      updated: 0,
      alreadyCurrent: 0,
      failed: 0,
    };

    await Promise.all([
      this.refreshAvailable(skipCache),
      this.refreshInstalled(),
    ]);

    // Merge in skills owned by the authenticated user across every
    // visibility tier so private records the user just published become
    // detectable for ownership checks.
    await this.refreshOwnedSkills();

    // Backfill sync state for skills installed before the sync feature
    // existed (pre-v2.3.16). Non-blocking: failures are logged and skipped.
    const needsBackfill = state.installed.some(
      (s) =>
        !s.syncState &&
        state.available.some(
          (a) =>
            (a.slug === s.slug || a.slug === s.dirName) && a.source === "seren",
        ),
    );
    if (needsBackfill) {
      const count = await skills.backfillSyncState(
        state.installed,
        state.available,
      );
      if (count > 0) {
        log.info("[SkillsStore] Backfilled sync state for", count, "skills");
        await this.refreshInstalled();
      }
    }

    // Auto-refresh stale upstream-managed skills so users always get the
    // latest runtime files without needing the explicit Refresh button.
    let autoRefreshed = 0;
    for (const skill of state.installed) {
      if (!isUpstreamManagedSkill(skill)) continue;
      if (skill.syncState?.upstreamDeleted) continue;
      try {
        const status = await skills.inspectSyncStatus(skill);
        // Keep the shared cache coherent so the composer Sync button reflects
        // this background sweep without re-inspecting.
        setSyncStatusState(skill.path, status);
        if (!status || status.hasLocalChanges) continue;
        if (status.updateAvailable || status.state === "bootstrap-required") {
          const refreshed = await skills.refreshInstalledSkill(skill);
          setSyncStatusState(refreshed.installed.path, refreshed.syncStatus);
          autoRefreshed++;
          summary.updated++;
          log.info("[SkillsStore] Auto-refreshed stale skill:", skill.slug);
        } else {
          summary.alreadyCurrent++;
        }
      } catch (err) {
        const is404 = err instanceof Error && err.message.includes(": 404");
        if (is404 && skill.syncState) {
          // Upstream skill was deleted — mark as orphaned so we stop retrying.
          skill.syncState.upstreamDeleted = true;
          await invoke("write_skill_sync_state", {
            skillsDir: skill.skillsDir,
            slug: skill.dirName,
            stateJson: JSON.stringify(skill.syncState),
          });
          log.info(
            "[SkillsStore] Upstream skill deleted, marked orphaned:",
            skill.slug,
          );
        } else {
          summary.failed++;
          log.warn(
            "[SkillsStore] Failed to check/refresh skill:",
            skill.slug,
            err,
          );
        }
      }
    }
    if (autoRefreshed > 0) {
      await this.refreshInstalled();
    }

    // Rename skill directories where the resolved slug (from SKILL.md name)
    // no longer matches the filesystem directory name. This happens when a
    // skill is renamed upstream — the content syncs but the directory retains
    // the old name, causing the agent to not find the skill by its new slug.
    let renamedDirs = 0;
    for (const skill of [...state.installed]) {
      if (skill.dirName === skill.slug) continue;
      if (!skill.syncState) continue;
      try {
        await skills.renameSkillDir(skill, skill.slug);
        renamedDirs++;
        log.info(
          "[SkillsStore] Renamed skill dir:",
          skill.dirName,
          "→",
          skill.slug,
        );
      } catch (err) {
        // Target may already exist or rename failed — not fatal
        log.debug(
          "[SkillsStore] Could not rename skill dir:",
          skill.dirName,
          "→",
          skill.slug,
          err,
        );
      }
    }
    if (renamedDirs > 0) {
      await this.refreshInstalled();
    }

    return summary;
  },

  /**
   * Install a skill.
   */
  async install(
    skill: Skill,
    content: string,
    scope: SkillScope,
    options?: SkillInstallOptions,
  ): Promise<InstalledSkill> {
    const key = `${scope}:${skill.slug}`;
    const inflight = activeInstallPromises.get(key);
    if (inflight) return inflight;

    const promise = (async () => {
      const fileTree = getFileTreeState();
      const projectRoot = fileTree.rootPath;

      const installed = await skills.install(
        skill,
        content,
        scope,
        projectRoot,
        options,
      );

      // Drop any prior entry sharing the install path before appending so a
      // racing caller cannot leave two records pointing at the same SKILL.md.
      setState("installed", [
        ...state.installed.filter((s) => s.path !== installed.path),
        installed,
      ]);

      // Set as enabled by default
      enabledState[installed.path] = true;
      saveEnabledState(enabledState);

      log.info("[SkillsStore] Installed skill:", skill.slug);
      return installed;
    })();

    activeInstallPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      activeInstallPromises.delete(key);
    }
  },

  /**
   * Remove an installed skill.
   */
  async remove(skill: InstalledSkill): Promise<void> {
    await skills.remove(skill);

    // Remove from installed list (filter by path, not id, since the same
    // slug can be installed in multiple scopes sharing the same id)
    setState(
      "installed",
      state.installed.filter((s) => s.path !== skill.path),
    );

    // Drop the cached sync verdict so a reinstall re-inspects from scratch.
    setSyncStatusState(skill.path, undefined);
    setSyncLoadingState(skill.path, false);

    // Remove enabled state
    delete enabledState[skill.path];
    saveEnabledState(enabledState);

    const removedRef = skillRef(skill);

    // Clean loaded project configs that reference this skill
    for (const [projectRoot, refs] of Object.entries(projectConfigState)) {
      if (!Array.isArray(refs)) continue;
      if (!refs.includes(removedRef) && !refs.includes(skill.path)) continue;
      const next = refs.filter((r) => r !== removedRef && r !== skill.path);
      await this.persistProjectRefs(projectRoot, next);
    }

    // Clean loaded thread overrides that reference this skill
    for (const [key, refs] of Object.entries(threadSkillsState)) {
      if (!Array.isArray(refs)) continue;
      if (!refs.includes(removedRef) && !refs.includes(skill.path)) continue;
      const parsed = parseThreadKey(key);
      if (!parsed) continue;
      const next = refs.filter((r) => r !== removedRef && r !== skill.path);
      await skills.setThreadSkills(parsed.projectRoot, parsed.threadId, next);
      setThreadSkillsState(key, next);
    }

    // Clear selection if this skill was selected and no other installation remains
    if (
      state.selectedId === skill.id &&
      !state.installed.some((s) => s.id === skill.id)
    ) {
      setState("selectedId", null);
    }

    log.info("[SkillsStore] Removed skill:", skill.slug);
  },

  /**
   * Get content for globally enabled skills to inject into system prompt.
   */
  async getEnabledContent(): Promise<string> {
    return skills.getEnabledSkillsContent(this.enabledSkills);
  },

  /**
   * Replace an installed skill record after an explicit refresh/update.
   */
  replaceInstalled(updated: InstalledSkill): void {
    const next = state.installed.map((skill) =>
      skill.path === updated.path ? updated : skill,
    );
    setState("installed", next);
  },

  // --------------------------------------------------------------------------
  // Sync status (shared by the Skills catalog panel and the composer button)
  // --------------------------------------------------------------------------

  /**
   * Reactive sync-status verdict for an installed skill (by path).
   */
  syncStatusFor(path: string): SkillSyncStatus | null | undefined {
    return syncStatusState[path];
  },

  /**
   * Whether an inspection or refresh is currently running for this skill path.
   */
  isSyncLoading(path: string): boolean {
    return syncLoadingState[path] === true;
  },

  /**
   * True when the cached verdict says the skill is out of step with upstream:
   * an update is available, the local files diverge, or the skill has never
   * been bootstrapped. Returns false when the status is unknown, an inspection
   * error, or `current`.
   */
  skillNeedsSync(skill: InstalledSkill): boolean {
    const status = syncStatusState[skill.path];
    if (!status) return false;
    return (
      status.updateAvailable ||
      status.hasLocalChanges ||
      status.state === "bootstrap-required"
    );
  },

  /**
   * Inspect (or re-inspect) a single skill's sync status and cache the result.
   * Non-upstream-managed skills are cached as `null` without a network call.
   */
  async loadSyncStatus(
    skill: InstalledSkill,
  ): Promise<SkillSyncStatus | null | undefined> {
    if (!isUpstreamManagedSkill(skill)) {
      setSyncStatusState(skill.path, null);
      return null;
    }

    setSyncLoadingState(skill.path, true);
    try {
      const status = await skills.inspectSyncStatus(skill);
      setSyncStatusState(skill.path, status);
      return status;
    } finally {
      setSyncLoadingState(skill.path, false);
    }
  },

  /**
   * Inspect sync status for every installed skill, populating the cache. Used
   * by the catalog panel on open; failures for a single skill are isolated so
   * one bad skill cannot abort the whole sweep.
   */
  async refreshAllSyncStatuses(): Promise<void> {
    await Promise.all(
      state.installed.map((skill) =>
        this.loadSyncStatus(skill).catch((err) => {
          log.warn(
            "[SkillsStore] Sync-status inspection failed:",
            skill.slug,
            err,
          );
          return undefined;
        }),
      ),
    );
  },

  /**
   * Sync an installed skill to its upstream revision. Shows a confirmation
   * popup describing what will change before applying, refreshes the files,
   * and updates the cached sync status. The single sync gesture for both the
   * catalog row and the composer Sync button.
   */
  async syncInstalledSkill(skill: InstalledSkill): Promise<SyncSkillResult> {
    const cached = syncStatusState[skill.path];
    const status =
      cached && cached.state !== "error"
        ? cached
        : await skills.inspectSyncStatus(skill);
    setSyncStatusState(skill.path, status);

    if (!status) {
      return {
        outcome: "untracked",
        syncStatus: status,
        message: `${skill.name} is not tracked against an upstream Seren skill revision, so Seren will not refresh it automatically.`,
      };
    }

    if (status.state === "error") {
      return {
        outcome: "error",
        syncStatus: status,
        message: status.error
          ? `Seren could not verify the current sync state for ${skill.name}.\n\n${status.error}\n\nSync has been blocked to avoid overwriting local files without a verified baseline.`
          : `Seren could not verify the current sync state for ${skill.name}. Sync has been blocked to avoid overwriting local files without a verified baseline.`,
      };
    }

    const confirmed = await confirm(syncConfirmationMessage(skill, status), {
      title: status.hasLocalChanges
        ? "Overwrite local skill changes?"
        : "Sync skill?",
      kind: status.hasLocalChanges ? "warning" : "info",
    });
    if (!confirmed) {
      return { outcome: "cancelled", syncStatus: status };
    }

    setSyncLoadingState(skill.path, true);
    try {
      const refreshed = await skills.refreshInstalledSkill(skill, {
        expectedLocalManagedState: status.localManagedState,
      });
      this.replaceInstalled(refreshed.installed);
      setSyncStatusState(refreshed.installed.path, refreshed.syncStatus);
      log.info("[SkillsStore] Synced skill:", skill.slug);
      return { outcome: "synced", syncStatus: refreshed.syncStatus };
    } catch (err) {
      // Re-inspect so the cached verdict reflects post-failure reality
      // (the refresh aborts before writing when local state drifted).
      await this.loadSyncStatus(skill).catch(() => undefined);
      throw err;
    } finally {
      setSyncLoadingState(skill.path, false);
    }
  },

  /**
   * Clear the skills index cache and run a full refresh (catalog + installed sync).
   */
  async clearCacheAndRefresh(): Promise<void> {
    skills.clearCache();
    queryClient.removeQueries({ queryKey: skillsCatalogQueryKey });
    await this.refresh(true);
  },

  hideSkill(slug: string): void {
    if (!hiddenSkillSlugs.includes(slug)) {
      hiddenSkillSlugs = [...hiddenSkillSlugs, slug];
      saveHiddenSkills(hiddenSkillSlugs);
    }
  },

  unhideSkill(slug: string): void {
    hiddenSkillSlugs = hiddenSkillSlugs.filter((s) => s !== slug);
    saveHiddenSkills(hiddenSkillSlugs);
  },

  isHidden(slug: string): boolean {
    return hiddenSkillSlugs.includes(slug);
  },
};
