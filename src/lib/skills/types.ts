// ABOUTME: Type definitions for the Skills Browser feature.
// ABOUTME: Defines Skill, InstalledSkill, and SkillSource types.

/**
 * Source of a skill - where it comes from.
 */
export type SkillSource =
  | "seren"
  | "anthropic"
  | "openai"
  | "community"
  | "local";

/**
 * Skill metadata parsed from SKILL.md frontmatter.
 * Per Agent Skills spec, only name and description are required.
 */
export interface SkillMetadata {
  name: string;
  /** Human-readable display name from frontmatter. */
  displayName?: string;
  description: string;
  slug?: string;
  version?: string;
  author?: string;
  tags?: string[];
  requires?: string[];
  globs?: string[];
  alwaysAllow?: string[];
  /** Repo-relative paths to bundle as shared dependencies under _deps/ */
  includes?: string[];
  /**
   * Hosts this skill is NOT compatible with. When the current host matches
   * one of these values, the skill is filtered from discovery and blocked
   * from invocation. Supported host tokens: "seren-desktop".
   * Spec: serenorg/seren-desktop#1496
   */
  excludeHosts?: string[];
}

/**
 * Visibility of a published skill on Seren Skills.
 * Mirrors `SkillVisibility` from the generated SDK.
 */
export type SkillVisibility = "private" | "public" | "paid";

/**
 * Discoverability of a published skill on Seren Skills.
 * Mirrors `SkillDiscoverability` from the generated SDK.
 */
export type SkillDiscoverability = "listed" | "unlisted";

/**
 * Lifecycle status of a published skill on Seren Skills.
 * Mirrors `SkillStatus` from the generated SDK.
 */
export type SkillPublishStatus =
  | "draft"
  | "published"
  | "suspended"
  | "deleted";

/**
 * Owner-side metadata propagated from the Seren Skills publisher API.
 * Present on catalog Skills and absent on locally-only skills.
 */
export interface SkillPublisherMetadata {
  /** User id of the original creator. Stable. */
  createdByUserId: string;
  /** Current user owner if the record is user-owned. */
  ownerUserId?: string | null;
  /** Visibility of the published record. */
  visibility: SkillVisibility;
  /** Discoverability of the published record. */
  discoverability: SkillDiscoverability;
  /** Publisher lifecycle status. */
  publishStatus: SkillPublishStatus;
}

/**
 * A skill available for installation.
 */
export interface Skill {
  /** Unique identifier: "source:slug" */
  id: string;
  /** URL-friendly slug (e.g., "commit-message") */
  slug: string;
  /**
   * Catalog folder name when this skill is published on Seren Skills.
   * Distinct from `slug` for org-owned skills, which carry an
   * org-namespaced slug (e.g. "autumn-foo") but publish under the bare
   * folder name ("foo"). Used to reconcile installed ↔ catalog rows
   * when the slug diverges from the install directory.
   */
  skillFolderName?: string;
  /** Slug-based name (used for lookups) */
  name: string;
  /** Human-readable display name from frontmatter */
  displayName?: string;
  /** Short description */
  description: string;
  /** Where this skill comes from */
  source: SkillSource;
  /** URL to fetch full SKILL.md content */
  sourceUrl?: string;
  /** Tags for categorization and filtering */
  tags: string[];
  /** Author name or organization */
  author?: string;
  /** Version string */
  version?: string;
  /**
   * ISO timestamp from the Seren Skills API.
   */
  lastModified?: string;
  /**
   * Hosts this skill is NOT compatible with. Propagated from SKILL.md
   * frontmatter. Used to filter Desktop-incompatible skills from catalog
   * discovery. Spec: serenorg/seren-desktop#1496
   */
  excludeHosts?: string[];
  /**
   * Owner-side metadata when the record exists on the Seren Skills
   * publisher. Absent for installed-only / local-only skills.
   */
  publisher?: SkillPublisherMetadata;
}

export interface SkillSyncState {
  /** Metadata schema version */
  version: 1;
  /** Original upstream source for this installation */
  upstreamSource: SkillSource;
  /** Canonical upstream SKILL.md URL */
  upstreamSourceUrl: string;
  /** Upstream revision last synced into this local installation */
  syncedRevision: string | null;
  /** Epoch ms when sync state was last persisted */
  syncedAt: number;
  /** SHA-256 hashes for upstream-managed files, keyed by relative path */
  managedFiles: Record<string, string>;
  /** True when the upstream source returned 404 (skill deleted from repo) */
  upstreamDeleted?: boolean;
}

export interface RemoteSkillRevision {
  sha: string;
  shortSha: string;
  committedAt?: string;
  message?: string;
  url?: string;
  changedFiles: string[];
}

export interface SkillSyncStatus {
  state:
    | "current"
    | "bootstrap-required"
    | "update-available"
    | "local-changes"
    | "error";
  updateAvailable: boolean;
  hasLocalChanges: boolean;
  syncedRevision: string | null;
  remoteRevision: RemoteSkillRevision | null;
  changedLocalFiles: string[];
  localManagedState: Record<string, string | null>;
  missingManagedFiles: string[];
  error?: string;
}

export type SkillInstallProgressStage = "downloading" | "installing";

export interface SkillInstallProgress {
  stage: SkillInstallProgressStage;
  downloadedBytes: number;
  totalBytes: number;
  progressPercent: number;
  filesCompleted: number;
  filesTotal: number;
  currentFile?: string;
  message: string;
}

export interface SkillInstallOptions {
  onProgress?: (progress: SkillInstallProgress) => void;
}

/**
 * Scope where a skill is installed.
 */
export type SkillScope = "seren" | "claude" | "project";

/**
 * An installed skill with additional metadata.
 */
export interface InstalledSkill extends Skill {
  /** Where the skill is installed (user or project scope) */
  scope: SkillScope;
  /** Root skills directory for this installation scope */
  skillsDir: string;
  /** Filesystem directory name (may differ from slug after a rename) */
  dirName: string;
  /** Full path to the SKILL.md file */
  path: string;
  /** Local authoring SKILL.md path when this row represents a published install */
  authoringPath?: string;
  /** Timestamp when the skill was installed */
  installedAt: number;
  /** Whether the skill is currently enabled */
  enabled: boolean;
  /** SHA-256 hash of content for update detection */
  contentHash: string;
  /** Original upstream source, if this installation is synced from a remote skill */
  upstreamSource?: SkillSource;
  /** Original upstream SKILL.md URL, if known */
  upstreamSourceUrl?: string;
  /** Persisted sync metadata for upstream-managed files */
  syncState?: SkillSyncState | null;
  /**
   * Result of post-install / post-refresh payload validation (#1917).
   * `'failed'` means SKILL.md references files that are missing from disk
   * and have no template sibling (`config.example.json`-style). The skill
   * row is kept in `state.installed` so the user can see it, but slash
   * commands and system-prompt injection skip it until a successful
   * refresh moves it back to `'ready'`.
   */
  payloadStatus?: "ready" | "failed";
  /** Files referenced by SKILL.md but missing from disk after install. */
  missingPayloadFiles?: string[];
}

/**
 * State for the skills store.
 */
export interface SkillsState {
  /** All available skills from the index */
  available: Skill[];
  /** All installed skills */
  installed: InstalledSkill[];
  /** Currently selected skill for preview */
  selectedId: string | null;
  /** Loading state */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
}
