// ABOUTME: Frontend service wrappers for Meeting Mode Tauri commands.
// ABOUTME: Keeps meeting persistence and transcript IPC out of Solid components.

import { invoke } from "@tauri-apps/api/core";

export type Speaker = "me" | "them";
export type MeetingStatus =
  | "pending_capture"
  | "capturing"
  | "transcribing"
  | "transcript_ready"
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
  captureDiagnosticsJson?: string | null;
  /** UUID of the auto-published seren-notes entry, when one exists. */
  serenNotesId?: string | null;
  /** How the recording started: "manual", "auto_mic", or "calendar". */
  triggerSource?: string | null;
  /** Matched calendar event id, when associated with a calendar event. */
  calendarEventId?: string | null;
  /** Calendar provider for the matched event (e.g. "google"). */
  calendarProvider?: string | null;
  /** JSON array of attendee names/emails from the matched calendar event. */
  attendeesJson?: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SpeakerSource = "channel" | "diarization";
export type SpeakerAssignmentScope = "meeting" | "segment";

export interface MeetingSpeakerAssignment {
  id: string;
  meetingId: string;
  source: SpeakerSource;
  sourceKey: string;
  displayName: string;
  attendeeEmail?: string | null;
  scope: SpeakerAssignmentScope;
  segmentId?: string | null;
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
  /** Raw diarization label from the model (e.g. "A"), if any. */
  speakerLabel?: string | null;
  /** Whether `speaker` came from the capture channel or model diarization. */
  speakerSource?: SpeakerSource;
  /** User-corrected speaker name resolved from assignment state, if present. */
  speakerDisplayName?: string | null;
  /** Assignment that supplied `speakerDisplayName`, useful for undo/change UI. */
  speakerAssignmentId?: string | null;
  speakerAssignmentScope?: SpeakerAssignmentScope | null;
  createdAt: number;
}

export interface CreateMeetingInput {
  title: string;
  sourceApp?: string | null;
  startedAt?: number | null;
  templateId?: string | null;
  triggerSource?: string | null;
  calendarEventId?: string | null;
  calendarProvider?: string | null;
  attendeesJson?: string | null;
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
    triggerSource: input.triggerSource ?? null,
    calendarEventId: input.calendarEventId ?? null,
    calendarProvider: input.calendarProvider ?? null,
    attendeesJson: input.attendeesJson ?? null,
  });
}

export function getMeeting(id: string): Promise<Meeting | null> {
  return invoke("get_meeting", { id });
}

export function listMeetings(limit = 50): Promise<Meeting[]> {
  return invoke("list_meetings", { limit });
}

export function deleteMeeting(id: string): Promise<void> {
  return invoke("delete_meeting", { id });
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

export function updateMeetingTitle(id: string, title: string): Promise<void> {
  return invoke("update_meeting_title", { id, title });
}

export function updateMeetingTemplate(
  id: string,
  templateId: string | null,
): Promise<void> {
  return invoke("update_meeting_template", { id, templateId });
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

export interface SegmentSpeakerKey {
  source: SpeakerSource;
  sourceKey: string;
}

export function segmentSpeakerKey(
  segment: TranscriptSegment,
): SegmentSpeakerKey {
  const diarized = segment.speakerLabel?.trim();
  if (diarized) {
    return { source: "diarization", sourceKey: diarized };
  }
  return { source: "channel", sourceKey: segment.speaker };
}

export function resolveSpeakerAssignment(
  segment: TranscriptSegment,
  assignments: readonly MeetingSpeakerAssignment[],
): MeetingSpeakerAssignment | null {
  const segmentAssignment =
    assignments.find(
      (assignment) =>
        assignment.scope === "segment" && assignment.segmentId === segment.id,
    ) ?? null;
  if (segmentAssignment) return segmentAssignment;

  const key = segmentSpeakerKey(segment);
  const meetingAssignment = assignments.find(
    (assignment) =>
      assignment.scope === "meeting" &&
      assignment.source === key.source &&
      assignment.sourceKey === key.sourceKey,
  );
  if (meetingAssignment) return meetingAssignment;

  if (key.source === "diarization") {
    return (
      assignments.find(
        (assignment) =>
          assignment.scope === "meeting" &&
          assignment.source === "channel" &&
          assignment.sourceKey === segment.speaker,
      ) ?? null
    );
  }

  return null;
}

export function applySpeakerAssignmentsToSegments(
  segments: readonly TranscriptSegment[],
  assignments: readonly MeetingSpeakerAssignment[],
): TranscriptSegment[] {
  return segments.map((segment) => {
    const assignment = resolveSpeakerAssignment(segment, assignments);
    if (!assignment) {
      return {
        ...segment,
        speakerDisplayName: null,
        speakerAssignmentId: null,
        speakerAssignmentScope: null,
      };
    }
    return {
      ...segment,
      speakerDisplayName: assignment.displayName,
      speakerAssignmentId: assignment.id,
      speakerAssignmentScope: assignment.scope,
    };
  });
}

export function listMeetingSpeakerAssignments(
  meetingId: string,
): Promise<MeetingSpeakerAssignment[]> {
  return invoke("list_meeting_speaker_assignments", { meetingId });
}

export interface UpsertMeetingSpeakerAssignmentInput {
  meetingId: string;
  source: SpeakerSource;
  sourceKey: string;
  displayName: string;
  attendeeEmail?: string | null;
  scope: SpeakerAssignmentScope;
  segmentId?: string | null;
}

export function upsertMeetingSpeakerAssignment(
  input: UpsertMeetingSpeakerAssignmentInput,
): Promise<MeetingSpeakerAssignment> {
  return invoke("upsert_meeting_speaker_assignment", { input });
}

export function deleteMeetingSpeakerAssignment(id: string): Promise<void> {
  return invoke("delete_meeting_speaker_assignment", { id });
}

export async function getTranscriptSegments(
  meetingId: string,
): Promise<TranscriptSegment[]> {
  const [segments, assignments] = await Promise.all([
    invoke<TranscriptSegment[]>("get_transcript_segments", { meetingId }),
    listMeetingSpeakerAssignments(meetingId).catch(
      () => [] as MeetingSpeakerAssignment[],
    ),
  ]);
  return applySpeakerAssignmentsToSegments(segments, assignments);
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

export function isMeetingCaptureActive(meetingId: string): Promise<boolean> {
  return invoke("is_meeting_capture_active", { meetingId });
}

export function isMeetingCapturePaused(meetingId: string): Promise<boolean> {
  return invoke("is_meeting_capture_paused", { meetingId });
}

export interface CaptureStopOutcome {
  hadCapture: boolean;
  nativeMicReady: boolean;
  /**
   * Mid-capture mic disconnects during this capture (#2608). `0` is healthy; a
   * positive value means the "Me" track briefly dropped and self-healed (or
   * stayed down at stop, where `nativeMicReady` is also false).
   */
  nativeMicDisconnectCount: number;
  systemAudioReady: boolean;
  apmReady: boolean;
  apmActive: boolean;
  nativeMicFrameCount: number;
  systemAudioFrameCount: number;
  levelEventCount: number;
  pushFrameCount: number;
  acceptedPushFrameCount: number;
  droppedPushFrameCount: number;
  droppedPushSampleCount: number;
  frameCount: number;
  sampleCount: number;
  speechFrameCount: number;
  chunkCount: number;
  emittedSegmentCount: number;
  emittedGapCount: number;
  persistedSegmentCount: number;
  persistedTextSegmentCount: number;
  apm: {
    initialized: boolean;
    active: boolean;
    echoCancellerEnabled: boolean;
    renderFrameCount: number;
    captureFrameCount: number;
    processedSampleCount: number;
    lastError?: string | null;
  };
  captureDiagnosticsJson: string;
  failureReason?: string | null;
  // Set only when a transport-level transcription failure (quota/auth/5xx) was
  // seen during capture. Drives the support ticket; absent for benign silence.
  transcriptionError?: string | null;
}

export function stopMeetingCapture(
  meetingId: string,
): Promise<CaptureStopOutcome> {
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

/**
 * Re-run the seren-notes publish for a meeting whose previous publish failed
 * (5xx after the backend retry budget) or never ran (auto-publish dropped
 * before the link landed). Idempotent under the per-meeting PublishGuard:
 * if a publish is already in flight, this no-ops on the backend without
 * double-posting. #2343.
 */
export function republishMeetingToSerenNotes(meetingId: string): Promise<void> {
  return invoke("republish_meeting_to_seren_notes", { meetingId });
}

export function selectMeetingSkills(skills: SkillRef[]): Promise<string[]> {
  return invoke("select_meeting_skills", { skills });
}

export function listMeetingTemplates(): Promise<MeetingTemplate[]> {
  return invoke("list_meeting_templates");
}

/**
 * Probe whether meeting capture should arm. Native side requires active input
 * activity; process presence alone is not enough.
 */
export interface MeetingAutodetectResult {
  detected: boolean;
  sourceApp: string | null;
}

export function meetingAutodetect(): Promise<MeetingAutodetectResult> {
  return invoke("meeting_autodetect");
}

/**
 * One auto-record lifecycle action returned by `meetingLifecycleTick`. The Rust
 * decision core owns the state machine; the frontend executes the action with
 * the existing start/stop paths.
 */
export type MeetingLifecycleAction =
  | { kind: "start_capture"; sourceApp: string | null }
  | {
      kind: "stop_capture";
      reason: "app_released" | "silence" | "calendar_end";
    };

/**
 * Advance the auto-record lifecycle one tick. Pass the currently-recording
 * meeting id (for the silence backstop) and an optional matched calendar end.
 * Returns the action to perform, or `null` when nothing changes this tick.
 */
export function meetingLifecycleTick(
  activeMeetingId: string | null,
  calendarEndMs: number | null = null,
): Promise<MeetingLifecycleAction | null> {
  return invoke("meeting_lifecycle_tick", { activeMeetingId, calendarEndMs });
}

/** Tell the lifecycle the user manually stopped capture (suppress auto-restart). */
export function meetingLifecycleNoteManualStop(): Promise<void> {
  return invoke("meeting_lifecycle_note_manual_stop");
}

/**
 * Tell the lifecycle a capture was started outside auto-start (manual/tray/
 * calendar), so auto-stop still protects it.
 */
export function meetingLifecycleNoteCaptureStarted(
  appReleaseStopEnabled = false,
): Promise<void> {
  return invoke("meeting_lifecycle_note_capture_started", {
    appReleaseStopEnabled,
  });
}

/** Tell the lifecycle the wiring failed to start a proposed capture. */
export function meetingLifecycleNoteStartFailed(): Promise<void> {
  return invoke("meeting_lifecycle_note_start_failed");
}

/** Pause a live capture without ending it. Resolves false if none is active. */
export function pauseMeetingCapture(meetingId: string): Promise<boolean> {
  return invoke("pause_meeting_capture", { meetingId });
}

/** Resume a paused capture. Resolves false if none is active. */
export function resumeMeetingCapture(meetingId: string): Promise<boolean> {
  return invoke("resume_meeting_capture", { meetingId });
}
