// ABOUTME: Guards the recording package boundary for host-specific adapters.
// ABOUTME: Ensures UI stays host-adapter based instead of importing Tauri.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRecordingTraceEvent,
  DEFAULT_RECORDING_TARGETS,
  buildRecordingRunPayload,
  buildRecordingSkillBundle,
  buildRecordingSkillBundleTar,
  buildRecordingSkillDraftPrompt,
  buildRecordingSkillRevisionPrompt,
  buildRecordingSkillRunFixPrompt,
  buildRecordingStepCorrectionPrompt,
  cloneDefaultRecordingPrep,
  createEmptyRecordingSkillDraft,
  createRecordingSkillDraftReview,
  evaluateRecordingPublishReadiness,
  evaluateRecordingSession,
  findRecordingPermissionBlocker,
  findInitialRecordingTarget,
  getRecordingSessionArtifactUrls,
  normalizeRecordingBrowserExtensionSession,
  normalizeRecordingSkillDraft,
  parseRecordingSkillDraftText,
  prepareRecordingRunPayload,
  recordingVideoArtifactName,
  recordingMarkerForShortcutCode,
  recordingMarkerLabel,
  scanRecordingArtifactTextForRedactions,
  type RecordingActionEvent,
  type RecordingCapability,
  type RecordingSession,
  type RecordingSkillDraft,
  validateRecordingStartRequest,
  recordingCanStart,
} from "@seren/recording-core";
import { formatCaptureStats } from "@/features/recording/localRecordings";
import { appendRecordingSkillDraftPrompt } from "@/features/recording/recordingComposer";

function source(path: string): string {
  return readFileSync(resolve(path), "utf-8");
}

const coreSource = source("packages/recording-core/src/index.ts");
const uiSource = source("packages/recording-ui/src/index.tsx");
const desktopAdapterSource = source(
  "src/features/recording/desktopRecordingAdapter.ts",
);
const recordingComposerSource = source(
  "src/features/recording/recordingComposer.ts",
);
const recordingHandoffSource = source(
  "src/features/recording/recordingHandoff.ts",
);
const agentChatSource = source("src/components/chat/AgentChat.tsx");
const chatContentSource = source("src/components/chat/ChatContent.tsx");
const recordedSessionCardSource = source(
  "src/components/recording/RecordedSessionCard.tsx",
);
const titlebarSource = source("src/components/layout/Titlebar.tsx");
const tauriLibSource = source("src-tauri/src/lib.rs");
const tauriConfigSource = source("src-tauri/tauri.conf.json");

function tarString(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.slice(offset, offset + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? slice.slice(0, end) : slice).trim();
}

function readTarEntries(bytes: Uint8Array): Record<string, string> {
  const entries: Record<string, string> = {};
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const path = tarString(bytes, offset, 100);
    if (!path) break;
    const sizeText = tarString(bytes, offset + 124, 12);
    const size = Number.parseInt(sizeText, 8);
    entries[path] = new TextDecoder().decode(
      bytes.slice(offset + 512, offset + 512 + size),
    );
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

describe("recording packages", () => {
  it("keeps core platform neutral and consumable outside desktop", () => {
    expect(coreSource).toContain("export interface RecordingHostAdapter");
    expect(coreSource).toContain("export interface RecordingSessionContext");
    expect(coreSource).toContain("export interface RecordingPermissionPreflight");
    expect(coreSource).toContain("RecordingBrowserExtensionReadiness");
    expect(coreSource).toContain("metadataArtifactUrl");
    expect(uiSource).toContain("props.review.draft.capture");
    expect(uiSource).toContain("recordingQualityStatusLabel");
    expect(uiSource).toContain("capture().traceEvents");
    expect(uiSource).toContain("capture().keyframes");
    expect(uiSource).toContain("capture().captureStats");
    expect(uiSource).toContain("onCorrectStep");
    expect(uiSource).toContain("onRunFix");
    expect(uiSource).toContain("export type RecordingUiSlot");
    expect(uiSource).toContain("classNames?: RecordingUiClassNames");
    expect(uiSource).toContain('data-rec-slot="dialog"');
    expect(uiSource).toContain('data-rec-slot="reviewPanel"');
    expect(uiSource).toContain('data-rec-slot="targetCard"');
    expect(coreSource).not.toContain("@tauri-apps");
    expect(coreSource).not.toContain("@/");
    expect(source("src/features/recording/localRecordings.ts")).toContain(
      'import type { RecordingCaptureStats } from "@seren/recording-core";',
    );

    const prep = cloneDefaultRecordingPrep();
    const target = DEFAULT_RECORDING_TARGETS[0];
    expect(recordingCanStart(target, prep)).toBe(false);
    expect(recordingCanStart(target, { ...prep, tosAcknowledged: true })).toBe(
      true,
    );
    expect(findInitialRecordingTarget([], "screen")).toBeNull();
    expect(
      findInitialRecordingTarget(
        [
          { ...DEFAULT_RECORDING_TARGETS[0], isAvailable: false },
          { ...DEFAULT_RECORDING_TARGETS[2], isAvailable: true },
        ],
        "screen",
      )?.id,
    ).toBe("browser");
  });

  it("validates recording start requests at the adapter boundary", () => {
    const target = DEFAULT_RECORDING_TARGETS[0];
    const request = {
      targetId: target.id,
      targetKind: target.kind,
      prep: { ...cloneDefaultRecordingPrep(), tosAcknowledged: true },
      includeMicrophone: true,
      includeCamera: false,
      executableUpgrade: false,
    };

    expect(validateRecordingStartRequest([target], request)).toBeNull();
    expect(
      validateRecordingStartRequest([target], {
        ...request,
        prep: { ...request.prep, tosAcknowledged: false },
      }),
    ).toBe("Acknowledge the target service policy before recording.");
    expect(
      validateRecordingStartRequest([target], {
        ...request,
        targetId: "missing",
      }),
    ).toBe("Unknown workflow recording target.");
    expect(
      validateRecordingStartRequest([target], {
        ...request,
        targetKind: "browser",
      }),
    ).toBe(
      "Workflow recording target kind does not match the selected target.",
    );
    expect(
      validateRecordingStartRequest(
        [{ ...target, isAvailable: false, label: "Full screen" }],
        request,
      ),
    ).toBe("Workflow recording target is not available: Full screen.");
    expect(
      validateRecordingStartRequest([target], {
        ...request,
        includeCamera: true,
      }),
    ).toBe("Workflow recording target does not support camera capture.");
    expect(
      validateRecordingStartRequest([target], {
        ...request,
        executableUpgrade: true,
      }),
    ).toBe(
      "Workflow recording target does not support executable action tracing.",
    );
    expect(
      validateRecordingStartRequest(
        [
          {
            ...target,
            capabilities: target.capabilities.filter(
              (capability) => capability !== "microphone",
            ),
          },
        ],
        request,
      ),
    ).toBe("Workflow recording target does not support microphone capture.");

    const windowTarget = {
      ...DEFAULT_RECORDING_TARGETS[1],
      isAvailable: true,
      capabilities: ["video"] satisfies RecordingCapability[],
    };
    const windowRequest = {
      ...request,
      targetId: windowTarget.id,
      targetKind: windowTarget.kind,
      includeMicrophone: false,
    };
    expect(
      validateRecordingStartRequest([windowTarget], windowRequest),
    ).toBe("Select an app window before recording.");
    expect(
      validateRecordingStartRequest([windowTarget], {
        ...windowRequest,
        captureWindowId: "123",
        captureWindow: {
          id: "123",
          appName: "Preview App",
          title: "Workflow",
          bounds: { x: 10, y: 20, width: 640, height: 480 },
        },
      }),
    ).toBeNull();
    expect(
      validateRecordingStartRequest([windowTarget], {
        ...windowRequest,
        captureWindowId: "123",
        captureWindow: {
          id: "456",
          appName: "Preview App",
          title: "Workflow",
          bounds: { x: 10, y: 20, width: 640, height: 480 },
        },
      }),
    ).toBe("Capture window metadata does not match the selected window.");
    expect(
      validateRecordingStartRequest([windowTarget], {
        ...windowRequest,
        captureWindowId: "123",
        captureWindow: {
          id: "123",
          appName: "",
          title: "Workflow",
          bounds: { x: 10, y: 20, width: 640, height: 480 },
        },
      }),
    ).toBe("Capture window app name is missing.");
    expect(
      validateRecordingStartRequest([windowTarget], {
        ...windowRequest,
        captureWindowId: "123",
        captureWindow: {
          id: "123",
          appName: "Preview App",
          title: "Workflow",
          bounds: { x: 10, y: 20, width: 0, height: 480 },
        },
      }),
    ).toBe("Capture window bounds are invalid.");
  });

  it("finds permission blockers for requested capture features", () => {
    const request = {
      targetId: "browser",
      targetKind: "browser" as const,
      prep: { ...cloneDefaultRecordingPrep(), tosAcknowledged: true },
      includeMicrophone: false,
      includeCamera: false,
      executableUpgrade: true,
    };

    expect(
      findRecordingPermissionBlocker(
        {
          platform: "macos",
          checks: [
            {
              key: "screen_recording",
              status: "unknown",
              label: "Screen recording",
              message: "Will be checked by the platform.",
              canRequest: true,
              requiredFor: ["screen", "window", "browser"],
            },
            {
              key: "accessibility",
              status: "denied",
              label: "Accessibility",
              message: "Enable accessibility access.",
              canRequest: true,
              requiredFor: ["screen", "window", "browser"],
            },
          ],
        },
        request,
      ),
    ).toBe("Accessibility permission is denied.");

    expect(
      findRecordingPermissionBlocker(
        {
          platform: "macos",
          checks: [
            {
              key: "camera",
              status: "unsupported",
              label: "Camera",
              message: "Camera unavailable.",
              canRequest: false,
              requiredFor: ["screen", "window", "browser"],
            },
          ],
        },
        request,
      ),
    ).toBeNull();
  });

  it("labels recording markers for fusion prompts and traces", () => {
    expect(recordingMarkerLabel("varies")).toBe("This varies");
    expect(recordingMarkerLabel("ignore")).toBe("Ignore this");
    expect(recordingMarkerLabel("important")).toBe("Important step");
    expect(recordingMarkerLabel("confirm")).toBe("Needs confirmation");
  });

  it("summarizes completed recording quality", () => {
    expect(
      evaluateRecordingSession({
        id: "session-1",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        artifactUrl: "blob:recording",
        sizeBytes: 1024,
        traceEventCount: 2,
      }).qualityStatus,
    ).toBe("ready");

    const truncated = evaluateRecordingSession({
      id: "session-truncated",
      targetKind: "browser",
      targetLabel: "Browser workflow",
      startedAtMs: 0,
      outputDir: null,
      maxVideoHeight: 720,
      artifactUrl: "blob:recording",
      sizeBytes: 1024,
      traceEventCount: 1500,
      traceTruncated: true,
    });
    expect(truncated.qualityStatus).toBe("needs_review");
    expect(truncated.qualityChecks).toContainEqual(
      expect.objectContaining({
        key: "action_trace",
        status: "warn",
      }),
    );

    const missingTranscript = evaluateRecordingSession({
      id: "session-missing-transcript",
      targetKind: "screen",
      targetLabel: "Screen workflow",
      startedAtMs: 0,
      outputDir: null,
      maxVideoHeight: 720,
      artifactUrl: "blob:recording",
      sizeBytes: 1024,
      traceEventCount: 0,
      context: {
        targetId: "screen",
        includeMicrophone: true,
        includeCamera: false,
        executableUpgrade: false,
        prep: { ...cloneDefaultRecordingPrep(), tosAcknowledged: true },
      },
    });
    expect(missingTranscript.qualityStatus).toBe("needs_review");
    expect(missingTranscript.qualityChecks).toContainEqual(
      expect.objectContaining({
        key: "transcript",
        status: "warn",
      }),
    );

    const skippedFrames = evaluateRecordingSession({
      id: "session-skipped-frames",
      targetKind: "screen",
      targetLabel: "Screen workflow",
      startedAtMs: 0,
      outputDir: null,
      maxVideoHeight: 720,
      artifactUrl: "blob:recording",
      sizeBytes: 1024,
      traceEventCount: 0,
      captureStats: {
        backend: "windows_xcap_mjpeg_avi",
        framesReceived: 40,
        framesEncoded: 15,
        framesSkipped: 25,
        encodeErrorCount: 0,
        effectiveFps: 7.5,
      },
      context: {
        targetId: "screen",
        includeMicrophone: false,
        includeCamera: false,
        executableUpgrade: false,
        prep: { ...cloneDefaultRecordingPrep(), tosAcknowledged: true },
      },
    });
    expect(skippedFrames.qualityStatus).toBe("ready");
    expect(skippedFrames.qualityChecks).toContainEqual(
      expect.objectContaining({
        key: "capture_health",
        status: "pass",
      }),
    );

    const encodeErrors = evaluateRecordingSession({
      id: "session-encode-errors",
      targetKind: "screen",
      targetLabel: "Screen workflow",
      startedAtMs: 0,
      outputDir: null,
      maxVideoHeight: 720,
      artifactUrl: "blob:recording",
      sizeBytes: 1024,
      traceEventCount: 0,
      captureStats: {
        backend: "windows_xcap_mjpeg_avi",
        framesReceived: 40,
        framesEncoded: 15,
        framesSkipped: 25,
        encodeErrorCount: 2,
        effectiveFps: 7.5,
      },
      context: {
        targetId: "screen",
        includeMicrophone: false,
        includeCamera: false,
        executableUpgrade: false,
        prep: { ...cloneDefaultRecordingPrep(), tosAcknowledged: true },
      },
    });
    expect(encodeErrors.qualityStatus).toBe("needs_review");
    expect(encodeErrors.qualityChecks).toContainEqual(
      expect.objectContaining({
        key: "capture_health",
        status: "warn",
      }),
    );

    expect(
      formatCaptureStats({
        backend: "windows_xcap_mjpeg_avi",
        framesEncoded: 15,
        effectiveFps: 7.5,
        framesSkipped: 25,
      }),
    ).toBe("15 encoded - 7.5 fps - 25 skipped");
    expect(formatCaptureStats({ backend: "macos_screencapture" })).toBe(
      "macos_screencapture",
    );

    expect(
      evaluateRecordingSession({
        id: "session-transcript",
        targetKind: "screen",
        targetLabel: "Screen workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        artifactUrl: "blob:recording",
        sizeBytes: 1024,
        traceEventCount: 0,
        transcriptSegmentCount: 2,
        context: {
          targetId: "screen",
          includeMicrophone: true,
          includeCamera: false,
          executableUpgrade: false,
          prep: { ...cloneDefaultRecordingPrep(), tosAcknowledged: true },
        },
      }).qualityStatus,
    ).toBe("ready");

    expect(
      evaluateRecordingSession({
        id: "session-2",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        artifactUrl: "blob:recording",
        sizeBytes: 1024,
        traceEventCount: 0,
      }).qualityStatus,
    ).toBe("retry");

    expect(
      evaluateRecordingSession({
        id: "session-3",
        targetKind: "screen",
        targetLabel: "Screen workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        artifactUrl: "blob:recording",
        sizeBytes: 1024,
        traceEventCount: 0,
        context: {
          targetId: "screen",
          includeMicrophone: false,
          includeCamera: false,
          executableUpgrade: false,
          prep: { ...cloneDefaultRecordingPrep(), tosAcknowledged: true },
        },
      }).qualityStatus,
    ).toBe("ready");
  });

  it("makes stopped-session artifact ownership explicit", () => {
    expect(coreSource).toContain("releaseSessionArtifacts?");
    expect(uiSource).toContain("releaseArtifactsFor");
    expect(uiSource).toContain(
      "props.adapter.releaseSessionArtifacts?.(session)",
    );
    expect(titlebarSource).toContain(
      "recordingHandoff.offer(session, releaseArtifacts)",
    );
    expect(recordingHandoffSource).toContain("releaseArtifacts?: () => void");
    const session: RecordingSession = {
      id: "session-urls",
      targetKind: "browser",
      targetLabel: "Browser workflow",
      startedAtMs: 0,
      outputDir: null,
      maxVideoHeight: 720,
      artifactUrl: "blob:video",
      traceArtifactUrl: "",
      transcriptArtifactUrl: "blob:transcript",
      keyframeArtifactUrl: "blob:keyframes",
      metadataArtifactUrl: "blob:metadata",
    };
    expect(getRecordingSessionArtifactUrls(session)).toEqual([
      "blob:video",
      "blob:transcript",
      "blob:keyframes",
      "blob:metadata",
    ]);
    expect(recordingVideoArtifactName({ ...session, mimeType: "video/webm" }))
      .toBe("workflow-recording.webm");
    expect(
      recordingVideoArtifactName({ ...session, mimeType: "video/quicktime" }),
    ).toBe("workflow-recording.mov");
    expect(recordingVideoArtifactName({ ...session, mimeType: "video/mp4" }))
      .toBe("workflow-recording-720p.m4v");
    expect(
      recordingVideoArtifactName({ ...session, mimeType: "video/x-msvideo" }),
    ).toBe("workflow-recording.avi");
  });

  it("builds a skill draft prompt from recording context", () => {
    const prompt = buildRecordingSkillDraftPrompt({
      id: "session-3",
      targetKind: "browser",
      targetLabel: "Browser workflow",
      startedAtMs: 0,
      outputDir: "/Users/alice/Library/Application Support/Seren/recordings/session-3",
      maxVideoHeight: 720,
      mimeType: "video/webm",
      sizeBytes: 2048,
      traceEventCount: 4,
      traceTruncated: true,
      markerCount: 1,
      redactedEventCount: 2,
      transcriptSegmentCount: 3,
      keyframeCount: 2,
      qualityStatus: "ready",
      captureStats: {
        backend: "windows_xcap_mjpeg_avi",
        framesReceived: 40,
        framesEncoded: 15,
        framesSkipped: 25,
        encodeErrorCount: 0,
        effectiveFps: 7.5,
        timeToFirstFrameMs: 120,
      },
      context: {
        targetId: "browser",
        captureWindow: {
          id: "123",
          appName: "Preview App",
          title: "Workflow",
          bounds: { x: 10, y: 20, width: 640, height: 480 },
        },
        includeMicrophone: true,
        includeCamera: false,
        executableUpgrade: true,
        traceScopeNote: "DOM trace covers the current Seren tab only.",
        prep: {
          goal: "Submit an invoice",
          successState: "Invoice is accepted",
          variableInputs: "Invoice PDF",
          preferences: "Use client defaults",
          tosAcknowledged: true,
        },
      },
    });

    expect(prompt).toContain("Create a Seren skill draft");
    expect(prompt).toContain("Submit an invoice");
    expect(prompt).toContain("selected window: App window (640x480)");
    expect(prompt).not.toContain("Preview App - Workflow");
    expect(prompt).toContain(
      "video: workflow-recording.webm (video/webm, 2048 bytes)",
    );
    expect(prompt).toContain(
      "capture health: windows_xcap_mjpeg_avi, 15 encoded, 40 received, 25 skipped, 7.5 fps, 120 ms first frame",
    );
    expect(prompt).toContain("workflow-trace.json");
    expect(prompt).toContain("workflow-transcript.txt (3 segments)");
    expect(prompt).toContain("workflow-keyframes.json (2 local-only frames)");
    expect(prompt).toContain("4 events, 1 markers, 2 redacted, capped");
    expect(prompt).toContain("2 redacted");
    expect(prompt).toContain("DOM trace covers the current Seren tab only.");
    expect(prompt).toContain(
      "local artifacts: inspect by logical artifact name only",
    );
    expect(prompt).toContain("never include local filesystem paths");
    expect(prompt).not.toContain("/Users/alice");
    expect(prompt).toContain("publish readiness");
    expect(prompt).toContain("unresolved blocking redactions");
    expect(prompt).toContain("Return a single JSON object");
    expect(prompt).toContain('"verification"');
    expect(prompt).toContain('"recovery"');

    const nativePrompt = buildRecordingSkillDraftPrompt({
      id: "session-native",
      targetKind: "window",
      targetLabel: "Preview App - Workflow",
      startedAtMs: 0,
      outputDir: null,
      maxVideoHeight: 0,
      mimeType: "video/quicktime",
      sizeBytes: 4096,
      qualityStatus: "needs_review",
    });
    expect(nativePrompt).toContain(
      "video: workflow-recording.mov (video/quicktime, 4096 bytes)",
    );
  });

  it("omits sensitive window and prep details from model-facing draft prompts", () => {
    const prompt = buildRecordingSkillDraftPrompt({
      id: "session-private-window",
      targetKind: "window",
      targetLabel: "Private App - Customer SSN Review",
      startedAtMs: 0,
      outputDir: null,
      maxVideoHeight: 720,
      mimeType: "video/quicktime",
      sizeBytes: 2048,
      qualityStatus: "ready",
      context: {
        targetId: "window",
        captureWindowId: "123",
        captureWindow: {
          id: "123",
          appName: "Private App",
          title: "Customer SSN Review",
          bounds: { x: 10, y: 20, width: 640, height: 480 },
        },
        includeMicrophone: false,
        includeCamera: false,
        executableUpgrade: false,
        traceScopeNote: "Artifacts live at /Users/alice/private/session",
        prep: {
          goal: "Open customer workspace",
          successState: "Customer details are visible",
          variableInputs: "Use /Users/alice/private-report.pdf",
          preferences: "client_secret = sk_test_1234567890abcdef",
          tosAcknowledged: true,
        },
      },
    });

    expect(prompt).toContain("- target: App window (window)");
    expect(prompt).toContain("- selected window: App window (640x480)");
    expect(prompt).toContain("- goal: Open customer workspace");
    expect(prompt).toContain("- trace scope: not specified");
    expect(prompt).toContain("- variable inputs: not specified");
    expect(prompt).toContain("- preferences: not specified");
    expect(prompt).not.toContain("Private App");
    expect(prompt).not.toContain("Customer SSN Review");
    expect(prompt).not.toContain("/Users/alice");
    expect(prompt).not.toContain("client_secret");
    expect(prompt).not.toContain("sk_test");
  });

  it("appends stopped recordings into the composer draft prompt", () => {
    const session: RecordingSession = {
      id: "session-composer",
      targetKind: "browser",
      targetLabel: "Browser workflow",
      startedAtMs: 0,
      outputDir: null,
      maxVideoHeight: 720,
      traceEventCount: 2,
      markerCount: 1,
      redactedEventCount: 0,
      qualityStatus: "ready",
      context: {
        targetId: "browser",
        includeMicrophone: false,
        includeCamera: false,
        executableUpgrade: true,
        prep: {
          goal: "Approve a customer",
          successState: "Customer is approved",
          variableInputs: "Customer name",
          preferences: "",
          tosAcknowledged: true,
        },
      },
    };

    expect(appendRecordingSkillDraftPrompt("", session)).toContain(
      "Create a Seren skill draft",
    );
    expect(
      appendRecordingSkillDraftPrompt("Existing instruction  \n", session),
    ).toMatch(/^Existing instruction\n\nCreate a Seren skill draft/);
    expect(recordingComposerSource).toContain("buildRecordingSkillDraftPrompt");
    // The composers still build the draft prompt from a stopped session, but
    // now consume it from the recordingHandoff store when the pane is active
    // rather than a fire-and-forget window event, so the draft survives
    // stopping with no chat focused. (#2614)
    for (const composer of [agentChatSource, chatContentSource]) {
      expect(composer).toContain("handleRecordingSessionStop");
      expect(composer).toContain("recordingHandoff.pendingEntry");
      expect(composer).toContain("releaseRecordedSessionArtifacts");
      expect(composer).toContain("setRecordedSession(session)");
      expect(composer).not.toContain(
        "if (session.outputDir) setRecordedSession(session)",
      );
    }
    expect(recordedSessionCardSource).toContain("hasLocalArtifacts");
    expect(recordedSessionCardSource).toContain("no local folder");
  });

  it("builds a correction prompt from an existing draft review", () => {
    const review = createRecordingSkillDraftReview({
      nowMs: 778,
      session: {
        id: "session-revision",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        qualityStatus: "ready",
        traceEventCount: 4,
        markerCount: 1,
        redactedEventCount: 2,
        transcriptSegmentCount: 3,
        keyframeCount: 2,
      },
      redactions: [
        {
          id: "trace-token-1",
          severity: "block",
          label: "Token",
          description: "A token appears in the trace.",
          artifact: "trace",
          resolved: false,
        },
      ],
      text: JSON.stringify({
        title: "Submit invoice",
        description: "Submit invoice and verify the confirmation.",
        status: "ready_to_publish",
        steps: [{ intent: "Submit invoice" }],
        verification: [{ kind: "ui_text", label: "Submitted" }],
        recovery: [{ when: "Submit fails", do: "Retry submit." }],
      }),
    });

    expect(review.review).not.toBeNull();
    const prompt = buildRecordingSkillRevisionPrompt(review.review!);

    expect(prompt).toContain("Revise this Seren skill draft");
    expect(prompt).toContain("Browser workflow");
    expect(prompt).toContain("4 events, 1 markers, 2 redacted");
    expect(prompt).toContain("3 segments");
    expect(prompt).toContain("2");
    expect(prompt).toContain('"title": "Submit invoice"');
    expect(prompt).toContain("preserve unresolved redaction findings");
    expect(prompt).toContain("Corrections to apply:\n- ");
    expect(prompt).not.toContain("workflow-recording.webm");
    expect(prompt).not.toContain("artifactUrl");
    expect(prompt).not.toContain("data:image");
  });

  it("builds focused step correction prompts from a draft review", () => {
    const review = createRecordingSkillDraftReview({
      nowMs: 778,
      session: {
        id: "session-step-correction",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        qualityStatus: "needs_review",
        traceEventCount: 8,
        markerCount: 2,
        redactedEventCount: 1,
      },
      text: JSON.stringify({
        title: "Submit invoice",
        description: "Submit invoice and verify confirmation.",
        steps: [
          {
            id: "step-open",
            intent: "Open invoices",
            essential: true,
          },
          {
            id: "step-submit",
            intent: "Submit invoice",
            essential: true,
            needsConfirmation: true,
          },
        ],
        verification: [{ kind: "ui_text", label: "Submitted" }],
      }),
    });

    expect(review.review).not.toBeNull();
    const prompt = buildRecordingStepCorrectionPrompt(
      review.review!,
      "step-submit",
    );

    expect(prompt).toContain("Correct one step");
    expect(prompt).toContain('"id": "step-submit"');
    expect(prompt).toContain("if I attach or describe a re-recording");
    expect(prompt).toContain("only as evidence for this step");
    expect(prompt).toContain("Return only the revised JSON object");
    expect(prompt).not.toContain("artifactUrl");
    expect(() =>
      buildRecordingStepCorrectionPrompt(review.review!, "missing-step"),
    ).toThrow("Recording draft step not found");
  });

  it("builds run-and-fix prompts from a draft review", () => {
    const review = createRecordingSkillDraftReview({
      nowMs: 778,
      session: {
        id: "session-run-fix",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        qualityStatus: "ready",
        traceEventCount: 4,
        markerCount: 1,
        redactedEventCount: 0,
      },
      text: JSON.stringify({
        title: "Submit invoice",
        description: "Submit invoice and verify confirmation.",
        steps: [{ id: "step-submit", intent: "Submit invoice" }],
        verification: [{ kind: "ui_text", label: "Submitted" }],
      }),
    });

    expect(review.review).not.toBeNull();
    const prompt = buildRecordingSkillRunFixPrompt(review.review!);

    expect(prompt).toContain("Run and repair");
    expect(prompt).toContain("dry-run smoke path first");
    expect(prompt).toContain("do not perform irreversible target actions");
    expect(prompt).toContain("Return only the revised JSON object");
    expect(prompt).not.toContain("workflow-recording.webm");
    expect(prompt).not.toContain("data:image");
  });

  it("builds a forwarded run payload from recording artifacts", () => {
    const payload = buildRecordingRunPayload({
      videoName: "workflow-recording.webm",
      trace: { text: "{\"events\":[]}", truncated: false },
      transcript: { text: "User narrated the workflow.", truncated: false },
      metadata: { text: "{\"version\":1}", truncated: false },
      redactions: [
        {
          id: "trace-token-1",
          severity: "block",
          label: "Token",
          description: "A token appears in the recording artifact.",
          artifact: "trace",
          resolved: false,
        },
      ],
      session: {
        id: "session-4",
        targetKind: "browser",
        targetLabel: "Private App - Customer SSN Review",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        mimeType: "video/webm",
        sizeBytes: 2048,
        traceEventCount: 4,
        markerCount: 1,
        redactedEventCount: 2,
        transcriptSegmentCount: 3,
        keyframeCount: 2,
        qualityStatus: "ready",
        captureStats: {
          backend: "windows_xcap_mjpeg_avi",
          framesReceived: 40,
          framesEncoded: 15,
          framesSkipped: 25,
          encodeErrorCount: 0,
          effectiveFps: 7.5,
        },
        context: {
          targetId: "browser",
          captureWindowId: "123",
          captureWindow: {
            id: "123",
            appName: "Private App",
            title: "Customer SSN Review",
            bounds: { x: 10, y: 20, width: 640, height: 480 },
          },
          includeMicrophone: true,
          includeCamera: false,
          executableUpgrade: true,
          traceScopeNote: "DOM trace covers the current Seren tab only.",
          prep: {
            goal: "",
            successState: "",
            variableInputs: "/Users/alice/private-report.pdf",
            preferences: "Use defaults",
            tosAcknowledged: true,
          },
        },
      },
    });

    const recording = payload.recording as {
      session: { targetLabel: string };
      traceScopeNote: string;
      context: {
        targetId: string;
        prep: { variableInputs: string; preferences: string };
        captureWindowId?: string;
        captureWindow?: unknown;
      };
      redactions: unknown[];
      redactionSummary: { total: number; unresolvedBlocking: number };
      counts: {
        redactedEvents: number;
        traceTruncated: boolean;
        transcriptSegments: number;
        keyframes: number;
      };
      captureStats: { backend: string; framesEncoded: number };
      artifacts: {
        video: { localOnly: boolean };
        transcript: { text: string; truncated: boolean } | null;
        keyframes: { count: number; localOnly: boolean };
        metadata: { text: string; truncated: boolean } | null;
      };
    };
    expect(recording.traceScopeNote).toBe(
      "DOM trace covers the current Seren tab only.",
    );
    expect(recording.session.targetLabel).toBe("Browser");
    expect(recording.redactions).toHaveLength(1);
    expect(recording.redactionSummary).toMatchObject({
      total: 1,
      unresolvedBlocking: 1,
    });
    expect(recording.counts.redactedEvents).toBe(2);
    expect(recording.counts.traceTruncated).toBe(false);
    expect(recording.counts.transcriptSegments).toBe(3);
    expect(recording.counts.keyframes).toBe(2);
    expect(recording.captureStats).toMatchObject({
      backend: "windows_xcap_mjpeg_avi",
      framesEncoded: 15,
    });
    expect(recording.context.targetId).toBe("browser");
    expect(recording.context.prep.variableInputs).toBe("");
    expect(recording.context.prep.preferences).toBe("Use defaults");
    expect(recording.context.captureWindowId).toBeUndefined();
    expect(recording.context.captureWindow).toBeUndefined();
    expect(recording.artifacts.video.localOnly).toBe(true);
    expect(recording.artifacts.keyframes).toEqual({
      count: 2,
      localOnly: true,
    });
    expect(recording.artifacts.transcript?.text).toBe(
      "User narrated the workflow.",
    );
    expect(recording.artifacts.metadata?.text).toContain(
      "workflow_recording_metadata_summary",
    );
    expect(JSON.stringify(recording)).not.toContain("Customer SSN Review");
    expect(JSON.stringify(recording)).not.toContain("artifactUrl");
    expect(JSON.stringify(recording)).not.toContain("file://");
  });

  it("prepares run payloads by scanning and stripping blocked artifacts", () => {
    const result = prepareRecordingRunPayload({
      videoName: "workflow-recording.webm",
      trace: {
        text: JSON.stringify({
          events: [{ value: "api_key = sk_test_1234567890abcdef" }],
        }),
        truncated: false,
      },
      metadata: {
        text: JSON.stringify({
          owner: "support@example.com",
          artifactUrl: "file:///Users/alice/recording/workflow.mov",
          outputDir: "/Users/alice/recording",
          context: {
            captureWindow: { title: "Sensitive Customer Window" },
          },
        }),
        truncated: false,
      },
      transcript: {
        text: "The operator said client_secret = sk_test_1234567890abcdef aloud.",
        truncated: false,
      },
      session: {
        id: "session-prepared-payload",
        targetKind: "browser",
        targetLabel: "Private App - Sensitive Customer Window",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        mimeType: "video/webm",
        sizeBytes: 2048,
        traceEventCount: 4,
        qualityStatus: "ready",
        captureStats: {
          backend: "windows_xcap_mjpeg_avi",
          framesEncoded: 15,
          effectiveFps: 7.5,
        },
        context: {
          targetId: "browser",
          captureWindowId: "123",
          captureWindow: {
            id: "123",
            appName: "Private App",
            title: "Sensitive Customer Window",
            bounds: { x: 10, y: 20, width: 640, height: 480 },
          },
          includeMicrophone: true,
          includeCamera: false,
          executableUpgrade: true,
          prep: {
            goal: "Submit report",
            successState: "Report submitted",
            variableInputs: "file:///Users/alice/recording/input.pdf",
            preferences: "client_secret = sk_test_1234567890abcdef",
            tosAcknowledged: true,
          },
        },
      },
    });

    const recording = result.payload.recording as {
      context: unknown;
      session: { targetLabel: string };
      artifacts: {
        trace: { text: string; truncated: boolean } | null;
        transcript: { text: string; truncated: boolean } | null;
        metadata: { text: string; truncated: boolean } | null;
      };
      captureStats: { backend: string; framesEncoded: number } | null;
      redactionSummary: { total: number; unresolvedBlocking: number };
    };

    expect(result.blockingRedactionCount).toBe(8);
    expect(result.warningRedactionCount).toBe(1);
    expect(recording.context).toBeNull();
    expect(recording.session.targetLabel).toBe("Browser");
    expect(recording.captureStats).toMatchObject({
      backend: "windows_xcap_mjpeg_avi",
      framesEncoded: 15,
    });
    expect(recording.artifacts.trace?.text).toBe(
      JSON.stringify({
        blocked: true,
        reason: "redaction_required",
        artifact: "trace",
      }),
    );
    expect(recording.artifacts.transcript?.text).toBe(
      JSON.stringify({
        blocked: true,
        reason: "redaction_required",
        artifact: "transcript",
      }),
    );
    expect(recording.artifacts.metadata?.text).toContain(
      "workflow_recording_metadata_summary",
    );
    expect(recording.artifacts.metadata?.text).not.toContain(
      "support@example.com",
    );
    expect(recording.redactionSummary).toMatchObject({
      total: 9,
      unresolvedBlocking: 8,
    });
    expect(JSON.stringify(recording)).not.toContain("sk_test");
    expect(JSON.stringify(recording)).not.toContain("file://");
    expect(JSON.stringify(recording)).not.toContain("/Users/alice");
    expect(JSON.stringify(recording)).not.toContain("Sensitive Customer Window");
  });

  it("creates a reviewable draft from recording context", () => {
    const draft = createEmptyRecordingSkillDraft(
      {
        id: "session-draft",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        traceEventCount: 4,
        traceTruncated: true,
        markerCount: 1,
        redactedEventCount: 2,
        transcriptSegmentCount: 3,
        keyframeCount: 2,
        qualityStatus: "ready",
        context: {
          targetId: "browser",
          includeMicrophone: true,
          includeCamera: false,
          executableUpgrade: true,
          prep: {
            goal: "Submit payroll",
            successState: "Payroll confirmation is visible",
            variableInputs: "Pay period",
            preferences: "",
            tosAcknowledged: true,
          },
        },
      },
      123,
    );

    expect(draft).toMatchObject({
      id: "draft-session-draft",
      sessionId: "session-draft",
      title: "Submit payroll",
      description: "Payroll confirmation is visible",
      status: "draft",
      capture: {
        targetKind: "browser",
        targetLabel: "Browser workflow",
        qualityStatus: "ready",
        traceEvents: 4,
        traceTruncated: true,
        markers: 1,
        redactedEvents: 2,
        transcriptSegments: 3,
        keyframes: 2,
      },
      createdAtMs: 123,
      updatedAtMs: 123,
    });

    const blockedDraft = createEmptyRecordingSkillDraft(
      {
        id: "session-retry",
        targetKind: "screen",
        targetLabel: "Screen workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        qualityStatus: "retry",
      },
      456,
    );
    expect(blockedDraft.status).toBe("blocked");
    expect(blockedDraft.title).toBe("Screen workflow");
  });

  it("tolerates malformed recording prep from backend payloads", () => {
    const session = {
      id: "session-malformed-prep",
      targetKind: "browser",
      targetLabel: "Browser workflow",
      startedAtMs: 0,
      outputDir: null,
      maxVideoHeight: 720,
      qualityStatus: "ready",
      context: {
        targetId: "browser",
        includeMicrophone: false,
        includeCamera: false,
        executableUpgrade: true,
        prep: {
          goal: null,
          successState: 123,
          variableInputs: ["unexpected"],
          preferences: false,
          tosAcknowledged: true,
        },
      },
    } as unknown as RecordingSession;

    expect(createEmptyRecordingSkillDraft(session, 1)).toMatchObject({
      title: "Browser workflow",
      description: "Draft generated from a workflow recording.",
    });

    const prompt = buildRecordingSkillDraftPrompt(session);
    expect(prompt).toContain("- goal: not specified");
    expect(prompt).toContain("- success state: not specified");
    expect(prompt).toContain("- variable inputs: not specified");
    expect(prompt).toContain("- preferences: not specified");
  });

  it("evaluates publication readiness for generated drafts", () => {
    const draft: RecordingSkillDraft = {
      id: "draft-session-ready",
      sessionId: "session-ready",
      title: "Submit payroll",
      description: "Payroll confirmation is visible",
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
      assumptions: ["Payroll provider keeps the same navigation labels."],
      verification: [
        {
          kind: "ui_text",
          label: "Confirmation",
          value: "Payroll submitted",
        },
      ],
      recovery: [],
      redactions: [
        {
          id: "redaction-1",
          severity: "block",
          label: "Visible SSN",
          description: "Sensitive value appears in the video.",
          artifact: "video",
          resolved: false,
        },
        {
          id: "redaction-2",
          severity: "warn",
          label: "Customer name",
          description: "Visible customer name may need review.",
          artifact: "trace",
          resolved: false,
        },
      ],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const blocked = evaluateRecordingPublishReadiness(draft);
    expect(blocked.canPublish).toBe(false);
    expect(blocked.blockingReasons).toContain(
      "Unresolved redaction finding: Visible SSN",
    );
    expect(blocked.warningReasons).toContain(
      "Unresolved redaction warning: Customer name",
    );
    expect(blocked.warningReasons).toContain(
      "Draft includes assumptions that should be reviewed.",
    );
    expect(blocked.warningReasons).toContain("Draft has no recovery guidance.");

    const ready = evaluateRecordingPublishReadiness({
      ...draft,
      assumptions: [],
      recovery: [{ when: "Submission fails", do: "Retry from the review page." }],
      redactions: draft.redactions.map((finding) => ({
        ...finding,
        resolved: true,
      })),
    });
    expect(ready).toEqual({
      canPublish: true,
      blockingReasons: [],
      warningReasons: [],
    });

    const incomplete = evaluateRecordingPublishReadiness({
      ...draft,
      status: "draft",
      steps: [],
      verification: [],
      redactions: [],
    });
    expect(incomplete.canPublish).toBe(false);
    expect(incomplete.blockingReasons).toContain(
      "Draft has not been marked ready to publish.",
    );
    expect(incomplete.blockingReasons).toContain(
      "Draft has no executable steps.",
    );
    expect(incomplete.blockingReasons).toContain(
      "Draft has no verification checks.",
    );
  });

  it("blocks publish when draft text itself carries sensitive content", () => {
    const draft: RecordingSkillDraft = {
      id: "draft-session-leak",
      sessionId: "session-leak",
      title: "Rotate API key",
      description: "Confirm rotation succeeded",
      status: "ready_to_publish",
      steps: [
        {
          id: "step-1",
          intent: "Paste api_key=AKIA1234SECRETVALUE into the form",
          essential: true,
          needsConfirmation: false,
        },
      ],
      inputs: [],
      assumptions: [],
      verification: [
        { kind: "ui_text", label: "Done", value: "Rotated" },
      ],
      recovery: [{ when: "Fails", do: "Retry." }],
      redactions: [],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const readiness = evaluateRecordingPublishReadiness(draft);
    expect(readiness.canPublish).toBe(false);
    expect(readiness.blockingReasons).toContain(
      "Draft text contains sensitive content: Credential",
    );
  });

  it("blocks publish when generated selectors carry sensitive content", () => {
    const draft: RecordingSkillDraft = {
      id: "draft-selector-leak",
      sessionId: "session-selector-leak",
      title: "Submit form",
      description: "Submit form and verify completion.",
      status: "ready_to_publish",
      steps: [
        {
          id: "step-1",
          intent: "Click submit",
          target: {
            role: "button",
            name: "Submit",
            selectors: ['[data-api-key="AKIA1234SECRETVALUE"]'],
          },
          essential: true,
          needsConfirmation: false,
        },
      ],
      inputs: [],
      assumptions: [],
      verification: [{ kind: "ui_text", label: "Done", value: "Completed" }],
      recovery: [{ when: "Fails", do: "Retry." }],
      redactions: [],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const readiness = evaluateRecordingPublishReadiness(draft);
    expect(readiness.canPublish).toBe(false);
    expect(readiness.blockingReasons).toContain(
      "Draft text contains sensitive content: Credential",
    );
  });

  it("blocks publish when generated draft text carries local paths", () => {
    const draft: RecordingSkillDraft = {
      id: "draft-local-path",
      sessionId: "session-local-path",
      title: "Upload receipt",
      description: "Upload a receipt and verify completion.",
      status: "ready_to_publish",
      steps: [
        {
          id: "step-1",
          intent: "Upload /Users/christian/Receipts/q2-payroll.pdf",
          essential: true,
          needsConfirmation: false,
        },
      ],
      inputs: [],
      assumptions: [],
      verification: [{ kind: "ui_text", label: "Done", value: "Uploaded" }],
      recovery: [{ when: "Upload fails", do: "Ask for a new file." }],
      redactions: [],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const readiness = evaluateRecordingPublishReadiness(draft);
    expect(readiness.canPublish).toBe(false);
    expect(readiness.blockingReasons).toContain(
      "Draft text contains sensitive content: Local file path",
    );
  });

  it("builds a public recorded skill bundle without raw artifacts", () => {
    const draft: RecordingSkillDraft = {
      id: "draft-bundle",
      sessionId: "session-bundle",
      title: "Submit Payroll!",
      description: "Submit payroll and verify the confirmation page.",
      status: "ready_to_publish",
      steps: [
        {
          id: "step-1",
          intent: "Open payroll dashboard",
          target: { role: "link", name: "Payroll" },
          essential: true,
          needsConfirmation: false,
        },
        {
          id: "step-2",
          intent: "Submit the payroll run",
          essential: true,
          needsConfirmation: true,
        },
      ],
      inputs: [
        {
          name: "payroll_period",
          type: "date",
          label: "Payroll period",
          required: true,
          source: "varies",
        },
      ],
      assumptions: ["Payroll provider navigation remains stable."],
      verification: [
        {
          kind: "ui_text",
          label: "Confirmation",
          value: "Payroll submitted",
        },
      ],
      recovery: [
        {
          when: "Login required",
          do: "Ask the user to sign in and then resume.",
        },
      ],
      redactions: [],
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const bundle = buildRecordingSkillBundle(draft);
    const files = Object.fromEntries(
      bundle.files.map((file) => [file.path, file.content]),
    );

    expect(bundle.slug).toBe("submit-payroll");
    expect(Object.keys(files).sort()).toEqual([
      "SKILL.md",
      "config.example.json",
      "requirements.txt",
      "scripts/agent.py",
      "skill.spec.yaml",
      "tests/test_smoke.py",
    ]);
    expect(files["SKILL.md"]).toContain("scripts/agent.py");
    expect(files["SKILL.md"]).toContain("config.example.json");
    expect(files["SKILL.md"]).toContain("recorded/unverified");
    expect(files["SKILL.md"]).toContain(
      'Use when the user asks to run the recorded workflow \\"Submit Payroll!\\".',
    );

    const spec = files["skill.spec.yaml"] ?? "";
    expect(spec.trim().startsWith("{")).toBe(false);
    expect(spec).toContain('skill: "submit-payroll"');
    expect(spec).toContain(
      'description: "Submit payroll and verify the confirmation page. Use when the user asks to run the recorded workflow \\"Submit Payroll!\\"."',
    );
    expect(spec).toContain("triggers:");
    expect(spec).toContain('- "run submit payroll"');
    expect(spec).toContain('- "submit payroll"');
    expect(spec).toContain(
      '- "submit payroll and verify the confirmation page"',
    );
    expect(spec).toContain('status: "recorded_unverified"');
    expect(spec).toContain('kind: "agentic"');
    expect(spec).toContain('language: "python"');
    expect(spec).toContain('entrypoint: "scripts/agent.py"');
    expect(spec).toContain("inputs:");
    expect(spec).toContain("payroll_period:");
    expect(spec).toContain('type: "date"');
    expect(spec).toContain('label: "Payroll period"');
    expect(spec).toContain('intent: "Open payroll dashboard"');
    expect(spec).toContain('intent: "Submit the payroll run"');
    expect(spec).toContain("needsConfirmation: true");
    expect(spec).toContain("publicBundleExcludesRecordingArtifacts: true");
    expect(spec).toContain('visibility: "private"');
    expect(files["scripts/agent.py"]).toContain("yaml.safe_load");
    expect(files["scripts/agent.py"]).toContain("missing_required_inputs");
    expect(files["scripts/agent.py"]).toContain("ready_for_execution");
    expect(files["scripts/agent.py"]).toContain("blocked_reason");
    expect(files["scripts/agent.py"]).toContain("confirmBeforeSubmit");
    expect(files["scripts/agent.py"]).toContain("isinstance(inputs, dict)");
    expect(files["scripts/agent.py"]).not.toContain("list[str]");
    expect(files["tests/test_smoke.py"]).toContain("yaml.safe_load");
    expect(files["tests/test_smoke.py"]).toContain("spec.get('triggers')");
    expect(files["tests/test_smoke.py"]).toContain("spec.get('inputs')");
    expect(files["requirements.txt"]).toContain("PyYAML");

    const config = JSON.parse(files["config.example.json"] ?? "{}") as {
      inputs: Record<string, unknown>;
    };
    expect(config.inputs).toEqual({ payroll_period: null });

    const publicBundleText = bundle.files
      .map((file) => `${file.path}\n${file.content}`)
      .join("\n");
    expect(publicBundleText).not.toContain("workflow-trace");
    expect(publicBundleText).not.toContain("workflow-recording");
    expect(publicBundleText).not.toContain("provenance");
    expect(publicBundleText).not.toContain("artifactUrl");
  });

  it("downloads generated skill bundles as tar archives", () => {
    const bundle = buildRecordingSkillBundle({
      id: "draft-tar",
      sessionId: "session-tar",
      title: "Submit Payroll",
      description: "Submit payroll and verify the confirmation page.",
      status: "ready_to_publish",
      steps: [
        {
          id: "step-1",
          intent: "Open payroll dashboard",
          essential: true,
          needsConfirmation: false,
        },
      ],
      inputs: [],
      assumptions: [],
      verification: [{ kind: "ui_text", label: "Done", value: "Submitted" }],
      recovery: [{ when: "Submit fails", do: "Retry from the review page." }],
      redactions: [],
      createdAtMs: 1,
      updatedAtMs: 2,
    });

    const archive = buildRecordingSkillBundleTar(bundle);
    const entries = readTarEntries(archive);
    expect(archive.length % 512).toBe(0);
    expect(Object.keys(entries).sort()).toEqual(
      bundle.files.map((file) => `${bundle.slug}/${file.path}`).sort(),
    );
    expect(entries["submit-payroll/SKILL.md"]).toContain("Submit Payroll");
    expect(entries["submit-payroll/skill.spec.yaml"]).toContain(
      'skill: "submit-payroll"',
    );
    expect(JSON.stringify(entries)).not.toContain("workflow-recording");
    expect(JSON.stringify(entries)).not.toContain("provenance");
  });

  it("rejects unsafe paths in generated tar archives", () => {
    expect(() =>
      buildRecordingSkillBundleTar({
        slug: "unsafe",
        files: [{ path: "../SKILL.md", content: "bad" }],
      }),
    ).toThrow("Recording skill bundle file path is not tar-safe");
    expect(() =>
      buildRecordingSkillBundleTar({
        slug: "unsafe",
        files: [{ path: "/tmp/SKILL.md", content: "bad" }],
      }),
    ).toThrow("Recording skill bundle file path is not tar-safe");
    expect(() =>
      buildRecordingSkillBundleTar({
        slug: "unsafe",
        files: [{ path: "scripts\\agent.py", content: "bad" }],
      }),
    ).toThrow("Recording skill bundle file path is not tar-safe");
    expect(() =>
      buildRecordingSkillBundleTar({
        slug: "../unsafe",
        files: [{ path: "SKILL.md", content: "bad" }],
      }),
    ).toThrow("Recording skill bundle file path is not tar-safe");
    expect(() =>
      buildRecordingSkillBundleTar({
        slug: "s",
        files: [{ path: "é".repeat(50), content: "bad" }],
      }),
    ).toThrow("Recording skill bundle file path is not tar-safe");
  });

  it("keeps generated skill triggers concise", () => {
    const bundle = buildRecordingSkillBundle({
      id: "draft-trigger",
      sessionId: "session-trigger",
      title: "Run Payroll",
      description:
        "Submit payroll and verify the confirmation page with a long trailing explanation that should not become a giant trigger phrase for the catalog",
      status: "ready_to_publish",
      steps: [
        {
          id: "step-1",
          intent: "Submit payroll",
          essential: true,
          needsConfirmation: false,
        },
      ],
      inputs: [],
      assumptions: [],
      verification: [{ kind: "ui_text", label: "Done", value: "Submitted" }],
      recovery: [{ when: "Submit fails", do: "Retry from the review page." }],
      redactions: [],
      createdAtMs: 1,
      updatedAtMs: 2,
    });

    const spec = bundle.files.find((file) => file.path === "skill.spec.yaml")
      ?.content;
    expect(spec).toContain('- "run payroll"');
    expect(spec).not.toContain('- "run run payroll"');
    expect(spec).toContain(
      '- "submit payroll and verify the confirmation page with a long trailing explanation that should"',
    );
  });

  it("renders generated markdown fields as single-line prose", () => {
    const bundle = buildRecordingSkillBundle({
      id: "draft-markdown",
      sessionId: "session-markdown",
      title: "Submit\nPayroll",
      description: "Submit payroll\nand verify confirmation.",
      status: "ready_to_publish",
      steps: [
        {
          id: "step-1",
          intent: "Open\npayroll dashboard",
          essential: true,
          needsConfirmation: false,
        },
      ],
      inputs: [
        {
          name: "pay_period",
          type: "date",
          label: "Pay\nperiod",
          description: "The payroll\nperiod",
          required: true,
        },
      ],
      assumptions: ["Navigation\nlabels stay stable."],
      verification: [
        {
          kind: "ui_text",
          label: "Confirmation\nmessage",
          value: "Payroll\nsubmitted",
        },
      ],
      recovery: [
        {
          when: "Submit\nfails",
          do: "Return to the review page\nand retry.",
        },
      ],
      redactions: [],
      createdAtMs: 1,
      updatedAtMs: 2,
    });

    const skillMd = bundle.files.find((file) => file.path === "SKILL.md")
      ?.content;
    expect(skillMd).toContain("# Submit Payroll");
    expect(skillMd).toContain("Submit payroll and verify confirmation.");
    expect(skillMd).toContain("1. Open payroll dashboard");
    expect(skillMd).toContain(
      "- pay_period (date, required): The payroll period",
    );
    expect(skillMd).toContain("- Navigation labels stay stable.");
    expect(skillMd).toContain(
      "- Confirmation message - ui_text - Payroll submitted",
    );
    expect(skillMd).toContain(
      "- Submit fails: Return to the review page and retry.",
    );
    expect(skillMd).not.toContain("# Submit\nPayroll");
  });

  it("quotes unsafe generated YAML keys", () => {
    const bundle = buildRecordingSkillBundle({
      id: "draft-unsafe-key",
      sessionId: "session-unsafe-key",
      title: "Submit Form",
      description: "Submit form and verify completion.",
      status: "ready_to_publish",
      steps: [
        {
          id: "step-1",
          intent: "Submit form",
          essential: true,
          needsConfirmation: false,
        },
      ],
      inputs: [
        {
          name: "customer: id",
          type: "string",
          label: "Customer ID",
          required: true,
        },
      ],
      assumptions: [],
      verification: [{ kind: "ui_text", label: "Done", value: "Submitted" }],
      recovery: [{ when: "Submit fails", do: "Retry from the form page." }],
      redactions: [],
      createdAtMs: 1,
      updatedAtMs: 2,
    });

    const spec = bundle.files.find((file) => file.path === "skill.spec.yaml")
      ?.content;
    expect(spec).toContain('"customer: id":');
    expect(spec).not.toContain("customer: id:");
  });

  it("normalizes untrusted generated draft output", () => {
    const draft = normalizeRecordingSkillDraft({
      nowMs: 999,
      session: {
        id: "session-normalize",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        qualityStatus: "ready",
        traceEventCount: 4,
        traceTruncated: true,
        markerCount: 1,
        redactedEventCount: 2,
        transcriptSegmentCount: 3,
        keyframeCount: 2,
      },
      redactions: [
        {
          id: "trace-token-1",
          severity: "block",
          label: "Token",
          description: "A token appears in the trace.",
          artifact: "trace",
          resolved: false,
        },
      ],
      draft: {
        id: "model-draft",
        sessionId: "wrong-session",
        title: "  Submit payroll  ",
        description: "  Payroll confirmation is visible  ",
        status: "ready_to_publish",
        steps: [
          {
            id: "step-open",
            intent: "Open payroll",
            essential: false,
            needsConfirmation: true,
            target: {
              role: "button",
              name: "Payroll",
              selectors: ["button[data-payroll]", ""],
              bbox: { x: 1, y: 2, width: 3, height: 4 },
            },
            sourceEventRange: { start: 2, end: 1 },
          },
          { intent: "" },
          "ignore",
        ],
        inputs: [
          {
            name: "pay_period",
            type: "date",
            label: "Pay period",
            required: false,
            source: "prep",
          },
          {
            name: "Customer: ID",
            type: "string",
            label: "Customer ID",
          },
          {
            name: "Customer ID",
            type: "string",
            label: "Customer duplicate",
          },
          {
            type: "string",
            label: "Approval comment",
          },
          {
            name: "2026 period",
            type: "date",
            label: "2026 period",
          },
          { name: "", label: "" },
        ],
        assumptions: [" Same navigation labels ", ""],
        verification: [
          {
            kind: "ui_text",
            label: "Confirmation",
            value: "Payroll submitted",
          },
          { kind: "unknown", label: "Review manually" },
          { value: "missing label" },
        ],
        recovery: [
          { when: "Upload fails", do: "Retry from the upload page." },
          { when: "Incomplete" },
        ],
        redactions: [
          {
            id: "trace-token-1",
            severity: "block",
            label: "Model tried to resolve token",
            description: "Should not replace scanner finding.",
            artifact: "trace",
            resolved: true,
          },
          {
            severity: "warn",
            label: "Customer name",
            description: "Visible customer name.",
            artifact: "video",
          },
          {
            severity: "block",
            label: "Context secret",
            description: "Sensitive context.",
            artifact: "context",
          },
        ],
        createdAtMs: 123,
      },
    });

    expect(draft).toMatchObject({
      id: "model-draft",
      sessionId: "session-normalize",
      title: "Submit payroll",
      description: "Payroll confirmation is visible",
      status: "blocked",
      createdAtMs: 123,
      updatedAtMs: 999,
    });
    expect(draft.steps).toEqual([
      expect.objectContaining({
        id: "step-open",
        intent: "Open payroll",
        essential: false,
        needsConfirmation: true,
        target: {
          role: "button",
          name: "Payroll",
          selectors: ["button[data-payroll]"],
          bbox: { x: 1, y: 2, width: 3, height: 4 },
        },
      }),
    ]);
    expect(draft.steps[0]?.sourceEventRange).toBeUndefined();
    expect(draft.inputs).toEqual([
      expect.objectContaining({
        name: "pay_period",
        type: "date",
        label: "Pay period",
        required: false,
      }),
      expect.objectContaining({
        name: "customer_id",
        label: "Customer ID",
      }),
      expect.objectContaining({
        name: "customer_id_2",
        label: "Customer duplicate",
      }),
      expect.objectContaining({
        name: "approval_comment",
        label: "Approval comment",
        type: "string",
      }),
      expect.objectContaining({
        name: "input_2026_period",
        label: "2026 period",
        type: "date",
      }),
    ]);
    expect(draft.assumptions).toEqual(["Same navigation labels"]);
    expect(draft.verification).toEqual([
      expect.objectContaining({ kind: "ui_text", label: "Confirmation" }),
      expect.objectContaining({
        kind: "human_confirmation",
        label: "Review manually",
      }),
    ]);
    expect(draft.recovery).toEqual([
      { when: "Upload fails", do: "Retry from the upload page." },
    ]);
    expect(draft.redactions).toEqual([
      expect.objectContaining({
        id: "trace-token-1",
        label: "Token",
        resolved: false,
      }),
      expect.objectContaining({
        id: "video-finding-2",
        severity: "warn",
        label: "Customer name",
      }),
      expect.objectContaining({
        id: "context-finding-3",
        severity: "block",
        label: "Context secret",
        artifact: "context",
      }),
    ]);
    expect(draft.capture).toMatchObject({
      targetKind: "browser",
      traceEvents: 4,
      traceTruncated: true,
      markers: 1,
      redactedEvents: 2,
      transcriptSegments: 3,
      keyframes: 2,
    });
  });

  it("normalizes publishable drafts into the readiness contract", () => {
    const draft = normalizeRecordingSkillDraft({
      nowMs: 999,
      session: {
        id: "session-ready-draft",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        qualityStatus: "ready",
      },
      draft: {
        title: "Submit payroll",
        description: "Payroll confirmation is visible",
        status: "ready_to_publish",
        steps: [
          {
            intent: "Submit payroll",
            essential: true,
            needsConfirmation: false,
            sourceEventRange: { start: 1, end: 2 },
          },
        ],
        verification: [{ kind: "ui_text", label: "Confirmation" }],
        recovery: [{ when: "Submit fails", do: "Retry the final action." }],
      },
    });

    expect(evaluateRecordingPublishReadiness(draft)).toEqual({
      canPublish: true,
      blockingReasons: [],
      warningReasons: [],
    });
  });

  it("parses generated draft JSON from model responses", () => {
    const result = parseRecordingSkillDraftText({
      nowMs: 777,
      session: {
        id: "session-parse",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        qualityStatus: "ready",
      },
      text: [
        "Here is the draft:",
        "```json",
        JSON.stringify({
          title: "Submit invoice",
          status: "ready_to_publish",
          steps: [{ intent: "Submit invoice" }],
          verification: [{ kind: "ui_text", label: "Submitted" }],
          recovery: [{ when: "Submit fails", do: "Retry submit." }],
        }),
        "```",
      ].join("\n"),
    });

    expect(result.error).toBeNull();
    expect(result.draft).toMatchObject({
      sessionId: "session-parse",
      title: "Submit invoice",
      status: "ready_to_publish",
      updatedAtMs: 777,
    });
  });

  it("creates a generated draft review with readiness and bundle metadata", () => {
    const result = createRecordingSkillDraftReview({
      nowMs: 778,
      session: {
        id: "session-review",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
        qualityStatus: "ready",
      },
      text: JSON.stringify({
        title: "Submit invoice",
        description: "Submit invoice and verify the confirmation.",
        status: "ready_to_publish",
        steps: [{ intent: "Submit invoice" }],
        verification: [{ kind: "ui_text", label: "Submitted" }],
        recovery: [{ when: "Submit fails", do: "Retry submit." }],
      }),
    });

    expect(result.error).toBeNull();
    expect(result.review).toMatchObject({
      parsedAtMs: 778,
      readiness: { canPublish: true },
      bundle: {
        slug: "submit-invoice",
        fileCount: 6,
      },
    });
    expect(result.review?.bundle.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "skill.spec.yaml",
      "scripts/agent.py",
      "config.example.json",
      "requirements.txt",
      "tests/test_smoke.py",
    ]);
  });

  it("parses prose-wrapped generated draft JSON", () => {
    const result = parseRecordingSkillDraftText({
      session: {
        id: "session-prose-json",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
      },
      text: 'Draft follows: {"title":"Browser flow","steps":[{"intent":"Open app"}]} Done.',
      nowMs: 888,
    });

    expect(result.error).toBeNull();
    expect(result.draft?.title).toBe("Browser flow");
    expect(result.draft?.steps).toEqual([
      expect.objectContaining({ intent: "Open app" }),
    ]);
  });

  it("reports invalid generated draft text", () => {
    const result = parseRecordingSkillDraftText({
      session: {
        id: "session-invalid-json",
        targetKind: "browser",
        targetLabel: "Browser workflow",
        startedAtMs: 0,
        outputDir: null,
        maxVideoHeight: 720,
      },
      text: "No structured draft here.",
    });

    expect(result).toEqual({
      draft: null,
      error: "No valid recording draft JSON was found.",
    });
  });

  it("scans artifact text for redaction findings without storing values", () => {
    const findings = scanRecordingArtifactTextForRedactions({
      artifact: "trace",
      text: [
        "api_key = sk_test_1234567890abcdef",
        "Email support@example.com",
        "Visit http://localhost:3000/admin",
      ].join("\n"),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        id: "trace-credential_assignment-1",
        severity: "block",
        label: "Credential",
        artifact: "trace",
        resolved: false,
      }),
      expect.objectContaining({
        id: "trace-email-2",
        severity: "warn",
        label: "Email address",
      }),
      expect.objectContaining({
        id: "trace-internal_url-3",
        severity: "warn",
        label: "Internal URL",
      }),
    ]);
    expect(JSON.stringify(findings)).not.toContain("sk_test");
    expect(JSON.stringify(findings)).not.toContain("support@example.com");
  });

  it("does not treat epoch timestamps as payment cards", () => {
    const findings = scanRecordingArtifactTextForRedactions({
      artifact: "metadata",
      text: JSON.stringify({
        startedAtMs: 1781014684000,
        card: "4242 4242 4242 4242",
      }),
    });

    expect(findings).toEqual([
      expect.objectContaining({
        severity: "block",
        label: "Payment card",
      }),
    ]);
  });

  it("caps redaction findings", () => {
    const findings = scanRecordingArtifactTextForRedactions({
      artifact: "metadata",
      text: [
        "password = abcdefghijk",
        "client_secret = zyxwvutsrq",
        "111-22-3333",
      ].join("\n"),
      maxFindings: 2,
    });

    expect(findings).toHaveLength(2);
    expect(findings.every((finding) => finding.severity === "block")).toBe(
      true,
    );
  });

  it("bounds the action trace to keep forwarded payloads small", () => {
    const scrollEvent = (tMs: number): RecordingActionEvent => ({
      tMs,
      type: "scroll",
      source: "browser_dom",
      confidence: 0.65,
      target: { role: "main", name: "Feed", selectors: ["main"] },
      redacted: false,
    });
    const events: RecordingActionEvent[] = [];

    // Consecutive scrolls on the same target collapse to the latest position.
    expect(appendRecordingTraceEvent(events, scrollEvent(10))).toBe(true);
    expect(appendRecordingTraceEvent(events, scrollEvent(20))).toBe(true);
    expect(appendRecordingTraceEvent(events, scrollEvent(30))).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.tMs).toBe(30);

    // Non-marker events stop accumulating once the cap is reached...
    const capped: RecordingActionEvent[] = Array.from({ length: 4 }, (_, i) => ({
      tMs: i,
      type: "click",
      source: "browser_dom",
      confidence: 0.65,
      redacted: false,
    }));
    const click: RecordingActionEvent = {
      tMs: 99,
      type: "click",
      source: "browser_dom",
      confidence: 0.65,
      redacted: false,
    };
    expect(appendRecordingTraceEvent(capped, click, 4)).toBe(false);
    expect(capped).toHaveLength(4);

    // ...but operator markers are always retained.
    const marker: RecordingActionEvent = {
      tMs: 100,
      type: "marker",
      source: "browser_dom",
      confidence: 0.65,
      markerKind: "confirm",
      redacted: false,
    };
    expect(appendRecordingTraceEvent(capped, marker, 4)).toBe(true);
    expect(capped).toHaveLength(5);
    expect(capped.at(-1)?.markerKind).toBe("confirm");
  });

  it("normalizes browser extension sessions into bounded trace artifacts", () => {
    const result = normalizeRecordingBrowserExtensionSession(
      {
        id: "extension-session-1",
        startedAtMs: 123,
        truncated: false,
        debuggerAttached: true,
        debuggerError: "",
        events: [
          {
            tMs: 10.3,
            type: "nav",
            source: "cdp",
            confidence: 0.9,
            url: "https://example.com/workflow?token=secret#hash",
            target: {
              role: "page",
              name: "Workflow",
              selectors: ["html"],
            },
            redacted: false,
          },
          {
            tMs: 20,
            type: "input",
            source: "browser_dom",
            confidence: 0.8,
            target: {
              role: "input",
              name: "[redacted]",
              selectors: ['input[name="password"]'],
            },
            value: { after: "[redacted]" },
            redacted: true,
            redactionReason: "input_value",
          },
          {
            tMs: 30,
            type: "click",
            source: "browser_dom",
            confidence: 0.8,
            target: { role: "button", name: "Ignored after cap" },
            redacted: false,
          },
          {
            tMs: 40,
            type: "marker",
            source: "browser_dom",
            confidence: 1,
            markerKind: "important",
            redacted: false,
          },
        ],
      },
      2,
    );

    expect(result).toMatchObject({
      eventCount: 3,
      markerCount: 1,
      redactedEventCount: 1,
      truncated: true,
      debuggerAttached: true,
      debuggerError: null,
    });
    expect(result.trace).not.toBeNull();

    const trace = JSON.parse(result.trace!.text) as {
      source: string;
      debugger: { attached: boolean; error: string | null };
      events: Array<{
        type: string;
        url?: string;
        markerKind?: string;
        value?: { after?: string };
      }>;
    };
    expect(trace.source).toBe("seren_workflow_recorder_extension");
    expect(trace.debugger).toEqual({ attached: true, error: null });
    expect(trace.events.map((event) => event.type)).toEqual([
      "nav",
      "input",
      "marker",
    ]);
    expect(trace.events[0]?.url).toBe("https://example.com/workflow");
    expect(trace.events[0]?.url).not.toContain("token");
    expect(trace.events[1]?.value?.after).toBe("[redacted]");
    expect(trace.events[2]?.markerKind).toBe("important");
  });

  it("keeps UI behind a host adapter", () => {
    expect(uiSource).toContain("adapter: RecordingHostAdapter");
    expect(uiSource).toContain("props.adapter.listTargets");
    expect(uiSource).toContain("props.adapter.checkPermissions");
    expect(uiSource).toContain("props.adapter.checkBrowserExtension");
    expect(uiSource).toContain("BrowserExtensionReadinessStrip");
    expect(uiSource).toContain("props.adapter.listCaptureWindows");
    expect(uiSource).toContain("props.adapter.captureWindowPreview");
    expect(uiSource).toContain("props.adapter.clearWindowPreviews");
    expect(uiSource).toContain("refreshCaptureWindows");
    expect(uiSource).toContain("onRefreshWindows");
    expect(uiSource).toContain("clearWindowPreviewState");
    expect(uiSource).toContain("WindowCapturePreviewPanel");
    expect(uiSource).toContain("selectedCaptureWindowId");
    expect(uiSource).toContain("selectedCaptureWindow");
    expect(uiSource).toContain("captureWindowId:");
    expect(uiSource).toContain("captureWindow:");
    expect(uiSource).toContain("props.adapter.requestPermission");
    expect(uiSource).toContain("props.adapter.openPermissionSettings");
    expect(uiSource).toContain("props.adapter.start");
    expect(uiSource).toContain("findRecordingPermissionBlocker");
    expect(uiSource).toContain("validateRecordingStartRequest");
    expect(uiSource).toContain("startDisabledReason");
    expect(uiSource).toContain("title={props.startBlocker");
    expect(uiSource).toContain('target.capabilities.includes("camera")');
    expect(uiSource).toContain(
      'target.capabilities.includes("action_trace")',
    );
    expect(uiSource).toContain("props.supportsExecutableTrace");
    expect(uiSource).toContain('target.isAvailable || target.kind === "window"');
    expect(uiSource).toContain("disabled={!selectable()}");
    expect(uiSource).toContain("target.limitations[0]");
    expect(uiSource).toContain("...props.target.limitations");
    expect(uiSource).toContain("For each={details()}");
    expect(uiSource).toContain("RecordingPermissionStrip");
    expect(uiSource).toContain("check.canRequest");
    expect(uiSource).toContain("document.body.appendChild(link)");
    expect(uiSource).toContain("link.remove()");
    expect(uiSource).toContain("props.review.readiness.blockingReasons.map");
    expect(uiSource).toContain('tone: "block" as const');
    expect(uiSource).toContain("onDeleteLocalRecording");
    expect(uiSource).toContain("onDeleteAfterPublishChange");
    expect(uiSource).toContain("delete after publish");
    expect(uiSource).toContain("delete local recording");
    expect(uiSource).toContain('fail(err, "recording")');
    expect(uiSource).toContain('props.status !== "preparing"');
    expect(uiSource).not.toContain("@tauri-apps");
    expect(uiSource).not.toContain("@/");
  });

  it("keeps marker shortcuts visible in the recording toolbar", () => {
    expect(uiSource).toContain("Alt+1");
    expect(uiSource).toContain("Alt+4");
    expect(uiSource).toContain("markerCount");
    expect(uiSource).toContain("lastMarkerLabel");
    expect(uiSource).toContain("activeSuccessState");
    expect(uiSource).toContain("Stop when:");
    expect(uiSource).toContain("Done");
    expect(uiSource).toContain("aria-live=\"polite\"");
    expect(uiSource).toContain('window.addEventListener("keydown"');
    expect(uiSource).toContain("event.altKey");
    // Marker shortcuts must key off the physical code, not event.key: on macOS
    // Option+digit composes a symbol so event.key never equals the digit.
    expect(uiSource).toContain("recordingMarkerForShortcutCode(event.code)");
  });

  it("maps Alt+digit marker shortcuts by physical key code", () => {
    expect(recordingMarkerForShortcutCode("Digit1")).toBe("varies");
    expect(recordingMarkerForShortcutCode("Digit2")).toBe("ignore");
    expect(recordingMarkerForShortcutCode("Digit3")).toBe("important");
    expect(recordingMarkerForShortcutCode("Digit4")).toBe("confirm");
    // macOS Option+3 yields key "£" but code stays "Digit3"; unknown codes and
    // composed-symbol keys must not resolve to a marker.
    expect(recordingMarkerForShortcutCode("£")).toBeNull();
    expect(recordingMarkerForShortcutCode("Digit5")).toBeNull();
    expect(recordingMarkerForShortcutCode("Numpad1")).toBeNull();
  });

  it("wires desktop through an adapter and places the screen recorder in the titlebar (#2609)", () => {
    expect(desktopAdapterSource).toContain("@tauri-apps/api/core");
    expect(desktopAdapterSource).toContain("recording_list_targets");
    expect(desktopAdapterSource).toContain("recording_check_permissions");
    expect(desktopAdapterSource).toContain("recording_request_permission");
    expect(desktopAdapterSource).toContain("convertFileSrc");
    expect(desktopAdapterSource).toContain("recording_start");
    expect(tauriConfigSource).toContain("img-src 'self' asset:");
    expect(tauriConfigSource).toContain("http://asset.localhost");

    // The screen recorder is a capture control: it sits in the titlebar
    // immediately before the meeting recorder, not beside the dictation mic.
    expect(titlebarSource).toContain('from "@seren/recording-ui"');
    expect(titlebarSource).toContain("desktopRecordingAdapter");
    expect(titlebarSource).toContain("<RecordButton");
    expect(titlebarSource.indexOf("<RecordButton")).toBeLessThan(
      titlebarSource.indexOf('data-testid="titlebar-meetings-button"'),
    );

    // It must not render in either composer toolbar; the titlebar offers the
    // stopped session to the handoff store and the active composer consumes it.
    expect(titlebarSource).toContain("recordingHandoff.offer");
    for (const composer of [agentChatSource, chatContentSource]) {
      expect(composer).not.toContain("<RecordButton");
      expect(composer).toContain("recordingHandoff.pending");
    }

    // The trigger glyph reads as "record video", never the ambiguous dot.
    expect(uiSource).not.toContain('<circle cx="8" cy="8" r="5" />');
  });

  it("registers the desktop recording command surface", () => {
    expect(tauriLibSource).toContain("pub mod recording");
    expect(tauriLibSource).toContain("RecordingState::default()");
    expect(tauriLibSource).toContain("recording_list_targets");
    expect(tauriLibSource).toContain("recording_check_permissions");
    expect(tauriLibSource).toContain("recording_request_permission");
    expect(tauriLibSource).toContain("recording_add_marker");
  });
});
