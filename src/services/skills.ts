// ABOUTME: Skills service for managing skill discovery, installation, and content.
// ABOUTME: Handles fetching from Seren Skills, local skills, and sync state.

import { invoke } from "@tauri-apps/api/core";
import {
  getCurrentUser,
  listOrganizations as listCoreOrganizations,
} from "@/api";
import {
  type BundleFileInput,
  createOrgFolder,
  createSkill,
  createVersion,
  deleteSkill,
  downloadSkill,
  downloadSkillFile,
  downloadSkillManifest,
  getAuthorIdentity,
  getOrgFolder,
  listSkills,
  type SkillBundle,
  type SkillBundleFile,
  type SkillBundleFileDownload,
  type SkillBundleManifest,
  type SkillSummary,
  updateSkill,
  upsertAuthorIdentity,
} from "@/api/seren-skills";
import { log } from "@/lib/logger";
import { verboseRuntimeConsole } from "@/lib/runtime-console";
import {
  catalogSkillMatchesInstalled,
  computeBytesHash,
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
  type SkillInstallOptions,
  type SkillInstallProgress,
  type SkillScope,
  type SkillSource,
  type SkillSyncState,
  type SkillSyncStatus,
} from "@/lib/skills";
import { captureSupportError } from "@/lib/support/hook";
import { getDefaultOrganizationId, isTauriRuntime } from "@/lib/tauri-bridge";

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
  /**
   * Base64 of the raw file bytes. Carried end-to-end so binary payload
   * files survive install without a lossy UTF-8 round-trip (#2297).
   */
  contentB64: string;
}

interface UpstreamSkillBundle {
  skillMd: string;
  payloadFiles: ExtraFile[];
  payloadTotalBytes: number;
  remoteRevision: RemoteSkillRevision | null;
}

type DownloadedSkillBundle = SkillBundle & {
  payloadTotalBytes?: number;
};

function isPublicDistributionVisibility(
  visibility: "private" | "public" | "paid" | undefined,
): boolean {
  return visibility === "public" || visibility === "paid";
}

function normalizeOrgFolderSlug(value: string, organizationId: string): string {
  const fallback = `org-${organizationId.slice(0, 8)}`;
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 96)
    .replace(/^-|-$/g, "");
  return normalized || fallback;
}

/**
 * Surface a public-publish preflight failure that is NOT a user-actionable
 * validation error (e.g. a Gateway 5xx or network fault). Reports it to the
 * support pipeline before rethrowing so an operator gets a ticket, while the
 * UI still receives the thrown error. Validation errors (403 admin, 409
 * slug-in-use, missing email) are thrown directly by the callers and are never
 * routed here.
 */
function failPublicPublishPreflight(
  kind: string,
  message: string,
  status: number | undefined,
): never {
  void captureSupportError({
    kind,
    message: status ? `${message} (status=${status})` : message,
  });
  throw new Error(message);
}

async function resolveDefaultOrgFolderSlug(
  organizationId: string,
): Promise<string> {
  const { data, error, response } = await listCoreOrganizations({
    throwOnError: false,
  });
  if (error) {
    failPublicPublishPreflight(
      "SkillPublishOrgFolderLoadFailure",
      "Failed to load organization folder details",
      response?.status,
    );
  }

  const organization = data?.data?.find((org) => org.id === organizationId);
  if (!organization) {
    throw new Error(
      "Public or paid skills require the default organization to be available before publishing.",
    );
  }

  return normalizeOrgFolderSlug(
    organization.slug || organization.name,
    organizationId,
  );
}

async function createOrgFolderForPublicPublish(
  organizationId: string,
): Promise<void> {
  const folderSlug = await resolveDefaultOrgFolderSlug(organizationId);
  const { error, response } = await createOrgFolder({
    path: { org_id: organizationId },
    body: { folder_slug: folderSlug },
    throwOnError: false,
  });
  if (!error) return;

  if (response?.status === 403) {
    throw new Error(
      "You do not have permission to create the organization skill folder. Ask an organization admin before publishing publicly.",
    );
  }
  if (response?.status === 409) {
    throw new Error(
      `The organization skill folder "${folderSlug}" is already used. Configure a different organization folder before publishing.`,
    );
  }

  failPublicPublishPreflight(
    "SkillPublishOrgFolderCreateFailure",
    "Failed to create organization skill folder",
    response?.status,
  );
}

async function assertOrgFolderConfiguredForPublicPublish(
  visibility: "private" | "public" | "paid" | undefined,
): Promise<void> {
  if (!isPublicDistributionVisibility(visibility)) return;

  const organizationId = await getDefaultOrganizationId();
  if (!organizationId) {
    throw new Error(
      "Public or paid skills require a default organization before publishing.",
    );
  }

  const { error, response } = await getOrgFolder({
    path: { org_id: organizationId },
    throwOnError: false,
  });
  if (!error) return;

  if (response?.status === 404 || response?.status === 409) {
    await createOrgFolderForPublicPublish(organizationId);
    return;
  }
  if (response?.status === 403) {
    throw new Error(
      "You do not have permission to inspect the organization skill folder. Ask an organization admin before publishing publicly.",
    );
  }

  failPublicPublishPreflight(
    "SkillPublishOrgFolderVerifyFailure",
    "Failed to verify organization skill folder",
    response?.status,
  );
}

async function ensureAuthorIdentityForPublicPublish(
  visibility: "private" | "public" | "paid" | undefined,
): Promise<void> {
  if (!isPublicDistributionVisibility(visibility)) return;

  const existingIdentity = await getAuthorIdentity({ throwOnError: false });
  if (!existingIdentity.error) return;
  if (existingIdentity.response?.status !== 404) {
    failPublicPublishPreflight(
      "SkillPublishAuthorIdentityVerifyFailure",
      "Failed to verify Git author identity",
      existingIdentity.response?.status,
    );
  }

  const { data, error, response } = await getCurrentUser({
    throwOnError: false,
  });
  if (error || !data?.data) {
    failPublicPublishPreflight(
      "SkillPublishAuthorIdentityLoadFailure",
      "Failed to load Git author identity details",
      response?.status,
    );
  }

  const accountName = `${data.data.name ?? ""}`.trim();
  const accountEmail = `${data.data.email ?? ""}`.trim();
  const displayName = accountName || accountEmail;
  const gitEmail = accountEmail;
  if (!displayName || !gitEmail) {
    throw new Error(
      "Public or paid skills require an account name and email for Git author attribution.",
    );
  }

  const upserted = await upsertAuthorIdentity({
    body: {
      display_name: displayName,
      git_email: gitEmail,
    },
    throwOnError: false,
  });
  if (upserted.error) {
    failPublicPublishPreflight(
      "SkillPublishAuthorIdentityUpsertFailure",
      "Failed to configure Git author identity",
      upserted.response?.status,
    );
  }
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
  const frontmatterTags = (summary.tags ?? []).filter((tag) => tag.length > 0);
  return {
    id: `seren:${summary.slug}`,
    slug: summary.slug,
    skillFolderName: summary.skill_folder_name,
    folderSlug: summary.folder_slug ?? null,
    name: humanizeSkillName(summary.name, summary.slug),
    description: summary.description,
    source: "seren",
    sourceUrl: `seren-skills:${summary.slug}`,
    tags: [
      ...new Set([
        ...frontmatterTags,
        summary.visibility,
        summary.discoverability,
        summary.status,
      ]),
    ],
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
    skillFolderName: skill.skillFolderName,
    folderSlug: skill.folderSlug,
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

function remoteRevisionFromBundle(
  bundle: SkillBundle | SkillBundleManifest,
): RemoteSkillRevision {
  return {
    sha: bundle.content_hash,
    shortSha: bundle.content_hash.slice(0, 10),
    committedAt: bundle.skill.updated_at,
    message: bundle.version,
    url: undefined,
    changedFiles: (bundle.files ?? []).map((file) => file.path),
  };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
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
    contentB64: file.content_b64,
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
  // Catalog responses may be nested in publisher execution envelopes.
  return findInResponseEnvelopes(value, (candidate) => {
    const response = candidate as { data?: unknown; pagination?: unknown };
    if (!Array.isArray(response.data)) return null;
    const pagination = response.pagination as { total?: unknown } | null;
    return {
      skills: response.data as SkillSummary[],
      total:
        pagination && typeof pagination.total === "number"
          ? pagination.total
          : response.data.length,
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

/** Gateway statuses worth a bounded retry on idempotent skill GETs (#2611). */
const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504]);
/** Backoff before each retry; length is the number of extra attempts. */
const TRANSIENT_RETRY_DELAYS_MS = [250, 1000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an idempotent seren-skills download GET on transient gateway
 * failures (502/503/504). The gateway intermittently 502s across publisher
 * endpoints while the upstream publisher pod is briefly unavailable
 * (serenorg/seren-core#189); a bounded retry rides through the blip instead
 * of surfacing a hard error. Non-transient statuses — including the
 * oversized-bundle 500 that triggers the split-download fallback — return on
 * the first attempt, so their existing handling is unchanged.
 */
async function withTransientGatewayRetry<
  T extends { error?: unknown; response?: { status?: number } },
>(call: () => Promise<T>): Promise<T> {
  let result = await call();
  for (const delayMs of TRANSIENT_RETRY_DELAYS_MS) {
    if (!result.error) return result;
    const status = result.response?.status;
    if (status === undefined || !TRANSIENT_GATEWAY_STATUSES.has(status)) {
      return result;
    }
    await sleep(delayMs);
    result = await call();
  }
  return result;
}

async function downloadSkillBundleSingleShot(
  slug: string,
): Promise<SkillBundle> {
  const { data, error, response } = await withTransientGatewayRetry(() =>
    downloadSkill({ path: { slug }, throwOnError: false }),
  );
  if (error || !data) {
    const status = response ? `: ${response.status}` : "";
    throw new SkillsApiError(
      `Failed to download skill ${slug}${status}`,
      response?.status,
    );
  }
  const apiResultFailure = findApiResultFailure(data);
  if (apiResultFailure) {
    const message = apiResultFailure.message
      ? ` (${apiResultFailure.message})`
      : "";
    throw new SkillsApiError(
      `Failed to download skill ${slug}: ${apiResultFailure.status}${message}`,
      apiResultFailure.status,
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

/**
 * The gateway buffers authenticated publisher responses and rejects
 * oversized bodies with a 500, so a 500 from the single-shot download is
 * the trigger for the split flow (#2296). Other statuses (401/403/404)
 * are real access failures and must surface unchanged.
 */
function isOversizedBundleError(error: unknown): boolean {
  return error instanceof SkillsApiError && error.status === 500;
}

function normalizeSkillBundleManifest(
  value: unknown,
): SkillBundleManifest | null {
  return findInResponseEnvelopes(value, (candidate) => {
    const manifest = candidate as {
      skill_md?: unknown;
      content_hash?: unknown;
      skill?: unknown;
    };
    if (
      typeof manifest.skill_md !== "string" ||
      typeof manifest.content_hash !== "string" ||
      !manifest.skill ||
      typeof manifest.skill !== "object"
    ) {
      return null;
    }
    return candidate as SkillBundleManifest;
  });
}

async function downloadSkillBundleManifest(
  slug: string,
): Promise<SkillBundleManifest> {
  const { data, error, response } = await withTransientGatewayRetry(() =>
    downloadSkillManifest({ path: { slug }, throwOnError: false }),
  );
  if (error || !data) {
    const status = response ? `: ${response.status}` : "";
    throw new SkillsApiError(
      `Failed to download manifest for skill ${slug}${status}`,
      response?.status,
    );
  }
  const apiResultFailure = findApiResultFailure(data);
  if (apiResultFailure) {
    const message = apiResultFailure.message
      ? ` (${apiResultFailure.message})`
      : "";
    throw new SkillsApiError(
      `Failed to download manifest for skill ${slug}: ${apiResultFailure.status}${message}`,
      apiResultFailure.status,
    );
  }
  const manifest = normalizeSkillBundleManifest(data);
  if (!manifest) {
    throw new Error(
      `Unexpected seren-skills manifest response for ${slug}${describeBundleEnvelope(data)}`,
    );
  }
  return manifest;
}

function normalizeSkillBundleFileDownload(
  value: unknown,
): SkillBundleFileDownload | null {
  return findInResponseEnvelopes(value, (candidate) => {
    const file = candidate as { path?: unknown; content_b64?: unknown };
    if (typeof file.path !== "string" || typeof file.content_b64 !== "string") {
      return null;
    }
    return candidate as SkillBundleFileDownload;
  });
}

async function downloadSkillBundleFilePayload(
  slug: string,
  path: string,
): Promise<SkillBundleFileDownload> {
  const { data, error, response } = await withTransientGatewayRetry(() =>
    downloadSkillFile({ path: { slug }, query: { path }, throwOnError: false }),
  );
  if (error || !data) {
    const status = response ? `: ${response.status}` : "";
    throw new SkillsApiError(
      `Failed to download file ${path} of skill ${slug}${status}`,
      response?.status,
    );
  }
  const apiResultFailure = findApiResultFailure(data);
  if (apiResultFailure) {
    throw new SkillsApiError(
      `Failed to download file ${path} of skill ${slug}: ${apiResultFailure.status}`,
      apiResultFailure.status,
    );
  }
  const file = normalizeSkillBundleFileDownload(data);
  if (!file) {
    throw new Error(
      `Unexpected seren-skills file response for ${slug} ${path}${describeBundleEnvelope(data)}`,
    );
  }
  return file;
}

/** Per-file fetch fan-out cap for the split download flow. */
const SPLIT_DOWNLOAD_CONCURRENCY = 4;

function progressPercent(downloadedBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.min(Math.round((downloadedBytes / totalBytes) * 100), 100);
}

function emitInstallProgress(
  options: SkillInstallOptions | undefined,
  progress: SkillInstallProgress,
): void {
  options?.onProgress?.(progress);
}

/**
 * Fetch every manifest file body with bounded concurrency and assemble
 * the `SkillBundle.files` shape the install pipeline consumes. Each file
 * response is pinned to the bundle version, so a publish landing between
 * the manifest fetch and a body fetch fails loudly instead of silently
 * assembling a mixed-version bundle.
 */
async function fetchManifestFiles(
  slug: string,
  manifest: SkillBundleManifest,
  options?: SkillInstallOptions,
): Promise<SkillBundleFile[]> {
  const metas = manifest.files ?? [];
  const files: SkillBundleFile[] = new Array(metas.length);
  const totalBytes = metas.reduce((sum, meta) => sum + meta.size_bytes, 0);
  const completedByIndex = new Set<number>();
  let downloadedBytes = 0;
  let filesCompleted = 0;
  let nextProgressIndex = 0;
  let next = 0;

  emitInstallProgress(options, {
    stage: "downloading",
    downloadedBytes: 0,
    totalBytes,
    progressPercent: 0,
    filesCompleted: 0,
    filesTotal: metas.length,
    message:
      totalBytes > 0
        ? `Downloading 0 of ${metas.length} payload files`
        : "Downloading skill payload files",
  });

  const emitContiguousCompletedProgress = (currentFile?: string) => {
    while (completedByIndex.has(nextProgressIndex)) {
      const meta = metas[nextProgressIndex];
      downloadedBytes += meta.size_bytes;
      filesCompleted += 1;
      nextProgressIndex += 1;
      emitInstallProgress(options, {
        stage: "downloading",
        downloadedBytes,
        totalBytes,
        progressPercent: progressPercent(downloadedBytes, totalBytes),
        filesCompleted,
        filesTotal: metas.length,
        currentFile,
        message: `Downloading ${filesCompleted} of ${metas.length} payload files`,
      });
    }
  };

  const workers = Array.from(
    { length: Math.min(SPLIT_DOWNLOAD_CONCURRENCY, metas.length) },
    async () => {
      while (next < metas.length) {
        const index = next++;
        const meta = metas[index];
        const payload = await downloadSkillBundleFilePayload(slug, meta.path);
        if (payload.version !== manifest.version) {
          throw new Error(
            `Skill ${slug} was republished during download (manifest version ${manifest.version}, file ${meta.path} is ${payload.version}). Retry the install.`,
          );
        }
        files[index] = {
          path: payload.path,
          content_b64: payload.content_b64,
          content_hash: payload.content_hash,
          mode: payload.mode,
          is_binary: payload.is_binary,
        };
        completedByIndex.add(index);
        emitContiguousCompletedProgress(payload.path);
      }
    },
  );
  await Promise.all(workers);
  return files;
}

async function downloadSkillBundle(
  slug: string,
  options?: SkillInstallOptions,
): Promise<DownloadedSkillBundle> {
  try {
    return await downloadSkillBundleSingleShot(slug);
  } catch (error) {
    if (!isOversizedBundleError(error)) throw error;
    log.warn(
      `[Skills] Single-shot download of ${slug} failed with 500; using split download fallback`,
    );
    const manifest = await downloadSkillBundleManifest(slug);
    const files = await fetchManifestFiles(slug, manifest, options);
    return {
      skill: manifest.skill,
      version: manifest.version,
      skill_md: manifest.skill_md,
      manifest: manifest.manifest,
      content_hash: manifest.content_hash,
      payloadTotalBytes:
        manifest.files?.reduce((sum, meta) => sum + meta.size_bytes, 0) ?? 0,
      files,
    };
  }
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
  const apiResultFailure = findApiResultFailure(data);
  if (apiResultFailure) {
    const message = apiResultFailure.message
      ? ` (${apiResultFailure.message})`
      : "";
    throw new SkillsApiError(
      `Failed to list seren-skills catalog: ${apiResultFailure.status}${message}`,
      apiResultFailure.status,
    );
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
  const apiResultFailure = findApiResultFailure(data);
  if (apiResultFailure) {
    const message = apiResultFailure.message
      ? ` (${apiResultFailure.message})`
      : "";
    throw new SkillsApiError(
      `Failed to list owned seren-skills: ${apiResultFailure.status}${message}`,
      apiResultFailure.status,
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
        verboseRuntimeConsole.debug(
          "[Skills] Using cached seren-skills catalog",
        );
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
  verboseRuntimeConsole.debug(
    "[Skills] Fetched",
    skills.length,
    "skills from seren-skills",
  );
  return skills;
}

function buildManagedFileMap(
  skillMdHash: string,
  payloadFiles: Array<{ path: string; hash: string }>,
): Record<string, string> {
  const managedFiles: Record<string, string> = {
    "SKILL.md": skillMdHash,
  };

  for (const file of payloadFiles) {
    managedFiles[file.path] = file.hash;
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
  // A revision check only needs content_hash/version/updated_at, all of which
  // the manifest carries. Query it directly instead of single-shot-first so a
  // large skill's refresh never pulls the full bundle (and never depends on
  // the gateway's oversized-bundle 500 to fall back). #2611
  return remoteRevisionFromBundle(await downloadSkillBundleManifest(slug));
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

async function fetchUpstreamSkillBundle(
  skill: {
    sourceUrl?: string;
    slug?: string;
  },
  options?: SkillInstallOptions,
): Promise<UpstreamSkillBundle | null> {
  const slug =
    (skill.sourceUrl ? skillSlugFromSourceUrl(skill.sourceUrl) : null) ??
    skill.slug ??
    null;
  if (!slug) return null;
  const bundle = await downloadSkillBundle(slug, options);
  return {
    skillMd: bundle.skill_md,
    payloadFiles: bundleFilesToExtraFiles(bundle.files),
    payloadTotalBytes: bundle.payloadTotalBytes ?? 0,
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
  // Hash the decoded bytes, not a text round-trip: for valid UTF-8 the
  // digest is identical, and binary payload files get a faithful hash
  // instead of one built on U+FFFD-mangled content (#2297).
  const payloadWithHashes = await Promise.all(
    payloadFiles.map(async (file) => ({
      path: file.path,
      hash: await computeBytesHash(base64ToBytes(file.contentB64)),
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

function normalizeSkillMatchText(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function installedSkillNameMatchesCatalog(
  installed: InstalledSkill,
  candidate: Skill,
): boolean {
  const installedNames = new Set(
    [installed.displayName, installed.name]
      .map(normalizeSkillMatchText)
      .filter((value) => value.length > 0),
  );
  if (installedNames.size === 0) return false;
  return [candidate.displayName, candidate.name]
    .map(normalizeSkillMatchText)
    .some((value) => value.length > 0 && installedNames.has(value));
}

function findCatalogBackfillMatch(
  installed: InstalledSkill,
  available: Skill[],
): Skill | null {
  const candidates = available.filter(
    (candidate) =>
      candidate.source === "seren" &&
      Boolean(candidate.sourceUrl) &&
      catalogSkillMatchesInstalled(candidate, installed),
  );
  if (candidates.length === 0) return null;

  const direct = candidates.find(
    (candidate) =>
      candidate.slug === installed.slug || candidate.slug === installed.dirName,
  );
  if (direct) return direct;

  const nameMatches = candidates.filter((candidate) =>
    installedSkillNameMatchesCatalog(installed, candidate),
  );
  if (nameMatches.length === 1) return nameMatches[0];

  return candidates.length === 1 ? candidates[0] : null;
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
            tags: parsed.metadata.tags ?? [],
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
    // Preview only needs skill_md, which the manifest carries. Query it
    // directly so previewing a large skill never pulls the full bundle
    // (which the metered gateway buffers and rejects with 500). #2617
    return (await downloadSkillBundleManifest(slug)).skill_md;
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
    options?: SkillInstallOptions,
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
    let payloadTotalBytes = 0;
    let syncState: SkillSyncState | null = null;
    if (skill.source === "seren" && skill.sourceUrl) {
      const bundle = await fetchUpstreamSkillBundle(skill, options);
      if (!bundle) {
        throw new Error("Unable to fetch upstream skill content");
      }
      installContent = bundle.skillMd;
      extraFiles = bundle.payloadFiles;
      payloadTotalBytes = bundle.payloadTotalBytes;
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

    emitInstallProgress(options, {
      stage: "installing",
      downloadedBytes: payloadTotalBytes,
      totalBytes: payloadTotalBytes,
      progressPercent: payloadTotalBytes > 0 ? 100 : 0,
      filesCompleted: extraFiles.length,
      filesTotal: extraFiles.length,
      message: "Installing skill files",
    });

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
   * Read a relative file from an installed skill directory as base64 of
   * its raw bytes. Binary-safe counterpart of readFile (#2297).
   */
  async readFileB64(
    skill: InstalledSkill,
    relativePath: string,
  ): Promise<string | null> {
    if (!isTauriRuntime()) {
      return null;
    }

    return invoke<string | null>("read_skill_file_b64", {
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
        // Payload files are hashed from raw bytes: a text read would fail
        // outright (or mangle) binary files like pptx templates (#2297).
        const results = await Promise.all(
          managedPaths.map(async (path) => {
            if (path === "SKILL.md") {
              const content = await this.readContent(skill);
              return {
                path,
                hash:
                  content === null ? null : await computeContentHash(content),
              };
            }
            const contentB64 = await this.readFileB64(skill, path);
            return {
              path,
              hash:
                contentB64 === null
                  ? null
                  : await computeBytesHash(base64ToBytes(contentB64)),
            };
          }),
        );

        for (const { path, hash } of results) {
          if (hash === null) {
            localManagedState[path] = null;
            missingManagedFiles.push(path);
            continue;
          }

          localManagedState[path] = hash;
          if (hash !== skill.syncState.managedFiles[path]) {
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
    await assertOrgFolderConfiguredForPublicPublish(patch.visibility);
    await ensureAuthorIdentityForPublicPublish(patch.visibility);
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
    await assertOrgFolderConfiguredForPublicPublish(options.visibility);
    await ensureAuthorIdentityForPublicPublish(options.visibility);
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
    return data.data;
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
    await assertOrgFolderConfiguredForPublicPublish(
      skill.publisher?.visibility,
    );
    await ensureAuthorIdentityForPublicPublish(skill.publisher?.visibility);
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
   * sync feature existed (pre-v2.3.16), and repair early sync states that
   * stored the install folder (`grant-intake`) instead of the canonical
   * publisher slug (`chief-grants-officer-grant-intake`). Matches installed
   * skills to available Seren Skills by slug or by org-owned
   * `skill_folder_name` with name disambiguation, then writes .seren-sync.json
   * so the upstream refresh flow can detect updates.
   */
  async backfillSyncState(
    installed: InstalledSkill[],
    available: Skill[],
  ): Promise<number> {
    if (!isTauriRuntime()) return 0;

    let backfilled = 0;

    for (const skill of installed) {
      const match = findCatalogBackfillMatch(skill, available);
      if (!match?.sourceUrl) {
        continue;
      }

      if (skill.syncState) {
        if (skill.syncState.upstreamSourceUrl === match.sourceUrl) {
          continue;
        }

        const repairedSyncState: SkillSyncState = {
          ...skill.syncState,
          upstreamSource: "seren",
          upstreamSourceUrl: match.sourceUrl,
          upstreamDeleted: undefined,
        };

        try {
          await invoke("write_skill_sync_state", {
            skillsDir: skill.skillsDir,
            slug: skill.dirName,
            stateJson: JSON.stringify(repairedSyncState),
          });
          backfilled++;
          log.info(
            "[Skills] Repaired sync state for",
            skill.slug,
            "→",
            match.sourceUrl,
          );
        } catch (err) {
          log.warn("[Skills] Failed to repair sync state for", skill.slug, err);
        }
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
