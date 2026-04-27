// ABOUTME: Skills service for managing skill discovery, installation, and content.
// ABOUTME: Handles fetching from index, local skills, and Seren publishers.

import { invoke } from "@tauri-apps/api/core";
import { apiBase } from "@/lib/config";
import { appFetch } from "@/lib/fetch";
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
  type SkillIndexEntry,
  type SkillScope,
  type SkillSource,
  type SkillSyncState,
  type SkillSyncStatus,
} from "@/lib/skills";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { catalog, type Publisher } from "./catalog";

const SKILLS_REPO_OWNER = "serenorg";
const SKILLS_REPO_NAME = "seren-skills";
const SKILLS_REPO_BRANCH = "main";
const SKILLS_R2_INDEX_URL =
  "https://pub-714fe894394345a0a8a102fbac2b208f.r2.dev/skills/index.json";
const SKILLS_RAW_URL = `https://raw.githubusercontent.com/${SKILLS_REPO_OWNER}/${SKILLS_REPO_NAME}/${SKILLS_REPO_BRANCH}`;
const INDEX_CACHE_KEY = "seren:skills_index";
const PUBLISHER_SKILLS_CACHE_KEY = "seren:publisher_skills";
const INDEX_CACHE_DURATION = 1000 * 60 * 5; // 5 minutes
const MAX_STALE_CACHE_AGE = 1000 * 60 * 60; // 1 hour — don't serve cache older than this on error

/**
 * Legacy tree-node shape retained so downstream helpers
 * (`collectTreeFiles`, `fetchRawFilesFromTree`, etc.) keep their current API.
 * R2-sourced entries are materialized with `type: "blob"` since R2 only ships
 * paths, not per-node metadata.
 */
interface GitHubTreeNode {
  path?: string;
  type?: string;
}

/**
 * Shape of the R2-hosted skills index payload
 * (`skills/index.json`, built by seren-skills/scripts/build-index.mjs).
 */
interface R2IndexPayload {
  version: string;
  updatedAt: string;
  skills: SkillIndexEntry[];
  tree?: string[];
}

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
function indexEntryToSkill(entry: SkillIndexEntry): Skill {
  return {
    id: `${entry.source}:${entry.slug}`,
    slug: entry.slug,
    name: humanizeSkillName(entry.name, entry.slug),
    displayName: entry.displayName,
    description: entry.description,
    source: entry.source,
    sourceUrl: entry.sourceUrl,
    tags: entry.tags,
    author: entry.author,
    version: entry.version,
    lastModified: entry.lastModified,
  };
}

/**
 * Serialize a skill for index cache.
 */
function skillToIndexEntry(skill: Skill): SkillIndexEntry {
  return {
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

/**
 * Cached repo tree from the most recent R2 index fetch.
 * Used to discover sibling files when installing or syncing a skill.
 */
let cachedRepoTree: GitHubTreeNode[] | null = null;

/**
 * Per-skill `lastModified` map from the most recent R2 v2+ index fetch,
 * keyed by canonical `sourceUrl`. Used by `fetchRemoteSkillRevision` to
 * derive a synthetic revision without any additional network calls once
 * the R2 index has been fetched. (#1476, #1515)
 *
 * Cleared and repopulated on every R2 fetch so deletions and renames in
 * the upstream repo don't leave stale entries.
 */
const cachedLastModifiedBySourceUrl = new Map<string, string>();

/**
 * In-flight promise for the current R2 index fetch. Deduplicates concurrent
 * callers (e.g. `fetchFreshRepoTree` + `fetchRemoteSkillRevision` fired in
 * parallel from `fetchUpstreamSkillBundle`) so a single sync-refresh cycle
 * hits R2 exactly once regardless of how many skills are being refreshed.
 */
let inflightR2IndexFetch: Promise<R2IndexPayload> | null = null;

/**
 * Populate the module-level caches from a parsed R2 index payload.
 * Factored out so both cold catalog fetches (`fetchSkillsFromR2Index`) and
 * fresh sync-refresh fetches (`fetchFreshR2Index`) share one code path.
 */
function populateCachesFromR2Payload(payload: R2IndexPayload): void {
  cachedRepoTree = (payload.tree ?? []).map((path) => ({
    path,
    type: "blob",
  }));
  cachedLastModifiedBySourceUrl.clear();
  for (const entry of payload.skills) {
    if (entry.lastModified && entry.sourceUrl) {
      cachedLastModifiedBySourceUrl.set(entry.sourceUrl, entry.lastModified);
    }
  }
}

/**
 * Fetch the R2 skills index with optional cache-bust, populate module caches,
 * and deduplicate concurrent callers.
 *
 * R2 is the sole source of truth for skill discovery, tree listings, and
 * upstream revision metadata. There is no GitHub fallback — with 10k+ users
 * the 60 req/hr anonymous GitHub rate limit would 403 on any fallback and
 * mask the real problem. R2 availability is monitored upstream. (#1515)
 */
async function fetchFreshR2Index(options?: {
  cacheBust?: boolean;
}): Promise<R2IndexPayload> {
  if (inflightR2IndexFetch) {
    return inflightR2IndexFetch;
  }
  inflightR2IndexFetch = (async () => {
    try {
      const url = options?.cacheBust
        ? `${SKILLS_R2_INDEX_URL}?t=${Date.now()}`
        : SKILLS_R2_INDEX_URL;
      const response = await appFetch(url);
      if (!response.ok) {
        throw new Error(`R2 skills index: ${response.status}`);
      }
      const payload = (await response.json()) as R2IndexPayload;
      populateCachesFromR2Payload(payload);
      return payload;
    } finally {
      inflightR2IndexFetch = null;
    }
  })();
  return inflightR2IndexFetch;
}

async function fetchSkillsFromR2Index(): Promise<Skill[]> {
  const payload = await fetchFreshR2Index();
  return payload.skills.map(indexEntryToSkill);
}

async function fetchSkillsFromRepoIndex(): Promise<Skill[]> {
  return fetchSkillsFromR2Index();
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

/**
 * Build a synthetic RemoteSkillRevision from an R2 v2+ `lastModified`
 * timestamp. The ISO string IS the synthetic SHA: it changes when and only
 * when the upstream commit changes, which is exactly what the freshness
 * check needs (`remoteRevision.sha !== syncedRevision`). Persisted as
 * `syncedRevision` after install — same string is used for every comparison.
 *
 * R2 is the sole source of truth for revision metadata. No GitHub commits
 * API fallback — the 60 req/hr anonymous limit would 403 at our user count
 * and mask the real problem. (#1476, #1515)
 */
function syntheticRevisionFromLastModified(
  lastModified: string,
): RemoteSkillRevision {
  return {
    sha: lastModified,
    shortSha: lastModified.slice(0, 10),
    committedAt: lastModified,
    message: undefined,
    url: undefined,
    changedFiles: [],
  };
}

async function fetchRemoteSkillRevision(
  sourceUrl: string,
): Promise<RemoteSkillRevision | null> {
  // Ensure the R2-backed lastModified cache is populated. This is a no-op
  // on warm paths (catalog already loaded) because `fetchFreshR2Index`
  // deduplicates concurrent and re-entrant calls.
  if (cachedLastModifiedBySourceUrl.size === 0) {
    try {
      await fetchFreshR2Index();
    } catch (err) {
      log.warn(
        "[Skills] Unable to fetch R2 index for revision lookup",
        sourceUrl,
        err,
      );
      return null;
    }
  }
  const cachedLastModified = cachedLastModifiedBySourceUrl.get(sourceUrl);
  if (!cachedLastModified) return null;
  return syntheticRevisionFromLastModified(cachedLastModified);
}

async function fetchUpstreamSkillBundle(skill: {
  sourceUrl?: string;
}): Promise<UpstreamSkillBundle | null> {
  if (!skill.sourceUrl) return null;

  // Phase 1: Fetch SKILL.md, repo tree, and revision in parallel
  const cacheBustedUrl = `${skill.sourceUrl}${skill.sourceUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const [skillMd, freshTree, remoteRevision] = await Promise.all([
    appFetch(cacheBustedUrl).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Failed to fetch skill content: ${response.status}`);
      }
      return response.text();
    }),
    fetchFreshRepoTree(skill.sourceUrl),
    fetchRemoteSkillRevision(skill.sourceUrl),
  ]);

  // Phase 2: Parse SKILL.md for includes, then fetch payload + includes files
  const parsed = parseSkillMd(skillMd);
  const payloadFiles = await fetchPayloadAndIncludes(
    skill.sourceUrl,
    freshTree,
    parsed.metadata.includes,
  );

  return { skillMd, payloadFiles, remoteRevision };
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

    if (
      parsedSyncState.upstreamSource === "serenorg" &&
      !deriveRepoDirPrefix(parsedSyncState.upstreamSourceUrl)
    ) {
      return null;
    }

    return {
      ...parsedSyncState,
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
  upstreamSource: "serenorg";
  upstreamSourceUrl: string;
} {
  return (
    !!skill.syncState &&
    skill.upstreamSource === "serenorg" &&
    typeof skill.upstreamSourceUrl === "string" &&
    skill.upstreamSourceUrl.length > 0
  );
}

/**
 * Check if an installed skill is managed by a Seren publisher (has sync state
 * with source "seren"). Used to detect stale publisher skills whose publisher
 * has been deleted.
 */
export function isPublisherManagedSkill(
  skill: InstalledSkill,
): skill is InstalledSkill & {
  syncState: SkillSyncState;
  upstreamSource: "seren";
  upstreamSourceUrl: string;
} {
  return (
    !!skill.syncState &&
    skill.upstreamSource === "seren" &&
    typeof skill.upstreamSourceUrl === "string" &&
    skill.upstreamSourceUrl.length > 0
  );
}

/**
 * Fetch a fresh repo tree from the R2 skills index with cache-bust to
 * bypass the Cloudflare edge cache. On failure this throws — callers must
 * not fall back to a stale tree because recording a new syncedRevision
 * with old file content would mask an incomplete sync and prevent future
 * retries.
 */
async function fetchFreshRepoTree(
  _sourceUrl: string,
): Promise<GitHubTreeNode[]> {
  try {
    await fetchFreshR2Index({ cacheBust: true });
  } catch (err) {
    throw new Error(
      `Failed to fetch repo tree for payload files: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return cachedRepoTree ?? [];
}

/**
 * Validate an includes path for safety.
 * Must be relative, no traversal, no absolute paths.
 */
function isValidIncludesPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.startsWith("\\")) return false;
  if (path.includes("..")) return false;
  if (path.startsWith(".") && !path.startsWith("./")) return false;
  return true;
}

/**
 * Collect blob file nodes from a tree matching a directory prefix.
 * Returns objects mapping each file's repo path to its install-relative path.
 */
function collectTreeFiles(
  tree: GitHubTreeNode[],
  dirPrefix: string,
  relativePrefix: string,
  excludeSkillMd: boolean,
): Array<{ repoPath: string; relativePath: string }> {
  return tree
    .filter(
      (node) =>
        node.type === "blob" &&
        typeof node.path === "string" &&
        node.path.startsWith(dirPrefix) &&
        (!excludeSkillMd || !node.path.endsWith("/SKILL.md")),
    )
    .map((node) => ({
      repoPath: node.path as string,
      relativePath:
        relativePrefix + (node.path as string).slice(dirPrefix.length),
    }));
}

/**
 * Fetch raw file contents from GitHub for a list of file nodes.
 */
async function fetchRawFilesFromTree(
  nodes: Array<{ repoPath: string; relativePath: string }>,
): Promise<ExtraFile[]> {
  if (nodes.length === 0) return [];

  const results = await Promise.allSettled(
    nodes.map(async ({ repoPath, relativePath }): Promise<ExtraFile> => {
      const segments = repoPath.split("/").map((s) => encodeURIComponent(s));
      const rawUrl = `${SKILLS_RAW_URL}/${segments.join("/")}?t=${Date.now()}`;

      const resp = await appFetch(rawUrl);
      if (!resp.ok) {
        throw new Error(
          `Failed to fetch payload file ${relativePath}: HTTP ${resp.status}`,
        );
      }
      const content = await resp.text();
      return { path: relativePath, content };
    }),
  );

  const files: ExtraFile[] = [];
  const failures: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      files.push(result.value);
    } else {
      failures.push(result.reason?.message ?? String(result.reason));
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to fetch ${failures.length}/${nodes.length} payload files: ${failures.join("; ")}`,
    );
  }

  return files;
}

/**
 * Fetch payload files from a skill's directory plus any declared includes paths.
 * Includes files are installed under `_deps/{repo-path}/` to keep them
 * safely within the skill directory while preserving the upstream structure.
 */
async function fetchPayloadAndIncludes(
  sourceUrl: string,
  tree: GitHubTreeNode[],
  includes?: string[],
): Promise<ExtraFile[]> {
  const dirPrefix = deriveRepoDirPrefix(sourceUrl);
  if (!dirPrefix || tree.length === 0) return [];

  // Collect files from the skill's own directory (excluding SKILL.md)
  const fileNodes = collectTreeFiles(tree, dirPrefix, "", true);

  // Collect files from declared includes paths (installed under _deps/)
  if (includes && includes.length > 0) {
    for (const includePath of includes) {
      if (!isValidIncludesPath(includePath)) {
        log.warn("[Skills] Skipping invalid includes path:", includePath);
        continue;
      }
      const normalizedPath = includePath.endsWith("/")
        ? includePath
        : `${includePath}/`;
      const includeNodes = collectTreeFiles(
        tree,
        normalizedPath,
        `_deps/${normalizedPath}`,
        false,
      );
      if (includeNodes.length === 0) {
        log.warn("[Skills] No files found for includes path:", includePath);
      }
      fileNodes.push(...includeNodes);
    }
    if (fileNodes.some((n) => n.relativePath.startsWith("_deps/"))) {
      log.info(
        "[Skills] Including shared dependencies from",
        includes.length,
        "declared paths",
      );
    }
  }

  if (fileNodes.length === 0) return [];

  log.info(
    "[Skills] Fetching",
    fileNodes.length,
    "payload files for",
    dirPrefix,
  );

  return fetchRawFilesFromTree(fileNodes);
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
    publisherSlug: publisher.slug,
    publisherSourceUrl: `${apiBase}/publishers/${publisher.slug}/skill.md`,
    publisherName: publisher.resource_name || publisher.name,
    publisherDescription: publisher.description,
    publisherType: publisher.publisher_type,
    publisherCapabilities: publisher.capabilities ?? [],
    publisherEndpoints: publisher.endpoints ?? [],
    publisherApiUrl: publisher.api_url ?? null,
    publisherMcpEndpoint: publisher.mcp_endpoint ?? null,
    tags,
    author: publisher.name,
  };
}

function skillMergeKey(skill: Skill, publisherSlugs: Set<string>): string {
  if (skill.source === "seren") {
    return skill.slug;
  }

  if (skill.source === "serenorg" && skill.slug.startsWith("seren-")) {
    const publisherSlug = skill.slug.slice("seren-".length);
    if (publisherSlugs.has(publisherSlug)) {
      // seren-skills indexes publisher wrappers as category-prefixed slugs
      // (e.g. seren/seren-bounty -> seren-seren-bounty). Collapse them onto
      // the live publisher slug, but merge precedence is handled separately.
      return publisherSlug;
    }
  }

  return skill.slug;
}

function mergePublisherMetadata(
  repoSkill: Skill,
  publisherSkill: Skill,
): Skill {
  return {
    ...repoSkill,
    id: `${repoSkill.source}:${publisherSkill.slug}`,
    slug: publisherSkill.slug,
    tags: [...new Set([...repoSkill.tags, ...publisherSkill.tags])],
    publisherSlug: publisherSkill.slug,
    publisherSourceUrl: publisherSkill.sourceUrl,
    publisherName: publisherSkill.name,
    publisherDescription: publisherSkill.description,
    publisherType: publisherSkill.publisherType,
    publisherCapabilities: publisherSkill.publisherCapabilities,
    publisherEndpoints: publisherSkill.publisherEndpoints,
    publisherApiUrl: publisherSkill.publisherApiUrl,
    publisherMcpEndpoint: publisherSkill.publisherMcpEndpoint,
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

      log.info("[Skills] Fetching skills index from", SKILLS_R2_INDEX_URL);
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
          log.warn(
            "[Skills] Serving stale index cache, age:",
            Math.round(ageMs / 1000),
            "s",
          );
          return (data as SkillIndexEntry[]).map(indexEntryToSkill);
        }
        log.error(
          "[Skills] Stale cache too old to serve:",
          Math.round(ageMs / 1000),
          "s",
        );
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
          log.warn(
            "[Skills] Serving stale publisher skills cache, age:",
            Math.round(ageMs / 1000),
            "s",
          );
          return data as Skill[];
        }
        log.error(
          "[Skills] Stale publisher skills cache too old to serve:",
          Math.round(ageMs / 1000),
          "s",
        );
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

    // Merge skills by canonical publisher slug. When a seren-skills wrapper is
    // present, keep its richer SKILL.md/sourceUrl and attach live publisher
    // metadata for availability/execution.
    const skillMap = new Map<string, Skill>();
    const publisherSlugs = new Set(publisherSkills.map((skill) => skill.slug));

    // Add index skills first
    for (const skill of indexSkills) {
      skillMap.set(skillMergeKey(skill, publisherSlugs), skill);
    }

    // Publisher-only skills remain available; repo-backed duplicates keep repo
    // content while gaining publisher metadata.
    for (const skill of publisherSkills) {
      const mergeKey = skillMergeKey(skill, publisherSlugs);
      const existingSkill = skillMap.get(mergeKey);
      skillMap.set(
        mergeKey,
        existingSkill?.source === "serenorg"
          ? mergePublisherMetadata(existingSkill, skill)
          : skill,
      );
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

    let installContent = content;
    let extraFiles: ExtraFile[] = [];
    let extraFilesJson: string | undefined;
    let syncState: SkillSyncState | null = null;
    if (skill.source === "serenorg" && skill.sourceUrl) {
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
    } else if (skill.source === "seren" && skill.sourceUrl) {
      // Publisher-installed skills also get sync state so they can be
      // detected and cleaned up when the publisher is deleted.
      syncState = await computeUpstreamSyncState(
        skill.source,
        skill.sourceUrl,
        null,
        installContent,
        [],
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
      skill.upstreamSource,
      skill.upstreamSourceUrl,
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

  /**
   * Backfill sync state for installed skills that were installed before the
   * sync feature existed (pre-v2.3.16). Matches installed skills missing
   * sync state to available repo skills by slug, then writes a minimal
   * .seren-sync.json so the upstream refresh flow can detect updates.
   */
  async backfillSyncState(
    installed: InstalledSkill[],
    available: Skill[],
  ): Promise<number> {
    if (!isTauriRuntime()) return 0;

    const repoSkillsBySlug = new Map<string, Skill>();
    const publisherSkillsBySlug = new Map<string, Skill>();
    for (const skill of available) {
      if (skill.source === "serenorg" && skill.sourceUrl) {
        repoSkillsBySlug.set(skill.slug, skill);
      } else if (skill.source === "seren" && skill.sourceUrl) {
        publisherSkillsBySlug.set(skill.slug, skill);
      }
    }

    let backfilled = 0;

    for (const skill of installed) {
      // Skip skills that already have sync state
      if (skill.syncState) continue;

      // Try matching by slug first, then fall back to dirName (which always
      // equals the marketplace slug even when resolveSkillSlug() derives a
      // different slug from SKILL.md frontmatter name).
      const repoMatch =
        repoSkillsBySlug.get(skill.slug) ?? repoSkillsBySlug.get(skill.dirName);
      const publisherMatch =
        publisherSkillsBySlug.get(skill.slug) ??
        publisherSkillsBySlug.get(skill.dirName);
      const match = repoMatch ?? publisherMatch;
      if (!match?.sourceUrl) {
        // Also detect publisher skills by SKILL.md metadata (publisher_slug)
        const content = await this.readContent(skill);
        if (!content) continue;
        const slugMatch = content.match(/"publisher_slug"\s*:\s*"([^"]+)"/);
        if (slugMatch) {
          const publisherSlug = slugMatch[1];
          const contentHash = await computeContentHash(content);
          const syncState: SkillSyncState = {
            version: 1,
            upstreamSource: "seren" as SkillSource,
            upstreamSourceUrl: `${apiBase}/publishers/${publisherSlug}/skill.md`,
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
              "[Skills] Backfilled publisher sync state for",
              skill.slug,
              "→ publisher:",
              publisherSlug,
            );
          } catch (err) {
            log.warn(
              "[Skills] Failed to backfill publisher sync state for",
              skill.slug,
              err,
            );
          }
        }
        continue;
      }

      const source: SkillSource = repoMatch ? "serenorg" : "seren";

      // Read current content to compute managed file hash
      const content = await this.readContent(skill);
      if (!content) continue;

      const contentHash = await computeContentHash(content);
      const syncState: SkillSyncState = {
        version: 1,
        upstreamSource: source,
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
