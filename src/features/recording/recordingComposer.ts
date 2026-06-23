// ABOUTME: Composer helpers for turning stopped recordings into skill-draft prompts.
// ABOUTME: Keeps recording prompt insertion consistent across chat surfaces.

import {
  buildRecordingSkillDraftPrompt,
  type RecordingSession,
} from "@seren/recording-core";

export function appendRecordingSkillDraftPrompt(
  current: string,
  session: RecordingSession,
): string {
  const prompt = buildRecordingSkillDraftPrompt(session);
  const trimmed = current.trimEnd();
  return trimmed ? `${trimmed}\n\n${prompt}` : prompt;
}
