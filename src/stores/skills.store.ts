// ABOUTME: Skills store for managing skills state in the UI.
// ABOUTME: Handles available skills, installed skills, and selection state.

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
    return enabledState[skill.path] !== false; // Default to enabled
  },

  /**
   * Get enabled skills.
   */
  get enabledSkills(): InstalledSkill[] {
    return state.installed.filter((s) => enabledState[s.path] !== false);
  },

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
