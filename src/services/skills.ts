// ABOUTME: Skills service for managing skill discovery, installation, and content.
// ABOUTME: Handles fetching from index, local skills, and Seren publishers.

import { invoke } from "@tauri-apps/api/core";
import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
import { log } from "@/lib/logger";
import {
  computeContentHash,
  getSkillPath,
  type InstalledSkill,
  parseSkillMd,
  type Skill,
  type SkillIndexEntry,
  type SkillScope,
  type SkillSource,
  type SkillsIndex,
} from "@/lib/skills";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { catalog, type Publisher } from "./catalog";

const SKILLS_INDEX_URL = "https://skills.serendb.com/index.json";
const INDEX_CACHE_KEY = "seren:skills_index";
const PUBLISHER_SKILLS_CACHE_KEY = "seren:publisher_skills";
const INDEX_CACHE_DURATION = 1000 * 60 * 60; // 1 hour

export interface ProjectSkillsConfig {
  version: number;
  skills: {
    enabled: string[];
  };
}

/**
 * Transform an index entry to a Skill.
 */
function indexEntryToSkill(entry: SkillIndexEntry): Skill {
  return {
    id: `${entry.source}:${entry.slug}`,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    source: entry.source,
    sourceUrl: entry.sourceUrl,
    tags: entry.tags,
    author: entry.author,
    version: entry.version,
  };
}

/**
 * Convert a Seren publisher to a Skill.
 */
function publisherToSkill(publisher: Publisher): Skill {
  // Map publisher type to tags
  const typeTags: string[] = [];
  if (publisher.publisher_type === "database") typeTags.push("database");
  if (publisher.publisher_type === "api") typeTags.push("api");
  if (publisher.publisher_type === "mcp") typeTags.push("mcp");

  // Combine with publisher categories
  const tags = [...new Set([...typeTags, ...publisher.categories])];

  return {
    id: `seren:${publisher.slug}`,
    slug: publisher.slug,
    name: publisher.resource_name || publisher.name,
    description: publisher.description,
    source: "seren" as SkillSource,
    sourceUrl: `${apiBase}/publishers/${publisher.slug}/skill.md`,
    tags,
    author: publisher.name,
  };
}

/**
 * Skills service for Seren Desktop.
 */
export const skills = {
  /**
   * Fetch the skills index from the aggregated endpoint.
   * Uses caching to reduce network requests.
   */
  async fetchIndex(): Promise<Skill[]> {
    try {
      // Check cache first
      const cached = localStorage.getItem(INDEX_CACHE_KEY);
      if (cached) {
        const { timestamp, data } = JSON.parse(cached);
        if (Date.now() - timestamp < INDEX_CACHE_DURATION) {
          log.info("[Skills] Using cached index");
          return (data as SkillIndexEntry[]).map(indexEntryToSkill);
        }
      }

      log.info("[Skills] Fetching skills index from", SKILLS_INDEX_URL);
      const response = await appFetch(SKILLS_INDEX_URL);

      if (!response.ok) {
        throw new Error(`Failed to fetch skills index: ${response.status}`);
      }

      const index: SkillsIndex = await response.json();

      // Cache the result
      localStorage.setItem(
        INDEX_CACHE_KEY,
        JSON.stringify({
          timestamp: Date.now(),
          data: index.skills,
        }),
      );

      log.info("[Skills] Fetched", index.skills.length, "skills from index");
      return index.skills.map(indexEntryToSkill);
    } catch (error) {
      log.error("[Skills] Error fetching index:", error);
      // Return cached data if available, even if expired
      const cached = localStorage.getItem(INDEX_CACHE_KEY);
      if (cached) {
        const { data } = JSON.parse(cached);
        return (data as SkillIndexEntry[]).map(indexEntryToSkill);
      }
      return [];
    }
  },

  /**
   * Fetch skills from Seren publishers.
   * Each publisher has a skill.md available at /publishers/{slug}/skill.md
   */
  async fetchPublisherSkills(): Promise<Skill[]> {
    try {
      // Check cache first
      const cached = localStorage.getItem(PUBLISHER_SKILLS_CACHE_KEY);
      if (cached) {
        const { timestamp, data } = JSON.parse(cached);
        if (Date.now() - timestamp < INDEX_CACHE_DURATION) {
          log.info("[Skills] Using cached publisher skills");
          return data as Skill[];
        }
      }

      log.info("[Skills] Fetching publisher skills from catalog");
      const publishers = await catalog.list();

      // Convert publishers to skills
      const skills = publishers
        .filter((p) => p.is_active)
        .map(publisherToSkill);

      // Cache the result
      localStorage.setItem(
        PUBLISHER_SKILLS_CACHE_KEY,
        JSON.stringify({
          timestamp: Date.now(),
          data: skills,
        }),
      );

      log.info("[Skills] Fetched", skills.length, "publisher skills");
      return skills;
    } catch (error) {
      log.error("[Skills] Error fetching publisher skills:", error);
      // Return cached data if available, even if expired
      const cached = localStorage.getItem(PUBLISHER_SKILLS_CACHE_KEY);
      if (cached) {
        const { data } = JSON.parse(cached);
        return data as Skill[];
      }
      return [];
    }
  },

  /**
   * Fetch all available skills (from index + publishers).
   */
  async fetchAllSkills(): Promise<Skill[]> {
    const [indexSkills, publisherSkills] = await Promise.all([
      this.fetchIndex(),
      this.fetchPublisherSkills(),
    ]);

    // Merge skills, with publisher skills taking precedence for duplicates
    const skillMap = new Map<string, Skill>();

    // Add index skills first
    for (const skill of indexSkills) {
      skillMap.set(skill.slug, skill);
    }

    // Publisher skills override index skills (they're more up-to-date)
    for (const skill of publisherSkills) {
      skillMap.set(skill.slug, skill);
    }

    return Array.from(skillMap.values());
  },

  /**
   * Get the Seren-scope skills directory.
   * Uses $XDG_CONFIG_HOME/seren/skills, fallback ~/.config/seren/skills.
   */
  async getSerenSkillsDir(): Promise<string> {
    if (!isTauriRuntime()) {
      return "~/.config/seren/skills";
    }
    return invoke<string>("get_seren_skills_dir");
  },

  /**
   * Get the Claude Code skills directory (~/.claude/skills/).
   */
  async getClaudeSkillsDir(): Promise<string> {
    if (!isTauriRuntime()) {
      return "~/.claude/skills";
    }
    return invoke<string>("get_claude_skills_dir");
  },

  /**
   * Get the project skills directory.
   */
  async getProjectSkillsDir(
    projectRoot: string | null,
  ): Promise<string | null> {
    if (!isTauriRuntime() || !projectRoot) {
      return null;
    }
    return invoke<string | null>("get_project_skills_dir", { projectRoot });
  },

  /**
   * Read `{project}/.seren/config.json`.
   */
  async readProjectConfig(
    projectRoot: string,
  ): Promise<ProjectSkillsConfig | null> {
    if (!isTauriRuntime()) return null;

    const raw = await invoke<string | null>("read_project_config", {
      projectRoot,
    });
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as ProjectSkillsConfig;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.version !== "number" ||
        !parsed.skills ||
        !Array.isArray(parsed.skills.enabled)
      ) {
        return null;
      }
      return {
        version: parsed.version,
        skills: {
          enabled: parsed.skills.enabled.filter((s) => typeof s === "string"),
        },
      };
    } catch {
      return null;
    }
  },

  /**
   * Write `{project}/.seren/config.json`.
   */
  async writeProjectConfig(
    projectRoot: string,
    config: ProjectSkillsConfig,
  ): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("write_project_config", {
      projectRoot,
      config: JSON.stringify(config),
    });
  },

  /**
   * Remove `{project}/.seren/config.json`.
   */
  async clearProjectConfig(projectRoot: string): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("clear_project_config", { projectRoot });
  },

  /**
   * Get thread-scoped skill refs for a project/thread pair.
   * Returns `null` when no override exists.
   */
  async getThreadSkills(
    projectRoot: string,
    threadId: string,
  ): Promise<string[] | null> {
    if (!isTauriRuntime()) return null;
    return invoke<string[] | null>("get_thread_skills", {
      projectRoot,
      threadId,
    });
  },

  /**
   * Replace thread-scoped skill refs for a project/thread pair.
   */
  async setThreadSkills(
    projectRoot: string,
    threadId: string,
    skillRefs: string[],
  ): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("set_thread_skills", {
      projectRoot,
      threadId,
      skillRefs,
    });
  },

  /**
   * Clear thread-scoped skill override for a project/thread pair.
   */
  async clearThreadSkills(
    projectRoot: string,
    threadId: string,
  ): Promise<void> {
    if (!isTauriRuntime()) return;
    await invoke("clear_thread_skills", {
      projectRoot,
      threadId,
    });
  },

  /**
   * List installed skills from a skills directory.
   */
  async listInstalled(
    skillsDir: string,
    scope: SkillScope,
  ): Promise<InstalledSkill[]> {
    if (!isTauriRuntime()) {
      return [];
    }

    try {
      const slugs = await invoke<string[]>("list_skill_dirs", { skillsDir });
      const installed: InstalledSkill[] = [];

      for (const slug of slugs) {
        const content = await invoke<string | null>("read_skill_content", {
          skillsDir,
          slug,
        });

        if (content) {
          const parsed = parseSkillMd(content);
          const hash = await computeContentHash(content);

          installed.push({
            id: `local:${slug}`,
            slug,
            name: parsed.metadata.name || slug,
            description: parsed.metadata.description || "",
            source: "local" as SkillSource,
            tags: parsed.metadata.tags || [],
            author: parsed.metadata.author,
            version: parsed.metadata.version,
            scope,
            path: getSkillPath(skillsDir, slug),
            installedAt: Date.now(), // We don't track this yet
            enabled: true, // All installed skills are enabled by default
            contentHash: hash,
          });
        }
      }

      return installed;
    } catch (error) {
      log.error("[Skills] Error listing installed skills:", error);
      return [];
    }
  },

  /**
   * List all installed skills (seren, claude, and project scopes).
   */
  async listAllInstalled(
    projectRoot: string | null,
  ): Promise<InstalledSkill[]> {
    const serenDir = await this.getSerenSkillsDir();
    const claudeDir = await this.getClaudeSkillsDir();
    const projectDir = await this.getProjectSkillsDir(projectRoot);

    const serenSkills = await this.listInstalled(serenDir, "seren");
    const claudeSkills = await this.listInstalled(claudeDir, "claude");
    const projectSkills = projectDir
      ? await this.listInstalled(projectDir, "project")
      : [];

    return [...serenSkills, ...claudeSkills, ...projectSkills];
  },

  /**
   * Fetch the full content of a skill from its source URL.
   */
  async fetchContent(skill: Skill): Promise<string | null> {
    if (!skill.sourceUrl) {
      log.warn("[Skills] No source URL for skill:", skill.id);
      return null;
    }

    try {
      log.info("[Skills] Fetching content from", skill.sourceUrl);
      const response = await appFetch(skill.sourceUrl);

      if (!response.ok) {
        throw new Error(`Failed to fetch skill content: ${response.status}`);
      }

      return await response.text();
    } catch (error) {
      log.error("[Skills] Error fetching content:", error);
      return null;
    }
  },

  /**
   * Install a skill to the specified scope.
   */
  async install(
    skill: Skill,
    content: string,
    scope: SkillScope,
    projectRoot: string | null,
  ): Promise<InstalledSkill> {
    if (!isTauriRuntime()) {
      throw new Error("Skills can only be installed in the desktop app");
    }

    let skillsDir: string | null;
    if (scope === "seren") {
      skillsDir = await this.getSerenSkillsDir();
    } else if (scope === "claude") {
      skillsDir = await this.getClaudeSkillsDir();
    } else {
      skillsDir = await this.getProjectSkillsDir(projectRoot);
    }

    if (!skillsDir) {
      throw new Error("No skills directory available for project scope");
    }

    const path = await invoke<string>("install_skill", {
      skillsDir,
      slug: skill.slug,
      content,
    });

    const hash = await computeContentHash(content);
    const parsed = parseSkillMd(content);

    log.info("[Skills] Installed skill:", skill.slug, "to", scope, "scope");

    return {
      ...skill,
      id: `local:${skill.slug}`,
      source: "local",
      scope,
      path,
      installedAt: Date.now(),
      enabled: true,
      contentHash: hash,
      // Override with parsed metadata in case it differs
      name: parsed.metadata.name || skill.name,
      description: parsed.metadata.description || skill.description,
      tags: parsed.metadata.tags || skill.tags,
      author: parsed.metadata.author || skill.author,
      version: parsed.metadata.version || skill.version,
    };
  },

  /**
   * Remove an installed skill.
   */
  async remove(skill: InstalledSkill): Promise<void> {
    if (!isTauriRuntime()) {
      throw new Error("Skills can only be removed in the desktop app");
    }

    // skill.path = ".../skills/my-skill/SKILL.md"
    // Strip "/my-skill/SKILL.md" to get the skills directory
    const skillsDir = skill.path.replace(/[/\\][^/\\]+[/\\]SKILL\.md$/, "");

    await invoke("remove_skill", {
      skillsDir,
      slug: skill.slug,
    });

    log.info("[Skills] Removed skill:", skill.slug);
  },

  /**
   * Read the content of an installed skill.
   */
  async readContent(skill: InstalledSkill): Promise<string | null> {
    if (!isTauriRuntime()) {
      return null;
    }

    const parentDir = skill.path.replace(/[/\\][^/\\]+[/\\]SKILL\.md$/, "");

    return invoke<string | null>("read_skill_content", {
      skillsDir: parentDir,
      slug: skill.slug,
    });
  },

  /**
   * Get content for enabled skills to inject into agent system prompt.
   */
  async getEnabledSkillsContent(
    installedSkills: InstalledSkill[],
  ): Promise<string> {
    const enabled = installedSkills.filter((s) => s.enabled);

    if (enabled.length === 0) {
      return "";
    }

    const contents: string[] = [];

    for (const skill of enabled) {
      const content = await this.readContent(skill);
      if (content) {
        const parsed = parseSkillMd(content);
        contents.push(`## Skill: ${skill.name}\n\n${parsed.content}`);
      }
    }

    if (contents.length === 0) {
      return "";
    }

    return `\n\n# Active Skills\n\n${contents.join("\n\n---\n\n")}`;
  },

  /**
   * Clear the skills index cache.
   */
  clearCache(): void {
    localStorage.removeItem(INDEX_CACHE_KEY);
    localStorage.removeItem(PUBLISHER_SKILLS_CACHE_KEY);
    log.info("[Skills] Cache cleared");
  },

  /**
   * Search skills by query.
   */
  search(skills: Skill[], query: string): Skill[] {
    const q = query.toLowerCase().trim();
    if (!q) return skills;

    return skills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(q) ||
        skill.description.toLowerCase().includes(q) ||
        skill.tags.some((tag) => tag.toLowerCase().includes(q)) ||
        skill.author?.toLowerCase().includes(q),
    );
  },

  /**
   * Filter skills by source.
   */
  filterBySource(skills: Skill[], source: SkillSource | null): Skill[] {
    if (!source) return skills;
    return skills.filter((skill) => skill.source === source);
  },

  /**
   * Filter skills by tag.
   */
  filterByTag(skills: Skill[], tag: string | null): Skill[] {
    if (!tag) return skills;
    return skills.filter((skill) =>
      skill.tags.some((t) => t.toLowerCase() === tag.toLowerCase()),
    );
  },

  /**
   * Get all unique tags from a list of skills.
   */
  getAllTags(skills: Skill[]): string[] {
    const tagSet = new Set<string>();
    for (const skill of skills) {
      for (const tag of skill.tags) {
        tagSet.add(tag.toLowerCase());
      }
    }
    return Array.from(tagSet).sort();
  },

  /**
   * Install bundled skills from app resources to ~/.config/seren/skills.
   * Only installs skills that don't already exist.
   * Returns the list of skill slugs that were installed.
   */
  async installBundledSkills(): Promise<string[]> {
    if (!isTauriRuntime()) return [];
    return invoke<string[]>("install_bundled_skills");
  },
};
