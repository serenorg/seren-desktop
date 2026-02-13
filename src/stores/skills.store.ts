// ABOUTME: Skills store for managing skills state in the UI.
// ABOUTME: Handles available skills, installed skills, and thread/project/global resolution.

import { createStore } from "solid-js/store";
import { log } from "@/lib/logger";
import type {
  InstalledSkill,
  Skill,
  SkillScope,
  SkillsState,
} from "@/lib/skills";
import { type ProjectSkillsConfig, skills } from "@/services/skills";
import { getFileTreeState } from "@/stores/fileTree";

const ENABLED_SKILLS_KEY = "seren:enabled_skills";

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

  /**
   * Check if a skill is installed.
   */
  isInstalled(skillId: string): boolean {
    // Check by slug since installed skills have different IDs
    const skill = state.available.find((s) => s.id === skillId);
    if (!skill) return false;
    return state.installed.some((s) => s.slug === skill.slug);
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
      return this.getProjectSkills(projectRoot);
    }

    const key = threadKey(projectRoot, threadId);
    const refs = threadSkillsState[key];
    if (!Array.isArray(refs)) {
      return this.getProjectSkills(projectRoot);
    }

    return this.resolveRefs(refs);
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
    const base = Array.isArray(current)
      ? [...current]
      : this.getProjectSkills(projectRoot).map((s) => skillRef(s));

    const next = base.includes(target)
      ? base.filter((r) => r !== target)
      : [...base, target];

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
   * Get formatted thread-effective skills content for prompt injection.
   */
  async getThreadSkillsContent(
    projectRoot: string | null,
    threadId: string | null,
  ): Promise<string> {
    await this.ensureContextLoaded(projectRoot, threadId);
    return skills.getEnabledSkillsContent(
      this.getThreadSkills(projectRoot, threadId),
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
   */
  async refreshAvailable(): Promise<void> {
    setState("isLoading", true);
    setState("error", null);

    try {
      const available = await skills.fetchAllSkills();
      setState("available", available);
      log.info("[SkillsStore] Loaded", available.length, "available skills");
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
   * Refresh installed skills from the file system.
   */
  async refreshInstalled(): Promise<void> {
    setState("isLoading", true);
    setState("error", null);

    try {
      const fileTree = getFileTreeState();
      const projectRoot = fileTree.rootPath;

      const installed = await skills.listAllInstalled(projectRoot);

      // Apply enabled state from localStorage
      for (const skill of installed) {
        skill.enabled = enabledState[skill.path] !== false;
      }

      setState("installed", installed);
      log.info("[SkillsStore] Loaded", installed.length, "installed skills");
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
   */
  async refresh(): Promise<void> {
    await Promise.all([this.refreshAvailable(), this.refreshInstalled()]);
  },

  /**
   * Install bundled skills from app resources to ~/.config/seren/skills.
   * Only installs skills that don't already exist.
   * Called once on app startup to ensure default skills are available.
   */
  async installBundledSkills(): Promise<void> {
    try {
      const installedSlugs = await skills.installBundledSkills();
      if (installedSlugs.length > 0) {
        log.info("[SkillsStore] Installed bundled skills:", installedSlugs);
      }
    } catch (error) {
      log.error("[SkillsStore] Failed to install bundled skills:", error);
    }
  },

  /**
   * Install a skill.
   */
  async install(
    skill: Skill,
    content: string,
    scope: SkillScope,
  ): Promise<InstalledSkill> {
    const fileTree = getFileTreeState();
    const projectRoot = fileTree.rootPath;

    const installed = await skills.install(skill, content, scope, projectRoot);

    // Add to installed list
    setState("installed", [...state.installed, installed]);

    // Set as enabled by default
    enabledState[installed.path] = true;
    saveEnabledState(enabledState);

    log.info("[SkillsStore] Installed skill:", skill.slug);
    return installed;
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
   * Clear the skills index cache and refresh.
   */
  async clearCacheAndRefresh(): Promise<void> {
    skills.clearCache();
    await this.refreshAvailable();
  },
};
