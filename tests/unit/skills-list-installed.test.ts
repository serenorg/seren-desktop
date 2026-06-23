// ABOUTME: Regression tests for listAllInstalled dedupe across overlapping scope dirs.
// ABOUTME: Guards against duplicates when projectDir overlaps the authoring dir.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@/api/seren-skills", () => ({
  createOrgFolder: vi.fn(),
  listSkills: vi.fn(),
  downloadSkill: vi.fn(),
  createSkill: vi.fn(),
  createVersion: vi.fn(),
  deleteSkill: vi.fn(),
  updateSkill: vi.fn(),
  getAuthorIdentity: vi.fn(),
  getOrgFolder: vi.fn(),
  upsertAuthorIdentity: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: () => true,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

function setupDirs(dirs: {
  authoring: string;
  seren: string;
  claude: string;
  project: string | null;
}) {
  return (cmd: string, args?: Record<string, unknown>): unknown => {
    if (cmd === "get_seren_skill_authoring_dir") return dirs.authoring;
    if (cmd === "get_seren_skills_dir") return dirs.seren;
    if (cmd === "get_claude_skills_dir") return dirs.claude;
    if (cmd === "get_project_skills_dir") return dirs.project;
    if (cmd === "list_skill_dirs") {
      const skillsDir = (args as { skillsDir: string }).skillsDir;
      const data = dirContents.get(skillsDir);
      return data ? Object.keys(data) : [];
    }
    if (cmd === "read_skill_content") {
      const { skillsDir, slug } = args as { skillsDir: string; slug: string };
      return dirContents.get(skillsDir)?.[slug] ?? null;
    }
    if (cmd === "resolve_skill_path") {
      const { skillsDir, slug } = args as { skillsDir: string; slug: string };
      return `${skillsDir}/${slug}/SKILL.md`;
    }
    if (cmd === "read_skill_sync_state") {
      return null;
    }
    return null;
  };
}

let dirContents: Map<string, Record<string, string>>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  dirContents = new Map();
});

describe("skills.listAllInstalled dedupes overlapping directories", () => {
  it("keeps a single row when projectDir equals the authoring dir", async () => {
    const authoringDir = "/Users/u/Documents/Seren/skills";
    dirContents.set(authoringDir, {
      "test-skill":
        '---\nname: test-skill\ndescription: A skill\nmetadata:\n  tags: "recorded unverified"\n---\n\n# Test\n',
    });

    mockInvoke.mockImplementation(
      setupDirs({
        authoring: authoringDir,
        seren: "/Users/u/.config/seren/skills",
        claude: "/Users/u/.claude/skills",
        // Simulate the user opening ~/Documents/Seren as their project root,
        // which makes <projectRoot>/skills point at the authoring dir.
        project: authoringDir,
      }),
    );

    const { skills } = await import("@/services/skills");
    const result = await skills.listAllInstalled("/Users/u/Documents/Seren");

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      slug: "test-skill",
      scope: "seren",
      tags: ["recorded", "unverified"],
      path: `${authoringDir}/test-skill/SKILL.md`,
    });
  });

  it("keeps separate rows when authoring, runtime, claude and project dirs are all distinct", async () => {
    const authoringDir = "/Users/u/Documents/Seren/skills";
    const serenDir = "/Users/u/.config/seren/skills";
    const claudeDir = "/Users/u/.claude/skills";
    const projectDir = "/Users/u/projects/foo/skills";

    dirContents.set(authoringDir, {
      "authored-only":
        "---\nname: authored-only\ndescription: Authored\n---\n\n# Authored\n",
    });
    dirContents.set(serenDir, {
      "runtime-only":
        "---\nname: runtime-only\ndescription: Runtime\n---\n\n# Runtime\n",
    });
    dirContents.set(claudeDir, {
      "claude-only":
        "---\nname: claude-only\ndescription: Claude\n---\n\n# Claude\n",
    });
    dirContents.set(projectDir, {
      "project-only":
        "---\nname: project-only\ndescription: Project\n---\n\n# Project\n",
    });

    mockInvoke.mockImplementation(
      setupDirs({
        authoring: authoringDir,
        seren: serenDir,
        claude: claudeDir,
        project: projectDir,
      }),
    );

    const { skills } = await import("@/services/skills");
    const result = await skills.listAllInstalled("/Users/u/projects/foo");

    expect(result.map((s) => s.slug).sort()).toEqual([
      "authored-only",
      "claude-only",
      "project-only",
      "runtime-only",
    ]);
  });

  it("attaches authoringPath to a runtime install when the same slug is also authored", async () => {
    const authoringDir = "/Users/u/Documents/Seren/skills";
    const serenDir = "/Users/u/.config/seren/skills";
    const claudeDir = "/Users/u/.claude/skills";

    dirContents.set(authoringDir, {
      "lead-finder":
        "---\nname: lead-finder\ndescription: Authored\n---\n\n# A\n",
    });
    dirContents.set(serenDir, {
      "lead-finder":
        "---\nname: lead-finder\ndescription: Runtime\n---\n\n# R\n",
    });

    mockInvoke.mockImplementation(
      setupDirs({
        authoring: authoringDir,
        seren: serenDir,
        claude: claudeDir,
        project: null,
      }),
    );

    const { skills } = await import("@/services/skills");
    const result = await skills.listAllInstalled(null);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      slug: "lead-finder",
      scope: "seren",
      path: `${serenDir}/lead-finder/SKILL.md`,
      authoringPath: `${authoringDir}/lead-finder/SKILL.md`,
    });
  });
});
