// ABOUTME: Skills service for managing skill discovery, installation, and content.
// ABOUTME: Handles fetching from Seren Skills, local skills, and sync state.

import { invoke } from "@tauri-apps/api/core";
import {
  downloadSkill,
  listSkills,
  type SkillBundle,
  type SkillBundleFile,
  type SkillSummary,
} from "@/api/seren-skills";
import { log } from "@/lib/logger";
import {
  computeContentHash,
  getSkillPath,
  humanizeSkillName,
  type InstalledSkill,
  parseSkillMd,
  type RemoteSkillRevision,
  resolveSkillDisplayName,
  resolveSkillSlug,
  type Skill,
  type SkillScope,
  type SkillSource,
  type SkillSyncState,
  type SkillSyncStatus,
} from "@/lib/skills";
import { isTauriRuntime } from "@/lib/tauri-bridge";

const LEGACY_INDEX_CACHE_KEY = "seren:skills_index";
const INDEX_CACHE_KEY = "seren:skills_index:v2";
const INDEX_CACHE_DURATION = 1000 * 60 * 5; // 5 minutes
const MAX_STALE_CACHE_AGE = 1000 * 60 * 60; // 1 hour

interface ExtraFile {
  path: string;
  content: string;
}

interface UpstreamSkillBundle {
  skillMd: string;
  payloadFiles: ExtraFile[];
  remoteRevision: RemoteSkillRevision | null;
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
 *
 * The catalog index `name` is often a slug-style directory basename
 * (e.g. `backtester`, `grid-trader`) when the upstream SKILL.md does
 * not provide a `display-name` in its frontmatter. Humanize the name
 * here so the UI never renders raw slugs even when the catalog or a
 * specific SKILL.md is missing display metadata.
 */
function skillSummaryToSkill(summary: SkillSummary): Skill {
  return {
    id: `seren:${summary.slug}`,
    slug: summary.slug,
    name: humanizeSkillName(summary.name, summary.slug),
    description: summary.description,
    source: "seren",
    sourceUrl: `seren-skills:${summary.slug}`,
    tags: [summary.visibility, summary.discoverability, summary.status].filter(
      Boolean,
    ),
    version: summary.current_version ?? undefined,
    lastModified: summary.updated_at,
  };
}

/**
 * Serialize a skill for index cache.
 */
function skillToCacheEntry(skill: Skill): Skill {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    source: skill.source,
    sourceUrl: skill.sourceUrl ?? "",
    tags: skill.tags,
    author: skill.author,
    version: skill.version,
    lastModified: skill.lastModified,
  };
}

function remoteRevisionFromBundle(bundle: SkillBundle): RemoteSkillRevision {
  return {
    sha: bundle.content_hash,
    shortSha: bundle.content_hash.slice(0, 10),
    committedAt: bundle.skill.updated_at,
    message: bundle.version,
    url: undefined,
    changedFiles: (bundle.files ?? []).map((file) => file.path),
  };
}

function decodeBase64Text(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function bundleFilesToExtraFiles(files: SkillBundleFile[] = []): ExtraFile[] {
  return files.map((file) => ({
    path: file.path,
    content: decodeBase64Text(file.content_b64),
  }));
}

interface SkillsCatalogResponsePage {
  skills: SkillSummary[];
  total: number;
}

export interface SkillsCatalogPage {
  skills: Skill[];
  total: number;
  offset: number;
  nextOffset: number | null;
}

function objectKeys(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const keys = Object.keys(value).slice(0, 5);
  return keys.length > 0 ? `: ${keys.join(", ")}` : "";
}

function normalizeSkillsCatalogPage(
  value: unknown,
): SkillsCatalogResponsePage | null {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();

  while (queue.length > 0 && seen.size < 25) {
    const candidate = queue.shift();
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    const page = candidate as {
      body?: unknown;
      data?: unknown;
      result?: unknown;
      skills?: unknown;
      total?: unknown;
    };

    if (Array.isArray(page.skills)) {
      return {
        skills: page.skills as SkillSummary[],
        total: typeof page.total === "number" ? page.total : page.skills.length,
      };
    }

    for (const nested of [page.data, page.result, page.body]) {
      if (nested && typeof nested === "object") {
        queue.push(nested);
      }
    }
  }

  return null;
}

async function downloadSkillBundle(slug: string): Promise<SkillBundle> {
  const { data, error, response } = await downloadSkill({
    path: { slug },
    throwOnError: false,
  });
  if (error || !data) {
    const status = response ? `: ${response.status}` : "";
    throw new Error(`Failed to download skill ${slug}${status}`);
  }
  return data;
}

async function fetchSerenSkillsPage(
  limit: number,
  offset: number,
  query?: string,
): Promise<SkillsCatalogPage> {
  const { data, error, response } = await listSkills({
    query: { limit, offset, q: query?.trim() || undefined },
    throwOnError: false,
  });
  if (error || !data) {
    const status = response ? `: ${response.status}` : "";
    throw new Error(`Failed to list seren-skills catalog${status}`);
  }

  const page = normalizeSkillsCatalogPage(data);
  if (!page) {
    throw new Error(
      `Unexpected seren-skills catalog response${objectKeys(data)}`,
    );
  }

  if (page.skills.length === 0 && offset < page.total) {
    log.warn(
      "[Skills] Seren Skills catalog returned an empty page before total was reached",
      { offset, total: page.total },
    );
  }

  const nextOffset = offset + page.skills.length;
  return {
    skills: page.skills.map(skillSummaryToSkill),
    total: page.total,
    offset,
    nextOffset:
      page.skills.length > 0 && nextOffset < page.total ? nextOffset : null,
  };
}

async function fetchSerenSkills(skipCache = false): Promise<Skill[]> {
  if (!skipCache) {
    const cached = localStorage.getItem(INDEX_CACHE_KEY);
    if (cached) {
      const { timestamp, data } = JSON.parse(cached);
      if (Date.now() - timestamp < INDEX_CACHE_DURATION) {
        log.info("[Skills] Using cached seren-skills catalog");
        return data as Skill[];
      }
    }
  }

  const pageSize = 100;
  let offset = 0;
  let total: number | null = null;
  const all: Skill[] = [];

  do {
    const page = await fetchSerenSkillsPage(pageSize, offset);
    if (page.skills.length === 0) {
      break;
    }
    all.push(...page.skills);
    total = page.total;
    offset = page.nextOffset ?? page.total;
  } while (total !== null && offset < total && offset > 0);

  const skills = all;
  if (skills.length > 0) {
    localStorage.setItem(
      INDEX_CACHE_KEY,
      JSON.stringify({
        timestamp: Date.now(),
        data: skills.map(skillToCacheEntry),
      }),
    );
  }
  log.info("[Skills] Fetched", skills.length, "skills from seren-skills");
  return skills;
}

function buildManagedFileMap(
  skillMdHash: string,
  payloadFiles: Array<{ path: string; content: string; hash?: string }>,
): Record<string, string> {
  const managedFiles: Record<string, string> = {
    "SKILL.md": skillMdHash,
  };

  for (const file of payloadFiles) {
    if (file.hash) {
      managedFiles[file.path] = file.hash;
    }
  }

  return managedFiles;
}

function localManagedStateFingerprint(
  localManagedState: Record<string, string | null>,
): string {
  return Object.entries(localManagedState)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, hash]) => `${path}:${hash ?? "missing"}`)
    .join("\n");
}

function skillSlugFromSourceUrl(sourceUrl: string): string | null {
  if (sourceUrl.startsWith("seren-skills:")) {
    const slug = sourceUrl.slice("seren-skills:".length).trim();
    return slug || null;
  }

  const legacyRawMatch = sourceUrl.match(
    /^https:\/\/raw\.githubusercontent\.com\/serenorg\/seren-skills\/[^/]+\/(.+)\/SKILL\.md(?:\?.*)?$/,
  );
  if (legacyRawMatch?.[1]) {
    const segments = legacyRawMatch[1].split("/").filter(Boolean);
    return segments[segments.length - 1] ?? null;
  }

  const match = sourceUrl.match(
    /\/publishers\/seren-skills\/skills\/([^/]+)(?:\/download)?$/,
  );
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function skillSourceUrlFromSlug(slug: string): string {
  return `seren-skills:${slug}`;
}

function isSerenUpstreamSource(value: string | undefined): boolean {
  return (
    value === "seren" ||
    value === "serenorg" ||
    value === "serenorg/seren-skills"
  );
}

function normalizeSyncSource(
  upstreamSource: string,
  upstreamSourceUrl: string,
): { upstreamSource: "seren"; upstreamSourceUrl: string } | null {
  if (!isSerenUpstreamSource(upstreamSource)) return null;

  const slug = skillSlugFromSourceUrl(upstreamSourceUrl);
  if (!slug) return null;

  return {
    upstreamSource: "seren",
    upstreamSourceUrl: skillSourceUrlFromSlug(slug),
  };
}

async function fetchRemoteSkillRevision(
  sourceUrl: string,
): Promise<RemoteSkillRevision | null> {
  const slug = skillSlugFromSourceUrl(sourceUrl);
  if (!slug) return null;
  return remoteRevisionFromBundle(await downloadSkillBundle(slug));
}

async function fetchUpstreamSkillBundle(skill: {
  sourceUrl?: string;
  slug?: string;
}): Promise<UpstreamSkillBundle | null> {
  const slug =
    skill.slug ??
    (skill.sourceUrl ? skillSlugFromSourceUrl(skill.sourceUrl) : null);
  if (!slug) return null;
  const bundle = await downloadSkillBundle(slug);
  return {
    skillMd: bundle.skill_md,
    payloadFiles: bundleFilesToExtraFiles(bundle.files),
    remoteRevision: remoteRevisionFromBundle(bundle),
  };
}

async function computeUpstreamSyncState(
  upstreamSource: SkillSource,
  upstreamSourceUrl: string,
  remoteRevision: RemoteSkillRevision | null,
  skillMd: string,
  payloadFiles: ExtraFile[],
): Promise<SkillSyncState> {
  const skillMdHash = await computeContentHash(skillMd);
  const payloadWithHashes = await Promise.all(
    payloadFiles.map(async (file) => ({
      path: file.path,
      content: file.content,
      hash: await computeContentHash(file.content),
    })),
  );

  return {
    version: 1,
    upstreamSource,
    upstreamSourceUrl,
    syncedRevision: remoteRevision?.sha ?? null,
    syncedAt: Date.now(),
    managedFiles: buildManagedFileMap(skillMdHash, payloadWithHashes),
  };
}

function isManagedFileMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return Object.entries(value).every(
    ([path, hash]) => typeof path === "string" && typeof hash === "string",
  );
}

function parseInstalledSyncState(
  raw: string,
  dirName: string,
): SkillSyncState | null {
  try {
    const parsedSyncState = JSON.parse(raw) as Partial<SkillSyncState>;
    const normalizedSyncedRevision =
      parsedSyncState.syncedRevision === undefined
        ? null
        : parsedSyncState.syncedRevision;
    if (
      parsedSyncState?.version !== 1 ||
      typeof parsedSyncState.upstreamSource !== "string" ||
      typeof parsedSyncState.upstreamSourceUrl !== "string" ||
      parsedSyncState.upstreamSourceUrl.length === 0 ||
      (normalizedSyncedRevision !== null &&
        typeof normalizedSyncedRevision !== "string") ||
      typeof parsedSyncState.syncedAt !== "number" ||
      !isManagedFileMap(parsedSyncState.managedFiles)
    ) {
      return null;
    }

    const normalizedSource = normalizeSyncSource(
      parsedSyncState.upstreamSource,
      parsedSyncState.upstreamSourceUrl,
    );
    if (!normalizedSource) return null;

    return {
      ...parsedSyncState,
      ...normalizedSource,
      syncedRevision: normalizedSyncedRevision,
    } as SkillSyncState;
  } catch (error) {
    log.warn("[Skills] Failed to parse sync state for", dirName, error);
    return null;
  }
}

export function isUpstreamManagedSkill(
  skill: InstalledSkill,
): skill is InstalledSkill & {
  syncState: SkillSyncState;
  upstreamSource: "seren";
  upstreamSourceUrl: string;
} {
  const upstreamSource = skill.upstreamSource as string | undefined;
  return (
    !!skill.syncState &&
    isSerenUpstreamSource(upstreamSource) &&
    typeof skill.upstreamSourceUrl === "string" &&
    skill.upstreamSourceUrl.length > 0 &&
    skillSlugFromSourceUrl(skill.upstreamSourceUrl) !== null
  );
}

/**
 * Skills service for Seren Desktop.
 */
export const skills = {
  /**
   * Fetch the skills index from Seren Skills.
   * Uses caching to reduce network requests. Pass skipCache to force a fresh fetch.
   */
  async fetchIndex(skipCache = false): Promise<Skill[]> {
    try {
      return await fetchSerenSkills(skipCache);
    } catch (error) {
      log.error("[Skills] Error fetching index:", error);
      const cached = localStorage.getItem(INDEX_CACHE_KEY);
      if (cached) {
        const { timestamp, data } = JSON.parse(cached);
        const ageMs = Date.now() - timestamp;
        if (ageMs < MAX_STALE_CACHE_AGE) {
          log.warn(
            "[Skills] Serving stale index cache, age:",
            Math.round(ageMs / 1000),
            "s",
          );
          return data as Skill[];
        }
        log.error(
          "[Skills] Stale cache too old to serve:",
          Math.round(ageMs / 1000),
          "s",
        );
      }
      throw error instanceof Error
        ? error
        : new Error("Failed to load seren-skills catalog");
    }
  },

  /**
   * Fetch all available skills.
   */
  async fetchAllSkills(skipCache = false): Promise<Skill[]> {
    return this.fetchIndex(skipCache);
  },

  async fetchCatalogPage(
    limit: number,
    offset: number,
    query?: string,
  ): Promise<SkillsCatalogPage> {
    return fetchSerenSkillsPage(limit, offset, query);
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
        const [content, resolvedPath, syncStateRaw] = await Promise.all([
          invoke<string | null>("read_skill_content", {
            skillsDir,
            slug: dirName,
          }),
          invoke<string | null>("resolve_skill_path", {
            skillsDir,
            slug: dirName,
          }),
          invoke<string | null>("read_skill_sync_state", {
            skillsDir,
            slug: dirName,
          }),
        ]);

        if (content) {
          const parsed = parseSkillMd(content);
          const hash = await computeContentHash(content);
          const slug = resolveSkillSlug(parsed, dirName);
          const syncState = syncStateRaw
            ? parseInstalledSyncState(syncStateRaw, dirName)
            : null;

          installed.push({
            id: `local:${slug}`,
            slug,
            name: resolveSkillDisplayName(parsed, slug),
            displayName: parsed.metadata.displayName,
            description: parsed.metadata.description || "",
            source: "local" as SkillSource,
            tags: [],
            excludeHosts: parsed.metadata.excludeHosts,
            scope,
            skillsDir,
            dirName,
            path: resolvedPath || getSkillPath(skillsDir, dirName),
            installedAt: Date.now(), // We don't track this yet
            enabled: true, // All installed skills are enabled by default
            contentHash: hash,
            upstreamSource: syncState?.upstreamSource,
            upstreamSourceUrl: syncState?.upstreamSourceUrl,
            syncState,
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
   * Fetch the full SKILL.md content for a remote skill.
   */
  async fetchContent(skill: Skill): Promise<string | null> {
    const slug = skill.sourceUrl
      ? skillSlugFromSourceUrl(skill.sourceUrl)
      : null;
    if (!slug) {
      log.warn("[Skills] No source URL for skill:", skill.id);
      return null;
    }

    try {
      log.info("[Skills] Fetching content for", slug);
      return (await downloadSkillBundle(slug)).skill_md;
    } catch (error) {
      log.error("[Skills] Error fetching content:", error);
      return null;
    }
  },

  /**
   * Install a skill to the specified scope.
   * Seren Skills installs use the API bundle as the source of truth.
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

    let installContent = content;
    let extraFiles: ExtraFile[] = [];
    let extraFilesJson: string | undefined;
    let syncState: SkillSyncState | null = null;
    if (skill.source === "seren" && skill.sourceUrl) {
      const bundle = await fetchUpstreamSkillBundle(skill);
      if (!bundle) {
        throw new Error("Unable to fetch upstream skill content");
      }
      installContent = bundle.skillMd;
      extraFiles = bundle.payloadFiles;
      if (extraFiles.length > 0) {
        extraFilesJson = JSON.stringify(extraFiles);
        log.info(
          "[Skills] Fetched",
          extraFiles.length,
          "payload files for",
          skill.slug,
        );
      }
      syncState = await computeUpstreamSyncState(
        skill.source,
        skill.sourceUrl,
        bundle.remoteRevision,
        installContent,
        extraFiles,
      );
    }

    const path = await invoke<string>("install_skill", {
      skillsDir,
      slug: skill.slug,
      content: installContent,
      extraFiles: extraFilesJson ?? null,
      syncStateJson: syncState ? JSON.stringify(syncState) : null,
    });

    const hash = await computeContentHash(installContent);
    const parsed = parseSkillMd(installContent);

    log.info("[Skills] Installed skill:", skill.slug, "to", scope, "scope");

    // Validate payload after install
    try {
      const missingFiles = await invoke<string[]>("validate_skill_payload", {
        skillsDir,
        slug: skill.slug,
      });
      if (missingFiles.length > 0) {
        // These are user-provisioned files (requirements.txt, config.json, etc.)
        // referenced in the SKILL.md but not included in the marketplace payload.
        // Demote to debug — absence is expected and not an install failure.
        log.debug(
          "[Skills] Skill",
          skill.slug,
          "references files not present in payload (user must provision):",
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
      upstreamSource: syncState?.upstreamSource,
      upstreamSourceUrl: syncState?.upstreamSourceUrl ?? skill.sourceUrl,
      syncState,
      // Override with parsed metadata in case it differs
      name: resolveSkillDisplayName(parsed, skill.slug),
      displayName: parsed.metadata.displayName,
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
  async validatePayload(skillsDir: string, slug: string): Promise<string[]> {
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
   * Rename a skill directory when the resolved slug no longer matches the
   * filesystem directory name. Returns the new SKILL.md path.
   */
  async renameSkillDir(
    skill: InstalledSkill,
    newDirName: string,
  ): Promise<string> {
    return invoke<string>("rename_skill_dir", {
      skillsDir: skill.skillsDir,
      oldDirName: skill.dirName,
      newDirName,
    });
  },

  /**
   * Read a relative file from an installed skill directory.
   */
  async readFile(
    skill: InstalledSkill,
    relativePath: string,
  ): Promise<string | null> {
    if (!isTauriRuntime()) {
      return null;
    }

    return invoke<string | null>("read_skill_file", {
      skillsDir: skill.skillsDir,
      slug: skill.dirName,
      relativePath,
    });
  },

  /**
   * Determine the sync status for an upstream-managed installed skill.
   */
  async inspectSyncStatus(
    skill: InstalledSkill,
  ): Promise<SkillSyncStatus | null> {
    if (!isUpstreamManagedSkill(skill)) {
      return null;
    }

    try {
      const changedLocalFiles: string[] = [];
      const localManagedState: Record<string, string | null> = {};
      const missingManagedFiles: string[] = [];
      const managedPaths = Object.keys(skill.syncState?.managedFiles ?? {});

      if (skill.syncState) {
        const results = await Promise.all(
          managedPaths.map(async (path) => {
            const content =
              path === "SKILL.md"
                ? await this.readContent(skill)
                : await this.readFile(skill, path);
            return { path, content };
          }),
        );

        for (const { path, content } of results) {
          if (content === null) {
            localManagedState[path] = null;
            missingManagedFiles.push(path);
            continue;
          }

          const contentHash = await computeContentHash(content);
          localManagedState[path] = contentHash;
          if (contentHash !== skill.syncState.managedFiles[path]) {
            changedLocalFiles.push(path);
          }
        }
      }

      const remoteRevision = await fetchRemoteSkillRevision(
        skill.upstreamSourceUrl,
      );
      const syncedRevision = skill.syncState?.syncedRevision ?? null;
      const updateAvailable = Boolean(
        remoteRevision?.sha &&
          syncedRevision &&
          remoteRevision.sha !== syncedRevision,
      );
      const hasLocalChanges =
        changedLocalFiles.length > 0 || missingManagedFiles.length > 0;
      const bootstrapRequired = Boolean(
        remoteRevision?.sha &&
          syncedRevision === null &&
          !hasLocalChanges &&
          managedPaths.length > 0,
      );

      return {
        state: hasLocalChanges
          ? "local-changes"
          : bootstrapRequired
            ? "bootstrap-required"
            : updateAvailable
              ? "update-available"
              : "current",
        updateAvailable,
        hasLocalChanges,
        syncedRevision,
        remoteRevision,
        changedLocalFiles,
        localManagedState,
        missingManagedFiles,
      };
    } catch (error) {
      return {
        state: "error",
        updateAvailable: false,
        hasLocalChanges: false,
        syncedRevision: skill.syncState?.syncedRevision ?? null,
        remoteRevision: null,
        changedLocalFiles: [],
        localManagedState: {},
        missingManagedFiles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  /**
   * Refresh an installed upstream-managed skill from its canonical source.
   */
  async refreshInstalledSkill(
    skill: InstalledSkill,
    options?: {
      expectedLocalManagedState?: Record<string, string | null>;
    },
  ): Promise<{
    installed: InstalledSkill;
    syncStatus: SkillSyncStatus | null;
  }> {
    if (!isUpstreamManagedSkill(skill)) {
      throw new Error("Skill is not managed by an upstream source");
    }

    const bundle = await fetchUpstreamSkillBundle({
      sourceUrl: skill.upstreamSourceUrl,
    });
    if (!bundle) {
      throw new Error("Unable to fetch upstream skill content");
    }

    if (options?.expectedLocalManagedState) {
      // Re-verify the last approved local snapshot immediately before invoking the
      // Rust install path. A tiny race remains between this check and the final
      // filesystem rename, but it is limited to the local hashing + sync-state prep
      // work in this method rather than the full upstream fetch sequence.
      const latestStatus = await this.inspectSyncStatus(skill);
      if (!latestStatus || latestStatus.state === "error") {
        throw new Error(
          `Seren could not re-verify ${skill.name} immediately before refresh.`,
        );
      }
      if (
        localManagedStateFingerprint(latestStatus.localManagedState) !==
        localManagedStateFingerprint(options.expectedLocalManagedState)
      ) {
        throw new Error(
          `${skill.name} changed after the overwrite check. Review the latest local edits and retry refresh.`,
        );
      }
    }

    const syncState = await computeUpstreamSyncState(
      "seren",
      skillSourceUrlFromSlug(
        skillSlugFromSourceUrl(skill.upstreamSourceUrl) ?? skill.slug,
      ),
      bundle.remoteRevision,
      bundle.skillMd,
      bundle.payloadFiles,
    );

    await invoke("install_skill", {
      skillsDir: skill.skillsDir,
      slug: skill.dirName,
      content: bundle.skillMd,
      extraFiles: JSON.stringify(bundle.payloadFiles),
      syncStateJson: JSON.stringify(syncState),
    });

    const hash = await computeContentHash(bundle.skillMd);
    const parsed = parseSkillMd(bundle.skillMd);
    const refreshed: InstalledSkill = {
      ...skill,
      name: resolveSkillDisplayName(parsed, skill.slug),
      displayName: parsed.metadata.displayName,
      description: parsed.metadata.description || skill.description,
      contentHash: hash,
      upstreamSource: syncState.upstreamSource,
      upstreamSourceUrl: syncState.upstreamSourceUrl,
      syncState,
    };

    return {
      installed: refreshed,
      syncStatus: await this.inspectSyncStatus(refreshed),
    };
  },

  /**
   * Get content for enabled skills to inject into agent system prompt.
   * Injects the absolute runtime path so the agent doesn't need to search.
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
        const runtimeDir = `${skill.skillsDir}/${skill.dirName}`;
        const hasIncludes =
          parsed.metadata.includes && parsed.metadata.includes.length > 0;
        const depsNote = hasIncludes
          ? `\n> **Shared dependencies:** \`${runtimeDir}/_deps/\` contains shared files from declared \`includes\` paths.\n`
          : "";
        const runtimeNote = `> **Skill runtime directory:** \`${runtimeDir}\`\n> Use this absolute path to reference skill files. Do not create local copies or fallback scaffolds.${depsNote}\n\n`;
        contents.push(
          `## Skill: ${skill.name}\n\n${runtimeNote}${parsed.content}`,
        );
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
    localStorage.removeItem(LEGACY_INDEX_CACHE_KEY);
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

  /**
   * Backfill sync state for installed skills that were installed before the
   * sync feature existed (pre-v2.3.16). Matches installed skills missing
   * sync state to available Seren Skills by slug, then writes a minimal
   * .seren-sync.json so the upstream refresh flow can detect updates.
   */
  async backfillSyncState(
    installed: InstalledSkill[],
    available: Skill[],
  ): Promise<number> {
    if (!isTauriRuntime()) return 0;

    const remoteSkillsBySlug = new Map<string, Skill>();
    for (const skill of available) {
      if (skill.source === "seren" && skill.sourceUrl) {
        remoteSkillsBySlug.set(skill.slug, skill);
      }
    }

    let backfilled = 0;

    for (const skill of installed) {
      // Skip skills that already have sync state
      if (skill.syncState) continue;

      // Try matching by slug first, then fall back to dirName (which always
      // equals the marketplace slug even when resolveSkillSlug() derives a
      // different slug from SKILL.md frontmatter name).
      const match =
        remoteSkillsBySlug.get(skill.slug) ??
        remoteSkillsBySlug.get(skill.dirName);
      if (!match?.sourceUrl) {
        continue;
      }

      // Read current content to compute managed file hash
      const content = await this.readContent(skill);
      if (!content) continue;

      const contentHash = await computeContentHash(content);
      const syncState: SkillSyncState = {
        version: 1,
        upstreamSource: "seren",
        upstreamSourceUrl: match.sourceUrl,
        syncedRevision: null,
        syncedAt: Date.now(),
        managedFiles: { "SKILL.md": contentHash },
      };

      try {
        await invoke("write_skill_sync_state", {
          skillsDir: skill.skillsDir,
          slug: skill.dirName,
          stateJson: JSON.stringify(syncState),
        });
        backfilled++;
        log.info(
          "[Skills] Backfilled sync state for",
          skill.slug,
          "→",
          match.sourceUrl,
        );
      } catch (err) {
        log.warn("[Skills] Failed to backfill sync state for", skill.slug, err);
      }
    }

    return backfilled;
  },
};
