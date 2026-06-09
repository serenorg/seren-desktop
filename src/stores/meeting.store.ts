// ABOUTME: Solid store for Meeting Mode library and live transcript state.
// ABOUTME: Owns loading, active meeting selection, and transcript event updates.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { createStore } from "solid-js/store";
import { formatTime } from "@/lib/meeting-format";
import { isTauriRuntime } from "@/lib/tauri-bridge";
import {
  closeCaptureWidget,
  onWidgetStopRequest,
  openCaptureWidget,
} from "@/services/captureWidget";
import {
  type CaptureStopOutcome,
  createMeeting,
  deleteMeeting as deleteMeetingRecord,
  generateMeetingNotes,
  getMeetingTranscriptText,
  getTranscriptSegments,
  isMeetingCaptureActive,
  listMeetings,
  listMeetingTemplates,
  type Meeting,
  type MeetingTemplate,
  meetingAutodetect,
  reconcileMeetingSpeakers,
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
   * True when the auto-detect poll has seen active input while nothing is
   * capturing. The titlebar surfaces an arm prompt; the user starts.
   */
  autoDetectSuggested: boolean;
  autoDetectSourceApp: string | null;
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
  autoDetectSourceApp: null,
  primingRequest: null,
});

let transcriptUnlisten: UnlistenFn | null = null;
let statusUnlisten: UnlistenFn | null = null;
let levelUnlisten: UnlistenFn | null = null;
let segmentsUpdatedUnlisten: UnlistenFn | null = null;
let widgetStopUnlisten: (() => void) | null = null;
let trayToggleUnlisten: (() => void) | null = null;

let autoDetectTimer: number | null = null;
let autoDetectDismissed = false;
const AUTO_DETECT_POLL_MS = 5_000;

// Shared in-flight guard across every start caller (panel, tray, auto-detect)
// so a double-trigger can't launch two mic streams for the same session.
let isStarting = false;

// Stops in flight, keyed by meeting id. Two stop sources (widget + panel, tray +
// panel) can fire near-simultaneously and both pass the status check, double-
// running notes + the agent handoff. This guard makes the second a no-op (#2162).
const processingMeetings = new Set<string>();

interface CaptureLevelEvent {
  meetingId: string;
  speaker: "me" | "them";
  level: number;
}

function meetingErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown error";
}

function captureStartupFailureReason(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  const message = meetingErrorMessage(error).toLowerCase();
  if (
    message.includes("system-audio") ||
    message.includes("audio capture permission") ||
    message.includes("audio-capture") ||
    message.includes("process tap") ||
    message.includes("loopback")
  ) {
    return "System audio capture could not start. Allow system-audio recording for Seren and make sure an output device is available, then start capture again.";
  }
  if (
    message.includes("native microphone") ||
    name === "NotAllowedError" ||
    name === "SecurityError" ||
    message.includes("permission") ||
    message.includes("denied")
  ) {
    return "Microphone access is blocked. Allow microphone access for Seren, then start capture again.";
  }
  if (
    name === "NotFoundError" ||
    message.includes("requested device not found") ||
    message.includes("no default input device")
  ) {
    return "No microphone was found. Connect or enable a microphone, then start capture again.";
  }
  if (message.includes("audio context is suspended")) {
    return "Audio capture could not start because the audio engine is suspended. Click Start capture again from the app window.";
  }
  if (message.includes("media devices") || message.includes("getusermedia")) {
    return "Microphone capture is unavailable in this desktop WebView. Restart Seren and try capture again.";
  }
  return `Meeting capture could not start: ${meetingErrorMessage(error)}`;
}

function notesFailureReason(error: unknown): string {
  const message = meetingErrorMessage(error);
  if (message.toLowerCase().includes("no transcript")) {
    return "No transcript was captured. Check microphone and system-audio permissions, then start capture again.";
  }
  return `Meeting notes could not be generated: ${message}`;
}

async function failMeeting(
  meetingId: string,
  reason: string,
  endedAt: number | null = Date.now(),
): Promise<void> {
  await updateMeetingStatus(meetingId, "failed", endedAt, reason).catch(
    () => {},
  );
  await loadMeetings();
  setMeetingState("error", reason);
  const refreshed =
    meetingState.meetings.find((meeting) => meeting.id === meetingId) ?? null;
  if (meetingState.activeMeeting?.id === meetingId || refreshed) {
    await setActiveMeeting(refreshed);
  }
}

async function loadMeetings(): Promise<void> {
  setMeetingState("isLoading", true);
  setMeetingState("error", null);
  if (!isTauriRuntime()) {
    setMeetingState("meetings", []);
    setMeetingState("autoDetectSourceApp", null);
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
    setMeetingState("liveSegments", sortSegmentsByCapture(segments));
  } catch (error) {
    setMeetingState(
      "error",
      error instanceof Error ? error.message : "Failed to load transcript",
    );
  }
}

// Order transcript segments by capture time, not completion order. `seq` is
// assigned when each chunk's transcription request returns, so the fast Me
// (whisper-1) vs slow Them (diarize) streams would otherwise interleave
// scrambled. startMs is the chunk's capture offset; seq only breaks exact-start
// ties (#2163). Every path that sets liveSegments — live append AND the reload
// paths (setActiveMeeting, the post-call segments-updated refresh) — must run
// through this so the DB's `ORDER BY seq` rows don't render scrambled (#2197).
export function sortSegmentsByCapture(
  segments: readonly TranscriptSegment[],
): TranscriptSegment[] {
  return [...segments].sort((left, right) => {
    if (left.startMs !== right.startMs) return left.startMs - right.startMs;
    return left.seq - right.seq;
  });
}

function appendLiveSegment(segment: TranscriptSegment): void {
  setMeetingState("liveSegments", (segments) => {
    const withoutDuplicate = segments.filter((item) => item.id !== segment.id);
    return sortSegmentsByCapture([...withoutDuplicate, segment]);
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

  levelUnlisten = await listen<CaptureLevelEvent>(
    "meeting://capture-level",
    (event) => {
      const active = meetingState.activeMeeting;
      if (
        active?.id === event.payload.meetingId &&
        event.payload.speaker === "me"
      ) {
        setMeetingState(
          "captureLevel",
          Math.max(0, Math.min(1, event.payload.level)),
        );
      }
    },
  );

  // The post-call diarization pass relabeled some segments in place. Reload the
  // active meeting's segments so the refreshed speaker labels show up live.
  segmentsUpdatedUnlisten = await listen<{ meetingId: string }>(
    "meeting://segments-updated",
    (event) => {
      const active = meetingState.activeMeeting;
      if (active?.id !== event.payload.meetingId) return;
      void getTranscriptSegments(event.payload.meetingId)
        .then((segments) =>
          setMeetingState("liveSegments", sortSegmentsByCapture(segments)),
        )
        .catch(() => {
          // Non-fatal: the existing labels stay; a manual refresh will reload.
        });
    },
  );

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
  levelUnlisten?.();
  segmentsUpdatedUnlisten?.();
  widgetStopUnlisten?.();
  trayToggleUnlisten?.();
  transcriptUnlisten = null;
  statusUnlisten = null;
  levelUnlisten = null;
  segmentsUpdatedUnlisten = null;
  widgetStopUnlisten = null;
  trayToggleUnlisten = null;
}

async function startCapture(meeting: Meeting): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  console.info("[meeting] capture start requested", { meetingId: meeting.id });
  try {
    await startBackendCapture(meeting.id);
    console.info("[meeting] backend capture started", {
      meetingId: meeting.id,
    });
  } catch (error) {
    void closeCaptureWidget();
    void setTrayRecording(false);
    const reason = captureStartupFailureReason(error);
    console.error(
      "[meeting] capture startup failed",
      { meetingId: meeting.id, reason },
      error,
    );
    await loadMeetings();
    const refreshed =
      meetingState.meetings.find((item) => item.id === meeting.id) ?? meeting;
    await setActiveMeeting(refreshed);
    setMeetingState("error", reason);
    return false;
  }
  setMeetingState("captureLevel", 0);
  void openCaptureWidget(meeting.id);
  void setTrayRecording(true);
  return true;
}

// Start a freshly-created meeting and surface it as the active one. Shared by
// every start caller (panel, tray, auto-detect) behind a single in-flight guard
// so a double-trigger can't launch two mic streams.
async function beginCapture(meeting: Meeting): Promise<void> {
  if (!isTauriRuntime() || isStarting) return;
  if (isCapturing(meeting.id)) return;
  isStarting = true;
  try {
    const started = await startCapture(meeting);
    if (!started) return;
    await loadMeetings();
    await setActiveMeeting(
      meetingState.meetings.find((item) => item.id === meeting.id) ?? meeting,
    );
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

// User dismissed the explainer: abort the pending start. The meeting row was
// created `pending_capture` before the gate, so mark it failed; otherwise
// isCapturing() stays true forever and blocks every future capture.
async function cancelPriming(): Promise<void> {
  const meeting = meetingState.primingRequest;
  setMeetingState("primingRequest", null);
  if (!meeting || !isTauriRuntime()) return;
  await failMeeting(
    meeting.id,
    "Capture was canceled before audio permissions were requested.",
  );
}

// At startup, backend capture may still be active even though the renderer
// reloaded. Reattach to that live capture; fail only rows whose backend registry
// is gone or whose post-capture processing cannot survive restart.
const STALE_STATUSES = new Set([
  "pending_capture",
  "capturing",
  "transcribing",
  "agent_running",
]);

async function reconcileStaleCaptures(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const meetings = await listMeetings();
    const stale = meetings.filter((meeting) =>
      STALE_STATUSES.has(meeting.status),
    );
    if (stale.length === 0) return;
    let changed = false;
    let reattached = false;
    for (const meeting of stale) {
      if (meeting.status === "capturing") {
        const active = await isMeetingCaptureActive(meeting.id).catch(
          () => false,
        );
        if (active) {
          void openCaptureWidget(meeting.id);
          void setTrayRecording(true);
          reattached = true;
          if (!meetingState.activeMeeting) {
            await setActiveMeeting(meeting);
          }
          continue;
        }
      }
      changed = true;
      await updateMeetingStatus(
        meeting.id,
        "failed",
        null,
        meeting.status === "capturing"
          ? "Seren found a capturing meeting without an active backend capture. Capture was stopped to prevent a stale recording."
          : "Seren restarted before this meeting finished processing.",
      ).catch(() => {});
    }
    if (changed || reattached) {
      await loadMeetings();
    }
  } catch {
    // Non-fatal: the panel still loads the (possibly stale) list on open.
  }
}

async function stopCapture(
  meetingId: string,
): Promise<CaptureStopOutcome | null> {
  setMeetingState("captureLevel", 0);
  void closeCaptureWidget();
  void setTrayRecording(false);
  if (isTauriRuntime()) {
    return await stopBackendCapture(meetingId);
  }
  return null;
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
// installed. With no meeting skill, it stops at notes (Granola parity). A single
// in-flight guard per meeting keeps two near-simultaneous stop sources (widget,
// tray, panel) from double-running notes + the agent handoff (#2162).
async function stopAndProcess(meeting: Meeting): Promise<void> {
  if (processingMeetings.has(meeting.id)) return;
  processingMeetings.add(meeting.id);
  try {
    const stopOutcome = await stopCapture(meeting.id);
    await loadMeetings();
    if (!isTauriRuntime()) return;
    if (stopOutcome?.failureReason) {
      console.error("[meeting] capture stopped without transcript output", {
        meetingId: meeting.id,
        outcome: stopOutcome,
      });
      await failMeeting(meeting.id, stopOutcome.failureReason, null);
      return;
    }

    if (settingsStore.get("meetingStableSpeakers")) {
      // Post-call speaker refinement: one diarized pass over the full Them
      // recording, reconciled onto the live segments for meeting-stable labels.
      // Fire-and-forget so it never delays notes; the segments-updated event
      // refreshes the transcript when it lands. Best-effort on the backend.
      void reconcileMeetingSpeakers(meeting.id).catch(() => {});
    }

    const templatePrompt = await resolveTemplatePrompt(meeting.templateId);
    try {
      await generateMeetingNotes({
        meetingId: meeting.id,
        model: providerStore.resolvedModel(),
        templatePrompt,
        vocabulary: settingsStore.get("voiceCustomVocabulary"),
      });
    } catch (error) {
      // Notes failed: keep successful transcripts usable instead of marking the
      // recording failed. Only true empty-transcript cases remain failed (#2227).
      const reason = notesFailureReason(error);
      console.error(
        "[meeting] post-capture processing failed",
        { meetingId: meeting.id, reason },
        error,
      );
      const transcript = await getMeetingTranscriptText(meeting.id).catch(
        () => "",
      );
      if (transcript.trim()) {
        await updateMeetingStatus(
          meeting.id,
          "transcript_ready",
          null,
          reason,
        ).catch(() => {});
        await loadMeetings();
        const refreshed =
          meetingState.meetings.find((m) => m.id === meeting.id) ?? null;
        await setActiveMeeting(refreshed);
        setMeetingState("error", reason);
      } else {
        await failMeeting(meeting.id, notesFailureReason(error));
      }
      return;
    }
    await loadMeetings();
    const refreshed =
      meetingState.meetings.find((m) => m.id === meeting.id) ?? null;
    await setActiveMeeting(refreshed);

    await runHandoff(meeting);
  } finally {
    processingMeetings.delete(meeting.id);
  }
}

async function runHandoff(meeting: Meeting): Promise<void> {
  // No transcript means nothing to hand off — guards a notes/transcribe failure
  // from auto-invoking a skill with an empty prompt (#2159).
  const transcript = await getMeetingTranscriptText(meeting.id).catch(() => "");
  if (!transcript.trim()) return;

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
    // The agent finished: drive the status machine to a terminal state so the
    // meeting doesn't sit at `agent_running` forever (#2158). Pass no ended_at
    // so the capture-end timestamp set at stop survives instead of being
    // overwritten with the agent-finish time (#2174).
    await updateMeetingStatus(meeting.id, "done");
  } catch (error) {
    const reason = `Agent handoff failed: ${meetingErrorMessage(error)}`;
    setMeetingState("error", reason);
    await updateMeetingStatus(meeting.id, "failed", null, reason).catch(
      () => {},
    );
  }
  await loadMeetings();
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

async function deleteMeeting(meeting: Meeting): Promise<void> {
  if (!isTauriRuntime()) return;
  setMeetingState("error", null);
  if (
    meeting.status === "pending_capture" ||
    meeting.status === "capturing" ||
    meeting.status === "transcribing" ||
    meeting.status === "agent_running"
  ) {
    setMeetingState("error", "Stop or finish this meeting before deleting it.");
    return;
  }
  try {
    await deleteMeetingRecord(meeting.id);
    const remaining = meetingState.meetings.filter(
      (item) => item.id !== meeting.id,
    );
    setMeetingState("meetings", remaining);
    if (meetingState.activeMeeting?.id === meeting.id) {
      await setActiveMeeting(remaining[0] ?? null);
    }
  } catch (error) {
    setMeetingState(
      "error",
      error instanceof Error ? error.message : "Failed to delete meeting",
    );
  }
}

function isCapturing(ignoreMeetingId?: string): boolean {
  return meetingState.meetings.some(
    (meeting) =>
      meeting.id !== ignoreMeetingId &&
      (meeting.status === "pending_capture" || meeting.status === "capturing"),
  );
}

// Opt-in poll: while "auto-detect meetings" is on and nothing is capturing,
// probe for active input and surface an arm prompt. The user still presses
// start; capture is never auto-armed without consent.
async function pollAutoDetect(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (!settingsStore.get("meetingAutoDetectEnabled")) {
    setMeetingState("autoDetectSuggested", false);
    setMeetingState("autoDetectSourceApp", null);
    return;
  }
  if (isCapturing()) {
    setMeetingState("autoDetectSuggested", false);
    setMeetingState("autoDetectSourceApp", null);
    return;
  }

  try {
    const detection = await meetingAutodetect();
    if (!detection.detected) {
      autoDetectDismissed = false;
      setMeetingState("autoDetectSuggested", false);
      setMeetingState("autoDetectSourceApp", null);
      return;
    }
    setMeetingState("autoDetectSourceApp", detection.sourceApp);
    setMeetingState("autoDetectSuggested", !autoDetectDismissed);
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

// Accept the auto-detect record prompt: clear it, then create + start a meeting
// through the shared priming gate (same path as the tray/panel start), so the
// app-wide prompt honors first-run priming and the in-flight guard.
async function acceptAutoDetect(): Promise<void> {
  if (!isTauriRuntime()) return;
  if (isStarting || meetingState.primingRequest) return;
  const sourceApp = meetingState.autoDetectSourceApp;
  dismissAutoDetect();
  const meeting = await createMeeting({
    title: `Meeting ${formatTime(Date.now())}`,
    sourceApp: meetingState.autoDetectSourceApp ?? sourceApp ?? "Auto-detect",
    templateId: settingsStore.get("meetingTemplateId"),
  });
  await requestCaptureStart(meeting);
}

// Hide the prompt until the next time no input activity is detected, so a
// single dismissal doesn't re-nag on every poll during the same call.
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
  reconcileStaleCaptures,
  stopCapture,
  stopAndProcess,
  regenerateNotes,
  deleteMeeting,
  clearError,
  startAutoDetect,
  stopAutoDetect,
  acceptAutoDetect,
  dismissAutoDetect,
  resetAutoDetectDismissal,
};
