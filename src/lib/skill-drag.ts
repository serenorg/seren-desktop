// ABOUTME: Shared drag payload helpers for dropping skills into prompt surfaces.
// ABOUTME: Lets browse cards carry a SKILL.md reference without embedding content in drag data.

import type { InstalledSkill, Skill } from "@/lib/skills";
import { RUN_SKILL_EVENT, type RunSkillEventDetail } from "@/lib/skills/invoke";
import { skills } from "@/services/skills";
import { skillsStore } from "@/stores/skills.store";

export const SKILL_DRAG_MIME = "application/x-seren-skill";
const SKILL_DRAG_TEXT_PREFIX = "seren-skill:";

export interface SkillDragPayload {
  id: string;
  displayName?: string;
  name?: string;
  slug?: string;
  sourceUrl?: string;
}

let currentSkillDragPayload: SkillDragPayload | null = null;

export function setCurrentSkillDragPayload(
  payload: SkillDragPayload | null,
): void {
  currentSkillDragPayload = payload;
}

export function getCurrentSkillDragPayload(): SkillDragPayload | null {
  return currentSkillDragPayload;
}

export function encodeSkillDragPayload(payload: SkillDragPayload): string {
  return JSON.stringify(payload);
}

export function encodeSkillDragText(payload: SkillDragPayload): string {
  return `${SKILL_DRAG_TEXT_PREFIX}${encodeSkillDragPayload(payload)}`;
}

export function decodeSkillDragPayload(
  value: string,
  options?: { requirePrefix?: boolean },
): SkillDragPayload | null {
  try {
    const hasPrefix = value.startsWith(SKILL_DRAG_TEXT_PREFIX);
    if (options?.requirePrefix && !hasPrefix) return null;
    const json = hasPrefix ? value.slice(SKILL_DRAG_TEXT_PREFIX.length) : value;
    const parsed = JSON.parse(json) as Partial<SkillDragPayload>;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    return {
      id: parsed.id,
      displayName:
        typeof parsed.displayName === "string" ? parsed.displayName : undefined,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      slug: typeof parsed.slug === "string" ? parsed.slug : undefined,
      sourceUrl:
        typeof parsed.sourceUrl === "string" ? parsed.sourceUrl : undefined,
    };
  } catch {
    return null;
  }
}

// Try the dataTransfer-bound payload first so a stale module-level signal
// (e.g. a prior drag whose dragend never fired) cannot poison the next drop.
// The signal is a last-resort fallback for browsers that strip dataTransfer
// between dragstart and drop.
export function skillDragPayload(event: DragEvent): SkillDragPayload | null {
  const transfer = event.dataTransfer;
  if (transfer) {
    const direct = transfer.getData(SKILL_DRAG_MIME);
    if (direct) {
      const decoded = decodeSkillDragPayload(direct);
      if (decoded) return decoded;
    }

    const text = transfer.getData("text/plain");
    if (text) {
      const decoded = decodeSkillDragPayload(text, { requirePrefix: true });
      if (decoded) return decoded;
    }
  }

  return getCurrentSkillDragPayload();
}

export function canAcceptSkillDrop(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer?.types ?? []);
  if (types.includes(SKILL_DRAG_MIME)) return true;

  if (types.includes("text/plain")) {
    const text = event.dataTransfer?.getData("text/plain");
    if (text && decodeSkillDragPayload(text, { requirePrefix: true })) {
      return true;
    }
  }

  return getCurrentSkillDragPayload() !== null;
}

function resolveSkill(
  payload: SkillDragPayload,
): Skill | InstalledSkill | null {
  const existing =
    skillsStore.available.find((skill) => skill.id === payload.id) ??
    skillsStore.installed.find((skill) => skill.id === payload.id);
  if (existing) return existing;

  if (!payload.sourceUrl || !payload.slug) return null;
  return {
    id: payload.id,
    slug: payload.slug,
    name: payload.name ?? payload.slug,
    displayName: payload.displayName,
    description: "",
    source: "seren",
    sourceUrl: payload.sourceUrl,
    tags: [],
  };
}

async function readSkillMarkdown(
  skill: Skill | InstalledSkill,
): Promise<string | null> {
  if ("path" in skill) {
    return skills.readContent(skill);
  }
  return skills.fetchContent(skill);
}

async function ensureInstalled(
  skill: Skill | InstalledSkill,
): Promise<InstalledSkill | null> {
  if ("path" in skill) return skill;

  const existing = skillsStore.installed.find((s) => s.slug === skill.slug);
  if (existing) return existing;

  const content = await skills.fetchContent(skill);
  if (!content) return null;
  return skillsStore.install(skill, content, "seren");
}

export interface DraftSkillInvocationResult {
  skill: InstalledSkill;
  installed: boolean;
}

export async function draftSkillInvocationFromDrag(
  payload: SkillDragPayload,
  context: { kind: "chat" | "agent"; threadId: string | null },
): Promise<DraftSkillInvocationResult | null> {
  if (!context.threadId) return null;

  const resolved = resolveSkill(payload);
  if (!resolved) return null;

  const wasInstalled = "path" in resolved;
  const installed = await ensureInstalled(resolved);
  if (!installed) return null;

  window.dispatchEvent(
    new CustomEvent<RunSkillEventDetail>(RUN_SKILL_EVENT, {
      detail: {
        kind: context.kind,
        threadId: context.threadId,
        skill: installed,
      },
    }),
  );

  return {
    skill: installed,
    installed: !wasInstalled,
  };
}

function fenceLongerThanContent(content: string): string {
  let longest = 0;
  for (const match of content.matchAll(/`{3,}/g)) {
    if (match[0].length > longest) longest = match[0].length;
  }
  return "`".repeat(Math.max(3, longest + 1));
}

export async function skillPromptTextForSkill(
  skill: Skill | InstalledSkill,
): Promise<string | null> {
  const content = await readSkillMarkdown(skill);
  if (!content) return null;

  const trimmed = content.trim();
  const name = skill.displayName ?? skill.name;
  const fence = fenceLongerThanContent(trimmed);
  return `Use this SKILL.md as context for ${name}:\n\n${fence}markdown\n${trimmed}\n${fence}`;
}

export async function skillPromptTextFromDrag(
  payload: SkillDragPayload,
): Promise<string | null> {
  const skill = resolveSkill(payload);
  if (!skill) return null;
  return skillPromptTextForSkill(skill);
}
