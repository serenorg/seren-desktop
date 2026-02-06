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
 * Get the project-scope skills directory (.claude/skills/).
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
 * Clear cached paths (useful when project changes).
 */
export function clearPathCache(): void {
  cachedSerenSkillsDir = null;
  cachedClaudeSkillsDir = null;
}
