// ABOUTME: Instruction-file helpers for deployed virtual employee specs.
// ABOUTME: Builds and parses the shared instruction-file vocabulary used by Seren Cloud.

import type { AgentInstructionFile } from "@/api/seren-agent";

export interface InstructionSections {
  skill: string;
  identity: string;
  soul: string;
  agents: string;
  user: string;
  memory: string;
  tools: string;
  heartbeat: string;
  eval: string;
}

export interface BuildEmployeeInstructionFilesInput {
  name: string;
  slug: string;
  skill: string;
  identity?: string;
  soul?: string;
  agents?: string;
  user?: string;
  memory?: string;
  tools?: string;
  heartbeat?: string;
  eval?: string;
}

const EMPTY_SECTIONS: InstructionSections = {
  skill: "",
  identity: "",
  soul: "",
  agents: "",
  user: "",
  memory: "",
  tools: "",
  heartbeat: "",
  eval: "",
};

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

function stripGeneratedSkillWrapper(content: string): string {
  const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n*/);
  if (!frontmatterMatch) return content.trim();

  const frontmatter = frontmatterMatch[1];
  const generatedByDesktop =
    /^description:\s*["']?.* - virtual employee["']?\s*$/m.test(frontmatter);
  if (!generatedByDesktop) return content.trim();

  const withoutFrontmatter = content.slice(frontmatterMatch[0].length);
  return withoutFrontmatter.replace(/^# .*(?:\n+|$)/, "").trim();
}

export function extractInstructionSections(
  instructions: AgentInstructionFile[] | null | undefined,
): InstructionSections {
  if (!instructions) return { ...EMPTY_SECTIONS };

  const sections = { ...EMPTY_SECTIONS };
  for (const instruction of instructions) {
    const body = instruction.content.trim();
    if (!body) continue;
    switch (instruction.kind) {
      case "skill":
        if (!sections.skill) sections.skill = stripGeneratedSkillWrapper(body);
        break;
      case "identity":
        if (!sections.identity) sections.identity = body;
        break;
      case "soul":
        if (!sections.soul) sections.soul = body;
        break;
      case "agents":
        if (!sections.agents) sections.agents = body;
        break;
      case "user":
        if (!sections.user) sections.user = body;
        break;
      case "memory":
        if (!sections.memory) sections.memory = body;
        break;
      case "tools":
        if (!sections.tools) sections.tools = body;
        break;
      case "heartbeat":
        if (!sections.heartbeat) sections.heartbeat = body;
        break;
      case "eval":
        if (!sections.eval) sections.eval = body;
        break;
    }
  }
  return sections;
}

function instruction(
  kind: AgentInstructionFile["kind"],
  path: string,
  content: string,
): AgentInstructionFile | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  return { kind, path, content: trimmed };
}

export function buildEmployeeInstructionFiles(
  input: BuildEmployeeInstructionFilesInput,
): AgentInstructionFile[] {
  const employeeName = input.name.trim();
  const skillBody = input.skill.trim();
  const skillDocument = `${frontmatterFor(
    employeeName,
    input.slug,
  )}# ${employeeName}\n\n${skillBody}\n`;

  const sections = [
    instruction("identity", "IDENTITY.md", input.identity ?? ""),
    instruction("soul", "SOUL.md", input.soul ?? ""),
    instruction("skill", "SKILL.md", skillDocument),
    instruction("agents", "AGENTS.md", input.agents ?? ""),
    instruction("user", "USER.md", input.user ?? ""),
    instruction("tools", "TOOLS.md", input.tools ?? ""),
    instruction("memory", "MEMORY.md", input.memory ?? ""),
    instruction("heartbeat", "HEARTBEAT.md", input.heartbeat ?? ""),
    instruction("eval", "EVAL.md", input.eval ?? ""),
  ];
  return sections.filter(
    (section): section is AgentInstructionFile => !!section,
  );
}
