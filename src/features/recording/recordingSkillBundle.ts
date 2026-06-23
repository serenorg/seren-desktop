// ABOUTME: Persists generated recording skill drafts into local authoring skills.
// ABOUTME: Keeps recording bundle creation separate from the generic skills service.

import {
  buildRecordingSkillBundle,
  evaluateRecordingPublishReadiness,
  type RecordingSkillDraft,
} from "@seren/recording-core";
import { invoke } from "@tauri-apps/api/core";
import type { SkillSummary } from "@/api/seren-skills";
import type {
  InstalledSkill,
  SkillDiscoverability,
  SkillVisibility,
} from "@/lib/skills";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import { skills } from "@/services/skills";

export interface SavedRecordingSkillBundle {
  slug: string;
  path: string;
  fileCount: number;
}

export interface PublishedRecordingSkillBundle {
  saved: InstalledSkill;
  published: SkillSummary;
  installed: InstalledSkill;
}

export interface PublishRecordingSkillDraftOptions {
  visibility: SkillVisibility;
  discoverability?: SkillDiscoverability;
  version?: string;
  reviewAcknowledged?: boolean;
  publicPermanentAcknowledged?: boolean;
  warningFindingsAcknowledged?: boolean;
}

const RECORDING_PROVENANCE_PATH = ".seren-recording/provenance.json";

function isPublicDistributionVisibility(visibility: SkillVisibility): boolean {
  return visibility === "public" || visibility === "paid";
}

function buildRecordingSkillProvenance(
  draft: RecordingSkillDraft,
  slug: string,
): string {
  const redactionSummary = draft.redactions.reduce(
    (summary, finding) => {
      if (finding.severity === "block") {
        summary.blocking += 1;
        if (!finding.resolved) summary.unresolvedBlocking += 1;
      } else {
        summary.warnings += 1;
        if (!finding.resolved) summary.unresolvedWarnings += 1;
      }
      return summary;
    },
    {
      blocking: 0,
      warnings: 0,
      unresolvedBlocking: 0,
      unresolvedWarnings: 0,
    },
  );

  return `${JSON.stringify(
    {
      version: 1,
      kind: "workflow_recording_provenance",
      slug,
      draftId: draft.id,
      sessionId: draft.sessionId,
      status: draft.status,
      createdAtMs: draft.createdAtMs,
      updatedAtMs: draft.updatedAtMs,
      counts: {
        steps: draft.steps.length,
        inputs: draft.inputs.length,
        assumptions: draft.assumptions.length,
        verification: draft.verification.length,
        recovery: draft.recovery.length,
        redactions: draft.redactions.length,
      },
      capture: draft.capture ?? null,
      redactionSummary,
      publicBundleExcludesRecordingArtifacts: true,
    },
    null,
    2,
  )}\n`;
}

function recordingDraftNotReadyMessage(
  readiness: ReturnType<typeof evaluateRecordingPublishReadiness>,
): string {
  return [
    "Recording skill draft is not ready to save.",
    ...readiness.blockingReasons,
  ].join(" ");
}

export async function saveRecordingSkillDraftAsLocalSkill(
  draft: RecordingSkillDraft,
): Promise<SavedRecordingSkillBundle> {
  if (!isTauriRuntime()) {
    throw new Error(
      "Recording skill bundles can only be saved in Seren Desktop.",
    );
  }

  const readiness = evaluateRecordingPublishReadiness(draft);
  if (!readiness.canPublish) {
    throw new Error(recordingDraftNotReadyMessage(readiness));
  }

  const bundle = buildRecordingSkillBundle(draft);
  const skillMd = bundle.files.find((file) => file.path === "SKILL.md");
  if (!skillMd) {
    throw new Error("Generated recording skill bundle is missing SKILL.md.");
  }

  const extraFiles = bundle.files
    .filter((file) => file.path !== "SKILL.md")
    .map((file) => ({
      path: file.path,
      content: file.content,
    }));
  extraFiles.push({
    path: RECORDING_PROVENANCE_PATH,
    content: buildRecordingSkillProvenance(draft, bundle.slug),
  });
  const skillsDir = await invoke<string>("get_seren_skill_authoring_dir");
  const path = await invoke<string>("create_skill_bundle_folder", {
    skillsDir,
    slug: bundle.slug,
    content: skillMd.content,
    extraFiles: JSON.stringify(extraFiles),
  });

  return {
    slug: bundle.slug,
    path,
    fileCount: bundle.files.length + 1,
  };
}

export async function saveRecordingSkillDraftAsInstalledSkill(
  draft: RecordingSkillDraft,
): Promise<InstalledSkill> {
  const saved = await saveRecordingSkillDraftAsLocalSkill(draft);
  const skillsDir = await skills.getSerenSkillAuthoringDir();
  const installed = await skills.listInstalled(skillsDir, "seren");
  const skill = installed.find(
    (candidate) =>
      candidate.slug === saved.slug && candidate.path === saved.path,
  );
  if (!skill) {
    throw new Error(`Saved recording skill ${saved.slug} could not be loaded.`);
  }
  return skill;
}

export async function publishRecordingSkillDraft(
  draft: RecordingSkillDraft,
  options: PublishRecordingSkillDraftOptions,
): Promise<PublishedRecordingSkillBundle> {
  const readiness = evaluateRecordingPublishReadiness(draft);
  if (!readiness.canPublish) {
    throw new Error(recordingDraftNotReadyMessage(readiness));
  }
  if (
    isPublicDistributionVisibility(options.visibility) &&
    !options.reviewAcknowledged
  ) {
    throw new Error(
      "Acknowledge the generated recording skill review before publishing publicly.",
    );
  }
  if (
    isPublicDistributionVisibility(options.visibility) &&
    !options.publicPermanentAcknowledged
  ) {
    throw new Error(
      "Acknowledge that public recording skills are permanent before publishing.",
    );
  }
  if (
    isPublicDistributionVisibility(options.visibility) &&
    readiness.warningReasons.length > 0 &&
    !options.warningFindingsAcknowledged
  ) {
    throw new Error(
      "Acknowledge generated draft warnings before publishing publicly.",
    );
  }

  const saved = await saveRecordingSkillDraftAsInstalledSkill(draft);
  const published = await skills.publishLocalSkill(saved, {
    visibility: options.visibility,
    discoverability: options.discoverability,
    version: options.version ?? "0.1.0",
  });
  const installed = await skills.installPublishedSkill(published);

  return { saved, published, installed };
}
