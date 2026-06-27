// ABOUTME: Helpers for dropping instruction files or folders into the wizard.
// ABOUTME: Routes recognized filenames (SKILL.md, IDENTITY.md, ...) to instruction sections.

import type { AgentAssetFile } from "@/api/seren-agent";
import type { InstructionSections } from "@/lib/employees/instructions";

/** The instruction-file slots the wizard can populate today. */
export type InstructionSlot = keyof InstructionSections;

const FILENAME_TO_SLOT: Record<string, InstructionSlot> = {
  "skill.md": "skill",
  "identity.md": "identity",
  "soul.md": "soul",
  "agents.md": "agents",
  "user.md": "user",
  "memory.md": "memory",
  "tools.md": "tools",
  "heartbeat.md": "heartbeat",
  "eval.md": "eval",
};

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function normalizeResourcePath(path: string): string | null {
  const raw = path.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw || raw.includes("\0")) return null;

  const parts: string[] = [];
  for (const [index, part] of raw.split("/").entries()) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === ".") continue;
    if (trimmed === "..") return null;
    if (
      trimmed.startsWith(".") &&
      !(index === 0 && trimmed.toLowerCase() === ".skills")
    ) {
      return null;
    }
    parts.push(
      index === 0 && trimmed.toLowerCase() === ".skills" ? ".skills" : trimmed,
    );
  }

  return parts.length > 0 ? parts.join("/") : null;
}

export function isRuntimeSkillResourcePath(path: string): boolean {
  const normalized = normalizeResourcePath(path);
  return normalized?.toLowerCase().startsWith(".skills/") ?? false;
}

export function hasHiddenPathSegment(path: string): boolean {
  const parts = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part.length > 0);
  return parts.some(
    (part, index) =>
      part.length > 1 &&
      part.startsWith(".") &&
      !(index === 0 && part === ".skills"),
  );
}

/**
 * Resolve a filename against the instruction-file vocabulary.
 *
 * Case-insensitive; ignores any leading path segments so `skill/SKILL.md`
 * and `bare SKILL.md` both resolve. Returns null for unrecognized names.
 */
export function slotForFilename(name: string): InstructionSlot | null {
  const base = basename(name).toLowerCase();
  if (!base) return null;
  return FILENAME_TO_SLOT[base] ?? null;
}

export interface ImportResult {
  /** Bodies routed to each section. Empty string when no file mapped. */
  sections: Partial<Record<InstructionSlot, string>>;
  /** Best-effort metadata parsed from SKILL.md. */
  skillMetadata: ImportedSkillMetadata | null;
  /** Filenames the importer recognized and routed. */
  routed: string[];
  /** Recognized instruction filenames skipped because an earlier file filled the slot. */
  collided: string[];
  /** Non-instruction files kept as runtime-readable bundle resources. */
  resources: AgentAssetFile[];
  /** Filenames the importer could not safely package. */
  ignored: string[];
}

export interface ImportFileEntry {
  name: string;
  body?: string;
  contentBase64?: string;
  contentType?: string | null;
  sha256?: string;
}

export interface ImportedSkillMetadata {
  slug?: string;
  name?: string;
}

export function importPathForFile(file: {
  name: string;
  path?: string;
  webkitRelativePath?: string;
}): string {
  if (file.webkitRelativePath && file.webkitRelativePath.length > 0) {
    return file.webkitRelativePath;
  }
  return file.name;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
}

export function parseSkillMetadata(body: string): ImportedSkillMetadata | null {
  const metadata: ImportedSkillMetadata = {};
  const frontmatterMatch = body.match(/^---\s*\n([\s\S]*?)\n---\s*\n*/);
  if (frontmatterMatch) {
    const nameMatch = frontmatterMatch[1].match(/^name:\s*(.+?)\s*$/m);
    if (nameMatch) {
      metadata.slug = unquoteYamlScalar(nameMatch[1]);
    }
  }

  const content = frontmatterMatch
    ? body.slice(frontmatterMatch[0].length)
    : body;
  const headingMatch = content.match(/^#\s+(.+?)\s*$/m);
  if (headingMatch) {
    metadata.name = headingMatch[1].trim();
  }

  return metadata.slug || metadata.name ? metadata : null;
}

/**
 * Resolve a set of `{filename, body}` entries to per-slot bodies.
 *
 * When multiple files map to the same slot, the first-supplied wins so a
 * caller can deterministically order their inputs.
 */
export function routeFiles(files: ImportFileEntry[]): ImportResult {
  const sections: Partial<Record<InstructionSlot, string>> = {};
  let skillMetadata: ImportedSkillMetadata | null = null;
  const routed: string[] = [];
  const collided: string[] = [];
  const resources: AgentAssetFile[] = [];
  const ignored: string[] = [];
  const seenResourcePaths = new Set<string>();

  for (const { name, body, contentBase64, contentType, sha256 } of files) {
    if (hasHiddenPathSegment(name)) {
      ignored.push(name);
      continue;
    }
    const runtimeSkillResource = isRuntimeSkillResourcePath(name);
    const slot = runtimeSkillResource ? null : slotForFilename(name);
    if (!slot) {
      const path = normalizeResourcePath(name);
      if (!path || !contentBase64 || seenResourcePaths.has(path)) {
        ignored.push(name);
        continue;
      }
      seenResourcePaths.add(path);
      resources.push({
        path,
        content_base64: contentBase64,
        content_type: contentType || undefined,
        sha256,
        purpose: "resource",
      });
      continue;
    }
    if (body === undefined) {
      ignored.push(name);
      continue;
    }
    if (sections[slot] !== undefined) {
      collided.push(name);
      continue;
    }
    sections[slot] = body;
    if (slot === "skill") {
      skillMetadata = parseSkillMetadata(body);
    }
    routed.push(name);
  }

  return { sections, skillMetadata, routed, collided, resources, ignored };
}
