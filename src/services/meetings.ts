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
  createdAt: number;
  updatedAt: number;
}

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  seq: number;
  speaker: Speaker;
  text: string;
  startMs: number;
  endMs: number;
  status: SegmentStatus;
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
): Promise<void> {
  return invoke("update_meeting_status", { id, status, endedAt });
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
