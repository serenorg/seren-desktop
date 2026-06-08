// ABOUTME: Frontend service wrappers for Meeting Mode Tauri commands.
// ABOUTME: Keeps meeting persistence and transcript IPC out of Solid components.

import { invoke } from "@tauri-apps/api/core";

export type Speaker = "me" | "them";
export type MeetingStatus =
  | "capturing"
  | "transcribing"
  | "notes_ready"
  | "agent_running"
  | "done"
  | "failed";
export type SegmentStatus = "ok" | "gap";

export interface Meeting {
  id: string;
  title: string;
  sourceApp: string | null;
  startedAt: number;
  endedAt: number | null;
  status: MeetingStatus;
  templateId: string | null;
  routedSkillSlug: string | null;
  agentConversationId: string | null;
  notesMarkdown: string | null;
  notesStructJson: string | null;
  failureReason?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SpeakerSource = "channel" | "diarization";

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  seq: number;
  speaker: Speaker;
  text: string;
  startMs: number;
  endMs: number;
  status: SegmentStatus;
  /** Raw diarization label from the model (e.g. "A"), if any. */
  speakerLabel?: string | null;
  /** Whether `speaker` came from the capture channel or model diarization. */
  speakerSource?: SpeakerSource;
  createdAt: number;
}

export interface CreateMeetingInput {
  title: string;
  sourceApp?: string | null;
  startedAt?: number | null;
  templateId?: string | null;
}

export interface AppendTranscriptSegmentInput {
  meetingId: string;
  seq: number;
  speaker: Speaker;
  text: string;
  startMs: number;
  endMs: number;
  status: SegmentStatus;
}

export function createMeeting(input: CreateMeetingInput): Promise<Meeting> {
  return invoke("create_meeting", {
    title: input.title,
    sourceApp: input.sourceApp ?? null,
    startedAt: input.startedAt ?? null,
    templateId: input.templateId ?? null,
  });
}

export function getMeeting(id: string): Promise<Meeting | null> {
  return invoke("get_meeting", { id });
}

export function listMeetings(limit = 50): Promise<Meeting[]> {
  return invoke("list_meetings", { limit });
}

export function updateMeetingStatus(
  id: string,
  status: MeetingStatus,
  endedAt?: number | null,
  failureReason?: string | null,
): Promise<void> {
  return invoke("update_meeting_status", {
    id,
    status,
    endedAt,
    failureReason,
  });
}

export function updateMeetingNotes(
  id: string,
  notesMarkdown: string,
  notesStructJson: string,
): Promise<void> {
  return invoke("update_meeting_notes", {
    id,
    notesMarkdown,
    notesStructJson,
  });
}

export function setMeetingRoutedSkill(
  id: string,
  routedSkillSlug?: string | null,
  agentConversationId?: string | null,
): Promise<void> {
  return invoke("set_meeting_routed_skill", {
    id,
    routedSkillSlug,
    agentConversationId,
  });
}

export function appendTranscriptSegment(
  input: AppendTranscriptSegmentInput,
): Promise<TranscriptSegment> {
  return invoke("append_transcript_segment", {
    meetingId: input.meetingId,
    seq: input.seq,
    speaker: input.speaker,
    text: input.text,
    startMs: input.startMs,
    endMs: input.endMs,
    status: input.status,
  });
}

export function getTranscriptSegments(
  meetingId: string,
): Promise<TranscriptSegment[]> {
  return invoke("get_transcript_segments", { meetingId });
}

export interface StructuredNotes {
  summary: string;
  actionItems: string[];
  fields: Record<string, unknown>;
}

export interface ParsedNotes {
  markdown: string;
  structured: StructuredNotes;
}

export interface MeetingTemplate {
  id: string;
  name: string;
  prompt: string;
}

export interface SkillRef {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  path: string;
}

export function startMeetingCapture(meetingId: string): Promise<void> {
  return invoke("start_meeting_capture", { meetingId });
}

export function pushCaptureFrame(input: {
  meetingId: string;
  speaker: Speaker;
  samples: number[];
  channels: number;
  sampleRate: number;
}): Promise<void> {
  return invoke("push_capture_frame", {
    meetingId: input.meetingId,
    speaker: input.speaker,
    samples: input.samples,
    channels: input.channels,
    sampleRate: input.sampleRate,
  });
}

export function stopMeetingCapture(meetingId: string): Promise<void> {
  return invoke("stop_meeting_capture", { meetingId });
}

/**
 * Post-call refinement: diarize the full Them recording in one pass and stamp
 * meeting-stable speaker labels onto the live segments. Returns the number of
 * segments relabeled. Best-effort on the backend — resolves to 0 when there's no
 * buffered audio, the audio is too short, or diarization fails.
 */
export function reconcileMeetingSpeakers(meetingId: string): Promise<number> {
  return invoke("reconcile_meeting_speakers", { meetingId });
}

export function generateMeetingNotes(input: {
  meetingId: string;
  model: string;
  templatePrompt: string;
  vocabulary: string[];
}): Promise<ParsedNotes> {
  return invoke("generate_meeting_notes", {
    meetingId: input.meetingId,
    model: input.model,
    templatePrompt: input.templatePrompt,
    vocabulary: input.vocabulary,
  });
}

export function getMeetingTranscriptText(meetingId: string): Promise<string> {
  return invoke("get_meeting_transcript_text", { meetingId });
}

export function selectMeetingSkills(skills: SkillRef[]): Promise<string[]> {
  return invoke("select_meeting_skills", { skills });
}

export function listMeetingTemplates(): Promise<MeetingTemplate[]> {
  return invoke("list_meeting_templates");
}

/**
 * Probe running processes and report whether a meeting capture should arm
 * (an allowlisted meeting app is running). mic-in-use is not probed.
 */
export function meetingAutodetect(allowlist: string[]): Promise<boolean> {
  return invoke("meeting_autodetect", { allowlist });
}
