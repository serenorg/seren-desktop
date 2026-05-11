// ABOUTME: Pure helpers and shared types for skill invocation — used by the
// ABOUTME: chat slash-command path and the sidebar Run button event.

import type { InstalledSkill } from "@/lib/skills/types";

export const RUN_SKILL_EVENT = "seren:run-skill" as const;

export interface RunSkillEventDetail {
  kind: "agent" | "chat";
  threadId: string;
  skill: InstalledSkill;
}

export interface BuildDirectiveArgs {
  slug: string;
  content: string | null;
  args?: string;
}

export function buildSkillInvocationDirective({
  slug,
  content,
  args,
}: BuildDirectiveArgs): string {
  if (!content) {
    return args ? `/${slug} ${args}` : `/${slug}`;
  }
  return [
    `<skill-invocation name="${slug}">`,
    `The user has invoked the /${slug} skill. Execute it by following the skill instructions below.`,
    args ? `\nUser request: ${args}` : "",
    `\n${content}`,
    `</skill-invocation>`,
  ].join("\n");
}

export function buildSkillInvocationDisplay(slug: string, args?: string) {
  return args ? `/${slug} ${args}` : `/${slug}`;
}
