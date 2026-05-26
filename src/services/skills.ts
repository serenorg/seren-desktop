// ABOUTME: Skills service for managing skill discovery, installation, and content.
// ABOUTME: Handles fetching from Seren Skills, local skills, and sync state.

import { invoke } from "@tauri-apps/api/core";
import {
  type BundleFileInput,
  createSkill,
  createVersion,
  deleteSkill,
  downloadSkill,
  listSkills,
  type SkillBundle,
  type SkillBundleFile,
  type SkillSummary,
  updateSkill,
} from "@/api/seren-skills";
import { log } from "@/lib/logger";
import {
  computeContentHash,
  getSkillPath,
  humanizeSkillName,
  type InstalledSkill,
  normalizeSkillSlug,
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

/**
 * Error thrown by Seren Skills API helpers. Carries the HTTP status when one
 * is available so callers can distinguish auth failures from server errors
 * without scraping the message string.
 */
export class SkillsApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "SkillsApiError";
    this.status = status;
  }
}

/**
 * True for HTTP statuses that map to "the user is not signed in or not
 * permitted to see this resource". Used to gate silent vs surfaced errors
 * on the owned-skills merge path.
 */
export function isAuthStatus(status: number | undefined): boolean {
  return status === 401 || status === 403;
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

export interface EnabledSkillsContentOptions {
  mode?: "full" | "compact";
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
    publisher: {
      createdByUserId: summary.created_by_user_id,
      ownerUserId: summary.owner_user_id ?? null,
      visibility: summary.visibility,
      discoverability: summary.discoverability,
      publishStatus: summary.status,
    },
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
    publisher: skill.publisher,
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

/**
 * Walk the installed skill's directory and collect payload files for a
 * publish/version push. SKILL.md and the local sync metadata are filtered
 * out by the Rust side; this just shapes the response into the
 * `BundleFileInput` format the publisher expects.
 */
async function collectPayloadFiles(
  skill: InstalledSkill,
): Promise<BundleFileInput[]> {
  if (!isTauriRuntime()) return [];
  const raw = await invoke<Array<{ path: string; contentB64: string }>>(
    "list_skill_payload_files",
    { skillsDir: skill.skillsDir, slug: skill.dirName },
  );
  return raw.map((file) => ({
    path: file.path,
    content_b64: file.contentB64,
  }));
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

function extractStructuredErrorMessage(
  value: unknown,
  depth = 0,
): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || depth > 3) return null;

  const obj = value as Record<string, unknown>;
  for (const key of ["message", "detail", "error", "code"]) {
    if (typeof obj[key] === "string") return obj[key];
  }
  for (const key of ["error", "message", "detail"]) {
    const nested = obj[key];
    if (nested && typeof nested === "object") {
      const message = extractStructuredErrorMessage(nested, depth + 1);
      if (message) return message;
    }
  }
  return null;
}

function extractEnvelopeErrorMessage(
  obj: Record<string, unknown>,
): string | null {
  if (typeof obj.error === "string") return obj.error;
  if (obj.error && typeof obj.error === "object") {
    const nested = extractStructuredErrorMessage(obj.error);
    if (nested) return nested;
  }
  if (
    typeof obj.message === "string" &&
    (obj.error !== undefined ||
      obj.code !== undefined ||
      obj.status !== undefined)
  ) {
    return obj.message;
  }
  return null;
}

// Diagnostic for envelope-walking failures: walks the same data->result->body
// chain that `findInResponseEnvelopes` uses and reports the keys at each
// depth, so a "wrapped" bundle response like `{ data: { error: ... } }` is
// debuggable from the user-facing error string alone. Surfaces a server
// error envelope when one is detected at any depth.
function describeBundleEnvelope(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const layers: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = value;
  let depth = 0;
  while (
    current &&
    typeof current === "object" &&
    !seen.has(current) &&
    depth < 5
  ) {
    seen.add(current);
    const obj = current as Record<string, unknown>;
    const keys = Object.keys(obj).slice(0, 6);
    layers.push(`{${keys.join(",")}}`);

    const errorMessage = extractEnvelopeErrorMessage(obj);
    if (errorMessage) {
      return `: ${layers.join(" -> ")} (server error: ${errorMessage})`;
    }

    const next =
      (obj.data && typeof obj.data === "object" ? obj.data : null) ??
      (obj.result && typeof obj.result === "object" ? obj.result : null) ??
      (obj.body && typeof obj.body === "object" ? obj.body : null);
    if (!next) break;
    current = next;
    depth++;
  }
  return layers.length > 0 ? `: ${layers.join(" -> ")}` : "";
}

// Generated SDK responses come back wrapped in unpredictable layers of
// {data,result,body} envelopes at runtime. Walk the envelope tree breadth-first
// and return the first object that satisfies `match`. Shared so list and
// download responses cannot silently drift apart again.
function findInResponseEnvelopes<T>(
  value: unknown,
  match: (candidate: object) => T | null,
): T | null {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();

  while (queue.length > 0 && seen.size < 25) {
    const candidate = queue.shift();
    if (!candidate || typeof candidate !== "object") continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const result = match(candidate);
    if (result !== null) return result;

    const envelope = candidate as {
      body?: unknown;
      data?: unknown;
      result?: unknown;
    };
    for (const nested of [envelope.data, envelope.result, envelope.body]) {
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }

  return null;
}

function findApiResultFailure(
  value: unknown,
): { status: number; message: string | null } | null {
  return findInResponseEnvelopes(value, (candidate) => {
    const apiResult = candidate as { body?: unknown; status?: unknown };
    if (typeof apiResult.status !== "number" || apiResult.status < 400) {
      return null;
    }

    const message =
      extractStructuredErrorMessage(apiResult.body) ??
      extractEnvelopeErrorMessage(candidate as Record<string, unknown>);
    return { status: apiResult.status, message };
  });
}

function normalizeSkillsCatalogPage(
  value: unknown,
): SkillsCatalogResponsePage | null {
  return findInResponseEnvelopes(value, (candidate) => {
    const page = candidate as { skills?: unknown; total?: unknown };
    if (!Array.isArray(page.skills)) return null;
    return {
      skills: page.skills as SkillSummary[],
      total: typeof page.total === "number" ? page.total : page.skills.length,
    };
  });
}

function normalizeSkillBundle(value: unknown): SkillBundle | null {
  return findInResponseEnvelopes(value, (candidate) => {
    const bundle = candidate as {
      skill_md?: unknown;
      content_hash?: unknown;
      skill?: unknown;
    };
    if (
      typeof bundle.skill_md !== "string" ||
      typeof bundle.content_hash !== "string" ||
      !bundle.skill ||
      typeof bundle.skill !== "object"
    ) {
      return null;
    }
    return candidate as SkillBundle;
  });
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
  const apiResultFailure = findApiResultFailure(data);
  if (apiResultFailure) {
    const message = apiResultFailure.message
      ? ` (${apiResultFailure.message})`
      : "";
    throw new Error(
      `Failed to download skill ${slug}: ${apiResultFailure.status}${message}`,
    );
  }
  const bundle = normalizeSkillBundle(data);
  if (!bundle) {
    throw new Error(
      `Unexpected seren-skills bundle response for ${slug}${describeBundleEnvelope(data)}`,
    );
  }
  return bundle;
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

/**
 * List skills owned by the authenticated user across every visibility tier.
 * The default `listSkills` path returns the public catalog only, which omits
 * private skills the user owns. Without this call the desktop UI cannot
 * detect ownership of those records and the manage actions never surface.
 */
async function fetchOwnedSkillsPage(
  limit: number,
  offset: number,
): Promise<SkillsCatalogPage> {
  const { data, error, response } = await listSkills({
    query: { limit, offset, mine: true },
    throwOnError: false,
  });
  if (error || !data) {
    const status = response?.status;
    const suffix = status !== undefined ? `: ${status}` : "";
    throw new SkillsApiError(
      `Failed to list owned seren-skills${suffix}`,
      status,
    );
  }
  const page = normalizeSkillsCatalogPage(data);
  if (!page) {
    throw new Error(
      `Unexpected seren-skills catalog response${objectKeys(data)}`,
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

function extractMarkdownSectionPreview(
  content: string,
  heading: string,
  maxChars: number,
): string | null {
  const lines = content.split(/\r?\n/);
  const headingPattern = new RegExp(`^#{2,3}\\s+${heading}\\s*$`, "i");
  const start = lines.findIndex((line) => headingPattern.test(line.trim()));
  if (start < 0) return null;

  const collected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s+/.test(line.trim())) break;
    collected.push(line);
  }

  const preview = collected.join("\n").trim();
  if (!preview) return null;
  return preview.length > maxChars
    ? `${preview.slice(0, maxChars).trimEnd()}...`
    : preview;
}

function buildCompactSkillPrompt(args: {
  skill: InstalledSkill;
  runtimeDir: string;
  sep: string;
  runtimeNote: string;
  parsedContent: string;
}): string {
  const { skill, runtimeDir, sep, runtimeNote, parsedContent } = args;
  const description = skill.description?.trim();
  const whenToUse = extractMarkdownSectionPreview(
    parsedContent,
    "When to Use",
    700,
  );
  const details = [
    description ? `Description: ${description}` : null,
    whenToUse ? `When to use:\n${whenToUse}` : null,
    `Before using this skill, open \`${runtimeDir}${sep}SKILL.md\` and follow its full instructions.`,
  ].filter((line): line is string => line !== null);

  return `## Skill: ${skill.name}\n\n${runtimeNote}${details.join("\n\n")}`;
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

/**
 * Validate post-install/post-refresh payload files. If any are missing,
 * (a) append a durable line to the per-scope install log so the failure
 * survives an app restart, and (b) attempt one silent retry via the
 * supplied closure (typically a re-fetch + reinstall). Returns the final
 * status the caller should stamp on the InstalledSkill.
 *
 * Issue serenorg/seren-desktop#1917 — closes the race where a partial
 * install would still get its SKILL.md injected into the agent's system
 * prompt, causing the agent to scaffold from scratch over an empty dir.
 */
async function validateAndRetryInstall(args: {
  skillsDir: string;
  slug: string;
  phase: "install" | "refresh";
  retry: (() => Promise<boolean | null>) | null;
}): Promise<{ status: "ready" | "failed"; missingFiles: string[] }> {
  const { skillsDir, slug, phase, retry } = args;
  const installLogPath = `${skillsDir.replace(/[/\\]+$/, "")}/.install-log.jsonl`;

  const missing = await validatePayloadSafe(skillsDir, slug);
  if (missing.length === 0) {
    return { status: "ready", missingFiles: [] };
  }

  log.warn(
    `[Skills] Payload validation failed after ${phase} of ${slug} — missing:`,
    missing,
  );
  await logInstallFailure(installLogPath, slug, phase, missing);

  if (retry) {
    try {
      const retried = await retry();
      if (retried) {
        const afterRetry = await validatePayloadSafe(skillsDir, slug);
        if (afterRetry.length === 0) {
          log.info(`[Skills] Auto-retry recovered ${slug} after ${phase}`);
          return { status: "ready", missingFiles: [] };
        }
        log.warn(
          `[Skills] Auto-retry of ${slug} (${phase}) still missing:`,
          afterRetry,
        );
        await logInstallFailure(installLogPath, slug, phase, afterRetry);
        return { status: "failed", missingFiles: afterRetry };
      }
    } catch (error) {
      log.warn(`[Skills] Auto-retry of ${slug} (${phase}) threw:`, error);
    }
  }

  return { status: "failed", missingFiles: missing };
}

async function validatePayloadSafe(
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
    log.warn("[Skills] validate_skill_payload threw:", error);
    return [];
  }
}

async function logInstallFailure(
  logPath: string,
  slug: string,
  phase: "install" | "refresh",
  missingFiles: string[],
): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    await invoke("log_skill_install_failure", {
      logPath,
      slug,
      phase,
      missingFiles,
    });
  } catch (error) {
    // Logging failure must never bubble — it would mask the real install
    // error we are trying to record.
    log.warn("[Skills] log_skill_install_failure threw:", error);
  }
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
   * Fetch every skill owned by the authenticated user across every
   * visibility tier. Returns the empty list for unauthenticated calls.
   */
  async fetchOwnedSkills(): Promise<Skill[]> {
    const pageSize = 100;
    const all: Skill[] = [];
    let offset = 0;
    let total: number | null = null;
    do {
      const page = await fetchOwnedSkillsPage(pageSize, offset);
      if (page.skills.length === 0) break;
      all.push(...page.skills);
      total = page.total;
      offset = page.nextOffset ?? page.total;
    } while (total !== null && offset < total);
    return all;
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
   * Get the local authoring directory for user-created skills.
   */
  async getSerenSkillAuthoringDir(): Promise<string> {
    if (!isTauriRuntime()) {
      return "~/Documents/Seren/skills";
    }
    return invoke<string>("get_seren_skill_authoring_dir");
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
   * Create a new local authoring skill folder and return the SKILL.md path.
   */
  async createSkillFolder(options: {
    name: string;
    description?: string | null;
  }): Promise<string> {
    if (!isTauriRuntime()) {
      throw new Error("Skills can only be created in the desktop app");
    }
    const trimmedName = options.name.trim();
    const slug = normalizeSkillSlug(trimmedName);
    const skillsDir = await this.getSerenSkillAuthoringDir();
    return invoke<string>("create_skill_folder", {
      skillsDir,
      slug,
      name: trimmedName,
      description: options.description?.trim() || null,
    });
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
    const authoringDir = await this.getSerenSkillAuthoringDir();
    const serenDir = await this.getSerenSkillsDir();
    const claudeDir = await this.getClaudeSkillsDir();
    const projectDir = await this.getProjectSkillsDir(projectRoot);

    const authoredSkills = await this.listInstalled(authoringDir, "seren");
    const serenSkills = await this.listInstalled(serenDir, "seren");
    const claudeSkills = await this.listInstalled(claudeDir, "claude");
    const projectSkills = projectDir
      ? await this.listInstalled(projectDir, "project")
      : [];

    const authoredBySlug = new Map(
      authoredSkills.map((skill) => [skill.slug, skill]),
    );
    const runtimeSerenSlugs = new Set(serenSkills.map((skill) => skill.slug));
    const runtimeSerenSkills = serenSkills.map((skill) => {
      const authored = authoredBySlug.get(skill.slug);
      return authored ? { ...skill, authoringPath: authored.path } : skill;
    });
    const visibleAuthoredSkills = authoredSkills.filter(
      (skill) => !runtimeSerenSlugs.has(skill.slug),
    );

    // Final pass: dedupe by absolute SKILL.md path so overlapping scan
    // directories never surface the same file twice. The most common case is
    // the user opening ~/Documents/Seren as their project root, which makes
    // projectDir === authoringDir and would otherwise show every authored
    // skill once with scope "seren" and again with scope "project".
    // First-write-wins keeps the authoring/runtime/claude/project ordering
    // semantically correct.
    const ordered = [
      ...visibleAuthoredSkills,
      ...runtimeSerenSkills,
      ...claudeSkills,
      ...projectSkills,
    ];
    const byPath = new Map<string, InstalledSkill>();
    for (const skill of ordered) {
      if (!byPath.has(skill.path)) {
        byPath.set(skill.path, skill);
      }
    }
    return Array.from(byPath.values());
  },

  /**
   * Fetch the full SKILL.md content for a remote skill.
   *
   * Throws on transport or shape failures so install paths can surface
   * the failure to the user. Returns null only when the skill payload
   * itself does not carry a sourceUrl (e.g. a Skill constructed without
   * one), which is a programmer error in the caller.
   */
  async fetchContent(skill: Skill): Promise<string | null> {
    const slug = skill.sourceUrl
      ? skillSlugFromSourceUrl(skill.sourceUrl)
      : null;
    if (!slug) {
      log.warn("[Skills] No source URL for skill:", skill.id);
      return null;
    }

    log.info("[Skills] Fetching content for", slug);
    return (await downloadSkillBundle(slug)).skill_md;
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

    // Validate payload after install (#1917). If files are missing on disk
    // we attempt one silent retry by re-fetching the upstream bundle, then
    // mark payloadStatus so slash-command + system-prompt callers can skip
    // the skill until a refresh succeeds.
    const validation = await validateAndRetryInstall({
      skillsDir,
      slug: skill.slug,
      phase: "install",
      retry:
        skill.source === "seren" && skill.sourceUrl
          ? async () => {
              const bundle = await fetchUpstreamSkillBundle(skill);
              if (!bundle) return null;
              await invoke<string>("install_skill", {
                skillsDir,
                slug: skill.slug,
                content: bundle.skillMd,
                extraFiles:
                  bundle.payloadFiles.length > 0
                    ? JSON.stringify(bundle.payloadFiles)
                    : null,
                syncStateJson: syncState ? JSON.stringify(syncState) : null,
              });
              return true;
            }
          : null,
    });

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
      payloadStatus: validation.status,
      missingPayloadFiles:
        validation.missingFiles.length > 0
          ? validation.missingFiles
          : undefined,
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

    const validation = await validateAndRetryInstall({
      skillsDir: skill.skillsDir,
      slug: skill.dirName,
      phase: "refresh",
      // Refresh already pulled the freshest bundle. A second fetch is unlikely
      // to recover from a write failure on this machine, so retry with the
      // same in-memory bundle to ride out a transient fs hiccup.
      retry: async () => {
        await invoke<string>("install_skill", {
          skillsDir: skill.skillsDir,
          slug: skill.dirName,
          content: bundle.skillMd,
          extraFiles: JSON.stringify(bundle.payloadFiles),
          syncStateJson: JSON.stringify(syncState),
        });
        return true;
      },
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
      payloadStatus: validation.status,
      missingPayloadFiles:
        validation.missingFiles.length > 0
          ? validation.missingFiles
          : undefined,
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
    opts?: EnabledSkillsContentOptions,
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
        const isWindowsRuntime =
          skill.skillsDir.includes("\\") || /^[A-Za-z]:/.test(skill.skillsDir);
        const sep = isWindowsRuntime ? "\\" : "/";
        const runtimeDir = `${skill.skillsDir}${sep}${skill.dirName}`;
        const hasIncludes =
          parsed.metadata.includes && parsed.metadata.includes.length > 0;
        const depsNote = hasIncludes
          ? `\n> **Shared dependencies:** \`${runtimeDir}${sep}_deps${sep}\` contains shared files from declared \`includes\` paths.\n`
          : "";
        const platformNote = isWindowsRuntime
          ? `\n> **Platform:** Windows. Python (\`python\` and \`python3\`) is bundled with Seren Desktop — no install needed. Skill docs commonly reference \`~/.config/seren/skills/<name>\` and forward-slash paths; on this machine:\n> - Replace any \`~/.config/seren/skills/<name>\` reference with the absolute runtime directory above.\n> - Use backslashes inside paths.\n> Always \`cd\` into the absolute runtime directory above before invoking skill scripts.`
          : "";
        const runtimeNote = `> **Skill runtime directory:** \`${runtimeDir}\`\n> Use this absolute path to reference skill files. Do not create local copies or fallback scaffolds.${platformNote}${depsNote}\n\n`;
        // #2041: compact is the default. Inlining every SKILL.md body shipped
        // ~90K tokens of system-prompt overhead per turn at 30 active skills,
        // pinning fresh sessions near the 200K cap before the user typed
        // anything. Compact mode keeps the name + description + runtime path
        // + "When to use" preview and tells the agent to open SKILL.md on
        // demand — the agent's existing Read tool covers the fetch when a
        // skill is actually invoked. Callers that genuinely need the full
        // body (e.g. an explicit slash-command invocation) opt in via
        // mode: "full".
        if (opts?.mode === "full") {
          contents.push(
            `## Skill: ${skill.name}\n\n${runtimeNote}${parsed.content}`,
          );
        } else {
          contents.push(
            buildCompactSkillPrompt({
              skill,
              runtimeDir,
              sep,
              runtimeNote,
              parsedContent: parsed.content,
            }),
          );
        }
      }
    }

    if (contents.length === 0) {
      return "";
    }

    return `\n\n# Active Skills\n\n${contents.join("\n\n---\n\n")}`;
  },

  // ─── Publisher actions for owned skills ─────────────

  /**
   * Delete an owned skill from the Seren Skills publisher (soft-delete).
   * The skill record + its versions are tombstoned. Local installs of the
   * same slug are unaffected by this call.
   */
  async deletePublishedSkill(slug: string): Promise<void> {
    const { error, response } = await deleteSkill({
      path: { slug },
      throwOnError: false,
    });
    if (error) {
      const status = response ? `: ${response.status}` : "";
      throw new Error(`Failed to delete skill ${slug}${status}`);
    }
  },

  /**
   * Update visibility/discoverability metadata on an owned published skill.
   */
  async updatePublishedMetadata(
    slug: string,
    patch: {
      visibility?: "private" | "public" | "paid";
      discoverability?: "listed" | "unlisted";
    },
  ): Promise<void> {
    const { error, response } = await updateSkill({
      path: { slug },
      body: patch,
      throwOnError: false,
    });
    if (error) {
      const status = response ? `: ${response.status}` : "";
      throw new Error(`Failed to update skill ${slug}${status}`);
    }
  },

  /**
   * Publish a locally-installed skill to Seren Skills as a brand-new record.
   * Creates the publisher entry and the seed version with the local
   * SKILL.md + payload contents. Throws on conflict so the caller can
   * surface "slug already exists" cleanly.
   */
  async publishLocalSkill(
    skill: InstalledSkill,
    options: {
      visibility: "private" | "public" | "paid";
      discoverability?: "listed" | "unlisted";
      version?: string;
    },
  ): Promise<SkillSummary> {
    if (!isTauriRuntime()) {
      throw new Error("Skills can only be published from the desktop app");
    }
    const skillMd = await this.readContent(skill);
    if (!skillMd) {
      throw new Error(`Could not read SKILL.md for ${skill.slug}`);
    }
    const files = await collectPayloadFiles(skill);
    const { data, error, response } = await createSkill({
      body: {
        slug: skill.slug,
        name: skill.displayName ?? skill.name,
        description: skill.description ?? "",
        visibility: options.visibility,
        discoverability: options.discoverability ?? "listed",
        skill_md: skillMd,
        files: files.length > 0 ? files : null,
        version: options.version ?? "0.1.0",
        publish_now: true,
      },
      throwOnError: false,
    });
    if (error || !data) {
      const status = response ? `: ${response.status}` : "";
      throw new Error(`Failed to publish skill ${skill.slug}${status}`);
    }
    return data;
  },

  /**
   * Install a just-published skill into the Seren runtime skills directory.
   */
  async installPublishedSkill(summary: SkillSummary): Promise<InstalledSkill> {
    const publishedSkill = skillSummaryToSkill(summary);
    return this.install(publishedSkill, "", "seren", null);
  },

  /**
   * Push a new version of a previously-published skill from the local
   * SKILL.md + payload. Used when the slug already exists upstream.
   */
  async publishNewVersion(
    skill: InstalledSkill,
    options: { version: string; changelog?: string },
  ): Promise<void> {
    if (!isTauriRuntime()) {
      throw new Error("Skills can only be published from the desktop app");
    }
    const skillMd = await this.readContent(skill);
    if (!skillMd) {
      throw new Error(`Could not read SKILL.md for ${skill.slug}`);
    }
    const files = await collectPayloadFiles(skill);
    const { error, response } = await createVersion({
      path: { slug: skill.slug },
      body: {
        version: options.version,
        skill_md: skillMd,
        files: files.length > 0 ? files : null,
        changelog: options.changelog ?? null,
      },
      throwOnError: false,
    });
    if (error) {
      const status = response ? `: ${response.status}` : "";
      throw new Error(`Failed to publish version of ${skill.slug}${status}`);
    }
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
