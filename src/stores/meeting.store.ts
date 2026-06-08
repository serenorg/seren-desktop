// ABOUTME: Solid store for Meeting Mode library and live transcript state.
// ABOUTME: Owns loading, active meeting selection, and transcript event updates.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore } from "solid-js/store";
import {
  type MeetingCaptureHandle,
  startMeetingMicCapture,
} from "@/lib/audio/meetingCapture";
import { formatTime } from "@/lib/meeting-format";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import {
  closeCaptureWidget,
  onWidgetStopRequest,
  openCaptureWidget,
} from "@/services/captureWidget";
import {
  createMeeting,
  generateMeetingNotes,
  getMeetingTranscriptText,
  getTranscriptSegments,
  listMeetings,
  listMeetingTemplates,
  type Meeting,
  type MeetingTemplate,
  meetingAutodetect,
  selectMeetingSkills,
  setMeetingRoutedSkill,
  startMeetingCapture as startBackendCapture,
  stopMeetingCapture as stopBackendCapture,
  type TranscriptSegment,
  updateMeetingStatus,
} from "@/services/meetings";
import { orchestrate } from "@/services/orchestrator";
import { onTrayToggleCapture, setTrayRecording } from "@/services/tray";
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
  /**
   * True when the auto-detect poll has seen an allowlisted meeting app while
   * nothing is capturing. The panel surfaces an arm prompt; the user starts.
   */
  autoDetectSuggested: boolean;
  /**
   * The meeting awaiting first-run audio priming. Set when a start is requested
   * before the user has acknowledged the permission explainer; the app-wide
   * priming dialog reads this so every start path (panel, tray, auto-detect)
   * honors the gate, not just the panel button.
   */
  primingRequest: Meeting | null;
}

const [meetingState, setMeetingState] = createStore<MeetingState>({
  meetings: [],
  activeMeeting: null,
  liveSegments: [],
  captureLevel: 0,
  isLoading: false,
  error: null,
  autoDetectSuggested: false,
  primingRequest: null,
});

let captureHandle: MeetingCaptureHandle | null = null;
let levelTimer: number | null = null;

let transcriptUnlisten: UnlistenFn | null = null;
let statusUnlisten: UnlistenFn | null = null;
let widgetStopUnlisten: (() => void) | null = null;
let trayToggleUnlisten: (() => void) | null = null;

let autoDetectTimer: number | null = null;
let autoDetectDismissed = false;
const AUTO_DETECT_POLL_MS = 5_000;

// Shared in-flight guard across every start caller (panel, tray, auto-detect)
// so a double-trigger can't launch two mic streams for the same session.
let isStarting = false;

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

  // The floating widget's Stop button can't run the notes/handoff flow in its
  // own webview, so it asks the main window to stop the capture it owns.
  widgetStopUnlisten = await onWidgetStopRequest((meetingId) => {
    const meeting = meetingState.meetings.find((item) => item.id === meetingId);
    if (meeting && meeting.status === "capturing") {
      void stopAndProcess(meeting);
    }
  });

  // The tray menu's Start/Stop action toggles capture through the same flow.
  trayToggleUnlisten = await onTrayToggleCapture(() => {
    void toggleCaptureFromTray();
  });
}

function stopMeetingEventListeners(): void {
  transcriptUnlisten?.();
  statusUnlisten?.();
  widgetStopUnlisten?.();
  trayToggleUnlisten?.();
  transcriptUnlisten = null;
  statusUnlisten = null;
  widgetStopUnlisten = null;
  trayToggleUnlisten = null;
}

async function startCapture(meeting: Meeting): Promise<void> {
  if (!isTauriRuntime()) return;
  await startBackendCapture(meeting.id);
  try {
    captureHandle = await startMeetingMicCapture(meeting.id);
  } catch (error) {
    // The backend capture already started; tear it down and mark the meeting
    // failed so it doesn't linger as a "capturing" zombie, and make sure the
    // widget/tray aren't left signalling an active capture that never began.
    await stopBackendCapture(meeting.id).catch(() => {});
    await updateMeetingStatus(meeting.id, "failed", Date.now()).catch(() => {});
    void closeCaptureWidget();
    void setTrayRecording(false);
    setMeetingState(
      "error",
      error instanceof Error ? error.message : "Microphone unavailable",
    );
    await loadMeetings();
    return;
  }
  if (levelTimer !== null) window.clearInterval(levelTimer);
  levelTimer = window.setInterval(() => {
    setMeetingState("captureLevel", captureHandle?.level() ?? 0);
  }, 60);
  void openCaptureWidget(meeting.id);
  void setTrayRecording(true);
}

// Start a freshly-created meeting and surface it as the active one. Shared by
// every start caller (panel, tray, auto-detect) behind a single in-flight guard
// so a double-trigger can't launch two mic streams.
async function beginCapture(meeting: Meeting): Promise<void> {
  if (!isTauriRuntime() || isStarting) return;
  if (isCapturing()) return;
  isStarting = true;
  try {
    await startCapture(meeting);
    await loadMeetings();
    await setActiveMeeting(meeting);
  } finally {
    isStarting = false;
  }
}

// First-run gate shared by every start path. If the user has already
// acknowledged the audio-permission explainer, start immediately; otherwise
// stash the meeting and let the app-wide priming dialog drive the decision.
async function requestCaptureStart(meeting: Meeting): Promise<void> {
  if (!isTauriRuntime()) return;
  if (settingsStore.get("meetingAudioPrimed")) {
    await beginCapture(meeting);
    return;
  }
  setMeetingState("primingRequest", meeting);
}

// User accepted the explainer: remember the choice, start the stashed meeting,
// and clear the request.
async function confirmPriming(): Promise<void> {
  const meeting = meetingState.primingRequest;
  setMeetingState("primingRequest", null);
  if (!meeting) return;
  settingsStore.set("meetingAudioPrimed", true);
  await beginCapture(meeting);
}

// User dismissed the explainer: abort the pending start without capturing.
function cancelPriming(): void {
  setMeetingState("primingRequest", null);
}

async function stopCapture(meetingId: string): Promise<void> {
  if (levelTimer !== null) {
    window.clearInterval(levelTimer);
    levelTimer = null;
  }
  setMeetingState("captureLevel", 0);
  void closeCaptureWidget();
  void setTrayRecording(false);
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

// Tray Start/Stop action: stop the active capture if one is running, otherwise
// create + request a manual capture. Routing through `requestCaptureStart`
// means the tray honors the first-run priming gate just like the panel button.
async function toggleCaptureFromTray(): Promise<void> {
  if (!isTauriRuntime()) return;
  const active = meetingState.meetings.find(
    (meeting) => meeting.status === "capturing",
  );
  if (active) {
    await stopAndProcess(active);
    return;
  }
  if (isStarting || meetingState.primingRequest) return;
  const meeting = await createMeeting({
    title: `Meeting ${formatTime(Date.now())}`,
    sourceApp: "Tray",
    templateId: settingsStore.get("meetingTemplateId"),
  });
  await requestCaptureStart(meeting);
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
      model: providerStore.resolvedModel(),
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

async function regenerateNotes(
  meeting: Meeting,
  templateId: string,
): Promise<void> {
  if (!isTauriRuntime()) return;
  const templatePrompt = await resolveTemplatePrompt(templateId);
  try {
    await generateMeetingNotes({
      meetingId: meeting.id,
      model: providerStore.resolvedModel(),
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
}

function clearError(): void {
  setMeetingState("error", null);
}

function isCapturing(): boolean {
  return meetingState.meetings.some(
    (meeting) => meeting.status === "capturing",
  );
}

// Opt-in poll: while "auto-detect meetings" is on and nothing is capturing,
// probe for an allowlisted meeting app and surface an arm prompt. The user
// still presses start — capture is never auto-armed without consent.
async function pollAutoDetect(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (!settingsStore.get("meetingAutoDetectEnabled")) {
    setMeetingState("autoDetectSuggested", false);
    return;
  }
  if (isCapturing() || autoDetectDismissed) {
    setMeetingState("autoDetectSuggested", false);
    return;
  }

  try {
    const detected = await meetingAutodetect(
      settingsStore.get("meetingAppAllowlist"),
    );
    setMeetingState("autoDetectSuggested", detected);
  } catch {
    // Probe failures are non-fatal; leave the prompt as-is.
  }
}

function startAutoDetect(): void {
  stopAutoDetect();
  if (!isTauriRuntime()) return;
  void pollAutoDetect();
  autoDetectTimer = window.setInterval(() => {
    void pollAutoDetect();
  }, AUTO_DETECT_POLL_MS);
}

function stopAutoDetect(): void {
  if (autoDetectTimer !== null) {
    window.clearInterval(autoDetectTimer);
    autoDetectTimer = null;
  }
}

// Hide the prompt until the next time no meeting app is detected, so a single
// dismissal doesn't re-nag on every poll for the same running app.
function dismissAutoDetect(): void {
  autoDetectDismissed = true;
  setMeetingState("autoDetectSuggested", false);
}

function resetAutoDetectDismissal(): void {
  autoDetectDismissed = false;
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
  requestCaptureStart,
  confirmPriming,
  cancelPriming,
  stopCapture,
  stopAndProcess,
  regenerateNotes,
  clearError,
  startAutoDetect,
  stopAutoDetect,
  dismissAutoDetect,
  resetAutoDetectDismissal,
};
