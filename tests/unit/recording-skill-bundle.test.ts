// ABOUTME: Tests saving generated recording skill bundles into local authoring.
// ABOUTME: Guards the bridge between recording-core bundles and Tauri skill files.

import type { RecordingSkillDraft } from "@seren/recording-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  publishRecordingSkillDraft,
  saveRecordingSkillDraftAsInstalledSkill,
  saveRecordingSkillDraftAsLocalSkill,
} from "@/features/recording/recordingSkillBundle";
import { isTauriRuntime } from "@/lib/tauri-bridge";

const mockInvoke = vi.hoisted(() => vi.fn());
const mockSkills = vi.hoisted(() => ({
  getSerenSkillAuthoringDir: vi.fn(),
  installPublishedSkill: vi.fn(),
  listInstalled: vi.fn(),
  publishLocalSkill: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauriRuntime: vi.fn(),
}));

vi.mock("@/services/skills", () => ({
  skills: mockSkills,
}));

const isTauriRuntimeMock = vi.mocked(isTauriRuntime);

function readyDraft(overrides: Partial<RecordingSkillDraft> = {}) {
  return {
    id: "draft-save",
    sessionId: "session-save",
    title: "Submit Payroll",
    description: "Submit payroll and verify confirmation.",
    status: "ready_to_publish",
    steps: [
      {
        id: "step-1",
        intent: "Open payroll",
        essential: true,
        needsConfirmation: false,
      },
    ],
    inputs: [],
    assumptions: [],
    verification: [
      {
        kind: "ui_text",
        label: "Confirmation",
        value: "Payroll submitted",
      },
    ],
    recovery: [{ when: "Login required", do: "Ask the user to sign in." }],
    redactions: [],
    capture: {
      targetKind: "browser",
      targetLabel: "Browser workflow",
      qualityStatus: "ready",
      traceEvents: 4,
      traceTruncated: false,
      markers: 1,
      redactedEvents: 0,
      transcriptSegments: 3,
      keyframes: 2,
    },
    createdAtMs: 1,
    updatedAtMs: 2,
    ...overrides,
  } satisfies RecordingSkillDraft;
}

describe("saveRecordingSkillDraftAsLocalSkill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isTauriRuntimeMock.mockReturnValue(true);
    mockSkills.getSerenSkillAuthoringDir.mockResolvedValue(
      "/Users/test/Seren/skills",
    );
    mockSkills.listInstalled.mockResolvedValue([
      {
        id: "local:submit-payroll",
        slug: "submit-payroll",
        name: "Submit Payroll",
        displayName: "Submit Payroll",
        description: "Submit payroll and verify confirmation.",
        source: "local",
        tags: [],
        scope: "seren",
        skillsDir: "/Users/test/Seren/skills",
        dirName: "submit-payroll",
        path: "/Users/test/Seren/skills/submit-payroll/SKILL.md",
        installedAt: 1,
        enabled: true,
        contentHash: "hash",
      },
    ]);
    mockSkills.publishLocalSkill.mockResolvedValue({
      slug: "submit-payroll",
      name: "Submit Payroll",
      description: "Submit payroll and verify confirmation.",
      visibility: "private",
      discoverability: "listed",
      status: "published",
    });
    mockSkills.installPublishedSkill.mockResolvedValue({
      id: "seren:submit-payroll",
      slug: "submit-payroll",
      name: "Submit Payroll",
      displayName: "Submit Payroll",
      description: "Submit payroll and verify confirmation.",
      source: "seren",
      tags: [],
      scope: "seren",
      skillsDir: "/Users/test/.config/seren/skills",
      dirName: "submit-payroll",
      path: "/Users/test/.config/seren/skills/submit-payroll/SKILL.md",
      installedAt: 2,
      enabled: true,
      contentHash: "published-hash",
    });
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === "get_seren_skill_authoring_dir") {
        return "/Users/test/Seren/skills";
      }
      if (command === "create_skill_bundle_folder") {
        return "/Users/test/Seren/skills/submit-payroll/SKILL.md";
      }
      throw new Error(`unexpected command ${command}`);
    });
  });

  it("creates a local authoring skill from the generated public bundle", async () => {
    await expect(saveRecordingSkillDraftAsLocalSkill(readyDraft())).resolves.toEqual(
      {
        slug: "submit-payroll",
        path: "/Users/test/Seren/skills/submit-payroll/SKILL.md",
        fileCount: 7,
      },
    );

    expect(mockInvoke).toHaveBeenNthCalledWith(
      1,
      "get_seren_skill_authoring_dir",
    );
    const createCall = mockInvoke.mock.calls[1];
    expect(createCall?.[0]).toBe("create_skill_bundle_folder");
    const args = createCall?.[1] as {
      skillsDir: string;
      slug: string;
      content: string;
      extraFiles: string;
    };
    expect(args).toMatchObject({
      skillsDir: "/Users/test/Seren/skills",
      slug: "submit-payroll",
    });
    expect(args.content).toContain("# Submit Payroll");
    const extraFiles = JSON.parse(args.extraFiles) as Array<{
      path: string;
      content: string;
    }>;
    expect(extraFiles.map((file) => file.path)).toEqual([
      "skill.spec.yaml",
      "scripts/agent.py",
      "config.example.json",
      "requirements.txt",
      "tests/test_smoke.py",
      ".seren-recording/provenance.json",
    ]);
    const provenance = JSON.parse(
      extraFiles.find(
        (file) => file.path === ".seren-recording/provenance.json",
      )?.content ?? "{}",
    );
    expect(provenance).toMatchObject({
      version: 1,
      kind: "workflow_recording_provenance",
      slug: "submit-payroll",
      draftId: "draft-save",
      sessionId: "session-save",
      publicBundleExcludesRecordingArtifacts: true,
    });
    expect(provenance.counts).toMatchObject({
      steps: 1,
      inputs: 0,
      redactions: 0,
    });
    expect(provenance.capture).toMatchObject({
      targetKind: "browser",
      targetLabel: "Browser workflow",
      traceEvents: 4,
      transcriptSegments: 3,
      keyframes: 2,
    });
    expect(JSON.stringify(provenance)).not.toContain("artifactUrl");
    expect(JSON.stringify(provenance)).not.toContain("data:image");
  });

  it("returns the installed skill row after saving", async () => {
    await expect(
      saveRecordingSkillDraftAsInstalledSkill(readyDraft()),
    ).resolves.toMatchObject({
      slug: "submit-payroll",
      path: "/Users/test/Seren/skills/submit-payroll/SKILL.md",
      scope: "seren",
    });

    expect(mockSkills.getSerenSkillAuthoringDir).toHaveBeenCalledTimes(1);
    expect(mockSkills.listInstalled).toHaveBeenCalledWith(
      "/Users/test/Seren/skills",
      "seren",
    );
  });

  it("surfaces a load failure when the saved skill is not indexed", async () => {
    mockSkills.listInstalled.mockResolvedValue([]);

    await expect(
      saveRecordingSkillDraftAsInstalledSkill(readyDraft()),
    ).rejects.toThrow("Saved recording skill submit-payroll could not be loaded.");
  });

  it("publishes a saved recording skill through the existing skills service", async () => {
    await expect(
      publishRecordingSkillDraft(readyDraft(), {
        visibility: "private",
        version: "0.1.0",
      }),
    ).resolves.toMatchObject({
      saved: { slug: "submit-payroll", source: "local" },
      published: { slug: "submit-payroll" },
      installed: { slug: "submit-payroll", source: "seren" },
    });

    expect(mockSkills.publishLocalSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "submit-payroll",
        path: "/Users/test/Seren/skills/submit-payroll/SKILL.md",
      }),
      {
        visibility: "private",
        discoverability: undefined,
        version: "0.1.0",
      },
    );
    expect(mockSkills.installPublishedSkill).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "submit-payroll" }),
    );
  });

  it("requires review acknowledgement before public publish", async () => {
    await expect(
      publishRecordingSkillDraft(readyDraft(), {
        visibility: "public",
        version: "0.1.0",
      }),
    ).rejects.toThrow("recording skill review");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSkills.publishLocalSkill).not.toHaveBeenCalled();
  });

  it("reports readiness blockers before public acknowledgements", async () => {
    await expect(
      publishRecordingSkillDraft(
        readyDraft({ status: "needs_review", verification: [] }),
        {
          visibility: "public",
          version: "0.1.0",
        },
      ),
    ).rejects.toThrow("Recording skill draft is not ready to save.");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSkills.publishLocalSkill).not.toHaveBeenCalled();
  });

  it("requires permanence acknowledgement before public publish", async () => {
    await expect(
      publishRecordingSkillDraft(readyDraft(), {
        visibility: "public",
        version: "0.1.0",
        reviewAcknowledged: true,
      }),
    ).rejects.toThrow("public recording skills are permanent");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSkills.publishLocalSkill).not.toHaveBeenCalled();
  });

  it("requires acknowledgements before paid publish", async () => {
    await expect(
      publishRecordingSkillDraft(readyDraft(), {
        visibility: "paid",
        version: "0.1.0",
        reviewAcknowledged: true,
      }),
    ).rejects.toThrow("public recording skills are permanent");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSkills.publishLocalSkill).not.toHaveBeenCalled();
  });

  it("publishes publicly after required acknowledgements", async () => {
    await publishRecordingSkillDraft(readyDraft(), {
      visibility: "public",
      version: "0.1.0",
      reviewAcknowledged: true,
      publicPermanentAcknowledged: true,
    });

    expect(mockSkills.publishLocalSkill).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ visibility: "public" }),
    );
  });

  it("requires warning acknowledgement before publishing warnings publicly", async () => {
    const draft = readyDraft({
      assumptions: ["Navigation labels remain stable."],
    });

    await expect(
      publishRecordingSkillDraft(draft, {
        visibility: "public",
        version: "0.1.0",
        reviewAcknowledged: true,
        publicPermanentAcknowledged: true,
      }),
    ).rejects.toThrow("Acknowledge generated draft warnings");

    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockSkills.publishLocalSkill).not.toHaveBeenCalled();
  });

  it("publishes public warning drafts after warning acknowledgement", async () => {
    await publishRecordingSkillDraft(
      readyDraft({ assumptions: ["Navigation labels remain stable."] }),
      {
        visibility: "public",
        version: "0.1.0",
        reviewAcknowledged: true,
        publicPermanentAcknowledged: true,
        warningFindingsAcknowledged: true,
      },
    );

    expect(mockSkills.publishLocalSkill).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ visibility: "public" }),
    );
  });

  it("refuses drafts that are not ready to publish", async () => {
    await expect(
      saveRecordingSkillDraftAsLocalSkill(
        readyDraft({ status: "needs_review", verification: [] }),
      ),
    ).rejects.toThrow("Recording skill draft is not ready to save.");

    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("requires the desktop runtime", async () => {
    isTauriRuntimeMock.mockReturnValue(false);

    await expect(saveRecordingSkillDraftAsLocalSkill(readyDraft())).rejects.toThrow(
      "Recording skill bundles can only be saved in Seren Desktop.",
    );
    expect(mockInvoke).not.toHaveBeenCalled();
  });
});
