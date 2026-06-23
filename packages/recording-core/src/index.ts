// ABOUTME: Platform-neutral contracts for recording workflows and generated skills.
// ABOUTME: Defines host-adapter boundaries without importing Tauri or browser APIs.

export type RecordingTargetKind = "screen" | "window" | "browser";

export type RecordingCapability =
  | "video"
  | "microphone"
  | "camera"
  | "cursor"
  | "action_trace"
  | "transcript";

export interface RecordingTarget {
  id: string;
  kind: RecordingTargetKind;
  label: string;
  detail: string;
  isAvailable: boolean;
  capabilities: RecordingCapability[];
  limitations: string[];
}

export interface RecordingCaptureWindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecordingCaptureWindow {
  id: string;
  platformId: number;
  pid: number;
  appName: string;
  title: string;
  bounds: RecordingCaptureWindowBounds;
  isFocused: boolean;
  isMinimized: boolean;
  isRecordable: boolean;
}

export interface RecordingCaptureWindowPreview {
  windowId: string;
  capturedAtMs: number;
  artifactUrl: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface RecordingCaptureWindowSelection {
  id: string;
  appName: string;
  title: string;
  bounds: RecordingCaptureWindowBounds;
}

export type RecordingPermissionKey =
  | "screen_recording"
  | "microphone"
  | "camera"
  | "accessibility";

export type RecordingPermissionStatus =
  | "granted"
  | "denied"
  | "prompt"
  | "unknown"
  | "unsupported";

export interface RecordingPermissionCheck {
  key: RecordingPermissionKey;
  status: RecordingPermissionStatus;
  label: string;
  message: string;
  canRequest: boolean;
  requiredFor: RecordingTargetKind[];
}

export interface RecordingPermissionPreflight {
  platform: string;
  checks: RecordingPermissionCheck[];
}

export type RecordingBrowserExtensionStatus =
  | "ready"
  | "not_installed"
  | "blocked"
  | "unknown"
  | "unsupported";

export interface RecordingBrowserExtensionReadiness {
  status: RecordingBrowserExtensionStatus;
  label: string;
  message: string;
  canContinueWithFallback: boolean;
  bannerDisclosure?: string;
}

export interface RecordingPrep {
  goal: string;
  successState: string;
  variableInputs: string;
  preferences: string;
  tosAcknowledged: boolean;
}

export interface RecordingStartRequest {
  targetId: string;
  targetKind: RecordingTargetKind;
  captureWindowId?: string | null;
  captureWindow?: RecordingCaptureWindowSelection | null;
  prep: RecordingPrep;
  includeMicrophone: boolean;
  includeCamera: boolean;
  executableUpgrade: boolean;
}

export interface RecordingSessionContext {
  targetId: string;
  captureWindowId?: string | null;
  captureWindow?: RecordingCaptureWindowSelection | null;
  prep: RecordingPrep;
  includeMicrophone: boolean;
  includeCamera: boolean;
  executableUpgrade: boolean;
  traceScopeNote?: string | null;
}

export interface RecordingCaptureStats {
  backend: string;
  frameWidth?: number | null;
  frameHeight?: number | null;
  targetFps?: number | null;
  effectiveFps?: number | null;
  framesReceived?: number | null;
  framesEncoded?: number | null;
  framesSkipped?: number | null;
  encodeErrorCount?: number | null;
  durationMs?: number | null;
  timeToFirstFrameMs?: number | null;
}

export interface RecordingSession {
  id: string;
  targetKind: RecordingTargetKind;
  targetLabel: string;
  startedAtMs: number;
  outputDir: string | null;
  maxVideoHeight: number;
  artifactUrl?: string | null;
  mimeType?: string | null;
  sizeBytes?: number | null;
  traceArtifactUrl?: string | null;
  traceEventCount?: number | null;
  traceTruncated?: boolean | null;
  markerCount?: number | null;
  redactedEventCount?: number | null;
  transcriptArtifactUrl?: string | null;
  transcriptSegmentCount?: number | null;
  keyframeArtifactUrl?: string | null;
  keyframeCount?: number | null;
  metadataArtifactUrl?: string | null;
  captureStats?: RecordingCaptureStats | null;
  context?: RecordingSessionContext;
  qualityStatus?: RecordingQualityStatus;
  qualityChecks?: RecordingQualityCheck[];
}

export type RecordingMarkerKind = "important" | "varies" | "ignore" | "confirm";

export function recordingMarkerLabel(kind: RecordingMarkerKind): string {
  if (kind === "varies") return "This varies";
  if (kind === "ignore") return "Ignore this";
  if (kind === "confirm") return "Needs confirmation";
  return "Important step";
}

/**
 * Resolves an Alt+digit marker shortcut from a physical key code.
 *
 * Uses `KeyboardEvent.code` (not `.key`): on macOS, Option(Alt)+digit composes
 * a symbol (e.g. Option+3 yields "£"), so `.key` would never equal the digit.
 * `.code` stays "Digit3" regardless of platform or modifier composition.
 */
export function recordingMarkerForShortcutCode(
  code: string,
): RecordingMarkerKind | null {
  switch (code) {
    case "Digit1":
      return "varies";
    case "Digit2":
      return "ignore";
    case "Digit3":
      return "important";
    case "Digit4":
      return "confirm";
    default:
      return null;
  }
}

export type RecordingActionType =
  | "click"
  | "key"
  | "nav"
  | "focus"
  | "scroll"
  | "input"
  | "marker";

export type RecordingTraceSource =
  | "cdp"
  | "ax"
  | "uia"
  | "at_spi"
  | "raw_input"
  | "browser_dom";

export interface RecordingActionEvent {
  tMs: number;
  type: RecordingActionType;
  source: RecordingTraceSource;
  confidence: number;
  url?: string;
  target?: {
    role?: string;
    name?: string;
    selectors?: string[];
    bbox?: { x: number; y: number; width: number; height: number };
  };
  value?: { before?: string; after?: string };
  markerKind?: RecordingMarkerKind;
  redacted: boolean;
  redactionReason?: string;
}

export interface RecordingBrowserExtensionSession {
  id?: string | null;
  startedAtMs?: number | null;
  events?: unknown[] | null;
  truncated?: boolean | null;
  debuggerAttached?: boolean | null;
  debuggerError?: string | null;
}

export interface RecordingBrowserExtensionTraceArtifact {
  trace: RecordingArtifactText | null;
  eventCount: number;
  markerCount: number;
  redactedEventCount: number;
  truncated: boolean;
  debuggerAttached: boolean;
  debuggerError: string | null;
}

export type RecordingQualityStatus = "ready" | "needs_review" | "retry";

export type RecordingQualityCheckKey =
  | "video"
  | "capture_health"
  | "action_trace"
  | "transcript"
  | "target";

export type RecordingQualityCheckStatus = "pass" | "warn" | "fail";

export interface RecordingQualityCheck {
  key: RecordingQualityCheckKey;
  status: RecordingQualityCheckStatus;
  label: string;
  message: string;
}

export interface RecordingArtifactText {
  text: string;
  truncated: boolean;
}

export interface RecordingRunPayloadInput {
  session: RecordingSession;
  videoName: string;
  trace: RecordingArtifactText | null;
  transcript: RecordingArtifactText | null;
  metadata: RecordingArtifactText | null;
  redactions?: RecordingRedactionFinding[];
}

export interface PrepareRecordingRunPayloadInput {
  session: RecordingSession;
  videoName: string;
  trace: RecordingArtifactText | null;
  transcript: RecordingArtifactText | null;
  metadata: RecordingArtifactText | null;
}

export interface PrepareRecordingRunPayloadResult {
  payload: Record<string, unknown>;
  redactions: RecordingRedactionFinding[];
  blockingRedactionCount: number;
  warningRedactionCount: number;
}

export type RecordingSkillInputType =
  | "string"
  | "number"
  | "boolean"
  | "file"
  | "date"
  | "secret";

export interface RecordingSkillInput {
  name: string;
  type: RecordingSkillInputType;
  label: string;
  description?: string;
  required: boolean;
  source?: string;
}

export type RecordingVerificationKind =
  | "ui_text"
  | "url"
  | "file_exists"
  | "api_check"
  | "human_confirmation";

export interface RecordingVerificationCheck {
  kind: RecordingVerificationKind;
  label: string;
  description?: string;
  value?: string;
}

export interface RecordingRecoveryStep {
  when: string;
  do: string;
}

export interface RecordingDraftStep {
  id: string;
  intent: string;
  target?: RecordingActionEvent["target"];
  narration?: string;
  essential: boolean;
  needsConfirmation: boolean;
  sourceEventRange?: { start: number; end: number };
  notes?: string;
}

export type RecordingRedactionFindingSeverity = "block" | "warn";

export type RecordingRedactionArtifact =
  | "trace"
  | "video"
  | "metadata"
  | "context"
  | "transcript";

export interface RecordingRedactionFinding {
  id: string;
  severity: RecordingRedactionFindingSeverity;
  label: string;
  description: string;
  artifact: RecordingRedactionArtifact;
  resolved: boolean;
}

export interface RecordingSkillDraftCaptureSummary {
  targetKind: RecordingTargetKind;
  targetLabel: string;
  qualityStatus: RecordingQualityStatus | null;
  captureStats?: RecordingCaptureStats | null;
  traceEvents: number;
  traceTruncated: boolean;
  markers: number;
  redactedEvents: number;
  transcriptSegments: number;
  keyframes: number;
}

export interface RecordingRedactionScanInput {
  artifact: RecordingRedactionArtifact;
  text: string;
  maxFindings?: number;
}

interface RecordingRedactionPattern {
  key: string;
  severity: RecordingRedactionFindingSeverity;
  label: string;
  description: string;
  pattern: RegExp;
  isMatch?: (value: string) => boolean;
}

export type RecordingSkillDraftStatus =
  | "draft"
  | "needs_review"
  | "blocked"
  | "ready_to_publish";

export interface RecordingSkillDraft {
  id: string;
  sessionId: string;
  title: string;
  description: string;
  status: RecordingSkillDraftStatus;
  steps: RecordingDraftStep[];
  inputs: RecordingSkillInput[];
  assumptions: string[];
  verification: RecordingVerificationCheck[];
  recovery: RecordingRecoveryStep[];
  redactions: RecordingRedactionFinding[];
  capture?: RecordingSkillDraftCaptureSummary;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface RecordingPublishReadiness {
  canPublish: boolean;
  blockingReasons: string[];
  warningReasons: string[];
}

export interface RecordingSkillBundleFile {
  path: string;
  content: string;
}

export interface RecordingSkillBundle {
  slug: string;
  files: RecordingSkillBundleFile[];
}

export interface RecordingSkillDraftReview {
  draft: RecordingSkillDraft;
  readiness: RecordingPublishReadiness;
  bundle: RecordingSkillBundle & {
    fileCount: number;
  };
  parsedAtMs: number;
}

export interface RecordingSkillDraftNormalizationInput {
  session: RecordingSession;
  draft: unknown;
  redactions?: RecordingRedactionFinding[];
  nowMs?: number;
}

export interface RecordingSkillDraftParseInput
  extends Omit<RecordingSkillDraftNormalizationInput, "draft"> {
  text: string;
}

export interface RecordingSkillDraftParseResult {
  draft: RecordingSkillDraft | null;
  error: string | null;
}

export interface RecordingSkillDraftReviewResult {
  review: RecordingSkillDraftReview | null;
  error: string | null;
}

export type RecordingStatus =
  | "idle"
  | "loading"
  | "preparing"
  | "recording"
  | "processing"
  | "error";

export interface RecordingHostAdapter {
  listTargets(): Promise<RecordingTarget[]>;
  listCaptureWindows?(): Promise<RecordingCaptureWindow[]>;
  captureWindowPreview?(
    windowId: string,
  ): Promise<RecordingCaptureWindowPreview>;
  clearWindowPreviews?(): Promise<void> | void;
  checkPermissions?(): Promise<RecordingPermissionPreflight>;
  checkBrowserExtension?(): Promise<RecordingBrowserExtensionReadiness>;
  requestPermission?(
    key: RecordingPermissionKey,
  ): Promise<RecordingPermissionPreflight>;
  /**
   * Opens the OS settings surface for a permission. A denied macOS permission
   * cannot be re-prompted, so this is the only recovery path once denied.
   */
  openPermissionSettings?(key: RecordingPermissionKey): Promise<void>;
  start(request: RecordingStartRequest): Promise<RecordingSession>;
  stop(): Promise<RecordingSession | null>;
  addMarker(kind: RecordingMarkerKind): Promise<void>;
  /**
   * Releases host-owned artifact handles for a stopped session.
   * Adapters that create blob: URLs should revoke them here.
   */
  releaseSessionArtifacts?(session: RecordingSession): Promise<void> | void;
  onExternalStop?(handler: (session: RecordingSession) => void): () => void;
}

export const DEFAULT_RECORDING_PREP: RecordingPrep = {
  goal: "",
  successState: "",
  variableInputs: "",
  preferences: "",
  tosAcknowledged: false,
};

export const RECORDING_MAX_VIDEO_HEIGHT = 720;

/**
 * Upper bound on captured action-trace events. Keeps the forwarded trace
 * payload small and bounded regardless of how long a workflow runs.
 */
export const RECORDING_MAX_TRACE_EVENTS = 1500;

const RECORDING_REDACTION_PATTERNS: RecordingRedactionPattern[] = [
  {
    key: "private_key",
    severity: "block",
    label: "Private key",
    description: "A private key marker appears in the recording artifact.",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  },
  {
    key: "jwt",
    severity: "block",
    label: "Token",
    description: "A JWT-like token appears in the recording artifact.",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    key: "credential_assignment",
    severity: "block",
    label: "Credential",
    description:
      "A credential-like assignment appears in the recording artifact.",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|pwd)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{8,}/i,
  },
  {
    key: "payment_card",
    severity: "block",
    label: "Payment card",
    description: "A payment-card-like value appears in the recording artifact.",
    pattern: /\b(?:\d[ -]*?){13,19}\b/,
    isMatch: isLikelyPaymentCard,
  },
  {
    key: "ssn",
    severity: "block",
    label: "SSN",
    description: "A US SSN-like value appears in the recording artifact.",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  {
    key: "local_file_path",
    severity: "block",
    label: "Local file path",
    description: "A local filesystem path appears in the recording artifact.",
    pattern:
      /(?:\/(?:Users|home|private\/var|var\/folders|tmp)\/[^\s"'<>]+|[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"'<>]+)/,
  },
  {
    key: "local_file_url",
    severity: "block",
    label: "Local file URL",
    description: "A local file URL appears in the recording artifact.",
    pattern: /\bfile:\/\/\/[^\s"'<>]+/i,
  },
  {
    key: "email",
    severity: "warn",
    label: "Email address",
    description: "An email address appears in the recording artifact.",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  },
  {
    key: "internal_url",
    severity: "warn",
    label: "Internal URL",
    description: "An internal or local URL appears in the recording artifact.",
    pattern:
      /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|[^\s/]+(?:\.internal|\.local))(?:[^\s]*)?/i,
  },
];

function sameTraceTarget(
  a: RecordingActionEvent,
  b: RecordingActionEvent,
): boolean {
  const left = a.target;
  const right = b.target;
  if (!left && !right) return true;
  if (!left || !right) return false;
  return (
    left.role === right.role &&
    left.name === right.name &&
    (left.selectors?.[0] ?? "") === (right.selectors?.[0] ?? "")
  );
}

function isLikelyPaymentCard(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * Appends an action event to a trace buffer with two size guards:
 * consecutive scrolls on the same target collapse into the latest position,
 * and non-marker events stop accumulating once the cap is reached. Markers are
 * always retained since they are operator intent, not high-volume noise.
 *
 * Mutates `events` in place and returns whether the event was retained, so
 * callers can flag a trace as truncated.
 */
export function appendRecordingTraceEvent(
  events: RecordingActionEvent[],
  event: RecordingActionEvent,
  maxEvents: number = RECORDING_MAX_TRACE_EVENTS,
): boolean {
  const last = events[events.length - 1];
  if (
    event.type === "scroll" &&
    last?.type === "scroll" &&
    sameTraceTarget(last, event)
  ) {
    events[events.length - 1] = event;
    return true;
  }
  if (event.type !== "marker" && events.length >= maxEvents) {
    return false;
  }
  events.push(event);
  return true;
}

function isRecordingActionType(value: unknown): value is RecordingActionType {
  return (
    value === "click" ||
    value === "key" ||
    value === "nav" ||
    value === "focus" ||
    value === "scroll" ||
    value === "input" ||
    value === "marker"
  );
}

function isRecordingTraceSource(value: unknown): value is RecordingTraceSource {
  return (
    value === "cdp" ||
    value === "ax" ||
    value === "uia" ||
    value === "at_spi" ||
    value === "raw_input" ||
    value === "browser_dom"
  );
}

function isRecordingMarkerKind(value: unknown): value is RecordingMarkerKind {
  return (
    value === "important" ||
    value === "varies" ||
    value === "ignore" ||
    value === "confirm"
  );
}

function finiteNumberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedTextField(value: unknown, maxLength = 512): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function sanitizedRecordingUrl(value: unknown): string | null {
  const raw = boundedTextField(value, 2048);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedRecordingEventValue(
  value: unknown,
): RecordingActionEvent["value"] | undefined {
  if (!isRecord(value)) return undefined;
  const before = boundedTextField(value.before, 512);
  const after = boundedTextField(value.after, 512);
  if (!before && !after) return undefined;
  return {
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  };
}

function normalizedRecordingActionEvent(
  value: unknown,
): RecordingActionEvent | null {
  if (!isRecord(value)) return null;
  if (!isRecordingActionType(value.type)) return null;
  const rawTime = finiteNumberField(value.tMs);
  if (rawTime === null) return null;
  const event: RecordingActionEvent = {
    tMs: Math.max(0, Math.round(rawTime)),
    type: value.type,
    source: isRecordingTraceSource(value.source) ? value.source : "browser_dom",
    confidence: Math.max(
      0,
      Math.min(1, finiteNumberField(value.confidence) ?? 0.5),
    ),
    redacted: value.redacted === true,
  };
  const url = sanitizedRecordingUrl(value.url);
  const target = normalizedTarget(value.target);
  const eventValue = normalizedRecordingEventValue(value.value);
  const markerKind = isRecordingMarkerKind(value.markerKind)
    ? value.markerKind
    : null;
  const redactionReason = boundedTextField(value.redactionReason, 120);
  if (url) event.url = url;
  if (target) event.target = target;
  if (eventValue) event.value = eventValue;
  if (markerKind) event.markerKind = markerKind;
  if (redactionReason) event.redactionReason = redactionReason;
  return event;
}

export function normalizeRecordingBrowserExtensionSession(
  value: unknown,
  maxEvents: number = RECORDING_MAX_TRACE_EVENTS,
): RecordingBrowserExtensionTraceArtifact {
  if (!isRecord(value)) {
    return {
      trace: null,
      eventCount: 0,
      markerCount: 0,
      redactedEventCount: 0,
      truncated: false,
      debuggerAttached: false,
      debuggerError: null,
    };
  }

  const events: RecordingActionEvent[] = [];
  let capTruncated = false;
  for (const rawEvent of Array.isArray(value.events) ? value.events : []) {
    const event = normalizedRecordingActionEvent(rawEvent);
    if (!event) continue;
    if (!appendRecordingTraceEvent(events, event, maxEvents)) {
      capTruncated = true;
    }
  }

  const debuggerError = boundedTextField(value.debuggerError, 240);
  const payload = {
    source: "seren_workflow_recorder_extension",
    sessionId: boundedTextField(value.id, 120),
    startedAtMs: finiteNumberField(value.startedAtMs),
    debugger: {
      attached: value.debuggerAttached === true,
      error: debuggerError,
    },
    truncated: value.truncated === true || capTruncated,
    events,
  };

  return {
    trace:
      events.length > 0
        ? {
            text: JSON.stringify(payload),
            truncated: payload.truncated,
          }
        : null,
    eventCount: events.length,
    markerCount: events.filter((event) => event.type === "marker").length,
    redactedEventCount: events.filter((event) => event.redacted).length,
    truncated: payload.truncated,
    debuggerAttached: payload.debugger.attached,
    debuggerError,
  };
}

export const DEFAULT_RECORDING_TARGETS: RecordingTarget[] = [
  {
    id: "screen",
    kind: "screen",
    label: "Full screen",
    detail: "Record the visible desktop and focused app actions.",
    isAvailable: true,
    capabilities: ["video", "microphone", "cursor", "transcript"],
    limitations: ["Executable traces may require accessibility permission."],
  },
  {
    id: "window",
    kind: "window",
    label: "App window",
    detail: "Record one application window with accessibility-backed actions.",
    isAvailable: true,
    capabilities: ["video", "microphone", "cursor", "transcript"],
    limitations: ["Window enumeration depends on the host adapter."],
  },
  {
    id: "browser",
    kind: "browser",
    label: "Browser",
    detail: "Record a browser workflow with DOM trace when available.",
    isAvailable: true,
    capabilities: [
      "video",
      "microphone",
      "cursor",
      "action_trace",
      "transcript",
    ],
    limitations: ["High-fidelity DOM tracing requires the browser extension."],
  },
];

export function recordingCanStart(
  target: RecordingTarget | null,
  prep: RecordingPrep,
): boolean {
  return Boolean(target?.isAvailable && prep.tosAcknowledged);
}

export function validateRecordingStartRequest(
  targets: RecordingTarget[],
  request: RecordingStartRequest,
): string | null {
  if (!request.prep.tosAcknowledged) {
    return "Acknowledge the target service policy before recording.";
  }

  const target =
    targets.find((candidate) => candidate.id === request.targetId) ?? null;
  if (!target) return "Unknown workflow recording target.";
  if (target.kind !== request.targetKind) {
    return "Workflow recording target kind does not match the selected target.";
  }
  if (!target.isAvailable) {
    return `Workflow recording target is not available: ${target.label}.`;
  }
  if (request.targetKind === "window" && !request.captureWindowId?.trim()) {
    return "Select an app window before recording.";
  }
  if (request.targetKind === "window" && request.captureWindow) {
    if (
      request.captureWindowId &&
      request.captureWindow.id !== request.captureWindowId
    ) {
      return "Capture window metadata does not match the selected window.";
    }
    if (!request.captureWindow.appName.trim()) {
      return "Capture window app name is missing.";
    }
    if (
      request.captureWindow.bounds.width <= 0 ||
      request.captureWindow.bounds.height <= 0
    ) {
      return "Capture window bounds are invalid.";
    }
  }
  if (
    request.includeMicrophone &&
    !target.capabilities.includes("microphone")
  ) {
    return "Workflow recording target does not support microphone capture.";
  }
  if (request.includeCamera && !target.capabilities.includes("camera")) {
    return "Workflow recording target does not support camera capture.";
  }
  if (
    request.executableUpgrade &&
    !target.capabilities.includes("action_trace")
  ) {
    return "Workflow recording target does not support executable action tracing.";
  }

  return null;
}

function recordingPermissionStatusText(
  status: RecordingPermissionStatus,
): string {
  if (status === "unsupported") return "not supported";
  return status;
}

export function findRecordingPermissionBlocker(
  preflight: RecordingPermissionPreflight | null,
  request: RecordingStartRequest,
): string | null {
  if (!preflight) return null;

  const requiredKeys = new Set<RecordingPermissionKey>(["screen_recording"]);
  if (request.includeMicrophone) requiredKeys.add("microphone");
  if (request.includeCamera) requiredKeys.add("camera");
  if (request.executableUpgrade) requiredKeys.add("accessibility");

  const blocker =
    preflight.checks.find(
      (check) =>
        check.requiredFor.includes(request.targetKind) &&
        requiredKeys.has(check.key) &&
        (check.status === "denied" || check.status === "unsupported"),
    ) ?? null;

  return blocker
    ? `${blocker.label} permission is ${recordingPermissionStatusText(blocker.status)}.`
    : null;
}

export function formatRecordingError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Recording failed.";
}

export function cloneDefaultRecordingPrep(): RecordingPrep {
  return { ...DEFAULT_RECORDING_PREP };
}

export function findInitialRecordingTarget(
  targets: RecordingTarget[],
  preferredTargetId: string,
): RecordingTarget | null {
  const preferredTarget =
    targets.find((target) => target.id === preferredTargetId) ?? null;

  if (preferredTarget?.isAvailable) return preferredTarget;

  return (
    targets.find((target) => target.isAvailable) ??
    preferredTarget ??
    targets[0] ??
    null
  );
}

export function getRecordingSessionArtifactUrls(
  session: RecordingSession,
): string[] {
  return [
    session.artifactUrl,
    session.traceArtifactUrl,
    session.transcriptArtifactUrl,
    session.keyframeArtifactUrl,
    session.metadataArtifactUrl,
  ].filter(
    (artifactUrl): artifactUrl is string =>
      typeof artifactUrl === "string" && artifactUrl.length > 0,
  );
}

export function recordingVideoArtifactName(session: RecordingSession): string {
  const mimeType = session.mimeType?.toLowerCase() ?? "";
  if (mimeType.includes("webm")) return "workflow-recording.webm";
  if (mimeType.includes("quicktime")) return "workflow-recording.mov";
  if (mimeType.includes("mp4")) return "workflow-recording-720p.m4v";
  if (mimeType.includes("x-msvideo") || mimeType.includes("avi")) {
    return "workflow-recording.avi";
  }
  return "workflow-recording-video";
}

export function evaluateRecordingSession(
  session: RecordingSession,
): Pick<RecordingSession, "qualityStatus" | "qualityChecks"> {
  const requiresActionTrace =
    session.context?.executableUpgrade ?? session.targetKind === "browser";
  const microphoneRequested = session.context?.includeMicrophone === true;
  const checks: RecordingQualityCheck[] = [
    session.artifactUrl && (session.sizeBytes ?? 0) > 0
      ? {
          key: "video",
          status: "pass",
          label: "Video",
          message: "Video artifact is present.",
        }
      : {
          key: "video",
          status: "fail",
          label: "Video",
          message: "No usable video artifact was produced.",
        },
    ...(session.captureStats
      ? [
          (() => {
            const stats = session.captureStats;
            const encoded = stats.framesEncoded ?? 1;
            const errors = stats.encodeErrorCount ?? 0;
            if (encoded === 0) {
              return {
                key: "capture_health" as const,
                status: "fail" as const,
                label: "Capture",
                message: `The ${stats.backend} backend did not encode any video frames.`,
              };
            }
            if (errors > 0) {
              return {
                key: "capture_health" as const,
                status: "warn" as const,
                label: "Capture",
                message: `The ${stats.backend} backend reported ${errors} encode error(s).`,
              };
            }
            return {
              key: "capture_health" as const,
              status: "pass" as const,
              label: "Capture",
              message: `The ${stats.backend} backend reported a usable capture.`,
            };
          })(),
        ]
      : []),
    !requiresActionTrace
      ? {
          key: "action_trace",
          status: "pass",
          label: "Trace",
          message: "Action trace was not requested.",
        }
      : (session.traceEventCount ?? 0) === 0
        ? {
            key: "action_trace",
            status: "fail",
            label: "Trace",
            message: "No action trace events were captured.",
          }
        : session.traceTruncated
          ? {
              key: "action_trace",
              status: "warn",
              label: "Trace",
              message:
                "Action trace reached the event cap; review the generated draft for missing late steps.",
            }
          : {
              key: "action_trace",
              status: "pass",
              label: "Trace",
              message: "Action trace includes captured events.",
            },
    !microphoneRequested
      ? {
          key: "transcript",
          status: "pass",
          label: "Transcript",
          message: "Microphone transcript was not requested.",
        }
      : session.transcriptArtifactUrl ||
          (session.transcriptSegmentCount ?? 0) > 0
        ? {
            key: "transcript",
            status: "pass",
            label: "Transcript",
            message: "Transcript artifact is present.",
          }
        : {
            key: "transcript",
            status: "warn",
            label: "Transcript",
            message:
              "Microphone capture was requested, but no transcript artifact was produced.",
          },
    session.targetLabel.trim().length > 0
      ? {
          key: "target",
          status: "pass",
          label: "Target",
          message: "Recording target is identified.",
        }
      : {
          key: "target",
          status: "warn",
          label: "Target",
          message: "Recording target identity is incomplete.",
        },
  ];

  const qualityStatus = checks.some((check) => check.status === "fail")
    ? "retry"
    : checks.some((check) => check.status === "warn")
      ? "needs_review"
      : "ready";

  return { qualityStatus, qualityChecks: checks };
}

export function createEmptyRecordingSkillDraft(
  session: RecordingSession,
  nowMs: number = Date.now(),
): RecordingSkillDraft {
  const prep = session.context?.prep;
  const title =
    stringField(prep?.goal) || session.targetLabel || "Recorded workflow";
  const description =
    stringField(prep?.successState) ||
    "Draft generated from a workflow recording.";
  const status =
    session.qualityStatus === "retry"
      ? "blocked"
      : session.qualityStatus === "ready"
        ? "draft"
        : "needs_review";

  return {
    id: `draft-${session.id}`,
    sessionId: session.id,
    title,
    description,
    status,
    steps: [],
    inputs: [],
    assumptions: [],
    verification: [],
    recovery: [],
    redactions: [],
    capture: recordingSkillDraftCaptureSummary(session),
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

function recordingSkillDraftCaptureSummary(
  session: RecordingSession,
): RecordingSkillDraftCaptureSummary {
  return {
    targetKind: session.targetKind,
    targetLabel: session.targetLabel,
    qualityStatus: session.qualityStatus ?? null,
    captureStats: session.captureStats ?? null,
    traceEvents: session.traceEventCount ?? 0,
    traceTruncated: Boolean(session.traceTruncated),
    markers: session.markerCount ?? 0,
    redactedEvents: session.redactedEventCount ?? 0,
    transcriptSegments: session.transcriptSegmentCount ?? 0,
    keyframes: session.keyframeCount ?? 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function recordingCaptureStatsSummary(
  stats: RecordingCaptureStats | null | undefined,
): string {
  if (!stats) return "not reported";
  const parts = [stats.backend];
  if (typeof stats.framesEncoded === "number") {
    parts.push(`${stats.framesEncoded} encoded`);
  }
  if (typeof stats.framesReceived === "number") {
    parts.push(`${stats.framesReceived} received`);
  }
  if (typeof stats.framesSkipped === "number" && stats.framesSkipped > 0) {
    parts.push(`${stats.framesSkipped} skipped`);
  }
  if (typeof stats.effectiveFps === "number") {
    parts.push(`${stats.effectiveFps.toFixed(1)} fps`);
  }
  if (typeof stats.timeToFirstFrameMs === "number") {
    parts.push(`${stats.timeToFirstFrameMs} ms first frame`);
  }
  return parts.join(", ");
}

function safeRecordingCaptureStats(
  stats: RecordingCaptureStats | null | undefined,
): RecordingCaptureStats | null {
  if (!stats || typeof stats.backend !== "string") return null;
  const backend = stats.backend.trim();
  if (!/^[A-Za-z0-9_.-]{1,80}$/.test(backend)) return null;
  const numberField = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? value
      : null;
  const output: RecordingCaptureStats = { backend };
  const frameWidth = numberField(stats.frameWidth);
  const frameHeight = numberField(stats.frameHeight);
  const targetFps = numberField(stats.targetFps);
  const effectiveFps = numberField(stats.effectiveFps);
  const framesReceived = numberField(stats.framesReceived);
  const framesEncoded = numberField(stats.framesEncoded);
  const framesSkipped = numberField(stats.framesSkipped);
  const encodeErrorCount = numberField(stats.encodeErrorCount);
  const durationMs = numberField(stats.durationMs);
  const timeToFirstFrameMs = numberField(stats.timeToFirstFrameMs);
  if (frameWidth !== null) output.frameWidth = frameWidth;
  if (frameHeight !== null) output.frameHeight = frameHeight;
  if (targetFps !== null) output.targetFps = targetFps;
  if (effectiveFps !== null) output.effectiveFps = effectiveFps;
  if (framesReceived !== null) output.framesReceived = framesReceived;
  if (framesEncoded !== null) output.framesEncoded = framesEncoded;
  if (framesSkipped !== null) output.framesSkipped = framesSkipped;
  if (encodeErrorCount !== null) output.encodeErrorCount = encodeErrorCount;
  if (durationMs !== null) output.durationMs = durationMs;
  if (timeToFirstFrameMs !== null) {
    output.timeToFirstFrameMs = timeToFirstFrameMs;
  }
  return output;
}

function booleanField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => stringField(item))
    .filter((item): item is string => Boolean(item));
}

function isSkillInputType(value: unknown): value is RecordingSkillInputType {
  return (
    value === "string" ||
    value === "number" ||
    value === "boolean" ||
    value === "file" ||
    value === "date" ||
    value === "secret"
  );
}

function isVerificationKind(
  value: unknown,
): value is RecordingVerificationKind {
  return (
    value === "ui_text" ||
    value === "url" ||
    value === "file_exists" ||
    value === "api_check" ||
    value === "human_confirmation"
  );
}

function isRedactionSeverity(
  value: unknown,
): value is RecordingRedactionFindingSeverity {
  return value === "block" || value === "warn";
}

function isRedactionArtifact(
  value: unknown,
): value is RecordingRedactionArtifact {
  return (
    value === "trace" ||
    value === "video" ||
    value === "metadata" ||
    value === "context" ||
    value === "transcript"
  );
}

function isDraftStatus(value: unknown): value is RecordingSkillDraftStatus {
  return (
    value === "draft" ||
    value === "needs_review" ||
    value === "blocked" ||
    value === "ready_to_publish"
  );
}

function normalizedTarget(
  value: unknown,
): RecordingActionEvent["target"] | undefined {
  if (!isRecord(value)) return undefined;
  const target: RecordingActionEvent["target"] = {};
  const role = stringField(value.role);
  const name = stringField(value.name);
  const selectors = Array.isArray(value.selectors)
    ? value.selectors
        .map((selector) => stringField(selector))
        .filter((selector): selector is string => Boolean(selector))
    : undefined;

  if (role) target.role = role;
  if (name) target.name = name;
  if (selectors?.length) target.selectors = selectors;
  if (isRecord(value.bbox)) {
    const { x, y, width, height } = value.bbox;
    if (
      typeof x === "number" &&
      typeof y === "number" &&
      typeof width === "number" &&
      typeof height === "number"
    ) {
      target.bbox = { x, y, width, height };
    }
  }

  return Object.keys(target).length > 0 ? target : undefined;
}

function normalizedSourceEventRange(
  value: unknown,
): RecordingDraftStep["sourceEventRange"] | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.start !== "number" || typeof value.end !== "number") {
    return undefined;
  }
  if (value.start < 0 || value.end < value.start) return undefined;
  return { start: value.start, end: value.end };
}

function normalizedSteps(value: unknown): RecordingDraftStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index): RecordingDraftStep[] => {
    if (!isRecord(item)) return [];
    const intent = stringField(item.intent);
    if (!intent) return [];
    const id = stringField(item.id) ?? `step-${index + 1}`;
    const step: RecordingDraftStep = {
      id,
      intent,
      essential: booleanField(item.essential, true),
      needsConfirmation: booleanField(item.needsConfirmation, false),
    };
    const target = normalizedTarget(item.target);
    const narration = stringField(item.narration);
    const sourceEventRange = normalizedSourceEventRange(item.sourceEventRange);
    const notes = stringField(item.notes);
    if (target) step.target = target;
    if (narration) step.narration = narration;
    if (sourceEventRange) step.sourceEventRange = sourceEventRange;
    if (notes) step.notes = notes;
    return [step];
  });
}

function normalizedInputName(value: string | null): string | null {
  if (!value) return null;
  const name = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!name) return null;
  return /^[a-z]/.test(name) ? name : `input_${name}`;
}

function uniqueInputName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }
  let suffix = 2;
  let candidate = `${baseName}_${suffix}`;
  while (usedNames.has(candidate)) {
    suffix += 1;
    candidate = `${baseName}_${suffix}`;
  }
  usedNames.add(candidate);
  return candidate;
}

function normalizedInputs(value: unknown): RecordingSkillInput[] {
  if (!Array.isArray(value)) return [];
  const usedNames = new Set<string>();
  return value.flatMap((item): RecordingSkillInput[] => {
    if (!isRecord(item)) return [];
    const rawName = stringField(item.name);
    const label = stringField(item.label) ?? rawName;
    const baseName = normalizedInputName(rawName) ?? normalizedInputName(label);
    if (!label || !baseName) return [];
    const input: RecordingSkillInput = {
      name: uniqueInputName(baseName, usedNames),
      label,
      type: isSkillInputType(item.type) ? item.type : "string",
      required: booleanField(item.required, true),
    };
    const description = stringField(item.description);
    const source = stringField(item.source);
    if (description) input.description = description;
    if (source) input.source = source;
    return [input];
  });
}

function normalizedVerification(value: unknown): RecordingVerificationCheck[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RecordingVerificationCheck[] => {
    if (!isRecord(item)) return [];
    const label = stringField(item.label);
    if (!label) return [];
    const check: RecordingVerificationCheck = {
      kind: isVerificationKind(item.kind) ? item.kind : "human_confirmation",
      label,
    };
    const description = stringField(item.description);
    const checkValue = stringField(item.value);
    if (description) check.description = description;
    if (checkValue) check.value = checkValue;
    return [check];
  });
}

function normalizedRecovery(value: unknown): RecordingRecoveryStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RecordingRecoveryStep[] => {
    if (!isRecord(item)) return [];
    const when = stringField(item.when);
    const action = stringField(item.do);
    if (!when || !action) return [];
    return [{ when, do: action }];
  });
}

function normalizedRedactions(value: unknown): RecordingRedactionFinding[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index): RecordingRedactionFinding[] => {
    if (!isRecord(item)) return [];
    const label = stringField(item.label);
    const description = stringField(item.description);
    if (
      !label ||
      !description ||
      !isRedactionSeverity(item.severity) ||
      !isRedactionArtifact(item.artifact)
    ) {
      return [];
    }
    return [
      {
        id: stringField(item.id) ?? `${item.artifact}-finding-${index + 1}`,
        severity: item.severity,
        label,
        description,
        artifact: item.artifact,
        resolved: booleanField(item.resolved, false),
      },
    ];
  });
}

function mergedRedactions(
  preserved: RecordingRedactionFinding[],
  generated: RecordingRedactionFinding[],
): RecordingRedactionFinding[] {
  const byId = new Map<string, RecordingRedactionFinding>();
  for (const finding of generated) byId.set(finding.id, finding);
  for (const finding of preserved) byId.set(finding.id, finding);
  return Array.from(byId.values());
}

export function normalizeRecordingSkillDraft(
  input: RecordingSkillDraftNormalizationInput,
): RecordingSkillDraft {
  const nowMs = input.nowMs ?? Date.now();
  const base = createEmptyRecordingSkillDraft(input.session, nowMs);
  if (!isRecord(input.draft)) {
    return {
      ...base,
      redactions: input.redactions ?? [],
      capture: base.capture,
      status: input.redactions?.some(
        (finding) => finding.severity === "block" && !finding.resolved,
      )
        ? "blocked"
        : base.status,
    };
  }

  const redactions = mergedRedactions(
    input.redactions ?? [],
    normalizedRedactions(input.draft.redactions),
  );
  const hasBlockingRedaction = redactions.some(
    (finding) => finding.severity === "block" && !finding.resolved,
  );

  return {
    id: stringField(input.draft.id) ?? base.id,
    sessionId: input.session.id,
    title: stringField(input.draft.title) ?? base.title,
    description: stringField(input.draft.description) ?? base.description,
    status: hasBlockingRedaction
      ? "blocked"
      : isDraftStatus(input.draft.status)
        ? input.draft.status
        : base.status,
    steps: normalizedSteps(input.draft.steps),
    inputs: normalizedInputs(input.draft.inputs),
    assumptions: stringList(input.draft.assumptions),
    verification: normalizedVerification(input.draft.verification),
    recovery: normalizedRecovery(input.draft.recovery),
    redactions,
    capture: base.capture,
    createdAtMs:
      typeof input.draft.createdAtMs === "number"
        ? input.draft.createdAtMs
        : base.createdAtMs,
    updatedAtMs: nowMs,
  };
}

function fencedJsonCandidate(text: string): string | null {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return match?.[1]?.trim() || null;
}

function balancedJsonCandidate(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }

  return null;
}

function draftJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  return [
    trimmed,
    fencedJsonCandidate(trimmed),
    balancedJsonCandidate(trimmed),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

export function parseRecordingSkillDraftText(
  input: RecordingSkillDraftParseInput,
): RecordingSkillDraftParseResult {
  for (const candidate of draftJsonCandidates(input.text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return {
        draft: normalizeRecordingSkillDraft({
          session: input.session,
          draft: parsed,
          redactions: input.redactions,
          nowMs: input.nowMs,
        }),
        error: null,
      };
    } catch {}
  }

  return {
    draft: null,
    error: "No valid recording draft JSON was found.",
  };
}

export function createRecordingSkillDraftReview(
  input: RecordingSkillDraftParseInput,
): RecordingSkillDraftReviewResult {
  const parsed = parseRecordingSkillDraftText(input);
  if (!parsed.draft) {
    return { review: null, error: parsed.error };
  }

  const readiness = evaluateRecordingPublishReadiness(parsed.draft);
  const bundle = buildRecordingSkillBundle(parsed.draft);
  return {
    review: {
      draft: parsed.draft,
      readiness,
      bundle: {
        ...bundle,
        fileCount: bundle.files.length,
      },
      parsedAtMs: input.nowMs ?? Date.now(),
    },
    error: null,
  };
}

function collectRecordingSkillDraftText(draft: RecordingSkillDraft): string {
  const parts: string[] = [draft.title, draft.description];
  for (const step of draft.steps) {
    parts.push(step.intent);
    if (step.narration) parts.push(step.narration);
    if (step.notes) parts.push(step.notes);
    if (step.target?.role) parts.push(step.target.role);
    if (step.target?.name) parts.push(step.target.name);
    if (step.target?.selectors) parts.push(...step.target.selectors);
  }
  for (const input of draft.inputs) {
    parts.push(input.name, input.type);
    parts.push(input.label);
    if (input.description) parts.push(input.description);
    if (input.source) parts.push(input.source);
  }
  for (const check of draft.verification) {
    parts.push(check.label);
    if (check.description) parts.push(check.description);
    if (check.value) parts.push(check.value);
  }
  parts.push(...draft.assumptions);
  for (const recovery of draft.recovery) {
    parts.push(recovery.when, recovery.do);
  }
  return parts.filter((part) => part.length > 0).join("\n");
}

export function evaluateRecordingPublishReadiness(
  draft: RecordingSkillDraft,
): RecordingPublishReadiness {
  const blockingReasons: string[] = [];
  const warningReasons: string[] = [];

  if (draft.status !== "ready_to_publish") {
    blockingReasons.push("Draft has not been marked ready to publish.");
  }
  if (draft.status === "blocked") {
    blockingReasons.push("Draft is blocked.");
  }
  if (draft.steps.length === 0) {
    blockingReasons.push("Draft has no executable steps.");
  }
  if (draft.verification.length === 0) {
    blockingReasons.push("Draft has no verification checks.");
  }

  for (const finding of draft.redactions) {
    if (finding.severity === "block" && !finding.resolved) {
      blockingReasons.push(`Unresolved redaction finding: ${finding.label}`);
    } else if (finding.severity === "warn" && !finding.resolved) {
      warningReasons.push(`Unresolved redaction warning: ${finding.label}`);
    }
  }

  // The public bundle is rendered from the draft's own text, which can echo
  // secrets the trace/metadata scan never saw (e.g. values typed into prep or
  // repeated by the model). Block publish when the rendered text itself carries
  // a high-severity match so sensitive content cannot ship in SKILL.md or the
  // skill spec.
  const seenDraftTextFindings = new Set<string>();
  for (const finding of scanRecordingArtifactTextForRedactions({
    artifact: "context",
    text: collectRecordingSkillDraftText(draft),
  })) {
    if (finding.severity !== "block") continue;
    if (seenDraftTextFindings.has(finding.label)) continue;
    seenDraftTextFindings.add(finding.label);
    blockingReasons.push(
      `Draft text contains sensitive content: ${finding.label}`,
    );
  }

  if (draft.assumptions.length > 0) {
    warningReasons.push("Draft includes assumptions that should be reviewed.");
  }
  if (draft.recovery.length === 0) {
    warningReasons.push("Draft has no recovery guidance.");
  }

  return {
    canPublish: blockingReasons.length === 0,
    blockingReasons,
    warningReasons,
  };
}

function slugifyRecordingSkillName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
  return slug || "recorded-workflow";
}

function markdownList(items: string[], empty: string): string {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${markdownInline(item)}`).join("\n");
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function markdownInline(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const TAR_BLOCK_SIZE = 512;

function tarOctal(value: number, width: number): string {
  const octal = Math.max(0, Math.floor(value)).toString(8);
  return `${octal.padStart(width - 1, "0")}\0`;
}

function writeTarString(
  target: Uint8Array<ArrayBuffer>,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  target.set(bytes.slice(0, length), offset);
}

function writeTarHeader(
  path: string,
  size: number,
  mtimeSeconds: number,
): Uint8Array<ArrayBuffer> {
  const pathParts = path.split("/");
  const pathUnsafe =
    path.length === 0 ||
    path.length > 100 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    pathParts.some((part) => part === "" || part === "." || part === "..");
  if (pathUnsafe) {
    throw new Error(
      `Recording skill bundle file path is not tar-safe: ${path}`,
    );
  }
  const header = new Uint8Array(TAR_BLOCK_SIZE);
  writeTarString(header, 0, 100, path);
  writeTarString(header, 100, 8, tarOctal(0o644, 8));
  writeTarString(header, 108, 8, tarOctal(0, 8));
  writeTarString(header, 116, 8, tarOctal(0, 8));
  writeTarString(header, 124, 12, tarOctal(size, 12));
  writeTarString(header, 136, 12, tarOctal(mtimeSeconds, 12));
  for (let index = 148; index < 156; index += 1) header[index] = 0x20;
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar\0");
  writeTarString(header, 263, 2, "00");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export function buildRecordingSkillBundleTar(
  bundle: RecordingSkillBundle,
  mtimeSeconds: number = 0,
): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array<ArrayBuffer>[] = [];

  for (const file of bundle.files) {
    const content = encoder.encode(file.content);
    chunks.push(
      writeTarHeader(
        `${bundle.slug}/${file.path}`,
        content.length,
        mtimeSeconds,
      ),
    );
    chunks.push(content);
    const padding =
      (TAR_BLOCK_SIZE - (content.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }

  chunks.push(new Uint8Array(TAR_BLOCK_SIZE * 2));
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const archive = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.length;
  }
  return archive;
}

function yamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function yamlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function yamlLines(value: unknown, indent = 0): string[] {
  const padding = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${padding}[]`];
    return value.flatMap((item) => yamlArrayItemLines(item, indent));
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(
      ([, entryValue]) => entryValue !== undefined,
    );
    if (entries.length === 0) return [`${padding}{}`];
    return entries.flatMap(([key, entryValue]) =>
      yamlObjectEntryLines(key, entryValue, indent),
    );
  }
  return [`${padding}${yamlScalar(value)}`];
}

function yamlArrayItemLines(value: unknown, indent: number): string[] {
  const padding = " ".repeat(indent);
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(
      ([, entryValue]) => entryValue !== undefined,
    );
    if (entries.length === 0) return [`${padding}- {}`];
    return entries.flatMap(([key, entryValue], index) => {
      const entryPadding = index === 0 ? `${padding}- ` : `${padding}  `;
      const entryKey = yamlKey(key);
      if (isRecord(entryValue) || Array.isArray(entryValue)) {
        return [
          `${entryPadding}${entryKey}:`,
          ...yamlLines(entryValue, indent + 4),
        ];
      }
      return [`${entryPadding}${entryKey}: ${yamlScalar(entryValue)}`];
    });
  }
  if (Array.isArray(value)) {
    return [`${padding}-`, ...yamlLines(value, indent + 2)];
  }
  return [`${padding}- ${yamlScalar(value)}`];
}

function yamlObjectEntryLines(
  key: string,
  value: unknown,
  indent: number,
): string[] {
  const padding = " ".repeat(indent);
  const entryKey = yamlKey(key);
  if (isRecord(value) || Array.isArray(value)) {
    return [`${padding}${entryKey}:`, ...yamlLines(value, indent + 2)];
  }
  return [`${padding}${entryKey}: ${yamlScalar(value)}`];
}

function yamlFile(value: unknown): string {
  return `${yamlLines(value).join("\n")}\n`;
}

function buildRecordingSkillFrontmatterDescription(
  draft: RecordingSkillDraft,
): string {
  const base =
    draft.description.trim() ||
    `Run ${draft.title.trim() || "the recorded workflow"}.`;
  const title = draft.title.trim();
  const trigger = title
    ? `Use when the user asks to run the recorded workflow "${title}".`
    : "Use when the user asks to run this recorded workflow.";
  return `${base} ${trigger}`;
}

function normalizedRecordingTriggerPhrase(value: string): string | null {
  const phrase = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!phrase) return null;
  if (phrase.length <= 96) return phrase;
  return (
    phrase
      .slice(0, 96)
      .replace(/\s+\S*$/g, "")
      .trim() || null
  );
}

function buildRecordingSkillTriggers(draft: RecordingSkillDraft): string[] {
  const title = normalizedRecordingTriggerPhrase(draft.title);
  const description = normalizedRecordingTriggerPhrase(draft.description);
  const candidates = [
    title ? (title.startsWith("run ") ? title : `run ${title}`) : null,
    title,
    description && description !== title ? description : null,
  ].filter((candidate): candidate is string => Boolean(candidate));
  const deduped = Array.from(new Set(candidates));
  return deduped.length > 0 ? deduped : ["run recorded workflow"];
}

function buildRecordingSkillSpecInputs(
  draft: RecordingSkillDraft,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const input of draft.inputs) {
    inputs[input.name] = {
      type: input.type,
      label: input.label,
      description: input.description,
      required: input.required,
      source: input.source,
    };
  }
  return inputs;
}

function buildRecordingSkillMarkdown(
  draft: RecordingSkillDraft,
  slug: string,
): string {
  const inputLines = draft.inputs.map((input) => {
    const required = input.required ? "required" : "optional";
    const source = input.source
      ? `, source: ${markdownInline(input.source)}`
      : "";
    return `${markdownInline(input.name)} (${input.type}, ${required}${source}): ${markdownInline(input.description || input.label)}`;
  });
  const stepLines = draft.steps.map((step, index) => {
    const flags = [
      step.essential ? "essential" : "optional",
      step.needsConfirmation ? "needs confirmation" : null,
    ].filter((flag): flag is string => Boolean(flag));
    return `${index + 1}. ${markdownInline(step.intent)}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}`;
  });
  const verificationLines = draft.verification.map((check) =>
    [check.label, check.kind, check.value]
      .filter(Boolean)
      .map((part) => markdownInline(String(part)))
      .join(" - "),
  );
  const recoveryLines = draft.recovery.map(
    (item) => `${markdownInline(item.when)}: ${markdownInline(item.do)}`,
  );

  return [
    "---",
    `name: ${JSON.stringify(slug)}`,
    `description: ${JSON.stringify(buildRecordingSkillFrontmatterDescription(draft))}`,
    "metadata:",
    `  tags: ${JSON.stringify("recorded unverified")}`,
    "---",
    "",
    `# ${markdownInline(draft.title)}`,
    "",
    markdownInline(draft.description),
    "",
    "## Runtime Instructions",
    "",
    "Load `skill.spec.yaml`, copy `config.example.json` to `config.json`, collect any required inputs, install `requirements.txt` if needed, follow the workflow plan with the host agent's browser or computer-use tools, and run `python3 scripts/agent.py --config config.json --dry-run` as a smoke check before irreversible actions.",
    "",
    "## Inputs",
    "",
    markdownList(inputLines, "No runtime inputs were inferred."),
    "",
    "## Workflow",
    "",
    stepLines.length > 0
      ? stepLines.join("\n")
      : "1. Review the generated plan before publishing.",
    "",
    "## Assumptions",
    "",
    markdownList(draft.assumptions, "No assumptions were recorded."),
    "",
    "## Verification",
    "",
    markdownList(verificationLines, "No verification checks were generated."),
    "",
    "## Recovery",
    "",
    markdownList(recoveryLines, "No recovery guidance was generated."),
    "",
    "## Status",
    "",
    "This skill was generated from a workflow recording and starts as recorded/unverified until a real run verifies it.",
    "",
  ].join("\n");
}

function buildRecordingSkillSpec(
  draft: RecordingSkillDraft,
  slug: string,
): string {
  return yamlFile({
    skill: slug,
    description: buildRecordingSkillFrontmatterDescription(draft),
    triggers: buildRecordingSkillTriggers(draft),
    status: "recorded_unverified",
    runtime: {
      kind: "agentic",
      language: "python",
      entrypoint: "scripts/agent.py",
    },
    plan: draft.steps.map((step) => ({
      id: step.id,
      intent: step.intent,
      target: step.target ?? null,
      narration: step.narration ?? null,
      essential: step.essential,
      needsConfirmation: step.needsConfirmation,
    })),
    inputs: buildRecordingSkillSpecInputs(draft),
    assumptions: draft.assumptions,
    verification: draft.verification,
    recovery: draft.recovery,
    policies: {
      requiresHumanConfirm: true,
      publicBundleExcludesRecordingArtifacts: true,
    },
    tests: {
      smoke: ["tests/test_smoke.py"],
    },
    publish: {
      visibility: "private",
    },
  });
}

function buildRecordingSkillAgent(): string {
  return [
    "#!/usr/bin/env python3",
    '"""Smoke helper for a recorded Seren skill."""',
    "",
    "import argparse",
    "import json",
    "from pathlib import Path",
    "",
    "import yaml",
    "",
    "",
    "def load_json(path: Path) -> dict:",
    "    if not path.exists():",
    "        return {}",
    "    value = json.loads(path.read_text())",
    "    return value if isinstance(value, dict) else {}",
    "",
    "",
    "def load_yaml(path: Path) -> dict:",
    "    if not path.exists():",
    "        return {}",
    "    value = yaml.safe_load(path.read_text()) or {}",
    "    return value if isinstance(value, dict) else {}",
    "",
    "",
    "def config_inputs(config: dict) -> dict:",
    "    inputs = config.get('inputs', {})",
    "    return inputs if isinstance(inputs, dict) else {}",
    "",
    "",
    "def required_input_names(spec: dict) -> list:",
    "    names = []",
    "    inputs = spec.get('inputs', {})",
    "    if isinstance(inputs, dict):",
    "        for name, item in inputs.items():",
    "            if isinstance(name, str) and (not isinstance(item, dict) or item.get('required', True)):",
    "                names.append(name)",
    "        return names",
    "    if isinstance(inputs, list):",
    "        for item in inputs:",
    "            if not isinstance(item, dict):",
    "                continue",
    "            name = item.get('name')",
    "            if isinstance(name, str) and item.get('required', True):",
    "                names.append(name)",
    "    return names",
    "",
    "",
    "def missing_required_inputs(spec: dict, config: dict) -> list:",
    "    inputs = config_inputs(config)",
    "    missing = []",
    "    for name in required_input_names(spec):",
    "        if inputs.get(name) in (None, ''):",
    "            missing.append(name)",
    "    return missing",
    "",
    "",
    "def main() -> int:",
    "    parser = argparse.ArgumentParser()",
    "    parser.add_argument('--config', default='config.json')",
    "    parser.add_argument('--dry-run', action='store_true')",
    "    args = parser.parse_args()",
    "    root = Path(__file__).resolve().parents[1]",
    "    spec = load_yaml(root / 'skill.spec.yaml')",
    "    config = load_json(root / args.config)",
    "    dry_run = bool(args.dry_run or config.get('dryRun'))",
    "    missing = missing_required_inputs(spec, config)",
    "    confirm_before_submit = bool(config.get('confirmBeforeSubmit', True))",
    "    blocked_reason = None",
    "    if not dry_run and missing:",
    "        blocked_reason = 'missing_required_inputs'",
    "    elif not dry_run and confirm_before_submit:",
    "        blocked_reason = 'confirm_before_submit'",
    "    print(json.dumps({",
    "        'skill': spec.get('skill'),",
    "        'status': spec.get('status'),",
    "        'dry_run': dry_run,",
    "        'ready_for_execution': blocked_reason is None,",
    "        'blocked_reason': blocked_reason,",
    "        'inputs': config_inputs(config),",
    "        'missing_required_inputs': missing,",
    "        'confirm_before_submit': confirm_before_submit,",
    "        'plan': spec.get('plan', []),",
    "        'verification': spec.get('verification', []),",
    "    }, indent=2))",
    "    if not dry_run and missing:",
    "        return 2",
    "    if not dry_run and config.get('confirmBeforeSubmit', True):",
    "        return 3",
    "    return 0",
    "",
    "",
    "if __name__ == '__main__':",
    "    raise SystemExit(main())",
    "",
  ].join("\n");
}

function buildRecordingSkillConfigExample(draft: RecordingSkillDraft): string {
  const inputs: Record<string, null> = {};
  for (const input of draft.inputs) inputs[input.name] = null;
  return jsonFile({
    inputs,
    dryRun: true,
    confirmBeforeSubmit: true,
  });
}

function buildRecordingSkillSmokeTest(): string {
  return [
    "from pathlib import Path",
    "",
    "import yaml",
    "",
    "",
    "def test_recorded_skill_spec_has_review_contract():",
    "    root = Path(__file__).resolve().parents[1]",
    "    spec = yaml.safe_load((root / 'skill.spec.yaml').read_text())",
    "    assert spec['runtime']['kind'] == 'agentic'",
    "    assert spec['runtime']['language'] == 'python'",
    "    assert spec['status'] == 'recorded_unverified'",
    "    assert isinstance(spec.get('triggers'), list)",
    "    assert isinstance(spec.get('inputs'), dict)",
    "    assert isinstance(spec.get('plan'), list)",
    "    assert isinstance(spec.get('verification'), list)",
    "    assert spec['policies']['publicBundleExcludesRecordingArtifacts'] is True",
    "",
  ].join("\n");
}

export function buildRecordingSkillBundle(
  draft: RecordingSkillDraft,
): RecordingSkillBundle {
  const slug = slugifyRecordingSkillName(draft.title);
  return {
    slug,
    files: [
      {
        path: "SKILL.md",
        content: buildRecordingSkillMarkdown(draft, slug),
      },
      {
        path: "skill.spec.yaml",
        content: buildRecordingSkillSpec(draft, slug),
      },
      {
        path: "scripts/agent.py",
        content: buildRecordingSkillAgent(),
      },
      {
        path: "config.example.json",
        content: buildRecordingSkillConfigExample(draft),
      },
      {
        path: "requirements.txt",
        content: "PyYAML>=6.0.2\n",
      },
      {
        path: "tests/test_smoke.py",
        content: buildRecordingSkillSmokeTest(),
      },
    ],
  };
}

function asGlobalPattern(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

export function scanRecordingArtifactTextForRedactions(
  input: RecordingRedactionScanInput,
): RecordingRedactionFinding[] {
  if (input.text.trim().length === 0) return [];

  const maxFindings = input.maxFindings ?? 25;
  const findings: RecordingRedactionFinding[] = [];

  for (const redactionPattern of RECORDING_REDACTION_PATTERNS) {
    const pattern = asGlobalPattern(redactionPattern.pattern);
    let match = pattern.exec(input.text);
    while (findings.length < maxFindings && match) {
      if (redactionPattern.isMatch && !redactionPattern.isMatch(match[0])) {
        match = pattern.exec(input.text);
        continue;
      }
      findings.push({
        id: `${input.artifact}-${redactionPattern.key}-${findings.length + 1}`,
        severity: redactionPattern.severity,
        label: redactionPattern.label,
        description: redactionPattern.description,
        artifact: input.artifact,
        resolved: false,
      });
      match = pattern.exec(input.text);
    }
    if (findings.length >= maxFindings) break;
  }

  return findings;
}

export function buildRecordingSkillDraftPrompt(
  session: RecordingSession,
): string {
  const context = session.context;
  const prep = context?.prep;
  const promptText = (value: unknown, fallback = "not specified") =>
    safeForwardableRecordingText(value) ?? fallback;
  const lines = [
    "Create a Seren skill draft from this workflow recording.",
    "",
    "Recording:",
    `- id: ${session.id}`,
    `- target: ${forwardableRecordingTargetLabel(session)} (${session.targetKind})`,
    ...(context?.captureWindow
      ? [
          `- selected window: App window (${context.captureWindow.bounds.width}x${context.captureWindow.bounds.height})`,
        ]
      : []),
    `- quality: ${session.qualityStatus ?? "unchecked"}`,
    `- video: ${recordingVideoArtifactName(session)} (${session.mimeType ?? "unknown"}, ${session.sizeBytes ?? "unknown"} bytes)`,
    `- capture health: ${recordingCaptureStatsSummary(session.captureStats)}`,
    `- trace: workflow-trace.json (${session.traceEventCount ?? 0} events, ${session.markerCount ?? 0} markers, ${session.redactedEventCount ?? 0} redacted${session.traceTruncated ? ", capped" : ""})`,
    `- transcript: ${session.transcriptArtifactUrl || (session.transcriptSegmentCount ?? 0) > 0 ? `workflow-transcript.txt (${session.transcriptSegmentCount ?? "unknown"} segments)` : session.context?.includeMicrophone ? "requested but unavailable" : "not requested"}`,
    `- keyframes: ${(session.keyframeCount ?? 0) > 0 ? `workflow-keyframes.json (${session.keyframeCount} local-only frames)` : "not captured"}`,
    `- trace scope: ${promptText(context?.traceScopeNote)}`,
    "- local artifacts: inspect by logical artifact name only when the recording host exposes them",
    "- metadata: workflow-metadata.json",
    "",
    "User intent:",
    `- goal: ${promptText(prep?.goal)}`,
    `- success state: ${promptText(prep?.successState)}`,
    `- variable inputs: ${promptText(prep?.variableInputs)}`,
    `- preferences: ${promptText(prep?.preferences)}`,
    "",
    "Draft requirements:",
    "- extract ordered steps with stable target descriptions",
    "- identify runtime inputs and assumptions",
    "- include success checks and recovery steps",
    "- flag any step that needs confirmation before execution",
    "- preserve the review sections: steps, inputs, assumptions, verification, recovery, redactions, publish readiness",
    "- never include local filesystem paths in generated skill files or draft JSON",
    "- if unresolved blocking redactions are present, do not infer or repeat the sensitive content; ask for redaction or re-recording",
    "- ask for a re-recording if the quality status is retry",
    "",
    "Return a single JSON object with this shape:",
    "{",
    '  "title": "short workflow title",',
    '  "description": "expected success state",',
    '  "status": "draft",',
    '  "steps": [{"id": "step-1", "intent": "...", "essential": true, "needsConfirmation": false}],',
    '  "inputs": [{"name": "runtime_value", "type": "string", "label": "Runtime value", "required": true}],',
    '  "assumptions": ["..."],',
    '  "verification": [{"kind": "ui_text", "label": "Success message", "value": "..."}],',
    '  "recovery": [{"when": "...", "do": "..."}],',
    '  "redactions": []',
    "}",
  ];
  return lines.join("\n");
}

function recordingSkillDraftRevisionPayload(
  draft: RecordingSkillDraft,
): Record<string, unknown> {
  return {
    title: draft.title,
    description: draft.description,
    status: draft.status,
    steps: draft.steps,
    inputs: draft.inputs,
    assumptions: draft.assumptions,
    verification: draft.verification,
    recovery: draft.recovery,
    redactions: draft.redactions,
  };
}

export function buildRecordingSkillRevisionPrompt(
  review: RecordingSkillDraftReview,
): string {
  const capture = review.draft.capture;
  const lines = [
    "Revise this Seren skill draft from a workflow recording.",
    "",
    "Current capture summary:",
    `- target: ${capture?.targetLabel ?? "unknown"} (${capture?.targetKind ?? "unknown"})`,
    `- quality: ${capture?.qualityStatus ?? "unchecked"}`,
    `- capture health: ${recordingCaptureStatsSummary(capture?.captureStats)}`,
    `- trace: ${capture?.traceEvents ?? 0} events, ${capture?.markers ?? 0} markers, ${capture?.redactedEvents ?? 0} redacted${capture?.traceTruncated ? ", capped" : ""}`,
    `- transcript: ${capture?.transcriptSegments ?? 0} segments`,
    `- local frames: ${capture?.keyframes ?? 0}`,
    "",
    "Current draft JSON:",
    "```json",
    JSON.stringify(recordingSkillDraftRevisionPayload(review.draft), null, 2),
    "```",
    "",
    "Revision requirements:",
    "- apply the corrections I provide after this prompt",
    "- keep the same JSON shape used by the current draft",
    "- preserve unresolved redaction findings unless I explicitly say they were reviewed",
    "- do not invent raw trace, transcript, video, frame, local path, or provenance details",
    "- keep the skill recorded/unverified unless a real run verifies it",
    "",
    "Return only the revised JSON object after applying these corrections.",
    "",
    "Corrections to apply:",
    "- ",
  ];
  return lines.join("\n");
}

function recordingReviewCaptureLines(
  review: RecordingSkillDraftReview,
): string[] {
  const capture = review.draft.capture;
  return [
    `- target: ${capture?.targetLabel ?? "unknown"} (${capture?.targetKind ?? "unknown"})`,
    `- quality: ${capture?.qualityStatus ?? "unchecked"}`,
    `- trace: ${capture?.traceEvents ?? 0} events, ${capture?.markers ?? 0} markers, ${capture?.redactedEvents ?? 0} redacted${capture?.traceTruncated ? ", capped" : ""}`,
    `- transcript: ${capture?.transcriptSegments ?? 0} segments`,
    `- local frames: ${capture?.keyframes ?? 0}`,
  ];
}

export function buildRecordingStepCorrectionPrompt(
  review: RecordingSkillDraftReview,
  stepId: string,
): string {
  const step =
    review.draft.steps.find((candidate) => candidate.id === stepId) ?? null;
  if (!step) {
    throw new Error(`Recording draft step not found: ${stepId}`);
  }

  const lines = [
    "Correct one step in this Seren skill draft.",
    "",
    "Current capture summary:",
    ...recordingReviewCaptureLines(review),
    "",
    "Step to correct:",
    "```json",
    JSON.stringify(step, null, 2),
    "```",
    "",
    "Current draft JSON:",
    "```json",
    JSON.stringify(recordingSkillDraftRevisionPayload(review.draft), null, 2),
    "```",
    "",
    "Step correction requirements:",
    "- apply the corrections I provide after this prompt",
    "- update this step first; only adjust inputs, verification, recovery, or adjacent steps when needed for consistency",
    "- if I attach or describe a re-recording, use it only as evidence for this step",
    "- preserve unresolved redaction findings unless I explicitly say they were reviewed",
    "- do not invent raw trace, transcript, video, frame, local path, or provenance details",
    "",
    "Return only the revised JSON object after applying these corrections.",
    "",
    "Corrections or re-recording notes to apply:",
    "- ",
  ];
  return lines.join("\n");
}

export function buildRecordingSkillRunFixPrompt(
  review: RecordingSkillDraftReview,
): string {
  const lines = [
    "Run and repair this Seren recorded skill draft.",
    "",
    "Generated bundle:",
    `- slug: ${review.bundle.slug}`,
    `- files: ${review.bundle.fileCount}`,
    "",
    "Current capture summary:",
    ...recordingReviewCaptureLines(review),
    "",
    "Current draft JSON:",
    "```json",
    JSON.stringify(recordingSkillDraftRevisionPayload(review.draft), null, 2),
    "```",
    "",
    "Run-and-fix requirements:",
    "- inspect the generated bundle and run the dry-run smoke path first",
    "- do not perform irreversible target actions unless I explicitly approve them",
    "- if dry-run or inspection finds a failure, revise the JSON to fix the draft",
    "- preserve unresolved redaction findings unless I explicitly say they were reviewed",
    "- keep the skill recorded/unverified unless a real run verifies it",
    "- do not invent raw trace, transcript, video, frame, local path, or provenance details",
    "",
    "Return only the revised JSON object if changes are needed; otherwise explain the dry-run result briefly.",
  ];
  return lines.join("\n");
}

/**
 * Packages a stopped recording into a forwardable run payload. Artifact text in
 * `input.trace`/`input.metadata` is forwarded verbatim; this builder neither
 * scrubs it nor inspects findings. Callers must resolve or strip unresolved
 * blocking redactions before forwarding so sensitive artifact text is not sent.
 */
export function buildRecordingRunPayload(
  input: RecordingRunPayloadInput,
): Record<string, unknown> {
  const session = input.session;
  const redactions = input.redactions ?? [];
  const context = forwardableRecordingContext(session.context);
  const traceScopeNote = safeForwardableRecordingText(
    session.context?.traceScopeNote,
  );
  return {
    recording: {
      kind: "workflow_recording",
      session: {
        id: session.id,
        targetKind: session.targetKind,
        targetLabel: forwardableRecordingTargetLabel(session),
        startedAtMs: session.startedAtMs,
        maxVideoHeight: session.maxVideoHeight,
      },
      context,
      traceScopeNote,
      quality: {
        status: session.qualityStatus ?? null,
        checks: session.qualityChecks ?? [],
      },
      redactions,
      redactionSummary: {
        total: redactions.length,
        blocking: redactions.filter((finding) => finding.severity === "block")
          .length,
        warnings: redactions.filter((finding) => finding.severity === "warn")
          .length,
        unresolvedBlocking: redactions.filter(
          (finding) => finding.severity === "block" && !finding.resolved,
        ).length,
      },
      counts: {
        traceEvents: session.traceEventCount ?? 0,
        traceTruncated: Boolean(session.traceTruncated),
        markers: session.markerCount ?? 0,
        redactedEvents: session.redactedEventCount ?? 0,
        transcriptSegments: session.transcriptSegmentCount ?? 0,
        keyframes: session.keyframeCount ?? 0,
      },
      captureStats: safeRecordingCaptureStats(session.captureStats),
      artifacts: {
        video: {
          name: input.videoName,
          mimeType: session.mimeType ?? null,
          sizeBytes: session.sizeBytes ?? null,
          localOnly: true,
        },
        trace: input.trace,
        transcript: input.transcript,
        keyframes: {
          count: session.keyframeCount ?? 0,
          localOnly: true,
        },
        metadata: forwardableRecordingMetadataText(input.metadata, session),
      },
    },
  };
}

function forwardableRecordingContext(
  context: RecordingSessionContext | null | undefined,
): Record<string, unknown> | null {
  if (!context) return null;
  const traceScopeNote = safeForwardableRecordingText(context.traceScopeNote);
  return {
    targetId: context.targetId,
    prep: {
      goal: safeForwardableRecordingText(context.prep.goal) ?? "",
      successState:
        safeForwardableRecordingText(context.prep.successState) ?? "",
      variableInputs:
        safeForwardableRecordingText(context.prep.variableInputs) ?? "",
      preferences: safeForwardableRecordingText(context.prep.preferences) ?? "",
      tosAcknowledged: context.prep.tosAcknowledged,
    },
    includeMicrophone: context.includeMicrophone,
    includeCamera: context.includeCamera,
    executableUpgrade: context.executableUpgrade,
    traceScopeNote,
  };
}

function forwardableRecordingTargetLabel(session: RecordingSession): string {
  if (session.targetKind === "screen") return "Full screen";
  if (session.targetKind === "window") return "App window";
  if (session.targetKind === "browser") return "Browser";
  return (
    safeForwardableRecordingText(session.targetLabel) ?? "Recording target"
  );
}

function safeForwardableRecordingText(value: unknown): string | null {
  const text = stringField(value);
  if (!text) return null;
  const findings = scanRecordingArtifactTextForRedactions({
    artifact: "context",
    text,
    maxFindings: 1,
  });
  if (findings.some((finding) => finding.severity === "block")) {
    return null;
  }
  return text;
}

function forwardableRecordingMetadataText(
  metadata: RecordingArtifactText | null,
  session: RecordingSession,
): RecordingArtifactText | null {
  if (!metadata) return null;
  return {
    text: JSON.stringify({
      kind: "workflow_recording_metadata_summary",
      sourceArtifact: "workflow-metadata.json",
      session: {
        id: session.id,
        targetKind: session.targetKind,
        targetLabel: forwardableRecordingTargetLabel(session),
        startedAtMs: session.startedAtMs,
        maxVideoHeight: session.maxVideoHeight,
      },
      counts: {
        traceEvents: session.traceEventCount ?? 0,
        traceTruncated: Boolean(session.traceTruncated),
        markers: session.markerCount ?? 0,
        redactedEvents: session.redactedEventCount ?? 0,
        transcriptSegments: session.transcriptSegmentCount ?? 0,
        keyframes: session.keyframeCount ?? 0,
      },
      captureStats: safeRecordingCaptureStats(session.captureStats),
      localOnlySourceExcluded: true,
    }),
    truncated: metadata.truncated,
  };
}

function scanRecordingArtifact(
  artifact: RecordingRedactionArtifact,
  text: RecordingArtifactText | null,
): RecordingRedactionFinding[] {
  if (!text) return [];
  if (text.truncated) {
    return [
      {
        id: `${artifact}-unreadable-1`,
        severity: "block",
        label: "Unreadable artifact",
        description:
          "A recording artifact could not be fully scanned before forwarding.",
        artifact,
        resolved: false,
      },
    ];
  }
  return scanRecordingArtifactTextForRedactions({
    artifact,
    text: text.text,
  });
}

function recordingContextArtifactText(
  session: RecordingSession,
): RecordingArtifactText {
  return {
    text: JSON.stringify(session.context ?? null),
    truncated: false,
  };
}

function recordingArtifactHasBlockingFinding(
  artifact: RecordingRedactionArtifact,
  redactions: RecordingRedactionFinding[],
): boolean {
  return redactions.some(
    (finding) =>
      finding.artifact === artifact &&
      finding.severity === "block" &&
      !finding.resolved,
  );
}

function blockedRecordingArtifactText(
  artifact: RecordingRedactionArtifact,
): string {
  return JSON.stringify({
    blocked: true,
    reason: "redaction_required",
    artifact,
  });
}

function safeRecordingArtifactText(
  artifact: RecordingRedactionArtifact,
  text: RecordingArtifactText | null,
  redactions: RecordingRedactionFinding[],
): RecordingArtifactText | null {
  if (!text) return null;
  if (!recordingArtifactHasBlockingFinding(artifact, redactions)) return text;
  return {
    text: blockedRecordingArtifactText(artifact),
    truncated: text.truncated,
  };
}

function safeRecordingSession(
  session: RecordingSession,
  redactions: RecordingRedactionFinding[],
): RecordingSession {
  if (!recordingArtifactHasBlockingFinding("context", redactions)) {
    return session;
  }
  return {
    ...session,
    context: undefined,
  };
}

export function prepareRecordingRunPayload(
  input: PrepareRecordingRunPayloadInput,
): PrepareRecordingRunPayloadResult {
  const redactions = [
    ...scanRecordingArtifact("trace", input.trace),
    ...scanRecordingArtifact("transcript", input.transcript),
    ...scanRecordingArtifact("metadata", input.metadata),
    ...scanRecordingArtifact(
      "context",
      recordingContextArtifactText(input.session),
    ),
  ];
  const blockingRedactionCount = redactions.filter(
    (finding) => finding.severity === "block" && !finding.resolved,
  ).length;
  const warningRedactionCount = redactions.filter(
    (finding) => finding.severity === "warn" && !finding.resolved,
  ).length;

  return {
    payload: buildRecordingRunPayload({
      session: safeRecordingSession(input.session, redactions),
      videoName: input.videoName,
      trace: safeRecordingArtifactText("trace", input.trace, redactions),
      transcript: safeRecordingArtifactText(
        "transcript",
        input.transcript,
        redactions,
      ),
      metadata: safeRecordingArtifactText(
        "metadata",
        input.metadata,
        redactions,
      ),
      redactions,
    }),
    redactions,
    blockingRedactionCount,
    warningRedactionCount,
  };
}
