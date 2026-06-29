// ABOUTME: Solid UI for recording workflows and skill-generation prep.
// ABOUTME: Depends on host-provided adapters rather than desktop-native services.

import {
  buildRecordingSkillBundleTar,
  cloneDefaultRecordingPrep,
  findInitialRecordingTarget,
  findRecordingPermissionBlocker,
  formatRecordingError,
  isBrowserCaptureAppName,
  type RecordingBrowserExtensionReadiness,
  type RecordingCaptureWindow,
  type RecordingCaptureWindowPreview,
  type RecordingHostAdapter,
  type RecordingMarkerKind,
  type RecordingPermissionCheck,
  type RecordingPermissionKey,
  type RecordingPermissionPreflight,
  type RecordingPrep,
  type RecordingSession,
  type RecordingSkillDraftReview,
  type RecordingStartRequest,
  type RecordingStatus,
  type RecordingTarget,
  recordingMarkerForShortcutCode,
  recordingMarkerLabel,
  validateRecordingStartRequest,
} from "@seren/recording-core";
import type { JSX } from "solid-js";
import {
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";

export interface RecordButtonProps {
  adapter: RecordingHostAdapter;
  class?: string;
  classNames?: RecordingUiClassNames;
  onSessionStart?: (session: RecordingSession) => void;
  onSessionStop?: (
    session: RecordingSession | null,
    releaseArtifacts?: () => void,
  ) => void;
  onError?: (message: string) => void;
}

export type RecordingUiSlot =
  | "root"
  | "trigger"
  | "toolbar"
  | "toolbarTimer"
  | "toolbarMarker"
  | "dialogBackdrop"
  | "dialog"
  | "dialogHeader"
  | "dialogBody"
  | "dialogFooter"
  | "targetGrid"
  | "targetCard"
  | "statusStrip"
  | "extensionStrip"
  | "permissionStrip"
  | "field"
  | "textarea"
  | "toggle"
  | "primaryButton"
  | "secondaryButton"
  | "reviewPanel"
  | "reviewSummary"
  | "reviewBody"
  | "reviewSidebar"
  | "reviewSection"
  | "reviewBadge"
  | "reviewAction";

export type RecordingUiClassNames = Partial<Record<RecordingUiSlot, string>>;

type ClassValue = string | false | null | undefined;

function cx(...classes: ClassValue[]): string {
  return classes
    .filter((className): className is string => Boolean(className))
    .join(" ");
}

function RecordIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <rect x="1.75" y="4.25" width="8.5" height="7.5" rx="1.75" />
      <path d="M10.25 7 14 5v6l-3.75-2z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function captureWindowsForTargetKind(
  windows: RecordingCaptureWindow[],
  kind: RecordingTarget["kind"] | null | undefined,
): RecordingCaptureWindow[] {
  if (kind === "browser") {
    return windows.filter((window) => isBrowserCaptureAppName(window.appName));
  }
  if (kind === "window") return windows;
  return [];
}

export function RecordButton(props: RecordButtonProps) {
  const [status, setStatus] = createSignal<RecordingStatus>("idle");
  const [dialogOpen, setDialogOpen] = createSignal(false);
  const [targets, setTargets] = createSignal<RecordingTarget[]>([]);
  const [captureWindows, setCaptureWindows] = createSignal<
    RecordingCaptureWindow[]
  >([]);
  const [windowPreview, setWindowPreview] =
    createSignal<RecordingCaptureWindowPreview | null>(null);
  const [previewingWindowId, setPreviewingWindowId] = createSignal<
    string | null
  >(null);
  const [selectedCaptureWindowId, setSelectedCaptureWindowId] = createSignal<
    string | null
  >(null);
  const [refreshingCaptureWindows, setRefreshingCaptureWindows] =
    createSignal(false);
  const [windowPreviewError, setWindowPreviewError] = createSignal<
    string | null
  >(null);
  const [permissionPreflight, setPermissionPreflight] =
    createSignal<RecordingPermissionPreflight | null>(null);
  const [browserExtensionReadiness, setBrowserExtensionReadiness] =
    createSignal<RecordingBrowserExtensionReadiness | null>(null);
  const [permissionRequestKey, setPermissionRequestKey] =
    createSignal<RecordingPermissionKey | null>(null);
  const [selectedTargetId, setSelectedTargetId] = createSignal("screen");
  const [activeSession, setActiveSession] =
    createSignal<RecordingSession | null>(null);
  const [elapsedMs, setElapsedMs] = createSignal(0);
  const [markerCount, setMarkerCount] = createSignal(0);
  const [lastMarkerLabel, setLastMarkerLabel] = createSignal<string | null>(
    null,
  );
  const [prep, setPrep] = createSignal<RecordingPrep>(
    cloneDefaultRecordingPrep(),
  );
  const [includeMicrophone, setIncludeMicrophone] = createSignal(true);
  const [includeCamera, setIncludeCamera] = createSignal(false);
  const [executableUpgrade, setExecutableUpgrade] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);

  const selectedTarget = () =>
    targets().find((target) => target.id === selectedTargetId()) ?? null;
  const selectedTargetCaptureWindows = () =>
    captureWindowsForTargetKind(captureWindows(), selectedTarget()?.kind);
  const selectedCaptureWindow = () =>
    selectedTargetCaptureWindows().find(
      (window) => window.id === selectedCaptureWindowId(),
    ) ?? null;
  const activeSuccessState = () =>
    activeSession()?.context?.prep.successState.trim() || null;
  const supportsExecutableTrace = () =>
    Boolean(selectedTarget()?.capabilities.includes("action_trace"));
  const preferredCaptureWindowId = (
    windows: RecordingCaptureWindow[],
    currentWindowId: string | null,
  ) =>
    windows.find(
      (window) => window.id === currentWindowId && window.isRecordable,
    )?.id ??
    windows.find((window) => window.isFocused && window.isRecordable)?.id ??
    windows.find((window) => window.isRecordable)?.id ??
    null;
  const startRequest = (): RecordingStartRequest | null => {
    const target = selectedTarget();
    if (!target) return null;
    const captureWindow = selectedCaptureWindow();
    return {
      targetId: target.id,
      targetKind: target.kind,
      captureWindowId:
        target.kind === "window" || target.kind === "browser"
          ? selectedCaptureWindowId()
          : null,
      captureWindow:
        (target.kind === "window" || target.kind === "browser") && captureWindow
          ? {
              id: captureWindow.id,
              appName: captureWindow.appName,
              title: captureWindow.title,
              bounds: captureWindow.bounds,
            }
          : null,
      prep: prep(),
      includeMicrophone:
        includeMicrophone() && target.capabilities.includes("microphone"),
      includeCamera: includeCamera() && target.capabilities.includes("camera"),
      executableUpgrade:
        executableUpgrade() && target.capabilities.includes("action_trace"),
    };
  };
  const permissionBlocker = () => {
    const request = startRequest();
    return request
      ? findRecordingPermissionBlocker(permissionPreflight(), request)
      : null;
  };
  const startDisabledReason = () => {
    const request = startRequest();
    if (!request) return "Select a workflow recording target.";
    return (
      validateRecordingStartRequest(targets(), request) ?? permissionBlocker()
    );
  };
  const canStart = () => !startDisabledReason();
  const isBusy = () => status() === "loading" || status() === "preparing";

  const updatePrep = <K extends keyof RecordingPrep>(
    key: K,
    value: RecordingPrep[K],
  ) => {
    setPrep((current) => ({ ...current, [key]: value }));
  };

  const fail = (err: unknown, nextStatus: RecordingStatus = "error") => {
    const message = formatRecordingError(err);
    setStatus(nextStatus);
    setError(message);
    props.onError?.(message);
  };

  const releaseArtifactsFor = (session: RecordingSession) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      void props.adapter.releaseSessionArtifacts?.(session);
    };
  };

  let elapsedTimer: ReturnType<typeof setInterval> | undefined;
  const stopElapsedTimer = () => {
    if (!elapsedTimer) return;
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
  };
  const startElapsedTimer = (session: RecordingSession) => {
    stopElapsedTimer();
    const startedAtMs = session.startedAtMs || Date.now();
    const updateElapsed = () => setElapsedMs(Date.now() - startedAtMs);
    updateElapsed();
    elapsedTimer = setInterval(updateElapsed, 1000);
  };
  onCleanup(stopElapsedTimer);

  const externalStopCleanup = props.adapter.onExternalStop?.((session) => {
    stopElapsedTimer();
    setActiveSession(null);
    setMarkerCount(0);
    setLastMarkerLabel(null);
    setStatus("idle");
    setError(null);
    props.onSessionStop?.(session, releaseArtifactsFor(session));
  });
  onCleanup(() => externalStopCleanup?.());
  onCleanup(() => {
    void props.adapter.clearWindowPreviews?.();
  });

  const openDialog = async () => {
    setDialogOpen(true);
    setError(null);
    setStatus("loading");
    try {
      setPermissionPreflight(null);
      setBrowserExtensionReadiness(null);
      setCaptureWindows([]);
      setWindowPreview(null);
      setWindowPreviewError(null);
      const [
        nextTargets,
        nextPermissionPreflight,
        nextBrowserExtensionReadiness,
        nextCaptureWindows,
      ] = await Promise.all([
        props.adapter.listTargets(),
        props.adapter.checkPermissions?.().catch(() => null) ??
          Promise.resolve(null),
        props.adapter.checkBrowserExtension?.().catch(() => null) ??
          Promise.resolve(null),
        props.adapter.listCaptureWindows?.().catch((err) => {
          setWindowPreviewError(formatRecordingError(err));
          return [] as RecordingCaptureWindow[];
        }) ?? Promise.resolve([]),
      ]);
      setTargets(nextTargets);
      setPermissionPreflight(nextPermissionPreflight);
      setBrowserExtensionReadiness(nextBrowserExtensionReadiness);
      setCaptureWindows(nextCaptureWindows);
      const initial = findInitialRecordingTarget(
        nextTargets,
        selectedTargetId(),
      );
      const nextSelectedTargetId = initial?.id ?? selectedTargetId();
      const nextSelectedTargetKind =
        initial?.kind ??
        nextTargets.find((target) => target.id === nextSelectedTargetId)
          ?.kind ??
        null;
      if (initial) setSelectedTargetId(initial.id);
      const nextSelectedCaptureWindowId = preferredCaptureWindowId(
        captureWindowsForTargetKind(nextCaptureWindows, nextSelectedTargetKind),
        selectedCaptureWindowId(),
      );
      setSelectedCaptureWindowId(nextSelectedCaptureWindowId);
      if (
        (nextSelectedTargetKind === "window" ||
          nextSelectedTargetKind === "browser") &&
        nextSelectedCaptureWindowId
      ) {
        await previewCaptureWindow(nextSelectedCaptureWindowId);
      }
      setStatus("idle");
    } catch (err) {
      fail(err);
    }
  };

  const refreshCaptureWindows = async () => {
    if (!props.adapter.listCaptureWindows || refreshingCaptureWindows()) return;
    setRefreshingCaptureWindows(true);
    setWindowPreviewError(null);
    try {
      const nextCaptureWindows = await props.adapter.listCaptureWindows();
      setCaptureWindows(nextCaptureWindows);
      const targetKind = selectedTarget()?.kind ?? null;
      const nextSelectedCaptureWindowId = preferredCaptureWindowId(
        captureWindowsForTargetKind(nextCaptureWindows, targetKind),
        selectedCaptureWindowId(),
      );
      setSelectedCaptureWindowId(nextSelectedCaptureWindowId);
      if (!nextSelectedCaptureWindowId) {
        setWindowPreview(null);
      } else if (targetKind === "window" || targetKind === "browser") {
        await previewCaptureWindow(nextSelectedCaptureWindowId);
      }
    } catch (err) {
      setWindowPreviewError(formatRecordingError(err));
    } finally {
      setRefreshingCaptureWindows(false);
    }
  };

  const selectTarget = (targetId: string) => {
    setSelectedTargetId(targetId);
    setWindowPreview(null);
    setWindowPreviewError(null);
    const targetKind =
      targets().find((target) => target.id === targetId)?.kind ?? null;
    const windowId = preferredCaptureWindowId(
      captureWindowsForTargetKind(captureWindows(), targetKind),
      selectedCaptureWindowId(),
    );
    setSelectedCaptureWindowId(windowId);
    if ((targetKind === "window" || targetKind === "browser") && windowId) {
      void previewCaptureWindow(windowId);
    }
  };

  const clearWindowPreviewState = () => {
    setWindowPreview(null);
    setPreviewingWindowId(null);
    setWindowPreviewError(null);
    void props.adapter.clearWindowPreviews?.();
  };

  const closeDialog = () => {
    if (status() === "preparing") return;
    clearWindowPreviewState();
    setDialogOpen(false);
  };

  const previewCaptureWindow = async (windowId: string) => {
    if (!props.adapter.captureWindowPreview || previewingWindowId()) return;
    setSelectedCaptureWindowId(windowId);
    setPreviewingWindowId(windowId);
    setWindowPreviewError(null);
    try {
      setWindowPreview(await props.adapter.captureWindowPreview(windowId));
    } catch (err) {
      setWindowPreview(null);
      setWindowPreviewError(formatRecordingError(err));
    } finally {
      setPreviewingWindowId(null);
    }
  };

  const handleWindowPreviewImageError = () => {
    if (!windowPreview()) return;
    setWindowPreview(null);
    setWindowPreviewError(
      "Window preview image could not be loaded. Refresh windows and try again.",
    );
  };

  const start = async () => {
    const target = selectedTarget();
    const request = startRequest();
    if (!target || !request || !canStart()) return;
    setStatus("preparing");
    setError(null);
    try {
      const session = await props.adapter.start(request);
      setDialogOpen(false);
      clearWindowPreviewState();
      setActiveSession(session);
      setMarkerCount(0);
      setLastMarkerLabel(null);
      startElapsedTimer(session);
      setStatus("recording");
      props.onSessionStart?.(session);
    } catch (err) {
      fail(err);
    }
  };

  const requestPermission = async (key: RecordingPermissionKey) => {
    if (!props.adapter.requestPermission || permissionRequestKey()) return;
    setPermissionRequestKey(key);
    setError(null);
    try {
      setPermissionPreflight(await props.adapter.requestPermission(key));
    } catch (err) {
      fail(err, status() === "recording" ? "recording" : "idle");
    } finally {
      setPermissionRequestKey(null);
    }
  };

  const recheckPermissions = async () => {
    if (!props.adapter.checkPermissions) return;
    try {
      setPermissionPreflight(await props.adapter.checkPermissions());
    } catch {
      // Keep the last known preflight if a background refresh fails.
    }
  };

  const openPermissionSettings = async (key: RecordingPermissionKey) => {
    if (!props.adapter.openPermissionSettings) return;
    try {
      await props.adapter.openPermissionSettings(key);
    } catch (err) {
      fail(err, status() === "recording" ? "recording" : "idle");
    }
  };

  // A denied macOS permission can only be changed in System Settings, and the
  // status the OS reports is stale until the app refocuses. Re-check on focus so
  // the strip reflects a grant the user just made without reopening the dialog.
  const onWindowFocus = () => {
    if (!dialogOpen() || isBusy()) return;
    void recheckPermissions();
  };
  onMount(() => {
    window.addEventListener("focus", onWindowFocus);
  });
  onCleanup(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("focus", onWindowFocus);
    }
  });

  const stop = async () => {
    setStatus("processing");
    setError(null);
    try {
      const session = await props.adapter.stop();
      stopElapsedTimer();
      setActiveSession(null);
      setMarkerCount(0);
      setLastMarkerLabel(null);
      setStatus("idle");
      props.onSessionStop?.(
        session,
        session ? releaseArtifactsFor(session) : undefined,
      );
    } catch (err) {
      fail(err, "recording");
    }
  };

  const marker = async (kind: RecordingMarkerKind) => {
    try {
      await props.adapter.addMarker(kind);
      setMarkerCount((count) => count + 1);
      setLastMarkerLabel(recordingMarkerLabel(kind));
    } catch (err) {
      fail(err, status() === "recording" ? "recording" : "error");
    }
  };

  const onMarkerShortcut = (event: KeyboardEvent) => {
    if (
      status() !== "recording" ||
      !event.altKey ||
      event.metaKey ||
      event.ctrlKey
    ) {
      return;
    }
    const kind = recordingMarkerForShortcutCode(event.code);
    if (!kind) return;
    event.preventDefault();
    void marker(kind);
  };
  onMount(() => {
    window.addEventListener("keydown", onMarkerShortcut);
  });
  onCleanup(() => {
    if (typeof window !== "undefined") {
      window.removeEventListener("keydown", onMarkerShortcut);
    }
  });

  return (
    <div
      class={cx("relative flex items-center gap-1", props.classNames?.root)}
      data-rec-slot="root"
    >
      <button
        type="button"
        class={cx(
          props.class ??
            "flex items-center justify-center w-8 h-8 border-none rounded-md bg-transparent text-rec-fg-muted cursor-pointer transition-all duration-150 relative shrink-0 hover:bg-rec-surface-hover hover:text-rec-fg disabled:cursor-not-allowed disabled:opacity-50",
          props.classNames?.trigger,
        )}
        classList={{
          "text-red-600 bg-red-500/10": status() === "recording",
          "cursor-wait": isBusy() || status() === "processing",
          "text-red-600": status() === "error",
        }}
        data-rec-slot="trigger"
        disabled={isBusy() || status() === "processing"}
        title={
          status() === "recording"
            ? "Stop workflow recording"
            : "Record workflow"
        }
        aria-label={
          status() === "recording"
            ? "Stop workflow recording"
            : "Record workflow"
        }
        onClick={() => {
          if (status() === "recording") {
            void stop();
          } else {
            void openDialog();
          }
        }}
      >
        <Show when={status() === "recording"} fallback={<RecordIcon />}>
          <StopIcon />
        </Show>
      </button>

      <Show when={status() === "recording"}>
        <RecordingToolbar
          elapsed={formatElapsed(elapsedMs())}
          targetLabel={activeSession()?.targetLabel}
          successState={activeSuccessState()}
          markerCount={markerCount()}
          lastMarkerLabel={lastMarkerLabel()}
          onMarker={marker}
          onStop={stop}
          classNames={props.classNames}
        />
      </Show>

      <Show when={dialogOpen()}>
        <RecordingDialog
          targets={targets()}
          permissionPreflight={permissionPreflight()}
          browserExtensionReadiness={browserExtensionReadiness()}
          permissionRequestKey={permissionRequestKey()}
          selectedTarget={selectedTarget()}
          selectedTargetId={selectedTargetId()}
          captureWindows={selectedTargetCaptureWindows()}
          windowPreview={windowPreview()}
          previewingWindowId={previewingWindowId()}
          refreshingCaptureWindows={refreshingCaptureWindows()}
          selectedCaptureWindowId={selectedCaptureWindowId()}
          windowPreviewError={windowPreviewError()}
          prep={prep()}
          includeMicrophone={includeMicrophone()}
          includeCamera={includeCamera()}
          executableUpgrade={executableUpgrade()}
          supportsExecutableTrace={supportsExecutableTrace()}
          status={status()}
          error={error()}
          canStart={canStart()}
          startBlocker={startDisabledReason()}
          onClose={closeDialog}
          onSelectTarget={selectTarget}
          onPreviewWindow={(windowId) => void previewCaptureWindow(windowId)}
          onPreviewImageError={handleWindowPreviewImageError}
          onRefreshWindows={() => void refreshCaptureWindows()}
          onPrepChange={updatePrep}
          onIncludeMicrophone={setIncludeMicrophone}
          onIncludeCamera={setIncludeCamera}
          onExecutableUpgrade={setExecutableUpgrade}
          onRequestPermission={
            props.adapter.requestPermission
              ? (key) => void requestPermission(key)
              : undefined
          }
          onOpenSettings={
            props.adapter.openPermissionSettings
              ? (key) => void openPermissionSettings(key)
              : undefined
          }
          onStart={() => void start()}
          classNames={props.classNames}
        />
      </Show>
    </div>
  );
}

function RecordingToolbar(props: {
  elapsed: string;
  targetLabel?: string;
  successState?: string | null;
  markerCount: number;
  lastMarkerLabel: string | null;
  onMarker: (kind: RecordingMarkerKind) => Promise<void>;
  onStop: () => Promise<void>;
  classNames?: RecordingUiClassNames;
}) {
  const markers = [
    ["varies", "Alt+1", "Varies", "Mark variable input"],
    ["ignore", "Alt+2", "Ignore", "Mark incidental action"],
    ["important", "Alt+3", "Important", "Mark important step"],
    ["confirm", "Alt+4", "Confirm", "Mark needs confirmation"],
  ] as Array<[RecordingMarkerKind, string, string, string]>;

  return (
    <div
      class={cx(
        "flex max-w-[min(560px,calc(100vw-96px))] items-center gap-1 overflow-x-auto rounded-lg border border-rec-border bg-rec-panel px-1.5 py-1 text-rec-fg-2 shadow-sm",
        props.classNames?.toolbar,
      )}
      data-rec-slot="toolbar"
    >
      <div
        class={cx(
          "flex shrink-0 items-center gap-2 px-1.5 font-mono text-[11px] tabular-nums text-rec-fg-muted",
          props.classNames?.toolbarTimer,
        )}
        data-rec-slot="toolbarTimer"
      >
        <span class="relative flex h-2 w-2" aria-hidden="true">
          <span class="absolute inline-flex h-full w-full rounded-full bg-red-500/60 motion-safe:animate-ping" />
          <span class="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
        </span>
        <span>{props.elapsed}</span>
      </div>
      <Show when={props.targetLabel}>
        {(targetLabel) => (
          <span class="hidden max-w-36 truncate border-l border-rec-border pl-2 text-[11px] text-rec-fg-muted sm:inline">
            {targetLabel()}
          </span>
        )}
      </Show>
      <Show when={props.successState}>
        {(successState) => (
          <div
            class="hidden min-w-0 max-w-56 items-center gap-1.5 border-l border-rec-border pl-2 md:flex"
            title={`Stop when: ${successState()}`}
          >
            <span class="truncate text-[11px] text-rec-fg-muted">
              {successState()}
            </span>
            <button
              type="button"
              class="h-7 shrink-0 rounded-md border border-emerald-500/40 bg-emerald-50 px-2 text-[11px] font-semibold text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20"
              title="Stop recording"
              aria-label="Stop recording"
              onClick={() => void props.onStop()}
            >
              Done
            </button>
          </div>
        )}
      </Show>
      <span class="mx-1 h-5 w-px shrink-0 bg-rec-surface-hover" />
      <Show when={props.markerCount > 0}>
        <span
          class="shrink-0 rounded-md bg-emerald-500/10 px-1.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"
          aria-live="polite"
          title={props.lastMarkerLabel ?? "Recording marker added"}
        >
          {props.markerCount} marker{props.markerCount === 1 ? "" : "s"}
        </span>
      </Show>
      <For each={markers}>
        {([kind, shortcut, label, title]) => (
          <button
            type="button"
            class={cx(
              "flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-rec-border bg-rec-surface px-2 text-[11px] font-medium text-rec-fg-2 hover:bg-rec-surface-hover hover:text-rec-fg",
              props.classNames?.toolbarMarker,
            )}
            data-rec-slot="toolbarMarker"
            title={title}
            aria-label={title}
            onClick={() => void props.onMarker(kind)}
          >
            <span class="rounded border border-rec-border px-1 font-mono text-[10px] text-rec-fg-muted">
              {shortcut}
            </span>
            {label}
          </button>
        )}
      </For>
    </div>
  );
}

export interface RecordingSkillDraftReviewPanelProps {
  review: RecordingSkillDraftReview;
  classNames?: RecordingUiClassNames;
  maxItems?: number;
  maxReasons?: number;
  onDownloadBundle?: (review: RecordingSkillDraftReview) => void;
  deleteAfterPublish?: boolean;
  onDeleteAfterPublishChange?: (
    enabled: boolean,
    review: RecordingSkillDraftReview,
  ) => void;
  onDeleteLocalRecording?: (review: RecordingSkillDraftReview) => void;
  onCorrectStep?: (
    review: RecordingSkillDraftReview,
    step: RecordingSkillDraftReview["draft"]["steps"][number],
  ) => void;
  onRunFix?: (review: RecordingSkillDraftReview) => void;
  extraActions?: (review: RecordingSkillDraftReview) => JSX.Element;
}

export function RecordingSkillDraftReviewPanel(
  props: RecordingSkillDraftReviewPanelProps,
) {
  const maxItems = () => props.maxItems ?? 4;
  const visibleSteps = () => props.review.draft.steps.slice(0, maxItems());
  const visibleInputs = () => props.review.draft.inputs.slice(0, maxItems());
  const visibleVerification = () =>
    props.review.draft.verification.slice(0, maxItems());
  const visibleAssumptions = () =>
    props.review.draft.assumptions.slice(0, maxItems());
  const visibleRecovery = () =>
    props.review.draft.recovery.slice(0, maxItems());
  const visibleRedactions = () =>
    props.review.draft.redactions.slice(0, maxItems());
  const visibleReasons = () =>
    [
      ...props.review.readiness.blockingReasons.map((reason) => ({
        reason,
        tone: "block" as const,
      })),
      ...props.review.readiness.warningReasons.map((reason) => ({
        reason,
        tone: "warn" as const,
      })),
    ].slice(0, props.maxReasons ?? 4);

  return (
    <details
      class={cx(
        "basis-full overflow-hidden rounded-lg border border-rec-border bg-rec-panel font-normal text-rec-fg-2",
        props.classNames?.reviewPanel,
      )}
      data-rec-slot="reviewPanel"
      open
    >
      <summary
        class={cx(
          "cursor-pointer border-b border-rec-border px-3 py-2 text-[12px] font-semibold text-rec-fg",
          props.classNames?.reviewSummary,
        )}
        data-rec-slot="reviewSummary"
      >
        Draft skill · {props.review.draft.title}
      </summary>
      <div
        class={cx(
          "grid gap-0 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)]",
          props.classNames?.reviewBody,
        )}
        data-rec-slot="reviewBody"
      >
        <div class="min-w-0 px-3 py-3" data-rec-slot="reviewContent">
          <div class="mb-3 flex min-w-0 flex-wrap items-center gap-2">
            <span
              class={cx(
                `rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${recordingDraftReadinessClass(props.review.readiness.canPublish)}`,
                props.classNames?.reviewBadge,
              )}
              data-rec-slot="reviewBadge"
            >
              {props.review.readiness.canPublish ? "publishable" : "needs work"}
            </span>
            <span class="rounded-md border border-rec-border bg-rec-surface px-1.5 py-0.5 font-mono text-[11px] text-rec-fg-muted">
              {props.review.bundle.slug}
            </span>
            <span class="rounded-md border border-rec-border bg-rec-surface px-1.5 py-0.5 text-[11px] text-rec-fg-muted">
              {props.review.bundle.fileCount} files
            </span>
            <Show when={props.review.draft.capture}>
              {(capture) => (
                <>
                  <span class="rounded-md border border-rec-border bg-rec-surface px-1.5 py-0.5 text-[11px] text-rec-fg-muted">
                    {capture().targetLabel}
                  </span>
                  <span
                    class={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${recordingQualityStatusClass(capture().qualityStatus)}`}
                  >
                    {recordingQualityStatusLabel(capture().qualityStatus)}
                  </span>
                  <span class="rounded-md border border-rec-border bg-rec-surface px-1.5 py-0.5 text-[11px] text-rec-fg-muted">
                    {capture().traceEvents} events
                    {capture().traceTruncated ? " capped" : ""}
                  </span>
                  <span class="rounded-md border border-rec-border bg-rec-surface px-1.5 py-0.5 text-[11px] text-rec-fg-muted">
                    {capture().transcriptSegments} transcript
                  </span>
                  <span class="rounded-md border border-rec-border bg-rec-surface px-1.5 py-0.5 text-[11px] text-rec-fg-muted">
                    {capture().keyframes} frames
                  </span>
                  <Show when={capture().captureStats}>
                    {(stats) => (
                      <span class="rounded-md border border-rec-border bg-rec-surface px-1.5 py-0.5 text-[11px] text-rec-fg-muted">
                        {stats().framesEncoded ?? "?"} encoded
                        {typeof stats().effectiveFps === "number"
                          ? ` - ${stats().effectiveFps?.toFixed(1)} fps`
                          : ""}
                      </span>
                    )}
                  </Show>
                </>
              )}
            </Show>
          </div>
          <Show when={visibleSteps().length > 0}>
            <ReviewSection
              title="Steps"
              className={props.classNames?.reviewSection}
              hiddenCount={
                props.review.draft.steps.length - visibleSteps().length
              }
            >
              <div class="grid gap-1">
                <For each={visibleSteps()}>
                  {(step, index) => (
                    <div class="flex min-w-0 gap-2 py-1">
                      <span class="w-4 shrink-0 font-mono text-[11px] text-rec-accent">
                        {index() + 1}
                      </span>
                      <div class="min-w-0">
                        <div class="break-words text-[12px] font-medium leading-5 text-rec-fg">
                          {step.intent}
                          <Show when={step.needsConfirmation}>
                            <span class="ml-1 text-amber-700 dark:text-amber-300">
                              confirm
                            </span>
                          </Show>
                        </div>
                        <Show when={props.onCorrectStep}>
                          {(onCorrectStep) => (
                            <button
                              type="button"
                              class="mt-1 h-6 rounded-md border border-rec-border bg-rec-surface px-2 text-[10.5px] font-semibold text-rec-fg-2 hover:bg-rec-surface-hover"
                              onClick={() =>
                                onCorrectStep()(props.review, step)
                              }
                            >
                              fix step
                            </button>
                          )}
                        </Show>
                        <Show when={recordingStepTargetLine(step)}>
                          {(targetLine) => (
                            <div class="break-words font-mono text-[10.5px] leading-4 text-rec-fg-muted">
                              {targetLine()}
                            </div>
                          )}
                        </Show>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </ReviewSection>
          </Show>
          <Show
            when={visibleInputs().length > 0 || visibleAssumptions().length > 0}
          >
            <ReviewSection
              title="Inputs & assumptions"
              className={props.classNames?.reviewSection}
              hiddenCount={
                props.review.draft.inputs.length -
                visibleInputs().length +
                props.review.draft.assumptions.length -
                visibleAssumptions().length
              }
            >
              <div class="grid gap-1">
                <For each={visibleInputs()}>
                  {(input) => (
                    <div class="min-w-0 break-words text-[11px] leading-5 text-rec-fg-muted">
                      <span class="font-semibold text-rec-fg">
                        {input.name}
                      </span>
                      <span class="font-mono">
                        {" "}
                        · {input.type}
                        {input.required ? "" : " · optional"}
                      </span>
                      <span> · {input.label}</span>
                    </div>
                  )}
                </For>
                <For each={visibleAssumptions()}>
                  {(assumption) => (
                    <div class="min-w-0 break-words text-[11px] leading-5 text-rec-fg-muted">
                      {assumption}
                    </div>
                  )}
                </For>
              </div>
            </ReviewSection>
          </Show>
        </div>
        <div
          class={cx(
            "min-w-0 border-t border-rec-border bg-rec-surface px-3 py-3 md:border-t-0 md:border-l",
            props.classNames?.reviewSidebar,
          )}
          data-rec-slot="reviewSidebar"
        >
          <ReviewSection
            title="Gate"
            className={props.classNames?.reviewSection}
            hiddenCount={
              props.review.draft.redactions.length -
              visibleRedactions().length +
              props.review.draft.verification.length -
              visibleVerification().length +
              props.review.draft.recovery.length -
              visibleRecovery().length
            }
          >
            <div class="grid gap-1">
              <For each={visibleRedactions()}>
                {(finding) => (
                  <GateRow tone={finding.severity}>
                    <span class="font-semibold">{finding.label}</span>
                    <span class="text-rec-fg-muted">
                      {" "}
                      · {finding.artifact}
                      {finding.resolved ? " · resolved" : ""}
                    </span>
                  </GateRow>
                )}
              </For>
              <For each={visibleVerification()}>
                {(check) => (
                  <GateRow tone="ok">
                    <span>{check.label}</span>
                    <span class="text-rec-fg-muted">
                      {" "}
                      · {check.kind}
                      {check.value ? ` · ${check.value}` : ""}
                    </span>
                  </GateRow>
                )}
              </For>
              <For each={visibleReasons()}>
                {(reason) => (
                  <GateRow tone={reason.tone}>
                    <span>{reason.reason}</span>
                  </GateRow>
                )}
              </For>
              <For each={visibleRecovery()}>
                {(item) => (
                  <GateRow tone="ok">
                    <span>{item.when}</span>
                    <span class="text-rec-fg-muted"> · {item.do}</span>
                  </GateRow>
                )}
              </For>
            </div>
          </ReviewSection>
          <div class="mt-3 border-t border-rec-border pt-3">
            <p class="m-0 text-[11px] leading-5 text-rec-fg-muted">
              Public publishing is permanent. Raw trace, transcripts, frames,
              and local provenance stay out of the public bundle.
            </p>
            <Show
              when={
                props.onDeleteAfterPublishChange || props.onDeleteLocalRecording
              }
            >
              <div class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-rec-fg-muted">
                <Show when={props.onDeleteAfterPublishChange}>
                  {(onDeleteAfterPublishChange) => (
                    <label class="inline-flex min-h-8 items-center gap-2 rounded-md border border-rec-border bg-rec-panel px-2 font-semibold text-rec-fg-2">
                      <input
                        type="checkbox"
                        class="size-3.5 accent-emerald-600"
                        checked={Boolean(props.deleteAfterPublish)}
                        onChange={(event) =>
                          onDeleteAfterPublishChange()(
                            event.currentTarget.checked,
                            props.review,
                          )
                        }
                      />
                      delete after publish
                    </label>
                  )}
                </Show>
                <Show when={props.onDeleteLocalRecording}>
                  {(onDeleteLocalRecording) => (
                    <button
                      type="button"
                      class={cx(
                        "h-8 rounded-md border border-rec-border bg-rec-panel px-3 text-[12px] font-semibold text-rec-fg-2 hover:bg-rec-surface-hover",
                        props.classNames?.reviewAction,
                      )}
                      data-rec-slot="reviewAction"
                      onClick={() => onDeleteLocalRecording()(props.review)}
                    >
                      delete local recording
                    </button>
                  )}
                </Show>
              </div>
            </Show>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <Show when={props.onDownloadBundle}>
                {(onDownloadBundle) => (
                  <button
                    type="button"
                    class={cx(
                      "h-8 rounded-md border border-emerald-500/40 bg-emerald-600 px-3 text-[12px] font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:border-rec-border disabled:bg-rec-surface-hover disabled:text-rec-fg-muted",
                      props.classNames?.reviewAction,
                    )}
                    data-rec-slot="reviewAction"
                    disabled={!props.review.readiness.canPublish}
                    title={
                      props.review.readiness.canPublish
                        ? "Download generated skill bundle"
                        : "Resolve blocking draft findings before downloading"
                    }
                    onClick={() => onDownloadBundle()(props.review)}
                  >
                    Download bundle
                  </button>
                )}
              </Show>
              <Show when={props.onRunFix}>
                {(onRunFix) => (
                  <button
                    type="button"
                    class={cx(
                      "h-8 rounded-md border border-rec-border bg-rec-surface px-3 text-[12px] font-semibold text-rec-fg-2 hover:bg-rec-surface-hover",
                      props.classNames?.reviewAction,
                    )}
                    data-rec-slot="reviewAction"
                    onClick={() => onRunFix()(props.review)}
                  >
                    run fix
                  </button>
                )}
              </Show>
              <Show when={props.extraActions}>
                {(extraActions) => extraActions()(props.review)}
              </Show>
            </div>
          </div>
        </div>
      </div>
    </details>
  );
}

function recordingStepTargetLine(
  step: RecordingSkillDraftReview["draft"]["steps"][number],
): string | null {
  const target = step.target;
  if (!target) return null;
  const parts = [
    target.role,
    target.name ? `"${target.name}"` : null,
    target.selectors?.[0] ? target.selectors[0] : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function ReviewSection(props: {
  title: string;
  hiddenCount: number;
  className?: string;
  children: JSX.Element;
}) {
  return (
    <section
      class={cx("min-w-0", props.className)}
      data-rec-slot="reviewSection"
    >
      <div class="mb-2 flex items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-[0.12em] text-rec-fg-muted">
        <span>{props.title}</span>
        <Show when={props.hiddenCount > 0}>
          <span>+{props.hiddenCount}</span>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

function GateRow(props: {
  tone: "block" | "warn" | "ok";
  children: JSX.Element;
}) {
  return (
    <div class="flex min-w-0 items-start gap-2 py-1 text-[11px] leading-5 text-rec-fg-2">
      <span
        class="mt-1.5 h-2 w-2 shrink-0 rounded-[2px]"
        classList={{
          "bg-red-500": props.tone === "block",
          "bg-amber-400": props.tone === "warn",
          "bg-emerald-500": props.tone === "ok",
        }}
      />
      <span class="min-w-0 break-words">{props.children}</span>
    </div>
  );
}

export function downloadRecordingSkillBundle(
  review: RecordingSkillDraftReview,
): void {
  if (!review.readiness.canPublish) return;
  if (typeof document === "undefined" || typeof URL === "undefined") return;
  const archive = buildRecordingSkillBundleTar(review.bundle);
  const blob = new Blob([archive], { type: "application/x-tar" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${review.bundle.slug}.tar`;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function recordingDraftReadinessClass(canPublish: boolean): string {
  if (canPublish) {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
}

function recordingQualityStatusLabel(
  status: string | null | undefined,
): string {
  if (status === "ready") return "quality ready";
  if (status === "needs_review") return "review quality";
  if (status === "retry") return "retry recording";
  return "quality unchecked";
}

function recordingQualityStatusClass(
  status: string | null | undefined,
): string {
  if (status === "ready") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  }
  if (status === "retry") {
    return "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400";
  }
  return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
}

interface RecordingDialogProps {
  targets: RecordingTarget[];
  permissionPreflight: RecordingPermissionPreflight | null;
  browserExtensionReadiness: RecordingBrowserExtensionReadiness | null;
  permissionRequestKey: RecordingPermissionKey | null;
  selectedTarget: RecordingTarget | null;
  selectedTargetId: string;
  captureWindows: RecordingCaptureWindow[];
  windowPreview: RecordingCaptureWindowPreview | null;
  previewingWindowId: string | null;
  refreshingCaptureWindows: boolean;
  selectedCaptureWindowId: string | null;
  windowPreviewError: string | null;
  prep: RecordingPrep;
  includeMicrophone: boolean;
  includeCamera: boolean;
  executableUpgrade: boolean;
  supportsExecutableTrace: boolean;
  status: RecordingStatus;
  error: string | null;
  canStart: boolean;
  startBlocker: string | null;
  onClose: () => void;
  onSelectTarget: (targetId: string) => void;
  onPreviewWindow: (windowId: string) => void;
  onPreviewImageError: () => void;
  onRefreshWindows: () => void;
  onPrepChange: <K extends keyof RecordingPrep>(
    key: K,
    value: RecordingPrep[K],
  ) => void;
  onIncludeMicrophone: (value: boolean) => void;
  onIncludeCamera: (value: boolean) => void;
  onExecutableUpgrade: (value: boolean) => void;
  onRequestPermission?: (key: RecordingPermissionKey) => void;
  onOpenSettings?: (key: RecordingPermissionKey) => void;
  onStart: () => void;
  classNames?: RecordingUiClassNames;
}

function targetKindAbbreviation(target: RecordingTarget): string {
  if (target.kind === "screen") return "SC";
  if (target.kind === "window") return "APP";
  return "BR";
}

function targetCapabilitySummary(target: RecordingTarget): string {
  if (
    target.kind === "browser" &&
    target.capabilities.includes("action_trace")
  ) {
    return "DOM + video + transcript";
  }
  if (target.capabilities.includes("action_trace")) {
    return "actions + video";
  }
  if (target.capabilities.includes("transcript")) {
    return "video + transcript";
  }
  return target.capabilities.join(" + ");
}

function TargetCard(props: {
  target: RecordingTarget;
  selected: boolean;
  onSelect: (targetId: string) => void;
  classNames?: RecordingUiClassNames;
}) {
  const target = props.target;
  const selectable = () => target.isAvailable || target.kind === "window";
  return (
    <button
      type="button"
      class={cx(
        "min-h-[112px] rounded-lg border p-3 text-left transition-colors",
        props.classNames?.targetCard,
      )}
      classList={{
        "border-rec-border bg-rec-panel": props.selected,
        "border-rec-border bg-rec-surface hover:bg-rec-surface-hover":
          !props.selected && selectable(),
        "cursor-not-allowed border-rec-border bg-rec-surface opacity-60":
          !selectable(),
      }}
      data-rec-slot="targetCard"
      disabled={!selectable()}
      aria-pressed={props.selected}
      onClick={() => props.onSelect(target.id)}
    >
      <div class="flex items-start justify-between gap-2">
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-rec-surface-hover font-mono text-[10px] font-semibold text-rec-fg-2">
          {targetKindAbbreviation(target)}
        </span>
        <Show when={props.selected}>
          <span class="rounded-full bg-rec-fg px-1.5 py-0.5 text-[10px] font-semibold text-rec-panel">
            Selected
          </span>
        </Show>
      </div>
      <div class="mt-3 text-[13px] font-semibold text-rec-fg">
        {target.label}
      </div>
      <div class="mt-1 text-[11px] leading-5 text-rec-fg-muted">
        {targetCapabilitySummary(target)}
      </div>
      <Show when={!target.isAvailable}>
        <div class="mt-2 text-[10px] font-semibold uppercase tracking-wide text-rec-fg-muted">
          Unavailable
        </div>
        <Show when={target.limitations[0]}>
          {(limitation) => (
            <div class="mt-1 line-clamp-2 text-[10.5px] leading-4 text-rec-fg-muted">
              {limitation()}
            </div>
          )}
        </Show>
      </Show>
    </button>
  );
}

function TargetStatusStrip(props: {
  target: RecordingTarget;
  classNames?: RecordingUiClassNames;
}) {
  const summary = () =>
    props.target.isAvailable
      ? targetCapabilitySummary(props.target)
      : "Target unavailable";
  const details = () => {
    const rows = [props.target.detail, ...props.target.limitations].filter(
      (row): row is string => row.trim().length > 0,
    );
    return rows.length > 0 ? rows : ["Ready"];
  };

  return (
    <div
      class={cx(
        "rounded-md border border-rec-border border-l-4 bg-rec-surface px-3 py-2 text-[12px] leading-5 text-rec-fg-muted",
        props.classNames?.statusStrip,
      )}
      classList={{
        "border-l-emerald-500": props.target.isAvailable,
        "border-l-amber-400": !props.target.isAvailable,
      }}
      data-rec-slot="statusStrip"
    >
      <div class="font-semibold text-rec-fg">{summary()}</div>
      <ul class="m-0 mt-1 grid list-none gap-0.5 p-0">
        <For each={details()}>{(detail) => <li>{detail}</li>}</For>
      </ul>
    </div>
  );
}

function browserExtensionStatusClass(
  status: RecordingBrowserExtensionReadiness["status"],
): string {
  if (status === "ready") {
    return "border-l-emerald-500";
  }
  if (status === "blocked") {
    return "border-l-red-500";
  }
  return "border-l-amber-400";
}

function BrowserExtensionReadinessStrip(props: {
  readiness: RecordingBrowserExtensionReadiness;
  classNames?: RecordingUiClassNames;
}) {
  return (
    <div
      class={cx(
        `rounded-md border border-rec-border border-l-4 bg-rec-surface px-3 py-2 text-[12px] leading-5 text-rec-fg-muted ${browserExtensionStatusClass(props.readiness.status)}`,
        props.classNames?.extensionStrip,
      )}
      data-rec-slot="extensionStrip"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-semibold text-rec-fg">{props.readiness.label}</span>
        <span class="rounded-md border border-rec-border bg-rec-panel px-1.5 py-0.5 font-mono text-[10px] uppercase text-rec-fg-muted">
          {props.readiness.status.replace("_", " ")}
        </span>
      </div>
      <div class="mt-1">{props.readiness.message}</div>
      <Show when={props.readiness.bannerDisclosure}>
        {(disclosure) => <div class="mt-1">{disclosure()}</div>}
      </Show>
      <Show when={props.readiness.canContinueWithFallback}>
        <div class="mt-1">
          Continue with accessibility/video fallback if high-fidelity DOM trace
          is unavailable.
        </div>
      </Show>
    </div>
  );
}

function permissionDotClass(
  status: RecordingPermissionCheck["status"],
): string {
  if (status === "granted") return "bg-emerald-500";
  if (status === "denied") return "bg-red-500";
  if (status === "unsupported") return "bg-rec-fg-muted/40";
  // prompt / unknown — action needed
  return "bg-amber-500";
}

function RecordingPermissionStrip(props: {
  preflight: RecordingPermissionPreflight | null;
  target: RecordingTarget;
  requestKey: RecordingPermissionKey | null;
  onRequestPermission?: (key: RecordingPermissionKey) => void;
  onOpenSettings?: (key: RecordingPermissionKey) => void;
  classNames?: RecordingUiClassNames;
}) {
  // Hide unsupported permissions: they are not something the user can act on
  // for this target, so they would only add noise.
  const checks = () =>
    (props.preflight?.checks ?? []).filter(
      (check) =>
        check.requiredFor.includes(props.target.kind) &&
        check.status !== "unsupported",
    );
  const readyCount = () =>
    checks().filter((check) => check.status === "granted").length;

  return (
    <Show when={checks().length > 0}>
      <div
        class={cx(
          "rounded-lg border border-rec-border bg-rec-panel px-3 py-2.5",
          props.classNames?.permissionStrip,
        )}
        data-rec-slot="permissionStrip"
      >
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-rec-fg-muted">
            Permissions
          </span>
          <span class="font-mono text-[10px] text-rec-fg-muted">
            {readyCount()}/{checks().length} ready
          </span>
        </div>
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          <For each={checks()}>
            {(check) => {
              const isGranted = () => check.status === "granted";
              const isDenied = () => check.status === "denied";
              const pending = () => props.requestKey === check.key;
              // `check.canRequest` is set by the host when the OS can show a
              // native prompt for this permission (macOS screen/accessibility).
              const canAllow = () =>
                Boolean(
                  props.onRequestPermission && check.canRequest && !isGranted(),
                );
              const canOpenSettings = () =>
                Boolean(props.onOpenSettings && !isGranted());
              return (
                <li class="flex items-start gap-2.5">
                  <span
                    class={`mt-1 size-1.5 shrink-0 rounded-full ${permissionDotClass(check.status)}`}
                    aria-hidden="true"
                  />
                  <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span class="text-[12px] font-medium text-rec-fg">
                      {check.label}
                    </span>
                    <span class="text-[11px] leading-snug text-rec-fg-muted">
                      {check.message}
                    </span>
                  </div>
                  <div class="flex shrink-0 flex-col items-end gap-1">
                    <Show when={isGranted()}>
                      <span class="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                        Allowed
                      </span>
                    </Show>
                    <Show when={!isGranted() && canAllow()}>
                      <button
                        type="button"
                        class="rounded-md border border-rec-accent/40 bg-rec-accent/10 px-2 py-1 text-[11px] font-semibold text-rec-accent transition-colors hover:bg-rec-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rec-accent/40 disabled:cursor-wait disabled:opacity-60"
                        disabled={pending()}
                        aria-label={`Allow ${check.label}`}
                        onClick={(event) => {
                          event.preventDefault();
                          props.onRequestPermission?.(check.key);
                        }}
                      >
                        {pending() ? "Requesting…" : "Allow"}
                      </button>
                    </Show>
                    <Show when={!isGranted() && !canAllow() && isDenied()}>
                      <button
                        type="button"
                        class="rounded-md border border-rec-border bg-rec-surface px-2 py-1 text-[11px] font-semibold text-rec-fg transition-colors hover:bg-rec-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rec-accent/40"
                        aria-label={`Open System Settings for ${check.label}`}
                        onClick={(event) => {
                          event.preventDefault();
                          props.onOpenSettings?.(check.key);
                        }}
                      >
                        Open Settings
                      </button>
                    </Show>
                    <Show
                      when={!isGranted() && canAllow() && canOpenSettings()}
                    >
                      <button
                        type="button"
                        class="text-[10px] text-rec-fg-muted underline-offset-2 transition-colors hover:text-rec-fg hover:underline focus-visible:underline focus-visible:outline-none"
                        aria-label={`Open System Settings for ${check.label}`}
                        onClick={(event) => {
                          event.preventDefault();
                          props.onOpenSettings?.(check.key);
                        }}
                      >
                        Open System Settings
                      </button>
                    </Show>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </div>
    </Show>
  );
}

function WindowCapturePreviewPanel(props: {
  targetKind: RecordingTarget["kind"];
  windows: RecordingCaptureWindow[];
  preview: RecordingCaptureWindowPreview | null;
  previewingWindowId: string | null;
  refreshing: boolean;
  selectedWindowId: string | null;
  error: string | null;
  onPreviewWindow: (windowId: string) => void;
  onPreviewImageError: () => void;
  onRefresh: () => void;
  classNames?: RecordingUiClassNames;
}) {
  const visibleWindows = () =>
    props.windows
      .slice()
      .sort((left, right) => {
        if (left.isFocused !== right.isFocused) return left.isFocused ? -1 : 1;
        if (left.isRecordable !== right.isRecordable) {
          return left.isRecordable ? -1 : 1;
        }
        return left.appName.localeCompare(right.appName);
      })
      .slice(0, 24);
  const panelTitle = () =>
    props.targetKind === "browser" ? "Browser preview" : "Window preview";
  const panelDescription = () =>
    props.targetKind === "browser"
      ? "Choose a browser window to preview and record."
      : "Choose an app window to preview and record.";
  const emptyMessage = () =>
    props.targetKind === "browser"
      ? "No previewable browser windows found."
      : "No previewable app windows found.";

  return (
    <div
      class={cx(
        "rounded-md border border-rec-border bg-rec-panel p-3",
        props.classNames?.statusStrip,
      )}
      data-rec-slot="statusStrip"
    >
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-[12px] font-semibold text-rec-fg">
            {panelTitle()}
          </div>
          <div class="mt-0.5 text-[11px] text-rec-fg-muted">
            {panelDescription()}
          </div>
        </div>
        <button
          type="button"
          class="h-7 rounded-md border border-rec-border bg-rec-surface px-2 text-[11px] font-semibold text-rec-fg-muted hover:bg-rec-surface-hover hover:text-rec-fg disabled:cursor-wait disabled:opacity-60"
          disabled={props.refreshing}
          onClick={props.onRefresh}
        >
          {props.refreshing ? "Refreshing" : "Refresh"}
        </button>
      </div>

      <Show when={props.error}>
        {(message) => (
          <div class="mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
            {message()}
          </div>
        )}
      </Show>

      <Show
        when={visibleWindows().length > 0}
        fallback={
          <div class="mt-2 rounded-md border border-rec-border bg-rec-surface px-2 py-2 text-[11px] text-rec-fg-muted">
            {emptyMessage()}
          </div>
        }
      >
        <div class="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_220px]">
          <div class="max-h-56 overflow-y-auto rounded-md border border-rec-border bg-rec-surface">
            <For each={visibleWindows()}>
              {(window) => {
                const title = () => window.title || "Untitled window";
                const busy = () => props.previewingWindowId === window.id;
                const selected = () => props.selectedWindowId === window.id;
                return (
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-3 border-b border-rec-border px-2 py-2 text-left text-[11px] last:border-b-0 hover:bg-rec-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                    classList={{
                      "bg-rec-surface-hover": selected(),
                    }}
                    disabled={!window.isRecordable || busy()}
                    title={`${window.appName} - ${title()}`}
                    onClick={() => props.onPreviewWindow(window.id)}
                  >
                    <span class="min-w-0">
                      <span class="block truncate font-semibold text-rec-fg">
                        {window.appName}
                      </span>
                      <span class="block truncate text-rec-fg-muted">
                        {title()}
                      </span>
                    </span>
                    <span class="shrink-0 rounded border border-rec-border px-1.5 py-0.5 font-mono text-[10px] uppercase text-rec-fg-muted">
                      {busy()
                        ? "..."
                        : selected()
                          ? "Selected"
                          : window.isFocused
                            ? "Focused"
                            : window.isRecordable
                              ? "View"
                              : "Hidden"}
                    </span>
                  </button>
                );
              }}
            </For>
          </div>

          <div class="grid min-h-32 place-items-center overflow-hidden rounded-md border border-rec-border bg-rec-surface">
            <Show
              when={props.preview}
              fallback={
                <span class="px-3 text-center text-[11px] text-rec-fg-muted">
                  Select a window to preview.
                </span>
              }
            >
              {(preview) => (
                <img
                  src={preview().artifactUrl}
                  alt="Window preview"
                  class="max-h-56 w-full object-contain"
                  onError={props.onPreviewImageError}
                />
              )}
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

function RecordingDialog(props: RecordingDialogProps) {
  const canClose = () => props.status !== "preparing";
  const backdrop = (event: MouseEvent) => {
    if (canClose() && event.target === event.currentTarget) props.onClose();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && canClose()) {
      event.stopPropagation();
      props.onClose();
    }
  };
  const supportsMicrophone = () =>
    Boolean(props.selectedTarget?.capabilities.includes("microphone"));
  const supportsCamera = () =>
    Boolean(props.selectedTarget?.capabilities.includes("camera"));
  const supportedBrowserExtensionReadiness = () =>
    props.selectedTarget?.kind === "browser" &&
    props.browserExtensionReadiness?.status !== "unsupported"
      ? props.browserExtensionReadiness
      : null;

  let goalInput: HTMLInputElement | undefined;
  onMount(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    goalInput?.focus();
    onCleanup(() => previouslyFocused?.focus());
  });

  return (
    <div
      class={cx(
        "fixed inset-0 bg-black/60 flex items-center justify-center z-[1000] px-4",
        props.classNames?.dialogBackdrop,
      )}
      data-rec-slot="dialogBackdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Record workflow"
      onClick={backdrop}
      onKeyDown={onKeyDown}
    >
      <div
        class={cx(
          "flex h-[90vh] max-h-[90vh] w-[720px] max-w-[96vw] flex-col overflow-hidden rounded-lg border border-rec-border bg-rec-panel shadow-xl md:h-auto",
          props.classNames?.dialog,
        )}
        data-rec-slot="dialog"
      >
        <div
          class={cx(
            "flex shrink-0 items-start justify-between gap-4 border-b border-rec-border px-5 py-4",
            props.classNames?.dialogHeader,
          )}
          data-rec-slot="dialogHeader"
        >
          <div>
            <h2 class="m-0 text-[15px] font-semibold text-rec-fg">
              Record workflow
            </h2>
            <p class="mt-1 text-[12px] leading-relaxed text-rec-fg-muted">
              Capture a short workflow and turn it into a draft skill.
            </p>
          </div>
          <button
            type="button"
            class="h-7 w-7 rounded-md text-rec-fg-muted hover:bg-rec-surface-hover hover:text-rec-fg"
            aria-label="Close"
            disabled={!canClose()}
            onClick={props.onClose}
          >
            x
          </button>
        </div>

        <div
          class={cx(
            "min-h-0 flex-1 overflow-y-auto",
            props.classNames?.dialogBody,
          )}
          data-rec-slot="dialogBody"
        >
          <div class="space-y-4 p-4">
            <div>
              <div class="text-[11px] font-semibold uppercase tracking-wide text-rec-fg-muted">
                Target
              </div>
              <div class="mt-2">
                <Switch>
                  <Match when={props.status === "loading"}>
                    <div class="rounded-md border border-rec-border bg-rec-surface px-3 py-2 text-[12px] text-rec-fg-muted">
                      Loading targets...
                    </div>
                  </Match>
                  <Match when={props.targets.length === 0}>
                    <div class="rounded-md border border-rec-border bg-rec-surface px-3 py-2 text-[12px] text-rec-fg-muted">
                      No recording targets found.
                    </div>
                  </Match>
                  <Match when={props.targets.length > 0}>
                    <div
                      class={cx(
                        "grid gap-2 md:grid-cols-3",
                        props.classNames?.targetGrid,
                      )}
                      data-rec-slot="targetGrid"
                    >
                      <For each={props.targets}>
                        {(target) => (
                          <TargetCard
                            target={target}
                            selected={target.id === props.selectedTargetId}
                            onSelect={props.onSelectTarget}
                            classNames={props.classNames}
                          />
                        )}
                      </For>
                    </div>
                  </Match>
                </Switch>
              </div>
            </div>

            <Show when={props.selectedTarget}>
              {(target) => (
                <TargetStatusStrip
                  target={target()}
                  classNames={props.classNames}
                />
              )}
            </Show>

            <Show
              when={
                props.selectedTarget?.kind === "window" ||
                props.selectedTarget?.kind === "browser"
              }
            >
              <WindowCapturePreviewPanel
                targetKind={props.selectedTarget?.kind ?? "window"}
                windows={props.captureWindows}
                preview={props.windowPreview}
                previewingWindowId={props.previewingWindowId}
                refreshing={props.refreshingCaptureWindows}
                selectedWindowId={props.selectedCaptureWindowId}
                error={props.windowPreviewError}
                onPreviewWindow={props.onPreviewWindow}
                onPreviewImageError={props.onPreviewImageError}
                onRefresh={props.onRefreshWindows}
                classNames={props.classNames}
              />
            </Show>

            <Show when={supportedBrowserExtensionReadiness()}>
              {(readiness) => (
                <BrowserExtensionReadinessStrip
                  readiness={readiness()}
                  classNames={props.classNames}
                />
              )}
            </Show>

            <Show when={props.selectedTarget}>
              {(target) => (
                <RecordingPermissionStrip
                  preflight={props.permissionPreflight}
                  target={target()}
                  requestKey={props.permissionRequestKey}
                  onRequestPermission={props.onRequestPermission}
                  onOpenSettings={props.onOpenSettings}
                  classNames={props.classNames}
                />
              )}
            </Show>

            <div class="grid gap-3 sm:grid-cols-2">
              <TextField
                label="Goal"
                value={props.prep.goal}
                placeholder="Submit a receipt"
                onInput={(value) => props.onPrepChange("goal", value)}
                className={props.classNames?.field}
                ref={(el) => {
                  goalInput = el;
                }}
              />
              <TextField
                label="Success state"
                value={props.prep.successState}
                placeholder="Expense shows submitted"
                onInput={(value) => props.onPrepChange("successState", value)}
                className={props.classNames?.field}
              />
            </div>
            <TextArea
              label="Variable inputs"
              value={props.prep.variableInputs}
              placeholder="Receipt file, date, amount, project"
              onInput={(value) => props.onPrepChange("variableInputs", value)}
              className={props.classNames?.textarea}
            />
            <TextArea
              label="Preferences"
              value={props.prep.preferences}
              placeholder="Defaults, naming rules, or values that are easy to miss"
              onInput={(value) => props.onPrepChange("preferences", value)}
              className={props.classNames?.textarea}
            />

            <div
              class="grid gap-2"
              classList={{
                "sm:grid-cols-3": supportsCamera(),
                "sm:grid-cols-2": !supportsCamera(),
              }}
            >
              <Toggle
                label="Mic"
                checked={props.includeMicrophone && supportsMicrophone()}
                onChange={props.onIncludeMicrophone}
                disabled={!supportsMicrophone()}
                className={props.classNames?.toggle}
              />
              <Show when={supportsCamera()}>
                <Toggle
                  label="Camera"
                  checked={props.includeCamera}
                  onChange={props.onIncludeCamera}
                  className={props.classNames?.toggle}
                />
              </Show>
              <Toggle
                label="Executable"
                checked={
                  props.executableUpgrade && props.supportsExecutableTrace
                }
                onChange={props.onExecutableUpgrade}
                disabled={!props.supportsExecutableTrace}
                className={props.classNames?.toggle}
              />
            </div>

            <label class="flex items-start gap-2 text-[12px] leading-relaxed text-rec-fg-muted">
              <input
                type="checkbox"
                class="mt-0.5"
                checked={props.prep.tosAcknowledged}
                onInput={(event) =>
                  props.onPrepChange(
                    "tosAcknowledged",
                    event.currentTarget.checked,
                  )
                }
              />
              <span>
                I am responsible for recording and automating this target under
                its applicable policies.
              </span>
            </label>

            <Show when={props.error}>
              {(message) => (
                <div class="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] text-red-600">
                  {message()}
                </div>
              )}
            </Show>
          </div>
        </div>

        <div
          class={cx(
            "flex shrink-0 flex-col gap-3 border-t border-rec-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between",
            props.classNames?.dialogFooter,
          )}
          data-rec-slot="dialogFooter"
        >
          <div class="min-w-0 text-[12px] leading-5 text-amber-700 dark:text-amber-300">
            <Show when={!props.canStart && props.startBlocker}>
              {(reason) => <span>{reason()}</span>}
            </Show>
          </div>
          <div class="flex shrink-0 justify-end gap-2">
            <button
              type="button"
              class={cx(
                "h-8 rounded-md border border-rec-border bg-rec-surface px-3 text-[12px] text-rec-fg hover:bg-rec-surface-hover",
                props.classNames?.secondaryButton,
              )}
              data-rec-slot="secondaryButton"
              disabled={!canClose()}
              onClick={props.onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              class={cx(
                "h-8 rounded-md border border-rec-accent/40 bg-rec-accent/10 px-3 text-[12px] text-rec-accent hover:bg-rec-accent/15 disabled:cursor-not-allowed disabled:opacity-50",
                props.classNames?.primaryButton,
              )}
              data-rec-slot="primaryButton"
              disabled={!props.canStart || props.status === "preparing"}
              title={props.startBlocker ?? undefined}
              onClick={props.onStart}
            >
              Start recording
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TextField(props: {
  label: string;
  value: string;
  placeholder: string;
  onInput: (value: string) => void;
  className?: string;
  ref?: (el: HTMLInputElement) => void;
}) {
  return (
    <label class={cx("block", props.className)} data-rec-slot="field">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-rec-fg-muted">
        {props.label}
      </span>
      <input
        ref={props.ref}
        type="text"
        class="mt-1 h-8 w-full rounded-md border border-rec-border bg-rec-surface px-2 text-[13px] text-rec-fg outline-none focus:border-rec-accent/40"
        value={props.value}
        placeholder={props.placeholder}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

function TextArea(props: {
  label: string;
  value: string;
  placeholder: string;
  onInput: (value: string) => void;
  className?: string;
}) {
  return (
    <label class={cx("block", props.className)} data-rec-slot="textarea">
      <span class="text-[11px] font-semibold uppercase tracking-wide text-rec-fg-muted">
        {props.label}
      </span>
      <textarea
        class="mt-1 min-h-[64px] w-full resize-y rounded-md border border-rec-border bg-rec-surface px-2 py-1.5 text-[13px] text-rec-fg outline-none focus:border-rec-accent/40"
        value={props.value}
        placeholder={props.placeholder}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

function Toggle(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <label
      class={cx(
        "flex h-8 items-center gap-2 rounded-md border border-rec-border bg-rec-surface px-2 text-[12px] text-rec-fg",
        props.className,
      )}
      classList={{ "opacity-50": props.disabled }}
      data-rec-slot="toggle"
    >
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onInput={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}
