// ABOUTME: Solid store for Meeting Mode library and live transcript state.
// ABOUTME: Owns loading, active meeting selection, and transcript event updates.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore } from "solid-js/store";
import {
  type MeetingCaptureHandle,
  startMeetingMicCapture,
} from "@/lib/audio/meetingCapture";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import {
  generateMeetingNotes,
  getMeetingTranscriptText,
  getTranscriptSegments,
  listMeetings,
  listMeetingTemplates,
  type Meeting,
  type MeetingTemplate,
  selectMeetingSkills,
  setMeetingRoutedSkill,
  startMeetingCapture as startBackendCapture,
  stopMeetingCapture as stopBackendCapture,
  type TranscriptSegment,
  updateMeetingStatus,
} from "@/services/meetings";
import { orchestrate } from "@/services/orchestrator";
import { conversationStore } from "@/stores/conversation.store";
import { providerStore } from "@/stores/provider.store";
import { settingsStore } from "@/stores/settings.store";
import { skillsStore } from "@/stores/skills.store";

interface MeetingState {
  meetings: Meeting[];
  activeMeeting: Meeting | null;
  liveSegments: TranscriptSegment[];
  captureLevel: number;
  isLoading: boolean;
  error: string | null;
}

const [meetingState, setMeetingState] = createStore<MeetingState>({
  meetings: [],
  activeMeeting: null,
  liveSegments: [],
  captureLevel: 0,
  isLoading: false,
  error: null,
});

let captureHandle: MeetingCaptureHandle | null = null;
let levelTimer: number | null = null;

let transcriptUnlisten: UnlistenFn | null = null;
let statusUnlisten: UnlistenFn | null = null;

async function loadMeetings(): Promise<void> {
  setMeetingState("isLoading", true);
  setMeetingState("error", null);
  if (!isTauriRuntime()) {
    setMeetingState("meetings", []);
    setMeetingState("isLoading", false);
    return;
  }

  try {
    const meetings = await listMeetings();
    setMeetingState("meetings", meetings);
  } catch (error) {
    setMeetingState(
      "error",
      error instanceof Error ? error.message : "Failed to load meetings",
    );
  } finally {
    setMeetingState("isLoading", false);
  }
}

async function setActiveMeeting(meeting: Meeting | null): Promise<void> {
  setMeetingState("activeMeeting", meeting);
  if (!meeting) {
    setMeetingState("liveSegments", []);
    return;
  }
  if (!isTauriRuntime()) {
    setMeetingState("liveSegments", []);
    return;
  }

  try {
    const segments = await getTranscriptSegments(meeting.id);
    setMeetingState("liveSegments", segments);
  } catch (error) {
    setMeetingState(
      "error",
      error instanceof Error ? error.message : "Failed to load transcript",
    );
  }
}

function appendLiveSegment(segment: TranscriptSegment): void {
  setMeetingState("liveSegments", (segments) => {
    const withoutDuplicate = segments.filter((item) => item.id !== segment.id);
    return [...withoutDuplicate, segment].sort((left, right) => {
      if (left.seq !== right.seq) return left.seq - right.seq;
      return left.startMs - right.startMs;
    });
  });
}

async function startMeetingEventListeners(): Promise<void> {
  stopMeetingEventListeners();
  if (!isTauriRuntime()) return;

  transcriptUnlisten = await listen<TranscriptSegment>(
    "meeting://transcript-chunk",
    (event) => {
      const active = meetingState.activeMeeting;
      if (active?.id === event.payload.meetingId) {
        appendLiveSegment(event.payload);
      }
    },
  );

  statusUnlisten = await listen<Meeting>("meeting://status", (event) => {
    setMeetingState("meetings", (meetings) => {
      const next = meetings.some((meeting) => meeting.id === event.payload.id)
        ? meetings.map((meeting) =>
            meeting.id === event.payload.id ? event.payload : meeting,
          )
        : [event.payload, ...meetings];
      return next.sort((left, right) => right.startedAt - left.startedAt);
    });
    if (meetingState.activeMeeting?.id === event.payload.id) {
      setMeetingState("activeMeeting", event.payload);
    }
  });
}

function stopMeetingEventListeners(): void {
  transcriptUnlisten?.();
  statusUnlisten?.();
  transcriptUnlisten = null;
  statusUnlisten = null;
}

async function startCapture(meeting: Meeting): Promise<void> {
  if (!isTauriRuntime()) return;
  await startBackendCapture(meeting.id);
  try {
    captureHandle = await startMeetingMicCapture(meeting.id);
  } catch (error) {
    setMeetingState(
      "error",
      error instanceof Error ? error.message : "Microphone unavailable",
    );
    return;
  }
  if (levelTimer !== null) window.clearInterval(levelTimer);
  levelTimer = window.setInterval(() => {
    setMeetingState("captureLevel", captureHandle?.level() ?? 0);
  }, 60);
}

async function stopCapture(meetingId: string): Promise<void> {
  if (levelTimer !== null) {
    window.clearInterval(levelTimer);
    levelTimer = null;
  }
  setMeetingState("captureLevel", 0);
  if (captureHandle) {
    try {
      await captureHandle.stop();
    } catch {
      // The audio graph may already be torn down; ignore.
    }
    captureHandle = null;
  }
  if (isTauriRuntime()) {
    await stopBackendCapture(meetingId);
  }
}

let templateCache: MeetingTemplate[] | null = null;

async function resolveTemplatePrompt(
  templateId: string | null,
): Promise<string> {
  if (!templateCache) {
    try {
      templateCache = await listMeetingTemplates();
    } catch {
      templateCache = [];
    }
  }
  const custom = settingsStore.get("meetingCustomTemplates");
  const match = [...templateCache, ...custom].find((t) => t.id === templateId);
  return match?.prompt ?? "Summarize key points, decisions, and next steps.";
}

// End capture, generate Tier-1 notes, then hand off to a tagged skill if one is
// installed. With no meeting skill, it stops at notes (Granola parity).
async function stopAndProcess(meeting: Meeting): Promise<void> {
  await stopCapture(meeting.id);
  await loadMeetings();
  if (!isTauriRuntime()) return;

  const templatePrompt = await resolveTemplatePrompt(meeting.templateId);
  try {
    await generateMeetingNotes({
      meetingId: meeting.id,
      model: providerStore.activeModel,
      templatePrompt,
      vocabulary: settingsStore.get("voiceCustomVocabulary"),
    });
  } catch (error) {
    setMeetingState(
      "error",
      error instanceof Error ? error.message : "Notes generation failed",
    );
  }
  await loadMeetings();
  const refreshed =
    meetingState.meetings.find((m) => m.id === meeting.id) ?? null;
  await setActiveMeeting(refreshed);

  await runHandoff(meeting);
}

async function runHandoff(meeting: Meeting): Promise<void> {
  const skillRefs = skillsStore.enabledSkills.map((skill) => ({
    slug: skill.slug,
    name: skill.name,
    description: skill.description ?? "",
    tags: skill.tags ?? [],
    path: skill.path,
  }));

  let meetingSlugs: string[] = [];
  try {
    meetingSlugs = await selectMeetingSkills(skillRefs);
  } catch {
    meetingSlugs = [];
  }
  if (meetingSlugs.length === 0) return;

  const defaultSlug = settingsStore.get("meetingDefaultSkill");
  const chosenSlug =
    defaultSlug && meetingSlugs.includes(defaultSlug)
      ? defaultSlug
      : meetingSlugs[0];
  const chosen = skillRefs.find((skill) => skill.slug === chosenSlug);
  if (!chosen) return;

  const transcript = await getMeetingTranscriptText(meeting.id).catch(() => "");
  const notes =
    meetingState.meetings.find((m) => m.id === meeting.id)?.notesMarkdown ?? "";

  const conversation = await conversationStore.createConversationWithModel(
    `Meeting: ${meeting.title}`.slice(0, 80),
    providerStore.activeModel,
  );
  await setMeetingRoutedSkill(meeting.id, chosenSlug, conversation.id);
  await updateMeetingStatus(meeting.id, "agent_running");
  await loadMeetings();

  const prompt = [
    `Process this completed meeting using the ${chosen.name} meeting skill` +
      (chosen.tags.length ? ` (tags: ${chosen.tags.join(", ")})` : "") +
      ".",
    notes ? `Meeting notes:\n${notes}` : "",
    transcript ? `Transcript:\n${transcript}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  conversationStore.setActiveConversation(conversation.id);
  try {
    await orchestrate(conversation.id, prompt);
  } catch (error) {
    setMeetingState(
      "error",
      error instanceof Error ? error.message : "Agent handoff failed",
    );
  }
}

export const meetingStore = {
  get state(): MeetingState {
    return meetingState;
  },
  loadMeetings,
  setActiveMeeting,
  appendLiveSegment,
  startMeetingEventListeners,
  stopMeetingEventListeners,
  startCapture,
  stopCapture,
  stopAndProcess,
};
