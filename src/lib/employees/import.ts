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
  for (const part of raw.split("/")) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === ".") continue;
    if (trimmed === "..") return null;
    parts.push(trimmed);
  }

  return parts.length > 0 ? parts.join("/") : null;
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
  /** Filenames the importer recognized and routed. */
  routed: string[];
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

/**
 * Resolve a set of `{filename, body}` entries to per-slot bodies.
 *
 * When multiple files map to the same slot, the first-supplied wins so a
 * caller can deterministically order their inputs.
 */
export function routeFiles(files: ImportFileEntry[]): ImportResult {
  const sections: Partial<Record<InstructionSlot, string>> = {};
  const routed: string[] = [];
  const resources: AgentAssetFile[] = [];
  const ignored: string[] = [];
  const seenResourcePaths = new Set<string>();

  for (const { name, body, contentBase64, contentType, sha256 } of files) {
    const slot = slotForFilename(name);
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
      // Already filled by an earlier file in the same drop; skip silently.
      routed.push(name);
      continue;
    }
    sections[slot] = body;
    routed.push(name);
  }

  return { sections, routed, resources, ignored };
}
