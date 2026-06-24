// ABOUTME: Regression tests for the oversized-bundle split-download fallback (#2296).
// ABOUTME: Verifies 500 fallback assembly, manifest-only preview, and race detection.

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill } from "@/lib/skills";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockDownloadSkill = vi.hoisted(() => vi.fn());
const mockDownloadSkillManifest = vi.hoisted(() => vi.fn());
const mockDownloadSkillFile = vi.hoisted(() => vi.fn());

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
  createOrgFolder: vi.fn(),
  createSkill: vi.fn(),
  createVersion: vi.fn(),
  deleteSkill: vi.fn(),
  downloadSkill: mockDownloadSkill,
  downloadSkillFile: mockDownloadSkillFile,
  downloadSkillManifest: mockDownloadSkillManifest,
  getAuthorIdentity: vi.fn(),
  getOrgFolder: vi.fn(),
  listSkills: vi.fn(),
  updateSkill: vi.fn(),
  upsertAuthorIdentity: vi.fn(),
}));

import { skills } from "@/services/skills";

const PPTX_BYTES = new Uint8Array([
  0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28,
]);
const PPTX_B64 = Buffer.from(PPTX_BYTES).toString("base64");
const SCRIPT_TEXT = "print('glide')\n";
const SCRIPT_B64 = Buffer.from(SCRIPT_TEXT, "utf8").toString("base64");
const SKILL_MD = "# Glide Affinity Proposals\n";

function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const oversized500 = {
  data: undefined,
  error: { error: "InternalError", message: "Publisher API response too large" },
  response: { status: 500 },
};

const manifest = {
  skill: {
    slug: "glide-affinity-proposals",
    name: "Glide Affinity Proposals",
    updated_at: "2026-06-10T00:00:00Z",
  },
  version: "1.0.0",
  skill_md: SKILL_MD,
  manifest: { name: "glide-affinity-proposals" },
  content_hash: "remote-hash-1",
  files: [
    {
      path: "assets/template.pptx",
      content_hash: sha256Hex(PPTX_BYTES),
      mode: 0o100644,
      is_binary: true,
      size_bytes: PPTX_BYTES.length,
    },
    {
      path: "scripts/run.py",
      content_hash: sha256Hex(SCRIPT_TEXT),
      mode: 0o100644,
      is_binary: false,
      size_bytes: SCRIPT_TEXT.length,
    },
  ],
};

const filePayloads: Record<string, unknown> = {
  "assets/template.pptx": {
    path: "assets/template.pptx",
    content_b64: PPTX_B64,
    content_hash: sha256Hex(PPTX_BYTES),
    mode: 0o100644,
    is_binary: true,
    version: "1.0.0",
  },
  "scripts/run.py": {
    path: "scripts/run.py",
    content_b64: SCRIPT_B64,
    content_hash: sha256Hex(SCRIPT_TEXT),
    mode: 0o100644,
    is_binary: false,
    version: "1.0.0",
  },
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
  mockDownloadSkillManifest.mockReset();
  mockDownloadSkillFile.mockReset();

  mockDownloadSkill.mockResolvedValue(oversized500);
  mockDownloadSkillManifest.mockResolvedValue({
    data: manifest,
    error: undefined,
    response: { status: 200 },
  });
  mockDownloadSkillFile.mockImplementation(
    async (options: { query: { path: string } }) => ({
      data: filePayloads[options.query.path],
      error: filePayloads[options.query.path] ? undefined : { error: "NotFound" },
      response: { status: filePayloads[options.query.path] ? 200 : 404 },
    }),
  );
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

describe("split-download fallback (#2296)", () => {
  it("assembles the full bundle from manifest + per-file fetches on 500", async () => {
    await skills.install(catalogSkill, "", "seren", null);

    const installCall = mockInvoke.mock.calls.find(
      (call) => call[0] === "install_skill",
    );
    expect(installCall).toBeDefined();
    const args = installCall?.[1] as {
      content: string;
      extraFiles: string;
      syncStateJson: string;
    };
    expect(args.content).toBe(SKILL_MD);

    const extraFiles = JSON.parse(args.extraFiles) as Array<{
      path: string;
      contentB64: string;
    }>;
    expect(extraFiles).toEqual([
      { path: "assets/template.pptx", contentB64: PPTX_B64 },
      { path: "scripts/run.py", contentB64: SCRIPT_B64 },
    ]);

    const syncState = JSON.parse(args.syncStateJson) as {
      syncedRevision: string | null;
      managedFiles: Record<string, string>;
    };
    expect(syncState.syncedRevision).toBe("remote-hash-1");
    expect(syncState.managedFiles["assets/template.pptx"]).toBe(
      sha256Hex(PPTX_BYTES),
    );
  });

  it("reports byte-aware progress while split-downloading payload files", async () => {
    const onProgress = vi.fn();

    await skills.install(catalogSkill, "", "seren", null, { onProgress });

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "downloading",
        downloadedBytes: 0,
        totalBytes: PPTX_BYTES.length + SCRIPT_TEXT.length,
        progressPercent: 0,
        filesCompleted: 0,
        filesTotal: 2,
      }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "downloading",
        downloadedBytes: PPTX_BYTES.length,
        totalBytes: PPTX_BYTES.length + SCRIPT_TEXT.length,
        filesCompleted: 1,
        filesTotal: 2,
      }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "installing",
        downloadedBytes: PPTX_BYTES.length + SCRIPT_TEXT.length,
        totalBytes: PPTX_BYTES.length + SCRIPT_TEXT.length,
        progressPercent: 100,
      }),
    );
  });

  it("serves content preview from the manifest without fetching file bodies", async () => {
    const content = await skills.fetchContent(catalogSkill);
    expect(content).toBe(SKILL_MD);
    expect(mockDownloadSkillManifest).toHaveBeenCalled();
    expect(mockDownloadSkillFile).not.toHaveBeenCalled();
  });

  it("does not fall back on non-500 download failures", async () => {
    mockDownloadSkill.mockResolvedValue({
      data: undefined,
      error: { error: "Forbidden" },
      response: { status: 403 },
    });

    await expect(
      skills.install(catalogSkill, "", "seren", null),
    ).rejects.toThrow(/403/);
    expect(mockDownloadSkillManifest).not.toHaveBeenCalled();
  });

  it("retries a transient 502 from the manifest endpoint and succeeds", async () => {
    vi.useFakeTimers();
    mockDownloadSkillManifest
      .mockResolvedValueOnce({
        data: undefined,
        error: { error: "BadGateway" },
        response: { status: 502 },
      })
      .mockResolvedValueOnce({
        data: manifest,
        error: undefined,
        response: { status: 200 },
      });

    const pending = skills.fetchContent(catalogSkill);
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toBe(SKILL_MD);
    expect(mockDownloadSkillManifest).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("rejects the install when a file was republished mid-download", async () => {
    mockDownloadSkillFile.mockImplementation(
      async (options: { query: { path: string } }) => ({
        data: {
          ...(filePayloads[options.query.path] as Record<string, unknown>),
          version: "1.0.1",
        },
        error: undefined,
        response: { status: 200 },
      }),
    );

    await expect(
      skills.install(catalogSkill, "", "seren", null),
    ).rejects.toThrow(/republished|version/i);
  });
});
