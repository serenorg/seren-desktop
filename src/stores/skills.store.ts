// ABOUTME: Skills store for managing skills state in the UI.
// ABOUTME: Handles available skills, installed skills, per-project overrides, and selection state.

import { createStore } from "solid-js/store";
import { log } from "@/lib/logger";
import type {
  InstalledSkill,
  Skill,
  SkillScope,
  SkillsState,
} from "@/lib/skills";
import { skills } from "@/services/skills";
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
 * Per-project skill overrides. Key: project root path, Value: array of skill paths.
 * Missing key = use global defaults. Empty array = no skills for that project.
 */
const [projectSkillsState, setProjectSkillsState] = createStore<
  Record<string, string[]>
>({});

/**
 * Per-thread skill overrides. Key: thread ID, Value: array of skill paths.
 * Missing key = use global defaults. Empty array = no skills for that thread.
 */
const [threadSkillsState, setThreadSkillsState] = createStore<
  Record<string, string[]>
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
   * Get enabled skills.
   */
  get enabledSkills(): InstalledSkill[] {
    return state.installed.filter((s) => s.enabled !== false);
  },

  // --------------------------------------------------------------------------
  // Per-project skill overrides
  // --------------------------------------------------------------------------

  /**
   * Get the effective skills for a project.
   * If the project has a custom override, returns those skills.
   * Otherwise falls back to the global enabled skills.
   */
  getProjectSkills(projectRoot: string | null): InstalledSkill[] {
    if (!projectRoot) {
      return this.enabledSkills;
    }
    const override = projectSkillsState[projectRoot];
    if (!override) {
      return this.enabledSkills;
    }
    const paths = new Set(override);
    return state.installed.filter((s) => paths.has(s.path));
  },

  /**
   * Check if a project's skills diverge from the global defaults.
   */
  hasProjectOverride(projectRoot: string | null): boolean {
    if (!projectRoot) return false;
    const override = projectSkillsState[projectRoot];
    if (!override) return false;
    const globalPaths = this.enabledSkills.map((s) => s.path);
    if (override.length !== globalPaths.length) return true;
    const globalSet = new Set(globalPaths);
    return override.some((p) => !globalSet.has(p));
  },

  /**
   * Toggle a single skill for a specific project.
   * On first toggle, copies the current global enabled set as the starting point.
   */
  toggleProjectSkill(projectRoot: string, skillPath: string): void {
    if (!projectSkillsState[projectRoot]) {
      const globalPaths = this.enabledSkills.map((s) => s.path);
      setProjectSkillsState(projectRoot, globalPaths);
    }

    const current = projectSkillsState[projectRoot];
    if (current.includes(skillPath)) {
      setProjectSkillsState(
        projectRoot,
        current.filter((p) => p !== skillPath),
      );
    } else {
      setProjectSkillsState(projectRoot, [...current, skillPath]);
    }
  },

  /**
   * Clear project override, reverting to global defaults.
   */
  resetProjectSkills(projectRoot: string): void {
    setProjectSkillsState((prev) => {
      const next = { ...prev };
      delete next[projectRoot];
      return next;
    });
  },

  /**
   * Get formatted skill content for a project's active skills.
   */
  async getProjectSkillsContent(projectRoot: string | null): Promise<string> {
    const projectSkills = this.getProjectSkills(projectRoot);
    return skills.getEnabledSkillsContent(projectSkills);
  },

  // --------------------------------------------------------------------------
  // Per-thread skill overrides
  // --------------------------------------------------------------------------

  /**
   * Get the effective skills for a thread.
   * If the thread has a custom override, returns those skills.
   * Otherwise falls back to the global enabled skills.
   */
  getThreadSkills(threadId: string | null): InstalledSkill[] {
    if (!threadId) {
      return this.enabledSkills;
    }
    const override = threadSkillsState[threadId];
    if (!override) {
      return this.enabledSkills;
    }
    const paths = new Set(override);
    return state.installed.filter((s) => paths.has(s.path));
  },

  /**
   * Check if a thread's skills diverge from the global defaults.
   */
  hasThreadOverride(threadId: string | null): boolean {
    if (!threadId) return false;
    const override = threadSkillsState[threadId];
    if (!override) return false;
    const globalPaths = this.enabledSkills.map((s) => s.path);
    if (override.length !== globalPaths.length) return true;
    const globalSet = new Set(globalPaths);
    return override.some((p) => !globalSet.has(p));
  },

  /**
   * Toggle a single skill for a specific thread.
   * On first toggle, copies the current global enabled set as the starting point.
   */
  toggleThreadSkill(threadId: string, skillPath: string): void {
    if (!threadSkillsState[threadId]) {
      const globalPaths = this.enabledSkills.map((s) => s.path);
      setThreadSkillsState(threadId, globalPaths);
    }

    const current = threadSkillsState[threadId];
    if (current.includes(skillPath)) {
      setThreadSkillsState(
        threadId,
        current.filter((p) => p !== skillPath),
      );
    } else {
      setThreadSkillsState(threadId, [...current, skillPath]);
    }
  },

  /**
   * Clear thread override, reverting to global defaults.
   */
  resetThreadSkills(threadId: string): void {
    setThreadSkillsState((prev) => {
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
  },

  /**
   * Get formatted skill content for a thread's active skills.
   */
  async getThreadSkillsContent(threadId: string | null): Promise<string> {
    const threadSkills = this.getThreadSkills(threadId);
    return skills.getEnabledSkillsContent(threadSkills);
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
   * Toggle a skill's enabled state.
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
   * Get content for enabled skills to inject into agent system prompt.
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
