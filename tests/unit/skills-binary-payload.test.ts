// ABOUTME: Regression tests for binary-safe skill payload installs (#2297).
// ABOUTME: Verifies base64 is carried end-to-end and sync hashes use raw bytes.

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledSkill, Skill } from "@/lib/skills";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockDownloadSkill = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: () => true,
}));

vi.mock("@/lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/runtime-console", () => ({
  verboseRuntimeConsole: { debug: vi.fn() },
}));

vi.mock("@/api/seren-skills", () => ({
  createSkill: vi.fn(),
  createVersion: vi.fn(),
  deleteSkill: vi.fn(),
  downloadSkill: mockDownloadSkill,
  listSkills: vi.fn(),
  updateSkill: vi.fn(),
}));

import { skills } from "@/services/skills";

// pptx/zip magic followed by sequences that are NOT valid UTF-8. A text
// round-trip (atob + TextDecoder) mangles these into U+FFFD replacements.
const BINARY_BYTES = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28, 0xa0, 0xa1,
]);
const BINARY_B64 = Buffer.from(BINARY_BYTES).toString("base64");
const SKILL_MD = "# Glide Affinity Proposals\n\nTemplates included.\n";

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const bundle = {
  skill: {
    slug: "glide-affinity-proposals",
    name: "Glide Affinity Proposals",
    updated_at: "2026-06-10T00:00:00Z",
  },
  version: "1.0.0",
  skill_md: SKILL_MD,
  content_hash: "remote-hash-1",
  files: [
    {
      path: "assets/template.pptx",
      content_b64: BINARY_B64,
      is_binary: true,
    },
  ],
};

const catalogSkill: Skill = {
  id: "seren:glide-affinity-proposals",
  slug: "glide-affinity-proposals",
  name: "Glide Affinity Proposals",
  description: "Builds proposals",
  source: "seren",
  sourceUrl: "seren-skills:glide-affinity-proposals",
  tags: [],
};

beforeEach(() => {
  mockInvoke.mockReset();
  mockDownloadSkill.mockReset();
  mockDownloadSkill.mockResolvedValue({
    data: bundle,
    error: undefined,
    response: { status: 200 },
  });
  mockInvoke.mockImplementation(async (cmd: string) => {
    switch (cmd) {
      case "get_seren_skills_dir":
        return "/tmp/seren-skills";
      case "install_skill":
        return "/tmp/seren-skills/glide-affinity-proposals/SKILL.md";
      case "validate_skill_payload":
        return [];
      default:
        return null;
    }
  });
});

describe("binary-safe skill installs (#2297)", () => {
  it("passes payload base64 to install_skill untouched (no UTF-8 round-trip)", async () => {
    await skills.install(catalogSkill, "", "seren", null);

    const installCall = mockInvoke.mock.calls.find(
      (call) => call[0] === "install_skill",
    );
    expect(installCall).toBeDefined();
    const args = installCall?.[1] as { extraFiles: string };
    const extraFiles = JSON.parse(args.extraFiles) as Array<{
      path: string;
      contentB64: string;
    }>;
    expect(extraFiles).toEqual([
      { path: "assets/template.pptx", contentB64: BINARY_B64 },
    ]);
  });

  it("hashes raw payload bytes (not a text round-trip) into sync state", async () => {
    await skills.install(catalogSkill, "", "seren", null);

    const installCall = mockInvoke.mock.calls.find(
      (call) => call[0] === "install_skill",
    );
    const args = installCall?.[1] as { syncStateJson: string };
    const syncState = JSON.parse(args.syncStateJson) as {
      managedFiles: Record<string, string>;
    };
    expect(syncState.managedFiles["assets/template.pptx"]).toBe(
      sha256Hex(BINARY_BYTES),
    );
    expect(syncState.managedFiles["SKILL.md"]).toBe(sha256Hex(SKILL_MD));
  });

  it("does not flag an unmodified binary payload file as locally changed", async () => {
    const installed = {
      id: "local:glide-affinity-proposals",
      slug: "glide-affinity-proposals",
      name: "Glide Affinity Proposals",
      description: "Builds proposals",
      source: "local",
      tags: [],
      scope: "seren",
      skillsDir: "/tmp/seren-skills",
      dirName: "glide-affinity-proposals",
      path: "/tmp/seren-skills/glide-affinity-proposals/SKILL.md",
      installedAt: Date.now(),
      enabled: true,
      contentHash: sha256Hex(SKILL_MD),
      upstreamSource: "seren",
      upstreamSourceUrl: "seren-skills:glide-affinity-proposals",
      syncState: {
        version: 1,
        upstreamSource: "seren",
        upstreamSourceUrl: "seren-skills:glide-affinity-proposals",
        syncedRevision: "remote-hash-1",
        syncedAt: Date.now(),
        managedFiles: {
          "SKILL.md": sha256Hex(SKILL_MD),
          "assets/template.pptx": sha256Hex(BINARY_BYTES),
        },
      },
    } as InstalledSkill;

    mockInvoke.mockImplementation(async (cmd: string, params?: unknown) => {
      switch (cmd) {
        case "read_skill_content":
          return SKILL_MD;
        case "read_skill_file_b64": {
          const { relativePath } = params as { relativePath: string };
          return relativePath === "assets/template.pptx" ? BINARY_B64 : null;
        }
        default:
          return null;
      }
    });

    const status = await skills.inspectSyncStatus(installed);
    expect(status).not.toBeNull();
    expect(status?.state).toBe("current");
    expect(status?.changedLocalFiles).toEqual([]);
    expect(status?.missingManagedFiles).toEqual([]);
  });
});
