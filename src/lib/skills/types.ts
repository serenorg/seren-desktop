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
  | "local"
  | "serenorg";

/**
 * Skill metadata parsed from SKILL.md frontmatter.
 * Per Agent Skills spec, only name and description are required.
 */
export interface SkillMetadata {
  name: string;
  description: string;
  slug?: string;
  version?: string;
  author?: string;
  tags?: string[];
  requires?: string[];
  globs?: string[];
  alwaysAllow?: string[];
}

/**
 * A skill available for installation.
 */
export interface Skill {
  /** Unique identifier: "source:slug" */
  id: string;
  /** URL-friendly slug (e.g., "commit-message") */
  slug: string;
  /** Display name */
  name: string;
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
}

/**
 * Index entry from the aggregated skills index.
 */
export interface SkillIndexEntry {
  slug: string;
  name: string;
  description: string;
  source: SkillSource;
  sourceUrl: string;
  tags: string[];
  author?: string;
  version?: string;
}

/**
 * Aggregated skills index response from the skills catalog.
 */
export interface SkillsIndex {
  version: string;
  updatedAt: string;
  skills: SkillIndexEntry[];
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
