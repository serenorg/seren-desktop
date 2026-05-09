// ABOUTME: Persona prompt helpers for deployed virtual employee system prompts.
// ABOUTME: Builds and parses SKILL.md/IDENTITY.md/SOUL.md prompt documents.

export interface PersonaSections {
  skill: string;
  identity: string;
  soul: string;
}

export interface BuildEmployeeSystemPromptInput {
  name: string;
  slug: string;
  skill: string;
  identity?: string;
  soul?: string;
}

const SECTION_MARKER_RE = /^---\s*(SKILL|IDENTITY|SOUL)\.md\s*---\s*$/;

function yamlScalar(s: string): string {
  return JSON.stringify(s);
}

function frontmatterFor(name: string, slug: string): string {
  return [
    "---",
    `name: ${yamlScalar(slug || "employee")}`,
    `description: ${yamlScalar(`${name} - virtual employee`)}`,
    "---",
    "",
  ].join("\n");
}

function stripSkillWrapper(prompt: string): string {
  const withoutFrontmatter = prompt.replace(/^---\s*\n[\s\S]*?\n---\s*\n*/, "");
  const withoutHeading = withoutFrontmatter.replace(/^# .*(?:\n+|$)/, "");
  return withoutHeading.trim();
}

function startsWithSkillMarker(body: string): boolean {
  const firstLine = body.split("\n", 1)[0] ?? "";
  const match = firstLine.match(SECTION_MARKER_RE);
  return match?.[1] === "SKILL";
}

function splitPersonaDocument(body: string): PersonaSections {
  const buf: Record<keyof PersonaSections, string[]> = {
    skill: [],
    identity: [],
    soul: [],
  };
  let current: keyof PersonaSections | null = null;

  for (const line of body.split("\n")) {
    const match = line.match(SECTION_MARKER_RE);
    if (match) {
      current = match[1].toLowerCase() as keyof PersonaSections;
      continue;
    }
    if (current) buf[current].push(line);
  }

  return {
    skill: stripSkillWrapper(buf.skill.join("\n")),
    identity: buf.identity.join("\n").trim(),
    soul: buf.soul.join("\n").trim(),
  };
}

/**
 * Pull editable SKILL.md / IDENTITY.md / SOUL.md bodies from a deployed prompt.
 *
 * The canonical managed-agent shape opens with `--- SKILL.md ---`, then stores
 * the YAML frontmatter and H1 inside the SKILL.md section. Older desktop builds
 * emitted the section marker after frontmatter; keep parsing that legacy shape
 * so edit mode does not drop persona content.
 */
export function extractPersonaSections(
  prompt: string | null | undefined,
): PersonaSections {
  if (!prompt) return { skill: "", identity: "", soul: "" };

  if (startsWithSkillMarker(prompt)) {
    return splitPersonaDocument(prompt);
  }

  const body = stripSkillWrapper(prompt);
  if (startsWithSkillMarker(body)) {
    return splitPersonaDocument(body);
  }

  return { skill: body, identity: "", soul: "" };
}

export function buildEmployeeSystemPrompt(
  input: BuildEmployeeSystemPromptInput,
): string {
  const employeeName = input.name.trim();
  const skillBody = input.skill.trim();
  const identityBody = input.identity?.trim() ?? "";
  const soulBody = input.soul?.trim() ?? "";
  const skillDocument = `${frontmatterFor(
    employeeName,
    input.slug,
  )}# ${employeeName}\n\n${skillBody}\n`;

  if (!identityBody && !soulBody) {
    return skillDocument;
  }

  const parts: string[] = [`--- SKILL.md ---\n${skillDocument.trim()}`];
  if (identityBody) {
    parts.push("--- IDENTITY.md ---", identityBody);
  }
  if (soulBody) {
    parts.push("--- SOUL.md ---", soulBody);
  }
  return `${parts.join("\n\n")}\n`;
}
