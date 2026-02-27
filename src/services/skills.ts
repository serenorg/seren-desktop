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
  resolveSkillDisplayName,
  resolveSkillSlug,
  type Skill,
  type SkillIndexEntry,
  type SkillScope,
  type SkillSource,
} from "@/lib/skills";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { catalog, type Publisher } from "./catalog";

const SKILLS_REPO_OWNER = "serenorg";
const SKILLS_REPO_NAME = "seren-skills";
const SKILLS_REPO_BRANCH = "main";
const SKILLS_INDEX_URL = `https://api.github.com/repos/${SKILLS_REPO_OWNER}/${SKILLS_REPO_NAME}/git/trees/${SKILLS_REPO_BRANCH}?recursive=1`;
const SKILLS_RAW_URL = `https://raw.githubusercontent.com/${SKILLS_REPO_OWNER}/${SKILLS_REPO_NAME}/${SKILLS_REPO_BRANCH}`;
const INDEX_CACHE_KEY = "seren:skills_index";
const PUBLISHER_SKILLS_CACHE_KEY = "seren:publisher_skills";
const INDEX_CACHE_DURATION = 1000 * 60 * 5; // 5 minutes
const MAX_STALE_CACHE_AGE = 1000 * 60 * 60; // 1 hour — don't serve cache older than this on error

interface GitHubTreeNode {
  path?: string;
  type?: string;
}

interface GitHubTreeResponse {
  tree?: GitHubTreeNode[];
}

interface ExtraFile {
  path: string;
  content: string;
}

export interface InstallResult {
  installed: InstalledSkill;
  missingFiles: string[];
}

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
 * Serialize a skill for index cache.
 */
function skillToIndexEntry(skill: Skill): SkillIndexEntry {
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    source: skill.source,
    sourceUrl: skill.sourceUrl ?? "",
    tags: skill.tags,
    author: skill.author,
    version: skill.version,
  };
}

/**
 * Convert a repo file path to org/skill-name.
 */
function parseRepoSkillPath(path: string): {
  org: string;
  skill: string;
} | null {
  const match = path.match(/^([^/]+)\/([^/]+)\/SKILL\.md$/);
  if (!match) return null;
  return { org: match[1], skill: match[2] };
}

/**
 * Fetch and parse a single remote SKILL.md from the skills repo.
 */
async function fetchSkillFromRepo(path: string): Promise<Skill | null> {
  const segments = path
    .split("/")
    .map((segment) => encodeURIComponent(segment));
  const sourceUrl = `${SKILLS_RAW_URL}/${segments.join("/")}`;
  const parsedPath = parseRepoSkillPath(path);
  if (!parsedPath) return null;

  const response = await appFetch(sourceUrl);
  if (!response.ok) {
    log.warn("[Skills] Failed to fetch repo skill", sourceUrl, response.status);
    return null;
  }

  const content = await response.text();
  const parsed = parseSkillMd(content);

  const slug = `${parsedPath.org}-${parsedPath.skill}`.toLowerCase();

  return {
    id: `serenorg:${slug}`,
    slug,
    name: resolveSkillDisplayName(parsed, slug),
    description: parsed.metadata.description || "Install this skill to add it.",
    source: "serenorg" as SkillSource,
    sourceUrl,
    tags: parsed.metadata.tags ?? [],
    author: parsed.metadata.author,
    version: parsed.metadata.version,
  };
}

/**
 * Cached GitHub tree from the most recent index fetch.
 * Used to discover sibling files when installing a skill.
 */
let cachedRepoTree: GitHubTreeNode[] | null = null;

/**
 * Fetch all available skills from GitHub repository tree.
 */
async function fetchSkillsFromRepoIndex(): Promise<Skill[]> {
  const response = await appFetch(SKILLS_INDEX_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch skills index: ${response.status}`);
  }

  const payload = (await response.json()) as GitHubTreeResponse;
  cachedRepoTree = payload.tree ?? [];

  const skillFiles = cachedRepoTree.filter(
    (node) =>
      node.type === "blob" &&
      typeof node.path === "string" &&
      parseRepoSkillPath(node.path),
  );

  const settled = await Promise.allSettled(
    skillFiles.map((entry) => {
      if (!entry.path) return Promise.resolve(null);
      return fetchSkillFromRepo(entry.path);
    }),
  );

  return settled
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter((skill): skill is Skill => skill !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Derive the GitHub skill directory prefix from a sourceUrl.
 * e.g. "https://raw.githubusercontent.com/.../curve/curve-gauge-yield-trader/SKILL.md"
 *   -> "curve/curve-gauge-yield-trader/"
 */
function deriveRepoDirPrefix(sourceUrl: string): string | null {
  const base = `${SKILLS_RAW_URL}/`;
  if (!sourceUrl.startsWith(base)) return null;
  const relative = sourceUrl.slice(base.length);
  const lastSlash = relative.lastIndexOf("/");
  if (lastSlash <= 0) return null;
  return relative.slice(0, lastSlash + 1);
}

/**
 * Fetch all payload files (excluding SKILL.md) from a skill's GitHub directory.
 * Uses the cached repo tree to discover files, then fetches their raw content.
 */
async function fetchRepoSkillPayloadFiles(
  sourceUrl: string,
): Promise<ExtraFile[]> {
  const dirPrefix = deriveRepoDirPrefix(sourceUrl);
  if (!dirPrefix) return [];

  // Re-fetch tree if not cached
  if (!cachedRepoTree) {
    try {
      const response = await appFetch(SKILLS_INDEX_URL, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (response.ok) {
        const payload = (await response.json()) as GitHubTreeResponse;
        cachedRepoTree = payload.tree ?? [];
      }
    } catch {
      log.warn("[Skills] Failed to fetch repo tree for payload files");
      return [];
    }
  }

  if (!cachedRepoTree) return [];

  // Find all blob files under the skill directory (excluding SKILL.md itself)
  const siblingFiles = cachedRepoTree.filter(
    (node) =>
      node.type === "blob" &&
      typeof node.path === "string" &&
      node.path.startsWith(dirPrefix) &&
      !node.path.endsWith("/SKILL.md"),
  );

  if (siblingFiles.length === 0) return [];

  log.info(
    "[Skills] Fetching",
    siblingFiles.length,
    "payload files for",
    dirPrefix,
  );

  const results = await Promise.allSettled(
    siblingFiles.map(async (node): Promise<ExtraFile | null> => {
      const filePath = node.path ?? "";
      const relativePath = filePath.slice(dirPrefix.length);
      const segments = filePath
        .split("/")
        .map((s) => encodeURIComponent(s));
      const rawUrl = `${SKILLS_RAW_URL}/${segments.join("/")}`;

      try {
        const resp = await appFetch(rawUrl);
        if (!resp.ok) {
          log.warn("[Skills] Failed to fetch payload file", rawUrl, resp.status);
          return null;
        }
        const content = await resp.text();
        return { path: relativePath, content };
      } catch (error) {
        log.warn("[Skills] Error fetching payload file", rawUrl, error);
        return null;
      }
    }),
  );

  return results
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((f): f is ExtraFile => f !== null);
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
   * Uses caching to reduce network requests. Pass skipCache to force a fresh fetch.
   */
  async fetchIndex(skipCache = false): Promise<Skill[]> {
    try {
      // Check cache first (unless explicitly bypassed)
      if (!skipCache) {
        const cached = localStorage.getItem(INDEX_CACHE_KEY);
        if (cached) {
          const { timestamp, data } = JSON.parse(cached);
          if (Date.now() - timestamp < INDEX_CACHE_DURATION) {
            log.info("[Skills] Using cached index");
            return (data as SkillIndexEntry[]).map(indexEntryToSkill);
          }
        }
      }

      log.info("[Skills] Fetching skills index from", SKILLS_INDEX_URL);
      const skills = await fetchSkillsFromRepoIndex();

      // Cache the result
      localStorage.setItem(
        INDEX_CACHE_KEY,
        JSON.stringify({
          timestamp: Date.now(),
          data: skills.map(skillToIndexEntry),
        }),
      );

      log.info("[Skills] Fetched", skills.length, "skills from repo");
      return skills;
    } catch (error) {
      log.error("[Skills] Error fetching index:", error);
      const cached = localStorage.getItem(INDEX_CACHE_KEY);
      if (cached) {
        const { timestamp, data } = JSON.parse(cached);
        const ageMs = Date.now() - timestamp;
        if (ageMs < MAX_STALE_CACHE_AGE) {
          log.warn("[Skills] Serving stale index cache, age:", Math.round(ageMs / 1000), "s");
          return (data as SkillIndexEntry[]).map(indexEntryToSkill);
        }
        log.error("[Skills] Stale cache too old to serve:", Math.round(ageMs / 1000), "s");
      }
      return [];
    }
  },

  /**
   * Fetch skills from Seren publishers.
   * Each publisher has a skill.md available at /publishers/{slug}/skill.md
   */
  async fetchPublisherSkills(skipCache = false): Promise<Skill[]> {
    try {
      // Check cache first (unless explicitly bypassed)
      if (!skipCache) {
        const cached = localStorage.getItem(PUBLISHER_SKILLS_CACHE_KEY);
        if (cached) {
          const { timestamp, data } = JSON.parse(cached);
          if (Date.now() - timestamp < INDEX_CACHE_DURATION) {
            log.info("[Skills] Using cached publisher skills");
            return data as Skill[];
          }
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
      const cached = localStorage.getItem(PUBLISHER_SKILLS_CACHE_KEY);
      if (cached) {
        const { timestamp, data } = JSON.parse(cached);
        const ageMs = Date.now() - timestamp;
        if (ageMs < MAX_STALE_CACHE_AGE) {
          log.warn("[Skills] Serving stale publisher skills cache, age:", Math.round(ageMs / 1000), "s");
          return data as Skill[];
        }
        log.error("[Skills] Stale publisher skills cache too old to serve:", Math.round(ageMs / 1000), "s");
      }
      return [];
    }
  },

  /**
   * Fetch all available skills (from index + publishers).
   */
  async fetchAllSkills(skipCache = false): Promise<Skill[]> {
    const [indexSkills, publisherSkills] = await Promise.all([
      this.fetchIndex(skipCache),
      this.fetchPublisherSkills(skipCache),
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

      for (const dirName of slugs) {
        const [content, resolvedPath] = await Promise.all([
          invoke<string | null>("read_skill_content", {
            skillsDir,
            slug: dirName,
          }),
          invoke<string | null>("resolve_skill_path", {
            skillsDir,
            slug: dirName,
          }),
        ]);

        if (content) {
          const parsed = parseSkillMd(content);
          const hash = await computeContentHash(content);
          const slug = resolveSkillSlug(parsed, dirName);

          installed.push({
            id: `local:${slug}`,
            slug,
            name: resolveSkillDisplayName(parsed, slug),
            description: parsed.metadata.description || "",
            source: "local" as SkillSource,
            tags: [],

            scope,
            skillsDir,
            dirName,
            path: resolvedPath || getSkillPath(skillsDir, dirName),
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
   * For serenorg skills, fetches payload files (scripts, configs) alongside SKILL.md.
   * Returns the installed skill along with any missing file warnings.
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

    // Fetch payload files for serenorg skills from the GitHub repo
    let extraFilesJson: string | undefined;
    if (skill.source === "serenorg" && skill.sourceUrl) {
      try {
        const extraFiles = await fetchRepoSkillPayloadFiles(skill.sourceUrl);
        if (extraFiles.length > 0) {
          extraFilesJson = JSON.stringify(extraFiles);
          log.info(
            "[Skills] Fetched",
            extraFiles.length,
            "payload files for",
            skill.slug,
          );
        }
      } catch (error) {
        log.warn("[Skills] Failed to fetch payload files:", error);
      }
    }

    const path = await invoke<string>("install_skill", {
      skillsDir,
      slug: skill.slug,
      content,
      extraFiles: extraFilesJson ?? null,
    });

    const hash = await computeContentHash(content);
    const parsed = parseSkillMd(content);

    log.info("[Skills] Installed skill:", skill.slug, "to", scope, "scope");

    // Validate payload after install
    try {
      const missingFiles = await invoke<string[]>("validate_skill_payload", {
        skillsDir,
        slug: skill.slug,
      });
      if (missingFiles.length > 0) {
        log.warn(
          "[Skills] Skill",
          skill.slug,
          "is missing referenced files:",
          missingFiles,
        );
      }
    } catch (error) {
      log.warn("[Skills] Payload validation failed:", error);
    }

    return {
      ...skill,
      id: `local:${skill.slug}`,
      source: "local",
      scope,
      skillsDir,
      dirName: skill.slug,
      path,
      installedAt: Date.now(),
      enabled: true,
      contentHash: hash,
      // Override with parsed metadata in case it differs
      name: resolveSkillDisplayName(parsed, skill.slug),
      description: parsed.metadata.description || skill.description,
      tags: skill.tags,
      author: skill.author,
      version: skill.version,
    };
  },

  /**
   * Validate an installed skill's payload files.
   * Returns a list of file paths referenced in SKILL.md but missing from disk.
   */
  async validatePayload(
    skillsDir: string,
    slug: string,
  ): Promise<string[]> {
    if (!isTauriRuntime()) return [];
    try {
      return await invoke<string[]>("validate_skill_payload", {
        skillsDir,
        slug,
      });
    } catch (error) {
      log.warn("[Skills] Payload validation error:", error);
      return [];
    }
  },

  /**
   * Remove an installed skill.
   */
  async remove(skill: InstalledSkill): Promise<void> {
    if (!isTauriRuntime()) {
      throw new Error("Skills can only be removed in the desktop app");
    }

    const skillsDir =
      skill.skillsDir || skill.path.replace(/[/\\][^/\\]+[/\\]SKILL\.md$/, "");

    await invoke("remove_skill", {
      skillsDir,
      slug: skill.dirName,
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

    return invoke<string | null>("read_skill_content", {
      skillsDir: skill.skillsDir,
      slug: skill.dirName,
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
        skill.slug.toLowerCase().includes(q) ||
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
};
