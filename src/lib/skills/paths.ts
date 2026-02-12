// ABOUTME: Path utilities for skills directories.
// ABOUTME: Provides functions to get seren, claude, and project skill paths.

import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/tauri-bridge";

/** Cached Seren skills directory */
let cachedSerenSkillsDir: string | null = null;

/** Cached Claude Code skills directory */
let cachedClaudeSkillsDir: string | null = null;

/**
 * Get the Seren-scope skills directory ({app_data_dir}/skills/).
 * Creates the directory if it doesn't exist.
 */
export async function getSerenSkillsDir(): Promise<string> {
  if (cachedSerenSkillsDir) {
    return cachedSerenSkillsDir;
  }

  if (!isTauriRuntime()) {
    return "{app_data}/skills";
  }

  const dir = await invoke<string>("get_seren_skills_dir");
  cachedSerenSkillsDir = dir;
  return dir;
}

/**
 * Get the Claude Code skills directory (~/.claude/skills/).
 * Creates the directory if it doesn't exist.
 */
export async function getClaudeSkillsDir(): Promise<string> {
  if (cachedClaudeSkillsDir) {
    return cachedClaudeSkillsDir;
  }

  if (!isTauriRuntime()) {
    return "~/.claude/skills";
  }

  const dir = await invoke<string>("get_claude_skills_dir");
  cachedClaudeSkillsDir = dir;
  return dir;
}

/**
 * Get the project-scope skills directory (skills/).
 * This is the canonical location following the AgentSkills.io standard.
 * A symlink at .claude/skills → ../skills provides Claude Code compatibility.
 * Returns null if no project is currently open.
 */
export async function getProjectSkillsDir(): Promise<string | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  try {
    return invoke<string | null>("get_project_skills_dir");
  } catch {
    return null;
  }
}

/**
 * Get the full path for a skill file.
 */
export function getSkillPath(skillsDir: string, slug: string): string {
  // Normalize path separators for the platform
  const separator = skillsDir.includes("\\") ? "\\" : "/";
  return `${skillsDir}${separator}${slug}${separator}SKILL.md`;
}

/**
 * Get the directory path for a skill.
 */
export function getSkillDir(skillsDir: string, slug: string): string {
  const separator = skillsDir.includes("\\") ? "\\" : "/";
  return `${skillsDir}${separator}${slug}`;
}

/**
 * Create symlink from .claude/skills to ../skills for Claude Code compatibility.
 * This enables both Claude Code and OpenAI Codex to use the same skills directory.
 */
export async function createSkillsSymlink(projectRoot: string): Promise<void> {
  if (!isTauriRuntime()) {
    return;
  }

  try {
    await invoke("create_skills_symlink", { projectRoot });
  } catch (error) {
    console.error("Failed to create skills symlink:", error);
    throw error;
  }
}

/**
 * Clear cached paths (useful when project changes).
 */
export function clearPathCache(): void {
  cachedSerenSkillsDir = null;
  cachedClaudeSkillsDir = null;
}
