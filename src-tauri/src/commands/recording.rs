// ABOUTME: Native command surface for workflow recording and skill-generation capture.
// ABOUTME: Provides stable IPC contracts while platform capture backends are implemented.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, mpsc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
use std::ffi::OsString;
#[cfg(target_os = "macos")]
use std::process::{Child, Command};
#[cfg(any(target_os = "windows", target_os = "linux"))]
use std::{
    io::{Seek, SeekFrom, Write},
    thread,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
#[cfg(any(target_os = "windows", target_os = "linux"))]
use tauri::Emitter;
use tauri::Manager;
use uuid::Uuid;

#[cfg(any(target_os = "windows", target_os = "linux"))]
use image::{ColorType, codecs::jpeg::JpegEncoder};

#[cfg(target_os = "macos")]
use core_foundation::{
    ConcreteCFType,
    array::CFArray,
    base::{CFType, TCFType},
    boolean::CFBoolean,
    dictionary::CFDictionary,
    number::CFNumber,
    string::{CFString, CFStringRef},
};
#[cfg(target_os = "macos")]
use core_graphics::{
    geometry::{CGPoint, CGRect, CGSize},
    window::{
        CGWindowListCopyWindowInfo, create_image, kCGWindowBounds, kCGWindowImageDefault,
        kCGWindowIsOnscreen, kCGWindowLayer, kCGWindowListExcludeDesktopElements,
        kCGWindowListOptionIncludingWindow, kCGWindowListOptionOnScreenOnly, kCGWindowName,
        kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID, kCGWindowSharingState,
    },
};
#[cfg(target_os = "macos")]
use image::RgbaImage;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::NSObject;
#[cfg(target_os = "macos")]
use objc2::{ClassType, extern_class, msg_send};
#[cfg(target_os = "macos")]
use objc2_core_foundation::CGRect as ScCGRect;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSError, NSString};
#[cfg(target_os = "macos")]
use objc2_screen_capture_kit::{SCShareableContent, SCWindow};

#[derive(Default)]
pub struct RecordingState {
    active: Mutex<RecordingSlot>,
}

/// Lifecycle slot for the single in-flight native recording. `Starting` is held
/// only while `recording_start` does its blocking capture/spawn work outside the
/// state lock, so a concurrent start is rejected without the lock being held
/// across a slow screen grab.
#[derive(Default)]
enum RecordingSlot {
    #[default]
    Idle,
    Starting,
    Active(ActiveRecording),
}

impl RecordingSlot {
    fn take_active(&mut self) -> Option<ActiveRecording> {
        match std::mem::replace(self, RecordingSlot::Idle) {
            RecordingSlot::Active(active) => Some(active),
            other => {
                *self = other;
                None
            }
        }
    }
}

impl RecordingState {
    /// Stop any in-progress native recording, releasing its capture process.
    /// Called from `RunEvent::Exit` because Tauri terminates via
    /// `std::process::exit`, which never runs `Drop` — without this an active
    /// macOS `screencapture` child is orphaned and keeps recording the screen
    /// after the app quits. Works through a shared reference by locking.
    pub fn shutdown(&self) {
        if let Ok(mut slot) = self.active.lock() {
            finalize_active_recording(slot.take_active());
        }
    }
}

impl Drop for RecordingState {
    fn drop(&mut self) {
        if let Ok(slot) = self.active.get_mut() {
            finalize_active_recording(slot.take_active());
        }
    }
}

fn finalize_active_recording(active: Option<ActiveRecording>) {
    if let Some(active) = active {
        clear_active_recorder_marker_for_output_dir(active.session.output_dir.as_deref());
        discard_native_recording_backend(active.backend);
    }
}

struct ActiveRecording {
    session: RecordingSession,
    backend: NativeRecordingBackend,
    markers: Vec<RecordingMarker>,
    keyframes: Vec<NativeKeyframe>,
    next_keyframe_index: usize,
    capture_window_platform_id: Option<u32>,
    started_instant: Instant,
}

enum NativeRecordingBackend {
    #[cfg(target_os = "macos")]
    MacScreencapture {
        child: Child,
        video_path: PathBuf,
        output_dir: PathBuf,
    },
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    XcapAvi {
        stop_tx: mpsc::Sender<()>,
        join: thread::JoinHandle<Result<NativeRecordingArtifacts, String>>,
        video_path: PathBuf,
        output_dir: PathBuf,
    },
}

const MAX_NATIVE_KEYFRAMES: usize = 8;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecordingMarker {
    t_ms: u64,
    kind: RecordingMarkerKind,
    context: Option<NativeActionContext>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
enum NativeActionContextSource {
    Accessibility,
    #[cfg(target_os = "windows")]
    ForegroundWindow,
    CaptureWindow,
    CaptureScreen,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeActionContext {
    source: NativeActionContextSource,
    app_name: String,
    window_title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeKeyframe {
    id: String,
    t_ms: u64,
    reason: String,
    mime_type: String,
    file_name: String,
    size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingCaptureWindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingCaptureWindow {
    pub id: String,
    pub platform_id: u32,
    pub pid: u32,
    pub app_name: String,
    pub title: String,
    pub bounds: RecordingCaptureWindowBounds,
    pub is_focused: bool,
    pub is_minimized: bool,
    pub is_recordable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingCaptureWindowPreview {
    pub window_id: String,
    pub captured_at_ms: i64,
    pub artifact_url: String,
    pub artifact_path: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingCaptureWindowSelection {
    pub id: String,
    pub app_name: String,
    pub title: String,
    pub bounds: RecordingCaptureWindowBounds,
}

/// Filesystem marker describing the currently-running native recorder. It is
/// written when a native recording starts and removed on a clean stop or
/// shutdown, so a fresh app launch can reap a recorder that a previous crash or
/// force-quit left running (cases that `Drop` cannot cover).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActiveRecorderMarker {
    pid: u32,
    recording_id: String,
    output_dir: String,
    video_path: String,
    started_at_ms: i64,
}

const ACTIVE_RECORDER_MARKER_FILE: &str = ".active-recorder.json";

fn active_recorder_marker_path(root: &Path) -> PathBuf {
    root.join(ACTIVE_RECORDER_MARKER_FILE)
}

fn write_active_recorder_marker(root: &Path, marker: &ActiveRecorderMarker) -> Result<(), String> {
    let serialized = serde_json::to_vec_pretty(marker).map_err(|error| error.to_string())?;
    fs::write(active_recorder_marker_path(root), serialized)
        .map_err(|error| format!("Failed to write active recorder marker: {error}"))
}

fn read_active_recorder_marker(root: &Path) -> Option<ActiveRecorderMarker> {
    let bytes = fs::read(active_recorder_marker_path(root)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn clear_active_recorder_marker(root: &Path) {
    let _ = fs::remove_file(active_recorder_marker_path(root));
}

fn clear_active_recorder_marker_for_output_dir(output_dir: Option<&str>) {
    if let Some(root) = output_dir.and_then(|dir| Path::new(dir).parent()) {
        clear_active_recorder_marker(root);
    }
}

fn path_is_direct_child_of(root: &Path, child: &Path) -> bool {
    child.parent() == Some(root)
}

fn active_marker_output_dir(root: &Path, marker: &ActiveRecorderMarker) -> Option<PathBuf> {
    if !validate_local_recording_id(&marker.recording_id).is_ok() {
        return None;
    }
    let output_dir = PathBuf::from(&marker.output_dir);
    let expected = root.join(&marker.recording_id);
    if output_dir == expected && path_is_direct_child_of(root, &output_dir) {
        Some(output_dir)
    } else {
        None
    }
}

fn active_marker_video_path(output_dir: &Path, marker: &ActiveRecorderMarker) -> Option<PathBuf> {
    let video_path = PathBuf::from(&marker.video_path);
    let expected = output_dir.join("workflow-recording.mov");
    if video_path == expected {
        Some(video_path)
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn native_backend_marker_fields(backend: &NativeRecordingBackend) -> Option<(u32, PathBuf)> {
    match backend {
        NativeRecordingBackend::MacScreencapture {
            child, video_path, ..
        } => Some((child.id(), video_path.clone())),
    }
}

#[cfg(not(target_os = "macos"))]
fn native_backend_marker_fields(backend: &NativeRecordingBackend) -> Option<(u32, PathBuf)> {
    match backend {
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        NativeRecordingBackend::XcapAvi { video_path, .. } => {
            // Write a marker for the recording process (this app) so a crash
            // leaves a `.active-recorder` the startup reaper can use to drop the
            // partial `recording-*` directory on the next launch.
            Some((std::process::id(), video_path.clone()))
        }
        #[cfg(not(any(target_os = "windows", target_os = "linux")))]
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingTargetKind {
    Screen,
    Window,
    Browser,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingCapability {
    Video,
    Microphone,
    Camera,
    Cursor,
    ActionTrace,
    Transcript,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingTarget {
    pub id: String,
    pub kind: RecordingTargetKind,
    pub label: String,
    pub detail: String,
    pub is_available: bool,
    pub capabilities: Vec<RecordingCapability>,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingPermissionKey {
    ScreenRecording,
    Microphone,
    Camera,
    Accessibility,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingPermissionStatus {
    Granted,
    Denied,
    Prompt,
    Unknown,
    Unsupported,
}

#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> std::os::raw::c_uchar;
    fn AXIsProcessTrustedWithOptions(
        options: core_foundation::dictionary::CFDictionaryRef,
    ) -> std::os::raw::c_uchar;
    static kAXTrustedCheckOptionPrompt: CFStringRef;
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
extern_class!(
    #[unsafe(super(NSObject))]
    struct AVCaptureDevice;
);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPermissionCheck {
    pub key: RecordingPermissionKey,
    pub status: RecordingPermissionStatus,
    pub label: String,
    pub message: String,
    pub can_request: bool,
    pub required_for: Vec<RecordingTargetKind>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPermissionPreflight {
    pub platform: String,
    pub checks: Vec<RecordingPermissionCheck>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingPrep {
    pub goal: String,
    pub success_state: String,
    pub variable_inputs: String,
    pub preferences: String,
    pub tos_acknowledged: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingRequestTargetKind {
    Screen,
    Window,
    Browser,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStartRequest {
    pub target_id: String,
    pub target_kind: RecordingRequestTargetKind,
    pub capture_window_id: Option<String>,
    pub capture_window: Option<RecordingCaptureWindowSelection>,
    pub prep: RecordingPrep,
    pub include_microphone: bool,
    pub include_camera: bool,
    pub executable_upgrade: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSessionContext {
    pub target_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_window_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_window: Option<RecordingCaptureWindowSelection>,
    pub prep: RecordingPrep,
    pub include_microphone: bool,
    pub include_camera: bool,
    pub executable_upgrade: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_scope_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingQualityStatus {
    Ready,
    NeedsReview,
    Retry,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingQualityCheckKey {
    Video,
    CaptureHealth,
    ActionTrace,
    Transcript,
    Target,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingQualityCheckStatus {
    Pass,
    Warn,
    Fail,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingQualityCheck {
    pub key: RecordingQualityCheckKey,
    pub status: RecordingQualityCheckStatus,
    pub label: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingCaptureStats {
    pub backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_fps: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_fps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames_received: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames_encoded: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frames_skipped: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encode_error_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_to_first_frame_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSession {
    pub id: String,
    pub target_kind: RecordingTargetKind,
    pub target_label: String,
    pub started_at_ms: i64,
    pub output_dir: Option<String>,
    pub max_video_height: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_artifact_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_event_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redacted_event_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_artifact_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transcript_segment_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyframe_artifact_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keyframe_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata_artifact_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capture_stats: Option<RecordingCaptureStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<RecordingSessionContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_status: Option<RecordingQualityStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quality_checks: Option<Vec<RecordingQualityCheck>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingMarkerKind {
    Important,
    Varies,
    Ignore,
    Confirm,
}

fn recording_targets() -> Vec<RecordingTarget> {
    let native_screen_video_available = cfg!(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    ));
    let native_window_video_available = cfg!(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    ));
    let native_audio_available = cfg!(target_os = "macos");
    let native_preview_available = cfg!(any(
        target_os = "macos",
        target_os = "windows",
        target_os = "linux"
    ));
    let mut screen_capabilities = vec![RecordingCapability::Video, RecordingCapability::Cursor];
    if native_audio_available {
        screen_capabilities.push(RecordingCapability::Microphone);
    }
    let mut window_capabilities = vec![RecordingCapability::Video, RecordingCapability::Cursor];
    if native_audio_available {
        window_capabilities.push(RecordingCapability::Microphone);
    }
    let mut browser_capabilities = vec![RecordingCapability::Video, RecordingCapability::Cursor];
    if native_audio_available {
        browser_capabilities.push(RecordingCapability::Microphone);
    }
    vec![
        RecordingTarget {
            id: "screen".to_string(),
            kind: RecordingTargetKind::Screen,
            label: "Full screen".to_string(),
            detail: "Capture the visible desktop with the native recorder.".to_string(),
            is_available: native_screen_video_available,
            capabilities: screen_capabilities,
            limitations: if cfg!(target_os = "macos") {
                vec![
                    "macOS full-screen recording uses the system screen recorder.".to_string(),
                    "Target anchors and explicit markers are captured; markers may include active-window context when Automation is available; native transcripts and semantic accessibility traces are pending; 720p normalization is best-effort."
                        .to_string(),
                ]
            } else if cfg!(target_os = "windows") {
                vec![
                    "Windows full-screen recording uses the native frame capture backend."
                        .to_string(),
                    "Target anchors and explicit markers are captured; markers may include active-window context; microphone audio, transcripts, and semantic accessibility traces are pending."
                        .to_string(),
                ]
            } else if cfg!(target_os = "linux") {
                vec![
                    "Linux full-screen recording uses the native frame capture backend."
                        .to_string(),
                    "Target anchors and explicit markers are captured; microphone audio, transcripts, and semantic accessibility traces are pending."
                        .to_string(),
                ]
            } else {
                vec![
                    "Native screen video recording is pending on this platform.".to_string(),
                    if native_preview_available {
                        "Local screenshot keyframes are available through the preview backend."
                            .to_string()
                    } else {
                        "Native screenshot capture is not wired on this platform.".to_string()
                    },
                ]
            },
        },
        RecordingTarget {
            id: "window".to_string(),
            kind: RecordingTargetKind::Window,
            label: "App window".to_string(),
            detail: "Capture one app window with the native recorder.".to_string(),
            is_available: native_window_video_available,
            capabilities: window_capabilities,
            limitations: if cfg!(target_os = "macos") {
                vec![
                    "macOS window recording uses the selected app window.".to_string(),
                    "Selected-window context anchors and explicit markers are captured; native transcripts and semantic accessibility traces are pending.".to_string(),
                ]
            } else if cfg!(target_os = "windows") {
                vec![
                    "Windows app-window recording uses the native frame capture backend."
                        .to_string(),
                    "Selected-window context anchors and explicit markers are captured; microphone audio, transcripts, and semantic accessibility traces are pending."
                        .to_string(),
                ]
            } else if cfg!(target_os = "linux") {
                vec![
                    "Linux app-window recording uses the native frame capture backend.".to_string(),
                    "Selected-window context anchors and explicit markers are captured; microphone audio, transcripts, and semantic accessibility traces are pending."
                        .to_string(),
                ]
            } else {
                vec![
                    "Native app-window video recording is pending on this platform.".to_string(),
                    if native_preview_available {
                        "App-window previews and local keyframes are available through the preview backend."
                            .to_string()
                    } else {
                        "Native app-window capture is not wired on this platform.".to_string()
                    },
                ]
            },
        },
        RecordingTarget {
            id: "browser".to_string(),
            kind: RecordingTargetKind::Browser,
            label: "Browser".to_string(),
            detail: "Capture browser workflows with native desktop recording.".to_string(),
            is_available: native_screen_video_available,
            capabilities: browser_capabilities,
            limitations: vec![
                "Records one selected browser window with native video, cursor, microphone when available, and explicit markers.".to_string(),
                "Use Full screen for browser workflows that span windows.".to_string(),
            ],
        },
    ]
}

fn permission_status_message(
    key: &RecordingPermissionKey,
    status: &RecordingPermissionStatus,
) -> String {
    match (key, status) {
        (RecordingPermissionKey::ScreenRecording, RecordingPermissionStatus::Granted) => {
            "Screen recording permission is granted.".to_string()
        }
        (RecordingPermissionKey::ScreenRecording, RecordingPermissionStatus::Prompt) => {
            screen_recording_permission_guidance("recording")
        }
        (RecordingPermissionKey::ScreenRecording, RecordingPermissionStatus::Unknown) => {
            "Permission state will be checked by the platform capture backend before recording."
                .to_string()
        }
        (RecordingPermissionKey::Microphone, RecordingPermissionStatus::Granted) => {
            "Microphone permission is granted.".to_string()
        }
        (RecordingPermissionKey::Microphone, RecordingPermissionStatus::Prompt) => {
            microphone_permission_prompt_message()
        }
        (RecordingPermissionKey::Microphone, RecordingPermissionStatus::Unknown) => {
            "Permission state will be checked by the platform capture backend before microphone capture."
                .to_string()
        }
        (RecordingPermissionKey::Camera, RecordingPermissionStatus::Unsupported) => {
            "Camera capture is not available for workflow recording targets yet.".to_string()
        }
        (RecordingPermissionKey::Camera, RecordingPermissionStatus::Granted) => {
            "Camera permission is granted.".to_string()
        }
        (RecordingPermissionKey::Camera, RecordingPermissionStatus::Prompt) => {
            "Camera permission will be requested before camera capture.".to_string()
        }
        (RecordingPermissionKey::Accessibility, RecordingPermissionStatus::Granted) => {
            "Accessibility permission is granted.".to_string()
        }
        (RecordingPermissionKey::Accessibility, RecordingPermissionStatus::Prompt) => {
            "Grant Accessibility access in System Settings before executable capture.".to_string()
        }
        (RecordingPermissionKey::Accessibility, RecordingPermissionStatus::Unknown) => {
            "Permission state will be checked by the platform tracing backend before executable capture."
                .to_string()
        }
        (_, RecordingPermissionStatus::Denied) => "Permission is denied.".to_string(),
        (_, RecordingPermissionStatus::Unknown) => {
            "Permission state will be checked by the platform capture backend.".to_string()
        }
        (_, RecordingPermissionStatus::Unsupported) => {
            "Permission is not supported on this platform.".to_string()
        }
    }
}

fn microphone_permission_prompt_message() -> String {
    "Microphone permission will be requested before microphone capture.".to_string()
}

fn screen_recording_permission_guidance(action: &str) -> String {
    format!("Grant Screen Recording access in System Settings, then restart Seren before {action}.")
}

fn permission_can_request(
    platform: &str,
    key: &RecordingPermissionKey,
    status: &RecordingPermissionStatus,
) -> bool {
    platform == "macos"
        && matches!(
            key,
            RecordingPermissionKey::ScreenRecording | RecordingPermissionKey::Accessibility
        )
        && !matches!(
            status,
            RecordingPermissionStatus::Granted | RecordingPermissionStatus::Unsupported
        )
}

/// System Settings privacy pane that hosts each permission toggle.
fn permission_settings_pane(key: &RecordingPermissionKey) -> &'static str {
    match key {
        RecordingPermissionKey::ScreenRecording => "Privacy_ScreenCapture",
        RecordingPermissionKey::Microphone => "Privacy_Microphone",
        RecordingPermissionKey::Camera => "Privacy_Camera",
        RecordingPermissionKey::Accessibility => "Privacy_Accessibility",
    }
}

fn permission_check(
    platform: &str,
    key: RecordingPermissionKey,
    status: RecordingPermissionStatus,
    label: &str,
    required_for: Vec<RecordingTargetKind>,
) -> RecordingPermissionCheck {
    let message = permission_status_message(&key, &status);
    let can_request = permission_can_request(platform, &key, &status);
    RecordingPermissionCheck {
        key,
        status,
        label: label.to_string(),
        message,
        can_request,
        required_for,
    }
}

fn all_recording_target_kinds() -> Vec<RecordingTargetKind> {
    vec![
        RecordingTargetKind::Screen,
        RecordingTargetKind::Window,
        RecordingTargetKind::Browser,
    ]
}

fn no_required_recording_target_kinds() -> Vec<RecordingTargetKind> {
    Vec::new()
}

fn recording_permission_preflight_for_statuses(
    platform: &str,
    screen_status: RecordingPermissionStatus,
    microphone_status: RecordingPermissionStatus,
    camera_status: RecordingPermissionStatus,
    accessibility_status: RecordingPermissionStatus,
) -> RecordingPermissionPreflight {
    RecordingPermissionPreflight {
        platform: platform.to_string(),
        checks: vec![
            permission_check(
                platform,
                RecordingPermissionKey::ScreenRecording,
                screen_status,
                "Screen recording",
                all_recording_target_kinds(),
            ),
            permission_check(
                platform,
                RecordingPermissionKey::Microphone,
                microphone_status,
                "Microphone",
                all_recording_target_kinds(),
            ),
            permission_check(
                platform,
                RecordingPermissionKey::Camera,
                camera_status,
                "Camera",
                vec![],
            ),
            permission_check(
                platform,
                RecordingPermissionKey::Accessibility,
                accessibility_status,
                "Accessibility",
                no_required_recording_target_kinds(),
            ),
        ],
    }
}

#[cfg(target_os = "macos")]
fn macos_permission_status(granted: bool) -> RecordingPermissionStatus {
    if granted {
        RecordingPermissionStatus::Granted
    } else {
        RecordingPermissionStatus::Prompt
    }
}

#[cfg(target_os = "macos")]
fn macos_screen_recording_status() -> RecordingPermissionStatus {
    // SAFETY: this is a side-effect-free CoreGraphics preflight probe.
    macos_permission_status(unsafe { CGPreflightScreenCaptureAccess() })
}

fn ensure_window_listing_permission(status: RecordingPermissionStatus) -> Result<(), String> {
    if status == RecordingPermissionStatus::Granted {
        return Ok(());
    }
    Err(screen_recording_permission_guidance(
        "selecting app windows",
    ))
}

#[cfg(target_os = "macos")]
fn ensure_macos_window_listing_permission() -> Result<(), String> {
    ensure_window_listing_permission(macos_screen_recording_status())
}

#[cfg(target_os = "macos")]
fn macos_request_screen_recording_permission() -> RecordingPermissionStatus {
    // SAFETY: this asks CoreGraphics to show the standard Screen Recording
    // prompt when the process is not yet trusted.
    macos_permission_status(unsafe { CGRequestScreenCaptureAccess() })
}

#[cfg(target_os = "macos")]
fn macos_accessibility_status() -> RecordingPermissionStatus {
    // SAFETY: this is a side-effect-free ApplicationServices trust probe.
    macos_permission_status(unsafe { AXIsProcessTrusted() != 0 })
}

#[cfg(target_os = "macos")]
fn macos_request_accessibility_permission() -> RecordingPermissionStatus {
    let key = unsafe { CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt) };
    let value = CFBoolean::true_value();
    let options = CFDictionary::from_CFType_pairs(&[(key, value)]);
    // SAFETY: the dictionary contains the documented prompt option and only
    // requests the standard Accessibility trust prompt.
    macos_permission_status(unsafe {
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0
    })
}

#[cfg(target_os = "macos")]
fn macos_av_authorization_status(raw_status: isize) -> RecordingPermissionStatus {
    match raw_status {
        0 => RecordingPermissionStatus::Prompt,
        1 | 2 => RecordingPermissionStatus::Denied,
        3 => RecordingPermissionStatus::Granted,
        _ => RecordingPermissionStatus::Unknown,
    }
}

#[cfg(target_os = "macos")]
fn macos_av_capture_status(media_type: &NSString) -> RecordingPermissionStatus {
    // SAFETY: `authorizationStatusForMediaType:` is a side-effect-free class
    // method and the media type is an NSString accepted by AVFoundation.
    let status: isize = unsafe {
        msg_send![
            AVCaptureDevice::class(),
            authorizationStatusForMediaType: media_type
        ]
    };
    macos_av_authorization_status(status)
}

#[cfg(target_os = "macos")]
fn macos_microphone_status() -> RecordingPermissionStatus {
    let media_type = NSString::from_str("soun");
    macos_av_capture_status(&media_type)
}

#[cfg(target_os = "macos")]
fn macos_camera_status() -> RecordingPermissionStatus {
    let media_type = NSString::from_str("vide");
    macos_av_capture_status(&media_type)
}

fn recording_permission_preflight() -> RecordingPermissionPreflight {
    #[cfg(target_os = "macos")]
    {
        return recording_permission_preflight_for_statuses(
            std::env::consts::OS,
            macos_screen_recording_status(),
            macos_microphone_status(),
            macos_camera_status(),
            macos_accessibility_status(),
        );
    }

    #[cfg(not(target_os = "macos"))]
    {
        recording_permission_preflight_for_statuses(
            std::env::consts::OS,
            RecordingPermissionStatus::Unknown,
            RecordingPermissionStatus::Unknown,
            RecordingPermissionStatus::Unsupported,
            RecordingPermissionStatus::Unknown,
        )
    }
}

fn request_recording_permission(
    key: RecordingPermissionKey,
) -> Result<RecordingPermissionPreflight, String> {
    #[cfg(target_os = "macos")]
    {
        match key {
            RecordingPermissionKey::ScreenRecording => {
                let _ = macos_request_screen_recording_permission();
            }
            RecordingPermissionKey::Accessibility => {
                let _ = macos_request_accessibility_permission();
            }
            RecordingPermissionKey::Microphone | RecordingPermissionKey::Camera => {
                return Err(
                    "This permission is requested by the capture backend when recording starts."
                        .to_string(),
                );
            }
        }
        return Ok(recording_permission_preflight());
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = key;
        Err("Native permission requests are not available on this platform.".to_string())
    }
}

fn target_kind_matches(target: &RecordingTargetKind, request: &RecordingRequestTargetKind) -> bool {
    matches!(
        (target, request),
        (
            RecordingTargetKind::Screen,
            RecordingRequestTargetKind::Screen
        ) | (
            RecordingTargetKind::Window,
            RecordingRequestTargetKind::Window
        ) | (
            RecordingTargetKind::Browser,
            RecordingRequestTargetKind::Browser
        )
    )
}

fn validate_recording_start_request_against_targets(
    request: &RecordingStartRequest,
    targets: &[RecordingTarget],
) -> Result<(), String> {
    if !request.prep.tos_acknowledged {
        return Err("Acknowledge the target service policy before recording.".to_string());
    }

    let Some(target) = targets.iter().find(|target| target.id == request.target_id) else {
        return Err("Unknown workflow recording target.".to_string());
    };
    if !target_kind_matches(&target.kind, &request.target_kind) {
        return Err(
            "Workflow recording target kind does not match the selected target.".to_string(),
        );
    }
    if !target.is_available {
        return Err(format!(
            "Workflow recording target is not available: {}.",
            target.label
        ));
    }
    if matches!(
        request.target_kind,
        RecordingRequestTargetKind::Window | RecordingRequestTargetKind::Browser
    ) {
        if let Some(selection) = &request.capture_window {
            validate_capture_window_selection(selection)?;
            if request
                .capture_window_id
                .as_deref()
                .is_some_and(|id| id != selection.id)
            {
                return Err(
                    "Capture window metadata does not match the selected window.".to_string(),
                );
            }
        }
        let Some(capture_window_id) = request_capture_window_id(request) else {
            let message = if matches!(request.target_kind, RecordingRequestTargetKind::Browser) {
                "Select a browser window before recording."
            } else {
                "Select an app window before recording."
            };
            return Err(message.to_string());
        };
        validate_capture_window_id(capture_window_id)?;
        if matches!(request.target_kind, RecordingRequestTargetKind::Browser)
            && !request
                .capture_window
                .as_ref()
                .is_some_and(|selection| is_browser_capture_app(&selection.app_name))
        {
            return Err("Select a browser window before recording.".to_string());
        }
    }
    if request.include_microphone
        && !target
            .capabilities
            .contains(&RecordingCapability::Microphone)
    {
        return Err("Workflow recording target does not support microphone capture.".to_string());
    }
    if request.include_camera && !target.capabilities.contains(&RecordingCapability::Camera) {
        return Err("Workflow recording target does not support camera capture.".to_string());
    }
    if request.executable_upgrade
        && !target
            .capabilities
            .contains(&RecordingCapability::ActionTrace)
    {
        return Err(
            "Workflow recording target does not support executable action tracing.".to_string(),
        );
    }

    Ok(())
}

fn validate_recording_start_request(request: &RecordingStartRequest) -> Result<(), String> {
    let targets = recording_targets();
    validate_recording_start_request_against_targets(request, &targets)
}

fn unix_time_ms() -> i64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis();
    millis.min(i64::MAX as u128) as i64
}

fn elapsed_marker_ms(started_instant: Instant) -> u64 {
    started_instant.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn request_target_kind(request: &RecordingStartRequest) -> RecordingTargetKind {
    match request.target_kind {
        RecordingRequestTargetKind::Screen => RecordingTargetKind::Screen,
        RecordingRequestTargetKind::Window => RecordingTargetKind::Window,
        RecordingRequestTargetKind::Browser => RecordingTargetKind::Browser,
    }
}

fn request_target_label(request: &RecordingStartRequest) -> String {
    if let Some(selection) = &request.capture_window {
        let app_name = selection.app_name.trim();
        let title = selection.title.trim();
        if !app_name.is_empty() && !title.is_empty() {
            return format!("{app_name} - {title}");
        }
        if !app_name.is_empty() {
            return app_name.to_string();
        }
    }
    recording_targets()
        .into_iter()
        .find(|target| target.id == request.target_id)
        .map(|target| target.label)
        .unwrap_or_else(|| "Workflow recording".to_string())
}

fn recording_output_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Failed to resolve app data directory: {error}"))?
        .join("recordings"))
}

fn recording_output_dir(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

fn file_url(path: &Path) -> Result<String, String> {
    url::Url::from_file_path(path)
        .map(|url| url.to_string())
        .map_err(|_| format!("Failed to convert path to file URL: {}", path.display()))
}

fn recording_preview_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let root = recording_output_root(app)?.join(".previews");
    fs::create_dir_all(&root)
        .map_err(|error| format!("Failed to create recording preview directory: {error}"))?;
    Ok(root)
}

fn recording_preview_root_if_exists(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let root = recording_output_root(app)?.join(".previews");
    Ok(root.is_dir().then_some(root))
}

fn allow_recording_preview_asset<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    path: &Path,
) -> Result<(), String> {
    app.asset_protocol_scope()
        .allow_file(path)
        .map_err(|error| format!("Failed to allow recording preview asset: {error}"))
}

fn prune_recording_previews(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with("window-preview-") && name.ends_with(".png") {
            let _ = fs::remove_file(path);
        }
    }
}

fn prune_recording_previews_for_output_root(root: &Path) {
    let preview_root = root.join(".previews");
    if preview_root.is_dir() {
        prune_recording_previews(&preview_root);
    }
}

fn validate_capture_window_id(id: &str) -> Result<u32, String> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed != id
        || trimmed.len() > 20
        || !trimmed.chars().all(|character| character.is_ascii_digit())
    {
        return Err(format!("Invalid capture window id: {id}"));
    }
    trimmed
        .parse::<u32>()
        .map_err(|_| format!("Invalid capture window id: {id}"))
}

fn request_capture_window_id(request: &RecordingStartRequest) -> Option<&str> {
    request
        .capture_window_id
        .as_deref()
        .or_else(|| {
            request
                .capture_window
                .as_ref()
                .map(|selection| selection.id.as_str())
        })
        .filter(|id| !id.trim().is_empty())
}

fn request_capture_window_platform_id(
    request: &RecordingStartRequest,
) -> Result<Option<u32>, String> {
    if matches!(
        request.target_kind,
        RecordingRequestTargetKind::Window | RecordingRequestTargetKind::Browser
    ) {
        let id = request_capture_window_id(request).ok_or_else(|| {
            if matches!(request.target_kind, RecordingRequestTargetKind::Browser) {
                "Select a browser window before recording.".to_string()
            } else {
                "Select an app window before recording.".to_string()
            }
        })?;
        return validate_capture_window_id(id).map(Some);
    }
    Ok(None)
}

fn validate_capture_window_selection(
    selection: &RecordingCaptureWindowSelection,
) -> Result<(), String> {
    validate_capture_window_id(&selection.id)?;
    if selection.app_name.trim().is_empty() {
        return Err("Capture window app name is missing.".to_string());
    }
    if selection.bounds.width == 0 || selection.bounds.height == 0 {
        return Err("Capture window bounds are invalid.".to_string());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn is_macos_system_capture_window(app_name: &str) -> bool {
    const SYSTEM_OWNERS: &[&str] = &[
        "Control Center",
        "Dock",
        "loginwindow",
        "Notification Center",
        "SystemUIServer",
        "Window Server",
    ];
    SYSTEM_OWNERS
        .iter()
        .any(|owner| app_name.eq_ignore_ascii_case(owner))
}

fn is_capture_window_candidate(app_name: &str, width: u32, height: u32) -> bool {
    let app_name = app_name.trim();
    if app_name.is_empty() || width == 0 || height == 0 {
        return false;
    }
    #[cfg(target_os = "macos")]
    if is_macos_system_capture_window(app_name) {
        return false;
    }
    true
}

fn normalized_capture_app_name(app_name: &str) -> String {
    app_name
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_browser_capture_app(app_name: &str) -> bool {
    let normalized = normalized_capture_app_name(app_name);
    if normalized.is_empty() {
        return false;
    }
    const EXACT_BROWSER_APPS: &[&str] = &[
        "arc",
        "bravebrowser",
        "dia",
        "firefox",
        "googlechrome",
        "googlechromecanary",
        "microsoftedge",
        "opera",
        "operagx",
        "safari",
        "vivaldi",
    ];
    EXACT_BROWSER_APPS.contains(&normalized.as_str())
        || normalized.contains("chromium")
        || normalized.ends_with("browser")
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn xcap_window_summary(window: &xcap::Window) -> Option<RecordingCaptureWindow> {
    let id = window.id().ok()?;
    let pid = window.pid().ok()?;
    let app_name = window.app_name().ok()?.trim().to_string();
    let title = window.title().unwrap_or_default().trim().to_string();
    let x = window.x().ok()?;
    let y = window.y().ok()?;
    let width = window.width().ok()?;
    let height = window.height().ok()?;
    let is_minimized = window.is_minimized().unwrap_or(false);
    let is_focused = window.is_focused().unwrap_or(false);
    if !is_capture_window_candidate(&app_name, width, height) {
        return None;
    }
    Some(RecordingCaptureWindow {
        id: id.to_string(),
        platform_id: id,
        pid,
        app_name,
        title,
        bounds: RecordingCaptureWindowBounds {
            x,
            y,
            width,
            height,
        },
        is_focused,
        is_minimized,
        is_recordable: !is_minimized,
    })
}

#[cfg(target_os = "macos")]
type MacosWindowInfoDictionary = CFDictionary<CFString, CFType>;

#[cfg(target_os = "macos")]
fn macos_cg_dictionary_value<T: ConcreteCFType>(
    dictionary: &MacosWindowInfoDictionary,
    key: CFStringRef,
) -> Option<T> {
    let key = unsafe { CFString::wrap_under_get_rule(key) };
    dictionary
        .find(&key)
        .and_then(|value| value.downcast::<T>())
}

#[cfg(target_os = "macos")]
fn macos_cg_number_i32(dictionary: &MacosWindowInfoDictionary, key: CFStringRef) -> Option<i32> {
    macos_cg_dictionary_value::<CFNumber>(dictionary, key).and_then(|number| number.to_i32())
}

#[cfg(target_os = "macos")]
fn macos_cg_string(dictionary: &MacosWindowInfoDictionary, key: CFStringRef) -> Option<String> {
    macos_cg_dictionary_value::<CFString>(dictionary, key)
        .map(|value| value.to_string())
        .and_then(|value| clean_native_context_text(&value, 200))
}

#[cfg(target_os = "macos")]
fn macos_cg_bool(dictionary: &MacosWindowInfoDictionary, key: CFStringRef) -> Option<bool> {
    macos_cg_dictionary_value::<CFBoolean>(dictionary, key).map(bool::from)
}

#[cfg(target_os = "macos")]
fn macos_cg_window_bounds(
    dictionary: &MacosWindowInfoDictionary,
) -> Option<RecordingCaptureWindowBounds> {
    let bounds = macos_cg_dictionary_value::<CFDictionary>(dictionary, unsafe { kCGWindowBounds })?;
    let rect = CGRect::from_dict_representation(&bounds)?;
    let width = macos_cg_dimension_to_u32(rect.size.width)?;
    let height = macos_cg_dimension_to_u32(rect.size.height)?;
    Some(RecordingCaptureWindowBounds {
        x: macos_cg_coordinate_to_i32(rect.origin.x)?,
        y: macos_cg_coordinate_to_i32(rect.origin.y)?,
        width,
        height,
    })
}

#[cfg(target_os = "macos")]
fn macos_cg_coordinate_to_i32(value: f64) -> Option<i32> {
    if !value.is_finite() {
        return None;
    }
    let rounded = value.round();
    if rounded < i32::MIN as f64 || rounded > i32::MAX as f64 {
        return None;
    }
    Some(rounded as i32)
}

#[cfg(target_os = "macos")]
fn macos_cg_dimension_to_u32(value: f64) -> Option<u32> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let rounded = value.round();
    if rounded <= 0.0 || rounded > u32::MAX as f64 {
        return None;
    }
    Some(rounded as u32)
}

fn merge_capture_window_summaries(
    primary: Vec<RecordingCaptureWindow>,
    fallback: Vec<RecordingCaptureWindow>,
) -> Vec<RecordingCaptureWindow> {
    let mut merged = Vec::with_capacity(primary.len().saturating_add(fallback.len()));
    for window in primary.into_iter().chain(fallback) {
        if !merged
            .iter()
            .any(|existing: &RecordingCaptureWindow| existing.platform_id == window.platform_id)
        {
            merged.push(window);
        }
    }
    merged
}

#[cfg(target_os = "macos")]
fn macos_window_summary_from_info(
    dictionary: &MacosWindowInfoDictionary,
) -> Option<RecordingCaptureWindow> {
    let platform_id =
        u32::try_from(macos_cg_number_i32(dictionary, unsafe { kCGWindowNumber })?).ok()?;
    let pid = u32::try_from(macos_cg_number_i32(dictionary, unsafe {
        kCGWindowOwnerPID
    })?)
    .ok()?;
    let app_name = macos_cg_string(dictionary, unsafe { kCGWindowOwnerName })?;
    let title = macos_cg_string(dictionary, unsafe { kCGWindowName }).unwrap_or_default();
    let bounds = macos_cg_window_bounds(dictionary)?;
    let layer = macos_cg_number_i32(dictionary, unsafe { kCGWindowLayer }).unwrap_or(0);
    let sharing_state =
        macos_cg_number_i32(dictionary, unsafe { kCGWindowSharingState }).unwrap_or(0);
    let is_on_screen = macos_cg_bool(dictionary, unsafe { kCGWindowIsOnscreen }).unwrap_or(true);
    if layer != 0 || sharing_state == 0 {
        return None;
    }
    if !is_capture_window_candidate(&app_name, bounds.width, bounds.height) {
        return None;
    }
    Some(RecordingCaptureWindow {
        id: platform_id.to_string(),
        platform_id,
        pid,
        app_name,
        title,
        bounds,
        is_focused: false,
        is_minimized: !is_on_screen,
        is_recordable: is_on_screen,
    })
}

#[cfg(target_os = "macos")]
fn macos_core_graphics_window_summaries() -> Result<Vec<RecordingCaptureWindow>, String> {
    let raw_windows = unsafe {
        CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            0,
        )
    };
    if raw_windows.is_null() {
        return Ok(Vec::new());
    }
    let windows: CFArray<MacosWindowInfoDictionary> =
        unsafe { TCFType::wrap_under_create_rule(raw_windows) };
    Ok(windows
        .iter()
        .filter_map(|dictionary| macos_window_summary_from_info(&dictionary))
        .collect())
}

#[cfg(target_os = "macos")]
fn macos_ns_error_message(error: *mut NSError, fallback: &str) -> String {
    let Some(error) = (unsafe { Retained::<NSError>::retain(error) }) else {
        return fallback.to_string();
    };
    let description = error.localizedDescription().to_string();
    clean_native_context_text(&description, 400).unwrap_or_else(|| fallback.to_string())
}

#[cfg(target_os = "macos")]
fn macos_sc_rect_bounds(frame: ScCGRect) -> Option<RecordingCaptureWindowBounds> {
    let width = macos_cg_dimension_to_u32(frame.size.width)?;
    let height = macos_cg_dimension_to_u32(frame.size.height)?;
    Some(RecordingCaptureWindowBounds {
        x: macos_cg_coordinate_to_i32(frame.origin.x)?,
        y: macos_cg_coordinate_to_i32(frame.origin.y)?,
        width,
        height,
    })
}

#[cfg(target_os = "macos")]
fn macos_screen_capturekit_window_summary(window: &SCWindow) -> Option<RecordingCaptureWindow> {
    let platform_id = unsafe { window.windowID() };
    let layer = unsafe { window.windowLayer() };
    if layer != 0 {
        return None;
    }
    let owner = unsafe { window.owningApplication() }?;
    let pid = u32::try_from(unsafe { owner.processID() }).ok()?;
    let app_name = clean_native_context_text(&unsafe { owner.applicationName() }.to_string(), 200)?;
    let title = unsafe { window.title() }
        .and_then(|title| clean_native_context_text(&title.to_string(), 200))
        .unwrap_or_default();
    let bounds = macos_sc_rect_bounds(unsafe { window.frame() })?;
    if !is_capture_window_candidate(&app_name, bounds.width, bounds.height) {
        return None;
    }
    let is_on_screen = unsafe { window.isOnScreen() };
    Some(RecordingCaptureWindow {
        id: platform_id.to_string(),
        platform_id,
        pid,
        app_name,
        title,
        bounds,
        is_focused: unsafe { window.isActive() },
        is_minimized: !is_on_screen,
        is_recordable: is_on_screen,
    })
}

#[cfg(target_os = "macos")]
fn macos_screen_capturekit_window_summaries() -> Result<Vec<RecordingCaptureWindow>, String> {
    let (tx, rx) = mpsc::channel::<Result<Vec<RecordingCaptureWindow>, String>>();
    let handler = block2::RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            if !error.is_null() {
                let _ = tx.send(Err(format!(
                    "ScreenCaptureKit failed to list windows: {}",
                    macos_ns_error_message(error, "unknown error")
                )));
                return;
            }
            let Some(content) = (unsafe { Retained::<SCShareableContent>::retain(content) }) else {
                let _ = tx.send(Err(
                    "ScreenCaptureKit returned an empty shareable content response.".to_string(),
                ));
                return;
            };
            let windows = unsafe { content.windows() };
            let summaries = windows
                .iter()
                .filter_map(|window| macos_screen_capturekit_window_summary(&window))
                .collect::<Vec<_>>();
            let _ = tx.send(Ok(summaries));
        },
    );

    unsafe {
        SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
            true,
            true,
            &handler,
        );
    }

    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "Timed out while listing ScreenCaptureKit windows.".to_string())?
}

#[cfg(target_os = "macos")]
fn macos_window_summaries() -> Result<Vec<RecordingCaptureWindow>, String> {
    match macos_screen_capturekit_window_summaries() {
        Ok(screen_capturekit_windows) if !screen_capturekit_windows.is_empty() => {
            let core_graphics_windows = macos_core_graphics_window_summaries().unwrap_or_else(
                |error| {
                    log::warn!(
                        "CoreGraphics fallback window listing failed after ScreenCaptureKit succeeded: {error}"
                    );
                    Vec::new()
                },
            );
            Ok(merge_capture_window_summaries(
                screen_capturekit_windows,
                core_graphics_windows,
            ))
        }
        Ok(_) => {
            log::warn!(
                "ScreenCaptureKit returned no capture windows; falling back to CoreGraphics."
            );
            macos_core_graphics_window_summaries()
        }
        Err(error) => {
            log::warn!("{error}; falling back to CoreGraphics.");
            macos_core_graphics_window_summaries()
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_window_summary_by_id(platform_id: u32) -> Result<RecordingCaptureWindow, String> {
    macos_window_summaries()?
        .into_iter()
        .find(|window| window.platform_id == platform_id)
        .ok_or_else(|| format!("Capture window not found: {platform_id}"))
}

#[cfg(target_os = "macos")]
fn macos_cg_rect_from_bounds(bounds: &RecordingCaptureWindowBounds) -> CGRect {
    CGRect::new(
        &CGPoint::new(bounds.x as f64, bounds.y as f64),
        &CGSize::new(bounds.width as f64, bounds.height as f64),
    )
}

#[cfg(target_os = "macos")]
fn macos_cg_image_to_rgba(image: &core_graphics::image::CGImage) -> Option<RgbaImage> {
    let width = image.width();
    let height = image.height();
    let bytes_per_row = image.bytes_per_row();
    if width == 0 || height == 0 || bytes_per_row < width.saturating_mul(4) {
        return None;
    }
    let data = image.data();
    let mut buffer = Vec::with_capacity(width.saturating_mul(height).saturating_mul(4));
    for row in data.chunks_exact(bytes_per_row).take(height) {
        buffer.extend_from_slice(&row[..width * 4]);
    }
    if buffer.len() != width.saturating_mul(height).saturating_mul(4) {
        return None;
    }
    for bgra in buffer.chunks_exact_mut(4) {
        bgra.swap(0, 2);
    }
    RgbaImage::from_raw(width as u32, height as u32, buffer)
}

#[cfg(target_os = "macos")]
fn macos_capture_window_image(platform_id: u32) -> Result<RgbaImage, String> {
    let summary = macos_window_summary_by_id(platform_id)?;
    if !summary.is_recordable {
        return Err("Capture window is minimized.".to_string());
    }
    let rect = macos_cg_rect_from_bounds(&summary.bounds);
    let image = create_image(
        rect,
        kCGWindowListOptionIncludingWindow,
        platform_id,
        kCGWindowImageDefault,
    )
    .ok_or_else(|| "Failed to capture window preview.".to_string())?;
    macos_cg_image_to_rgba(&image)
        .ok_or_else(|| "Failed to decode window preview image.".to_string())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn xcap_windows() -> Result<Vec<xcap::Window>, String> {
    xcap::Window::all().map_err(|error| format!("Failed to list capture windows: {error}"))
}

fn list_capture_windows() -> Result<Vec<RecordingCaptureWindow>, String> {
    #[cfg(target_os = "macos")]
    {
        ensure_macos_window_listing_permission()?;
        return macos_window_summaries();
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let windows = xcap_windows()?;
        Ok(windows
            .iter()
            .filter_map(xcap_window_summary)
            .collect::<Vec<_>>())
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Ok(Vec::new())
    }
}

fn capture_window_preview(
    app: &tauri::AppHandle,
    window_id: &str,
) -> Result<RecordingCaptureWindowPreview, String> {
    #[cfg(target_os = "macos")]
    {
        ensure_macos_window_listing_permission()?;
        let platform_id = validate_capture_window_id(window_id)?;
        let summary = macos_window_summary_by_id(platform_id)?;
        if !summary.is_recordable {
            return Err("Capture window is minimized.".to_string());
        }
        let image = macos_capture_window_image(platform_id)?;
        let preview_width = image.width();
        let preview_height = image.height();
        let preview_root = recording_preview_root(app)?;
        prune_recording_previews(&preview_root);
        let captured_at_ms = unix_time_ms();
        let path = preview_root.join(format!("window-preview-{platform_id}-{captured_at_ms}.png"));
        image
            .save(&path)
            .map_err(|error| format!("Failed to write window preview: {error}"))?;
        allow_recording_preview_asset(app, &path)?;
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Failed to stat window preview: {error}"))?;
        return Ok(RecordingCaptureWindowPreview {
            window_id: platform_id.to_string(),
            captured_at_ms,
            artifact_url: file_url(&path)?,
            artifact_path: path.to_string_lossy().into_owned(),
            mime_type: "image/png".to_string(),
            width: preview_width,
            height: preview_height,
            size_bytes: metadata.len(),
        });
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let platform_id = validate_capture_window_id(window_id)?;
        let window = xcap_windows()?
            .into_iter()
            .find(|window| window.id().ok() == Some(platform_id))
            .ok_or_else(|| format!("Capture window not found: {window_id}"))?;
        let summary = xcap_window_summary(&window)
            .ok_or_else(|| "Capture window is not visible.".to_string())?;
        if !summary.is_recordable {
            return Err("Capture window is minimized.".to_string());
        }
        let image = window
            .capture_image()
            .map_err(|error| format!("Failed to capture window preview: {error}"))?;
        let preview_root = recording_preview_root(app)?;
        prune_recording_previews(&preview_root);
        let captured_at_ms = unix_time_ms();
        let path = preview_root.join(format!("window-preview-{platform_id}-{captured_at_ms}.png"));
        image
            .save(&path)
            .map_err(|error| format!("Failed to write window preview: {error}"))?;
        allow_recording_preview_asset(app, &path)?;
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Failed to stat window preview: {error}"))?;
        Ok(RecordingCaptureWindowPreview {
            window_id: platform_id.to_string(),
            captured_at_ms,
            artifact_url: file_url(&path)?,
            artifact_path: path.to_string_lossy().into_owned(),
            mime_type: "image/png".to_string(),
            width: summary.bounds.width,
            height: summary.bounds.height,
            size_bytes: metadata.len(),
        })
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = app;
        let _ = window_id;
        Err("Window capture previews are not supported on this platform.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn ensure_capture_window_recordable(platform_id: u32) -> Result<(), String> {
    let summary = macos_window_summary_by_id(platform_id)?;
    if !summary.is_recordable {
        return Err("Capture window is minimized.".to_string());
    }
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn select_xcap_recordable_window(platform_id: u32) -> Result<xcap::Window, String> {
    let window = xcap_windows()?
        .into_iter()
        .find(|window| window.id().ok() == Some(platform_id))
        .ok_or_else(|| format!("Capture window not found: {platform_id}"))?;
    let summary =
        xcap_window_summary(&window).ok_or_else(|| "Capture window is not visible.".to_string())?;
    if !summary.is_recordable {
        return Err("Capture window is minimized.".to_string());
    }
    Ok(window)
}

fn ensure_native_recording_permissions(request: &RecordingStartRequest) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let preflight = recording_permission_preflight();
        let status_for = |key: RecordingPermissionKey| {
            preflight
                .checks
                .iter()
                .find(|check| check.key == key)
                .map(|check| check.status.clone())
                .unwrap_or(RecordingPermissionStatus::Unknown)
        };
        if status_for(RecordingPermissionKey::ScreenRecording) != RecordingPermissionStatus::Granted
        {
            return Err(screen_recording_permission_guidance("recording"));
        }
        if request.include_microphone
            && status_for(RecordingPermissionKey::Microphone) == RecordingPermissionStatus::Denied
        {
            return Err("Microphone permission is denied.".to_string());
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = request;
    }

    Ok(())
}

fn build_recording_session(
    request: &RecordingStartRequest,
    id: String,
    output_dir: &Path,
) -> RecordingSession {
    let trace_scope_note = if matches!(request.target_kind, RecordingRequestTargetKind::Browser) {
        "Browser recording uses native video capture, target anchors, and explicit markers; high-fidelity DOM traces require the Seren Workflow Recorder extension."
    } else {
        "Native desktop recording captures video, target context anchors, and explicit markers; accessibility action traces are pending."
    };
    RecordingSession {
        id,
        target_kind: request_target_kind(request),
        target_label: request_target_label(request),
        started_at_ms: unix_time_ms(),
        output_dir: Some(output_dir.to_string_lossy().to_string()),
        max_video_height: 720,
        artifact_url: None,
        mime_type: None,
        size_bytes: None,
        trace_artifact_url: None,
        trace_event_count: None,
        trace_truncated: None,
        marker_count: None,
        redacted_event_count: None,
        transcript_artifact_url: None,
        transcript_segment_count: None,
        keyframe_artifact_url: None,
        keyframe_count: None,
        metadata_artifact_url: None,
        capture_stats: None,
        context: Some(RecordingSessionContext {
            target_id: request.target_id.clone(),
            capture_window_id: request.capture_window_id.clone(),
            capture_window: request.capture_window.clone(),
            prep: request.prep.clone(),
            include_microphone: request.include_microphone,
            include_camera: request.include_camera,
            executable_upgrade: request.executable_upgrade,
            trace_scope_note: Some(trace_scope_note.to_string()),
        }),
        quality_status: None,
        quality_checks: None,
    }
}

fn start_native_recording_backend(
    app: &tauri::AppHandle,
    request: &RecordingStartRequest,
    output_dir: &Path,
) -> Result<NativeRecordingBackend, String> {
    match request.target_kind {
        RecordingRequestTargetKind::Screen => {
            start_screen_recording_backend(app, request, output_dir)
        }
        RecordingRequestTargetKind::Window => {
            start_window_recording_backend(app, request, output_dir)
        }
        RecordingRequestTargetKind::Browser => {
            start_window_recording_backend(app, request, output_dir)
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_screencapture_video_args(
    request: &RecordingStartRequest,
    video_path: &Path,
) -> Result<Vec<OsString>, String> {
    let mut args = vec![
        OsString::from("-v"),
        OsString::from("-x"),
        OsString::from("-C"),
        OsString::from("-k"),
    ];
    if let Some(platform_id) = request_capture_window_platform_id(request)? {
        args.push(OsString::from("-l"));
        args.push(OsString::from(platform_id.to_string()));
    }
    if request.include_microphone {
        args.push(OsString::from("-g"));
    }
    args.push(video_path.as_os_str().to_os_string());
    Ok(args)
}

fn start_screen_recording_backend(
    app: &tauri::AppHandle,
    request: &RecordingStartRequest,
    output_dir: &Path,
) -> Result<NativeRecordingBackend, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let video_path = output_dir.join("workflow-recording.mov");
        let mut command = Command::new("/usr/sbin/screencapture");
        command.args(macos_screencapture_video_args(request, &video_path)?);
        let child = command
            .spawn()
            .map_err(|error| format!("Failed to start macOS screen recorder: {error}"))?;
        Ok(NativeRecordingBackend::MacScreencapture {
            child,
            video_path,
            output_dir: output_dir.to_path_buf(),
        })
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let _ = request;
        start_xcap_screen_recording_backend(app, output_dir)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = app;
        let _ = request;
        let _ = output_dir;
        Err("Native screen recording is not implemented on this platform yet.".to_string())
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn recording_id_from_output_dir(output_dir: &Path) -> Option<String> {
    output_dir
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn start_xcap_screen_recording_backend(
    app: &tauri::AppHandle,
    output_dir: &Path,
) -> Result<NativeRecordingBackend, String> {
    let video_path = output_dir.join("workflow-recording.avi");
    let monitors = xcap::Monitor::all()
        .map_err(|error| format!("Failed to list capture monitors: {error}"))?;
    let monitor = monitors
        .iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or_else(|| "No capture monitor is available.".to_string())?
        .clone();
    let (recorder, receiver) = monitor
        .video_recorder()
        .map_err(|error| format!("Failed to create native screen recorder: {error}"))?;
    recorder
        .start()
        .map_err(|error| format!("Failed to start native screen recorder: {error}"))?;
    let (stop_tx, stop_rx) = mpsc::channel();
    let thread_video_path = video_path.clone();
    let thread_output_dir = output_dir.to_path_buf();
    let thread_app = app.clone();
    let recording_id = recording_id_from_output_dir(output_dir);
    let join = thread::spawn(move || {
        record_xcap_avi(
            thread_video_path,
            thread_output_dir,
            recorder,
            receiver,
            stop_rx,
            thread_app,
            recording_id,
        )
    });
    Ok(NativeRecordingBackend::XcapAvi {
        stop_tx,
        join,
        video_path,
        output_dir: output_dir.to_path_buf(),
    })
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn start_xcap_window_recording_backend(
    app: &tauri::AppHandle,
    output_dir: &Path,
    window: xcap::Window,
) -> Result<NativeRecordingBackend, String> {
    let video_path = output_dir.join("workflow-recording.avi");
    let (stop_tx, stop_rx) = mpsc::channel();
    let thread_video_path = video_path.clone();
    let thread_output_dir = output_dir.to_path_buf();
    let _ = app;
    let join = thread::spawn(move || {
        record_xcap_window_avi(thread_video_path, thread_output_dir, window, stop_rx)
    });
    Ok(NativeRecordingBackend::XcapAvi {
        stop_tx,
        join,
        video_path,
        output_dir: output_dir.to_path_buf(),
    })
}

fn start_window_recording_backend(
    app: &tauri::AppHandle,
    request: &RecordingStartRequest,
    output_dir: &Path,
) -> Result<NativeRecordingBackend, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let platform_id = request_capture_window_platform_id(request)?
            .ok_or_else(|| "Select an app window before recording.".to_string())?;
        ensure_capture_window_recordable(platform_id)?;
        let video_path = output_dir.join("workflow-recording.mov");
        let mut command = Command::new("/usr/sbin/screencapture");
        command.args(macos_screencapture_video_args(request, &video_path)?);
        let child = command
            .spawn()
            .map_err(|error| format!("Failed to start macOS window recorder: {error}"))?;
        Ok(NativeRecordingBackend::MacScreencapture {
            child,
            video_path,
            output_dir: output_dir.to_path_buf(),
        })
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        let platform_id = request_capture_window_platform_id(request)?
            .ok_or_else(|| "Select an app window before recording.".to_string())?;
        let window = select_xcap_recordable_window(platform_id)?;
        start_xcap_window_recording_backend(app, output_dir, window)
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = app;
        let _ = request;
        let _ = output_dir;
        Err("Native window recording is not implemented on this platform yet.".to_string())
    }
}

#[cfg(target_os = "macos")]
fn wait_child_with_timeout(child: &mut Child, timeout: Duration) -> Result<(), String> {
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if started.elapsed() < timeout => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => return Err("timed out waiting for recorder to stop".to_string()),
            Err(error) => return Err(format!("Failed to wait for recorder: {error}")),
        }
    }
}

#[cfg(target_os = "macos")]
fn request_child_interrupt(child: &Child) -> Result<(), String> {
    let pid = child.id();
    // SAFETY: sends SIGINT to the recorder child process we own.
    let result = unsafe { libc::kill(pid as i32, libc::SIGINT) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "Failed to request recorder stop: {}",
            std::io::Error::last_os_error()
        ))
    }
}

struct NativeRecordingArtifacts {
    video_path: PathBuf,
    mime_type: String,
    size_bytes: u64,
    output_dir: PathBuf,
    normalized: bool,
    capture_stats: Option<RecordingCaptureStats>,
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
struct AviFrameIndex {
    offset: u32,
    size: u32,
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
struct MjpegAviWriter {
    file: fs::File,
    riff_size_pos: u64,
    movi_size_pos: u64,
    total_frames_pos: u64,
    stream_length_pos: u64,
    movi_data_start: u64,
    frames: Vec<AviFrameIndex>,
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn write_u32_le(file: &mut fs::File, value: u32) -> Result<(), String> {
    file.write_all(&value.to_le_bytes())
        .map_err(|error| error.to_string())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn patch_u32_le(file: &mut fs::File, offset: u64, value: u32) -> Result<(), String> {
    let current = file.stream_position().map_err(|error| error.to_string())?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| error.to_string())?;
    write_u32_le(file, value)?;
    file.seek(SeekFrom::Start(current))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn riff_size(start: u64, end: u64) -> Result<u32, String> {
    end.checked_sub(start)
        .and_then(|size| u32::try_from(size).ok())
        .ok_or_else(|| "AVI artifact is too large.".to_string())
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
impl MjpegAviWriter {
    fn create(path: &Path, width: u32, height: u32, fps: u32) -> Result<Self, String> {
        let mut file =
            fs::File::create(path).map_err(|error| format!("Failed to create AVI: {error}"))?;
        file.write_all(b"RIFF").map_err(|error| error.to_string())?;
        let riff_size_pos = file.stream_position().map_err(|error| error.to_string())?;
        write_u32_le(&mut file, 0)?;
        file.write_all(b"AVI ").map_err(|error| error.to_string())?;

        let hdrl = {
            let mut header = Vec::new();
            header.extend_from_slice(b"avih");
            header.extend_from_slice(&56_u32.to_le_bytes());
            header.extend_from_slice(&(1_000_000_u32 / fps.max(1)).to_le_bytes());
            header.extend_from_slice(&0_u32.to_le_bytes());
            header.extend_from_slice(&0_u32.to_le_bytes());
            header.extend_from_slice(&0x10_u32.to_le_bytes());
            let total_frames_pos_in_header = header.len();
            header.extend_from_slice(&0_u32.to_le_bytes());
            header.extend_from_slice(&0_u32.to_le_bytes());
            header.extend_from_slice(&1_u32.to_le_bytes());
            header.extend_from_slice(&0_u32.to_le_bytes());
            header.extend_from_slice(&width.to_le_bytes());
            header.extend_from_slice(&height.to_le_bytes());
            header.extend_from_slice(&[0; 16]);

            let mut strl = Vec::new();
            strl.extend_from_slice(b"strh");
            strl.extend_from_slice(&56_u32.to_le_bytes());
            strl.extend_from_slice(b"vids");
            strl.extend_from_slice(b"MJPG");
            strl.extend_from_slice(&0_u32.to_le_bytes());
            strl.extend_from_slice(&0_u16.to_le_bytes());
            strl.extend_from_slice(&0_u16.to_le_bytes());
            strl.extend_from_slice(&0_u32.to_le_bytes());
            strl.extend_from_slice(&1_u32.to_le_bytes());
            strl.extend_from_slice(&fps.max(1).to_le_bytes());
            strl.extend_from_slice(&0_u32.to_le_bytes());
            let stream_length_pos_in_strl = strl.len();
            strl.extend_from_slice(&0_u32.to_le_bytes());
            strl.extend_from_slice(&0_u32.to_le_bytes());
            strl.extend_from_slice(&u32::MAX.to_le_bytes());
            strl.extend_from_slice(&0_u32.to_le_bytes());
            strl.extend_from_slice(&0_i16.to_le_bytes());
            strl.extend_from_slice(&0_i16.to_le_bytes());
            strl.extend_from_slice(&(width.min(i16::MAX as u32) as i16).to_le_bytes());
            strl.extend_from_slice(&(height.min(i16::MAX as u32) as i16).to_le_bytes());

            strl.extend_from_slice(b"strf");
            strl.extend_from_slice(&40_u32.to_le_bytes());
            strl.extend_from_slice(&40_u32.to_le_bytes());
            strl.extend_from_slice(&(width as i32).to_le_bytes());
            strl.extend_from_slice(&(height as i32).to_le_bytes());
            strl.extend_from_slice(&1_u16.to_le_bytes());
            strl.extend_from_slice(&24_u16.to_le_bytes());
            strl.extend_from_slice(b"MJPG");
            strl.extend_from_slice(&(width.saturating_mul(height).saturating_mul(3)).to_le_bytes());
            strl.extend_from_slice(&0_i32.to_le_bytes());
            strl.extend_from_slice(&0_i32.to_le_bytes());
            strl.extend_from_slice(&0_u32.to_le_bytes());
            strl.extend_from_slice(&0_u32.to_le_bytes());

            let mut wrapped_strl = Vec::new();
            wrapped_strl.extend_from_slice(b"LIST");
            wrapped_strl.extend_from_slice(&(strl.len() as u32 + 4).to_le_bytes());
            wrapped_strl.extend_from_slice(b"strl");
            wrapped_strl.extend_from_slice(&strl);

            let stream_length_pos_in_header = header.len() + 12 + stream_length_pos_in_strl;
            header.extend_from_slice(&wrapped_strl);
            (
                header,
                total_frames_pos_in_header,
                stream_length_pos_in_header,
            )
        };

        file.write_all(b"LIST").map_err(|error| error.to_string())?;
        write_u32_le(&mut file, hdrl.0.len() as u32 + 4)?;
        file.write_all(b"hdrl").map_err(|error| error.to_string())?;
        let hdrl_start = file.stream_position().map_err(|error| error.to_string())?;
        file.write_all(&hdrl.0).map_err(|error| error.to_string())?;
        let total_frames_pos = hdrl_start + hdrl.1 as u64;
        let stream_length_pos = hdrl_start + hdrl.2 as u64;

        file.write_all(b"LIST").map_err(|error| error.to_string())?;
        let movi_size_pos = file.stream_position().map_err(|error| error.to_string())?;
        write_u32_le(&mut file, 0)?;
        file.write_all(b"movi").map_err(|error| error.to_string())?;
        let movi_data_start = file.stream_position().map_err(|error| error.to_string())?;

        Ok(Self {
            file,
            riff_size_pos,
            movi_size_pos,
            total_frames_pos,
            stream_length_pos,
            movi_data_start,
            frames: Vec::new(),
        })
    }

    fn write_frame(&mut self, jpeg: &[u8]) -> Result<(), String> {
        let chunk_start = self
            .file
            .stream_position()
            .map_err(|error| error.to_string())?;
        self.file
            .write_all(b"00dc")
            .map_err(|error| error.to_string())?;
        write_u32_le(&mut self.file, jpeg.len() as u32)?;
        self.file
            .write_all(jpeg)
            .map_err(|error| error.to_string())?;
        if jpeg.len() % 2 != 0 {
            self.file
                .write_all(&[0])
                .map_err(|error| error.to_string())?;
        }
        self.frames.push(AviFrameIndex {
            offset: riff_size(self.movi_data_start, chunk_start)?,
            size: jpeg.len() as u32,
        });
        Ok(())
    }

    fn finish(mut self) -> Result<(), String> {
        let idx_start = self
            .file
            .stream_position()
            .map_err(|error| error.to_string())?;
        self.file
            .write_all(b"idx1")
            .map_err(|error| error.to_string())?;
        write_u32_le(&mut self.file, self.frames.len() as u32 * 16)?;
        for frame in &self.frames {
            self.file
                .write_all(b"00dc")
                .map_err(|error| error.to_string())?;
            write_u32_le(&mut self.file, 0x10)?;
            write_u32_le(&mut self.file, frame.offset)?;
            write_u32_le(&mut self.file, frame.size)?;
        }
        let end = self
            .file
            .stream_position()
            .map_err(|error| error.to_string())?;
        patch_u32_le(&mut self.file, self.riff_size_pos, riff_size(8, end)?)?;
        patch_u32_le(
            &mut self.file,
            self.movi_size_pos,
            riff_size(self.movi_size_pos + 4, idx_start)?,
        )?;
        let frame_count = self.frames.len() as u32;
        patch_u32_le(&mut self.file, self.total_frames_pos, frame_count)?;
        patch_u32_le(&mut self.file, self.stream_length_pos, frame_count)?;
        self.file.flush().map_err(|error| error.to_string())
    }
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn encode_mjpeg_frame(frame: &xcap::Frame) -> Result<Vec<u8>, String> {
    encode_mjpeg_rgba_frame(frame.width, frame.height, &frame.raw)
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn encode_mjpeg_rgba_frame(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
    let expected_len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixel_count| pixel_count.checked_mul(4))
        .ok_or_else(|| "MJPEG frame dimensions are too large.".to_string())?;
    if rgba.len() != expected_len {
        return Err("MJPEG frame buffer length does not match its dimensions.".to_string());
    }
    let mut rgb = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for pixel in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&[pixel[0], pixel[1], pixel[2]]);
    }
    let mut jpeg = Vec::new();
    let mut encoder = JpegEncoder::new_with_quality(&mut jpeg, 82);
    encoder
        .encode(&rgb, width, height, ColorType::Rgb8.into())
        .map_err(|error| format!("Failed to encode MJPEG frame: {error}"))?;
    Ok(jpeg)
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn finish_xcap_avi_artifact(
    video_path: PathBuf,
    output_dir: PathBuf,
    backend_name: &'static str,
    writer: Option<MjpegAviWriter>,
    started_at: Instant,
    frame_width: Option<u32>,
    frame_height: Option<u32>,
    target_fps: u32,
    frames_received: u64,
    frames_encoded: u64,
    frames_skipped: u64,
    encode_error_count: u64,
    first_frame_ms: Option<u64>,
) -> Result<NativeRecordingArtifacts, String> {
    let Some(writer) = writer else {
        let _ = fs::remove_file(&video_path);
        return Err("Native recording did not capture any frames.".to_string());
    };
    if frames_encoded == 0 {
        drop(writer);
        let _ = fs::remove_file(&video_path);
        return Err("Native recording did not encode any frames.".to_string());
    }
    if let Err(error) = writer.finish() {
        let _ = fs::remove_file(&video_path);
        return Err(error);
    }
    let metadata = fs::metadata(&video_path).map_err(|error| {
        format!(
            "Native recording artifact is unavailable at {}: {error}",
            video_path.display()
        )
    })?;
    if metadata.len() == 0 {
        return Err("Native recording produced an empty video artifact.".to_string());
    }
    let duration_ms = started_at.elapsed().as_millis() as u64;
    let effective_fps = if duration_ms > 0 {
        Some((frames_encoded as f64 * 1000.0) / duration_ms as f64)
    } else {
        None
    };
    Ok(NativeRecordingArtifacts {
        video_path,
        mime_type: "video/x-msvideo".to_string(),
        size_bytes: metadata.len(),
        output_dir,
        normalized: false,
        capture_stats: Some(RecordingCaptureStats {
            backend: backend_name.to_string(),
            frame_width,
            frame_height,
            target_fps: Some(target_fps),
            effective_fps,
            frames_received: Some(frames_received),
            frames_encoded: Some(frames_encoded),
            frames_skipped: Some(frames_skipped),
            encode_error_count: Some(encode_error_count),
            duration_ms: Some(duration_ms),
            time_to_first_frame_ms: first_frame_ms,
        }),
    })
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn record_xcap_avi(
    video_path: PathBuf,
    output_dir: PathBuf,
    recorder: xcap::VideoRecorder,
    receiver: mpsc::Receiver<xcap::Frame>,
    stop_rx: mpsc::Receiver<()>,
    app: tauri::AppHandle,
    recording_id: Option<String>,
) -> Result<NativeRecordingArtifacts, String> {
    const FPS: u32 = 8;
    let started_at = Instant::now();
    let mut writer: Option<MjpegAviWriter> = None;
    let mut last_frame_at: Option<Instant> = None;
    let mut first_frame_ms: Option<u64> = None;
    let mut frame_width: Option<u32> = None;
    let mut frame_height: Option<u32> = None;
    let mut frames_received: u64 = 0;
    let mut frames_encoded: u64 = 0;
    let mut frames_skipped: u64 = 0;
    let mut encode_error_count: u64 = 0;
    // Captured instead of early-returning so `recorder.stop()` always runs and a
    // partial file is removed on the error paths below.
    let mut loop_error: Option<String> = None;

    'capture: loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(frame) => {
                frames_received = frames_received.saturating_add(1);
                if first_frame_ms.is_none() {
                    first_frame_ms = Some(started_at.elapsed().as_millis() as u64);
                }
                if let Some(last) = last_frame_at {
                    if last.elapsed() < Duration::from_millis(1_000 / FPS as u64) {
                        frames_skipped = frames_skipped.saturating_add(1);
                        continue;
                    }
                }
                if writer.is_none() {
                    frame_width = Some(frame.width);
                    frame_height = Some(frame.height);
                    match MjpegAviWriter::create(&video_path, frame.width, frame.height, FPS) {
                        Ok(created) => writer = Some(created),
                        Err(error) => {
                            loop_error = Some(error);
                            break 'capture;
                        }
                    }
                }
                if frame_width != Some(frame.width) || frame_height != Some(frame.height) {
                    frames_skipped = frames_skipped.saturating_add(1);
                    continue;
                }
                let jpeg = match encode_mjpeg_frame(&frame) {
                    Ok(jpeg) => jpeg,
                    Err(error) => {
                        encode_error_count = encode_error_count.saturating_add(1);
                        if writer.is_none() {
                            loop_error = Some(error);
                            break 'capture;
                        }
                        continue;
                    }
                };
                if let Some(writer) = writer.as_mut() {
                    if let Err(error) = writer.write_frame(&jpeg) {
                        loop_error = Some(error);
                        break 'capture;
                    }
                }
                frames_encoded = frames_encoded.saturating_add(1);
                last_frame_at = Some(Instant::now());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                // The OS/capture ended the session out-of-band (no stop was
                // requested), so notify the frontend before finalizing.
                if let Some(recording_id) = recording_id.as_deref() {
                    let _ = app.emit(
                        "recording://external-stop",
                        json!({ "recordingId": recording_id }),
                    );
                }
                break;
            }
        }
    }

    let _ = recorder.stop();
    if let Some(error) = loop_error {
        let _ = fs::remove_file(&video_path);
        return Err(error);
    }
    finish_xcap_avi_artifact(
        video_path,
        output_dir,
        xcap_screen_avi_backend_name(),
        writer,
        started_at,
        frame_width,
        frame_height,
        FPS,
        frames_received,
        frames_encoded,
        frames_skipped,
        encode_error_count,
        first_frame_ms,
    )
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
fn record_xcap_window_avi(
    video_path: PathBuf,
    output_dir: PathBuf,
    window: xcap::Window,
    stop_rx: mpsc::Receiver<()>,
) -> Result<NativeRecordingArtifacts, String> {
    const FPS: u32 = 8;
    let started_at = Instant::now();
    let frame_interval = Duration::from_millis(1_000 / FPS as u64);
    let mut next_frame_at = Instant::now();
    let mut writer: Option<MjpegAviWriter> = None;
    let mut first_frame_ms: Option<u64> = None;
    let mut frame_width: Option<u32> = None;
    let mut frame_height: Option<u32> = None;
    let mut frames_received: u64 = 0;
    let mut frames_encoded: u64 = 0;
    let mut frames_skipped: u64 = 0;
    let mut encode_error_count: u64 = 0;

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        let now = Instant::now();
        if now < next_frame_at {
            thread::sleep((next_frame_at - now).min(Duration::from_millis(50)));
            continue;
        }
        next_frame_at = now + frame_interval;

        let image = match window.capture_image() {
            Ok(image) => image,
            Err(_) => {
                frames_skipped = frames_skipped.saturating_add(1);
                continue;
            }
        };
        let width = image.width();
        let height = image.height();
        frames_received = frames_received.saturating_add(1);
        if first_frame_ms.is_none() {
            first_frame_ms = Some(started_at.elapsed().as_millis() as u64);
        }
        if writer.is_none() {
            frame_width = Some(width);
            frame_height = Some(height);
            match MjpegAviWriter::create(&video_path, width, height, FPS) {
                Ok(created) => writer = Some(created),
                Err(error) => {
                    let _ = fs::remove_file(&video_path);
                    return Err(error);
                }
            }
        }
        if frame_width != Some(width) || frame_height != Some(height) {
            frames_skipped = frames_skipped.saturating_add(1);
            continue;
        }
        let jpeg = match encode_mjpeg_rgba_frame(width, height, image.as_raw()) {
            Ok(jpeg) => jpeg,
            Err(error) => {
                encode_error_count = encode_error_count.saturating_add(1);
                if writer.is_none() {
                    let _ = fs::remove_file(&video_path);
                    return Err(error);
                }
                continue;
            }
        };
        if let Some(writer) = writer.as_mut() {
            if let Err(error) = writer.write_frame(&jpeg) {
                let _ = fs::remove_file(&video_path);
                return Err(error);
            }
        }
        frames_encoded = frames_encoded.saturating_add(1);
    }

    finish_xcap_avi_artifact(
        video_path,
        output_dir,
        xcap_window_avi_backend_name(),
        writer,
        started_at,
        frame_width,
        frame_height,
        FPS,
        frames_received,
        frames_encoded,
        frames_skipped,
        encode_error_count,
        first_frame_ms,
    )
}

#[cfg(target_os = "windows")]
fn xcap_screen_avi_backend_name() -> &'static str {
    "windows_xcap_screen_mjpeg_avi"
}

#[cfg(target_os = "linux")]
fn xcap_screen_avi_backend_name() -> &'static str {
    "linux_xcap_screen_mjpeg_avi"
}

#[cfg(target_os = "windows")]
fn xcap_window_avi_backend_name() -> &'static str {
    "windows_xcap_window_mjpeg_avi"
}

#[cfg(target_os = "linux")]
fn xcap_window_avi_backend_name() -> &'static str {
    "linux_xcap_window_mjpeg_avi"
}

#[cfg(target_os = "macos")]
fn normalize_native_video(input_path: &Path, output_dir: &Path) -> Option<PathBuf> {
    let output_path = output_dir.join("workflow-recording-720p.m4v");
    let status = Command::new("/usr/bin/avconvert")
        .arg("--source")
        .arg(input_path)
        .args(["--preset", "Preset1280x720", "--output"])
        .arg(&output_path)
        .arg("--replace")
        .status()
        .ok()?;
    if !status.success() {
        let _ = fs::remove_file(&output_path);
        return None;
    }
    let metadata = fs::metadata(&output_path).ok()?;
    if metadata.len() == 0 {
        let _ = fs::remove_file(&output_path);
        return None;
    }
    Some(output_path)
}

fn stop_native_recording_backend(
    backend: NativeRecordingBackend,
) -> Result<NativeRecordingArtifacts, String> {
    match backend {
        #[cfg(target_os = "macos")]
        NativeRecordingBackend::MacScreencapture {
            mut child,
            video_path,
            output_dir,
        } => {
            if child
                .try_wait()
                .map_err(|error| format!("Failed to inspect recorder state: {error}"))?
                .is_none()
            {
                let _ = request_child_interrupt(&child);
                if wait_child_with_timeout(&mut child, Duration::from_secs(5)).is_err() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
            let metadata = fs::metadata(&video_path).map_err(|error| {
                format!(
                    "Screen recording did not produce a video artifact at {}: {error}",
                    video_path.display()
                )
            })?;
            if metadata.len() == 0 {
                return Err("Screen recording produced an empty video artifact.".to_string());
            }
            let (artifact_path, mime_type, normalized) =
                if let Some(normalized_path) = normalize_native_video(&video_path, &output_dir) {
                    let _ = fs::remove_file(&video_path);
                    (normalized_path, "video/mp4".to_string(), true)
                } else {
                    (video_path, "video/quicktime".to_string(), false)
                };
            let artifact_metadata = fs::metadata(&artifact_path).map_err(|error| {
                format!(
                    "Screen recording artifact is unavailable at {}: {error}",
                    artifact_path.display()
                )
            })?;
            Ok(NativeRecordingArtifacts {
                video_path: artifact_path,
                mime_type,
                size_bytes: artifact_metadata.len(),
                output_dir,
                normalized,
                capture_stats: Some(RecordingCaptureStats {
                    backend: "macos_screencapture".to_string(),
                    frame_width: None,
                    frame_height: None,
                    target_fps: None,
                    effective_fps: None,
                    frames_received: None,
                    frames_encoded: None,
                    frames_skipped: None,
                    encode_error_count: None,
                    duration_ms: None,
                    time_to_first_frame_ms: None,
                }),
            })
        }
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        NativeRecordingBackend::XcapAvi { stop_tx, join, .. } => {
            let _ = stop_tx.send(());
            join.join()
                .map_err(|_| "Native recorder thread panicked.".to_string())?
        }
    }
}

fn discard_native_recording_backend(backend: NativeRecordingBackend) {
    match backend {
        #[cfg(target_os = "macos")]
        NativeRecordingBackend::MacScreencapture { mut child, .. } => {
            if child.try_wait().ok().flatten().is_none() {
                let _ = request_child_interrupt(&child);
                if wait_child_with_timeout(&mut child, Duration::from_secs(1)).is_err() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        NativeRecordingBackend::XcapAvi {
            stop_tx,
            join,
            output_dir,
            ..
        } => {
            let _ = stop_tx.send(());
            // A failed finalize leaves only an empty/partial artifact; drop the
            // output directory rather than accumulating dead recording folders.
            if matches!(join.join(), Ok(Err(_)) | Err(_)) {
                let _ = fs::remove_dir_all(&output_dir);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn recorder_process_is_active(pid: u32, video_path: &Path) -> bool {
    // Match both process name and output path so a reused PID or unrelated
    // screencapture process is not signalled.
    Command::new("/bin/ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "command="])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| {
            let command = String::from_utf8_lossy(&output.stdout);
            command.contains("screencapture")
                && command.contains(video_path.to_string_lossy().as_ref())
        })
        .unwrap_or(false)
}

/// Reap a native recorder left running by a previous crash/force-quit, using the
/// on-disk marker. Best-effort: finalizes via SIGINT (which lets the orphaned
/// recorder write a playable file), force-kills if it lingers, removes an
/// unusable empty/partial output directory, and always clears the marker.
fn reap_orphaned_recordings_in(root: &Path) {
    let Some(marker) = read_active_recorder_marker(root) else {
        return;
    };
    let output_dir = active_marker_output_dir(root, &marker);
    let video_path = output_dir
        .as_deref()
        .and_then(|output_dir| active_marker_video_path(output_dir, &marker));

    #[cfg(target_os = "macos")]
    {
        if let Some(video_path) = video_path.as_deref() {
            let recorder_is_active = || recorder_process_is_active(marker.pid, video_path);
            if recorder_is_active() {
                // SAFETY: signals the recorder PID recorded by this app on start.
                let _ = unsafe { libc::kill(marker.pid as i32, libc::SIGINT) };
                let deadline = Instant::now() + Duration::from_secs(2);
                while Instant::now() < deadline && recorder_is_active() {
                    std::thread::sleep(Duration::from_millis(50));
                }
                if recorder_is_active() {
                    // SAFETY: same recorder PID; SIGKILL as a last resort.
                    let _ = unsafe { libc::kill(marker.pid as i32, libc::SIGKILL) };
                }
            }
        } else {
            clear_active_recorder_marker(root);
            return;
        }
    }

    // Keep a non-empty (possibly SIGINT-finalized) video; drop an unusable
    // empty/partial directory so orphans do not accumulate.
    let Some(output_dir) = output_dir else {
        clear_active_recorder_marker(root);
        return;
    };
    let Some(video_path) = video_path else {
        clear_active_recorder_marker(root);
        return;
    };
    let has_usable_video = fs::metadata(&video_path)
        .map(|metadata| metadata.len() > 0)
        .unwrap_or(false);
    if !has_usable_video {
        let _ = fs::remove_dir_all(&output_dir);
    }
    clear_active_recorder_marker(root);
}

/// Reap a recorder orphaned by a previous run. Call once during app setup.
pub fn reap_orphaned_recordings(app: &tauri::AppHandle) {
    if let Ok(root) = recording_output_root(app) {
        prune_recording_previews_for_output_root(&root);
        reap_orphaned_recordings_in(&root);
    }
}

fn marker_label(kind: &RecordingMarkerKind) -> &'static str {
    match kind {
        RecordingMarkerKind::Important => "Important step",
        RecordingMarkerKind::Varies => "This varies",
        RecordingMarkerKind::Ignore => "Ignore this",
        RecordingMarkerKind::Confirm => "Needs confirmation",
    }
}

fn clean_native_context_text(value: &str, max_chars: usize) -> Option<String> {
    let mut normalized = String::new();
    let mut previous_was_space = false;
    for character in value.trim().chars() {
        if character.is_whitespace() {
            if !previous_was_space && !normalized.is_empty() {
                normalized.push(' ');
                previous_was_space = true;
            }
        } else {
            normalized.push(character);
            previous_was_space = false;
        }
        if normalized.chars().count() >= max_chars {
            break;
        }
    }
    let cleaned = normalized.trim();
    (!cleaned.is_empty()).then(|| cleaned.to_string())
}

fn app_name_from_process_path(path: &str) -> Option<String> {
    let file_name = path
        .rsplit(['\\', '/'])
        .next()
        .map(str::trim)
        .filter(|name| !name.is_empty())?;
    let app_name = if file_name.to_ascii_lowercase().ends_with(".exe") {
        &file_name[..file_name.len().saturating_sub(4)]
    } else {
        file_name
    };
    clean_native_context_text(app_name, 80)
}

#[cfg(target_os = "windows")]
fn windows_process_app_name(process_id: u32) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };
    use windows::core::PWSTR;

    if process_id == 0 {
        return None;
    }
    let process =
        unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?;
    let mut buffer = vec![0u16; 32_768];
    let mut size = buffer.len() as u32;
    let result = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
    };
    let _ = unsafe { CloseHandle(process) };
    result.ok()?;
    if size == 0 {
        return None;
    }
    let path = String::from_utf16_lossy(&buffer[..size as usize]);
    app_name_from_process_path(&path)
}

fn frontmost_action_context() -> Option<NativeActionContext> {
    #[cfg(target_os = "macos")]
    {
        let script = r#"tell application "System Events"
  set frontApp to first application process whose frontmost is true
  set appName to name of frontApp
  set windowTitle to ""
  try
    set windowTitle to value of attribute "AXTitle" of window 1 of frontApp
  end try
  return appName & "\n" & windowTitle
end tell"#;
        let output = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(script)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut lines = stdout.lines();
        let app_name = clean_native_context_text(lines.next()?, 80)?;
        let window_title = lines
            .next()
            .and_then(|title| clean_native_context_text(title, 160));
        Some(NativeActionContext {
            source: NativeActionContextSource::Accessibility,
            app_name,
            window_title,
        })
    }

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        };

        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.0.is_null() {
            return None;
        }
        let text_len = unsafe { GetWindowTextLengthW(hwnd) };
        if text_len <= 0 {
            return None;
        }
        let mut buffer = vec![0u16; text_len as usize + 1];
        let copied = unsafe { GetWindowTextW(hwnd, &mut buffer) };
        if copied <= 0 {
            return None;
        }
        let window_title =
            clean_native_context_text(&String::from_utf16_lossy(&buffer[..copied as usize]), 160)?;
        let mut process_id = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut process_id)) };
        let app_name =
            windows_process_app_name(process_id).unwrap_or_else(|| "Windows app".to_string());
        Some(NativeActionContext {
            source: NativeActionContextSource::ForegroundWindow,
            app_name,
            window_title: Some(window_title),
        })
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        None
    }
}

fn selected_window_action_context(session: &RecordingSession) -> Option<NativeActionContext> {
    let selection = session.context.as_ref()?.capture_window.as_ref()?;
    let app_name = selection.app_name.trim();
    if app_name.is_empty() {
        return None;
    }
    Some(NativeActionContext {
        source: NativeActionContextSource::CaptureWindow,
        app_name: app_name.to_string(),
        window_title: (!selection.title.trim().is_empty())
            .then(|| selection.title.trim().to_string()),
    })
}

fn screen_action_context(session: &RecordingSession) -> Option<NativeActionContext> {
    matches!(session.target_kind, RecordingTargetKind::Screen).then(|| NativeActionContext {
        source: NativeActionContextSource::CaptureScreen,
        app_name: "Desktop".to_string(),
        window_title: None,
    })
}

fn recording_target_action_context(session: &RecordingSession) -> Option<NativeActionContext> {
    selected_window_action_context(session).or_else(|| screen_action_context(session))
}

fn recording_marker_action_context_for_session(
    session: &RecordingSession,
    fallback_context: Option<NativeActionContext>,
) -> Option<NativeActionContext> {
    if matches!(
        session.target_kind,
        RecordingTargetKind::Window | RecordingTargetKind::Browser
    ) {
        return selected_window_action_context(session);
    }
    fallback_context
}

fn recording_marker_action_context(
    active: &ActiveRecording,
    fallback_context: Option<NativeActionContext>,
) -> Option<NativeActionContext> {
    recording_marker_action_context_for_session(&active.session, fallback_context)
}

fn native_action_context_source(context: &NativeActionContext) -> &'static str {
    match context.source {
        NativeActionContextSource::Accessibility => "ax",
        #[cfg(target_os = "windows")]
        NativeActionContextSource::ForegroundWindow => "raw_input",
        NativeActionContextSource::CaptureWindow | NativeActionContextSource::CaptureScreen => {
            "raw_input"
        }
    }
}

fn native_action_context_target(context: &NativeActionContext) -> serde_json::Value {
    match context.source {
        NativeActionContextSource::Accessibility => json!({
            "role": "window",
            "name": context.window_title.as_deref().unwrap_or(&context.app_name),
            "selectors": [format!("app={}", context.app_name)]
        }),
        #[cfg(target_os = "windows")]
        NativeActionContextSource::ForegroundWindow => json!({
            "role": "window",
            "name": context.window_title.as_deref().unwrap_or(&context.app_name),
            "selectors": [format!("app={}", context.app_name)]
        }),
        NativeActionContextSource::CaptureWindow => json!({
            "role": "window",
            "name": "App window",
            "selectors": ["capture_window=selected"]
        }),
        NativeActionContextSource::CaptureScreen => json!({
            "role": "screen",
            "name": "Desktop",
            "selectors": ["capture_screen=visible_desktop"]
        }),
    }
}

fn native_focus_trace_event(
    t_ms: u64,
    context: &NativeActionContext,
    label: &str,
) -> serde_json::Value {
    json!({
        "tMs": t_ms,
        "type": "focus",
        "source": native_action_context_source(context),
        "confidence": 0.7,
        "target": native_action_context_target(context),
        "value": { "after": label },
        "redacted": false
    })
}

fn native_marker_trace_event(marker: &RecordingMarker) -> serde_json::Value {
    let mut event = json!({
        "tMs": marker.t_ms,
        "type": "marker",
        "source": marker
            .context
            .as_ref()
            .map(native_action_context_source)
            .unwrap_or("raw_input"),
        "confidence": 1.0,
        "markerKind": marker.kind,
        "value": { "after": marker_label(&marker.kind) },
        "redacted": false
    });
    if let Some(context) = &marker.context {
        event["target"] = native_action_context_target(context);
    }
    event
}

fn native_trace_events(
    session: &RecordingSession,
    markers: &[RecordingMarker],
    duration_ms: u64,
) -> Vec<serde_json::Value> {
    let mut events = Vec::new();
    if let Some(context) = recording_target_action_context(session) {
        events.push(native_focus_trace_event(0, &context, "Recording started"));
        events.push(native_focus_trace_event(
            duration_ms,
            &context,
            "Recording stopped",
        ));
    }
    events.extend(markers.iter().map(native_marker_trace_event));
    events.sort_by_key(|event| event["tMs"].as_u64().unwrap_or(0));
    events
}

fn write_native_trace(
    output_dir: &Path,
    session: &RecordingSession,
    markers: &[RecordingMarker],
    duration_ms: u64,
) -> Result<Option<(PathBuf, usize)>, String> {
    let events = native_trace_events(session, markers, duration_ms);
    if events.is_empty() {
        return Ok(None);
    }
    let path = output_dir.join("workflow-trace.json");
    let payload = json!({
        "version": 1,
        "source": "native_desktop",
        "truncated": false,
        "events": events
    });
    fs::write(
        &path,
        serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Failed to write marker trace: {error}"))?;
    Ok(Some((path, events.len())))
}

fn native_keyframe_file_name(index: usize, reason: &str) -> String {
    format!("workflow-keyframe-{index:02}-{reason}.png")
}

fn marker_keyframe_reason(kind: &RecordingMarkerKind) -> &'static str {
    match kind {
        RecordingMarkerKind::Important => "marker-important",
        RecordingMarkerKind::Varies => "marker-varies",
        RecordingMarkerKind::Ignore => "marker-ignore",
        RecordingMarkerKind::Confirm => "marker-confirm",
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
fn capture_xcap_keyframe_image(
    capture_window_platform_id: Option<u32>,
) -> Result<xcap::image::RgbaImage, String> {
    if let Some(platform_id) = capture_window_platform_id {
        #[cfg(target_os = "macos")]
        {
            return macos_capture_window_image(platform_id);
        }

        #[cfg(any(target_os = "windows", target_os = "linux"))]
        {
            let window = xcap_windows()?
                .into_iter()
                .find(|window| window.id().ok() == Some(platform_id))
                .ok_or_else(|| format!("Capture window not found: {platform_id}"))?;
            let summary = xcap_window_summary(&window)
                .ok_or_else(|| "Capture window is not visible.".to_string())?;
            if !summary.is_recordable {
                return Err("Capture window is minimized.".to_string());
            }
            return window
                .capture_image()
                .map_err(|error| format!("Failed to capture window keyframe: {error}"));
        }
    }

    let monitors = xcap::Monitor::all()
        .map_err(|error| format!("Failed to list capture monitors: {error}"))?;
    let monitor = monitors
        .iter()
        .find(|monitor| monitor.is_primary().unwrap_or(false))
        .or_else(|| monitors.first())
        .ok_or_else(|| "No capture monitor is available.".to_string())?;
    monitor
        .capture_image()
        .map_err(|error| format!("Failed to capture screen keyframe: {error}"))
}

fn capture_native_keyframe(
    output_dir: &Path,
    reason: &str,
    t_ms: u64,
    index: usize,
    capture_window_platform_id: Option<u32>,
) -> Option<NativeKeyframe> {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        let file_name = native_keyframe_file_name(index, reason);
        let path = output_dir.join(&file_name);
        let image = capture_xcap_keyframe_image(capture_window_platform_id).ok()?;
        image.save(&path).ok()?;
        let metadata = fs::metadata(&path).ok()?;
        if metadata.len() == 0 {
            let _ = fs::remove_file(&path);
            return None;
        }
        Some(NativeKeyframe {
            id: format!("keyframe-{index}"),
            t_ms,
            reason: reason.to_string(),
            mime_type: "image/png".to_string(),
            file_name,
            size_bytes: metadata.len(),
        })
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = output_dir;
        let _ = reason;
        let _ = t_ms;
        let _ = index;
        let _ = capture_window_platform_id;
        None
    }
}

fn write_native_keyframe_manifest(
    output_dir: &Path,
    frames: &[NativeKeyframe],
) -> Result<Option<PathBuf>, String> {
    if frames.is_empty() {
        return Ok(None);
    }
    let path = output_dir.join("workflow-keyframes.json");
    let payload = json!({
        "version": 1,
        "source": "native_desktop",
        "localOnly": true,
        "redactionStatus": "not_scanned",
        "note": "Raw frames are retained locally for review and are not forwarded in run payloads.",
        "frames": frames
    });
    fs::write(
        &path,
        serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Failed to write keyframe manifest: {error}"))?;
    Ok(Some(path))
}

fn recording_quality(
    session: &RecordingSession,
) -> (RecordingQualityStatus, Vec<RecordingQualityCheck>) {
    let mut checks = vec![
        if session.artifact_url.is_some() && session.size_bytes.unwrap_or(0) > 0 {
            RecordingQualityCheck {
                key: RecordingQualityCheckKey::Video,
                status: if session.max_video_height == 0 {
                    RecordingQualityCheckStatus::Warn
                } else {
                    RecordingQualityCheckStatus::Pass
                },
                label: "Video".to_string(),
                message: if session.max_video_height == 0 {
                    "Raw video artifact is present; 720p normalization was unavailable.".to_string()
                } else {
                    "720p video artifact is present.".to_string()
                },
            }
        } else {
            RecordingQualityCheck {
                key: RecordingQualityCheckKey::Video,
                status: RecordingQualityCheckStatus::Fail,
                label: "Video".to_string(),
                message: "No usable video artifact was produced.".to_string(),
            }
        },
        RecordingQualityCheck {
            key: RecordingQualityCheckKey::ActionTrace,
            status: RecordingQualityCheckStatus::Pass,
            label: "Trace".to_string(),
            message: if session.marker_count.unwrap_or(0) > 0 {
                "Explicit recording markers were captured.".to_string()
            } else if session.trace_event_count.unwrap_or(0) > 0 {
                "Native target context anchors were captured.".to_string()
            } else {
                "Native accessibility action trace was not requested.".to_string()
            },
        },
        if session
            .context
            .as_ref()
            .map(|context| context.include_microphone)
            .unwrap_or(false)
        {
            RecordingQualityCheck {
                key: RecordingQualityCheckKey::Transcript,
                status: RecordingQualityCheckStatus::Warn,
                label: "Transcript".to_string(),
                message: "Native microphone audio may be present in the video, but transcript generation is pending.".to_string(),
            }
        } else {
            RecordingQualityCheck {
                key: RecordingQualityCheckKey::Transcript,
                status: RecordingQualityCheckStatus::Pass,
                label: "Transcript".to_string(),
                message: "Microphone transcript was not requested.".to_string(),
            }
        },
        if session.target_label.trim().is_empty() {
            RecordingQualityCheck {
                key: RecordingQualityCheckKey::Target,
                status: RecordingQualityCheckStatus::Warn,
                label: "Target".to_string(),
                message: "Recording target identity is incomplete.".to_string(),
            }
        } else {
            RecordingQualityCheck {
                key: RecordingQualityCheckKey::Target,
                status: RecordingQualityCheckStatus::Pass,
                label: "Target".to_string(),
                message: "Recording target is identified.".to_string(),
            }
        },
    ];

    if let Some(stats) = &session.capture_stats {
        let encoded = stats.frames_encoded.unwrap_or(1);
        let errors = stats.encode_error_count.unwrap_or(0);
        checks.push(if encoded == 0 {
            RecordingQualityCheck {
                key: RecordingQualityCheckKey::CaptureHealth,
                status: RecordingQualityCheckStatus::Fail,
                label: "Capture".to_string(),
                message: format!(
                    "The {} backend did not encode any video frames.",
                    stats.backend
                ),
            }
        } else if errors > 0 {
            RecordingQualityCheck {
                key: RecordingQualityCheckKey::CaptureHealth,
                status: RecordingQualityCheckStatus::Warn,
                label: "Capture".to_string(),
                message: format!(
                    "The {} backend reported {} encode error(s).",
                    stats.backend, errors
                ),
            }
        } else {
            RecordingQualityCheck {
                key: RecordingQualityCheckKey::CaptureHealth,
                status: RecordingQualityCheckStatus::Pass,
                label: "Capture".to_string(),
                message: format!("The {} backend reported a usable capture.", stats.backend),
            }
        });
    }

    let status = if checks
        .iter()
        .any(|check| matches!(check.status, RecordingQualityCheckStatus::Fail))
    {
        RecordingQualityStatus::Retry
    } else if checks
        .iter()
        .any(|check| matches!(check.status, RecordingQualityCheckStatus::Warn))
    {
        RecordingQualityStatus::NeedsReview
    } else {
        RecordingQualityStatus::Ready
    };
    checks.shrink_to_fit();
    (status, checks)
}

fn write_recording_metadata(
    output_dir: &Path,
    session: &RecordingSession,
) -> Result<PathBuf, String> {
    let path = output_dir.join("workflow-metadata.json");
    let payload = json!({
        "version": 1,
        "source": "native_desktop",
        "session": {
            "id": session.id,
            "targetKind": session.target_kind,
            "targetLabel": session.target_label,
            "startedAtMs": session.started_at_ms,
            "maxVideoHeight": session.max_video_height
        },
        "capture": {
            "mimeType": session.mime_type,
            "sizeBytes": session.size_bytes,
            "stats": session.capture_stats,
            "traceEventCount": session.trace_event_count,
            "traceTruncated": session.trace_truncated,
            "markerCount": session.marker_count,
            "redactedEventCount": session.redacted_event_count,
            "transcriptSegmentCount": session.transcript_segment_count,
            "keyframeCount": session.keyframe_count
        },
        "context": session.context,
        "quality": {
            "status": session.quality_status,
            "checks": session.quality_checks
        }
    });
    fs::write(
        &path,
        serde_json::to_vec_pretty(&payload).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Failed to write recording metadata: {error}"))?;
    Ok(path)
}

#[tauri::command]
pub async fn recording_list_targets() -> Result<Vec<RecordingTarget>, String> {
    Ok(recording_targets())
}

#[tauri::command]
pub async fn recording_list_capture_windows() -> Result<Vec<RecordingCaptureWindow>, String> {
    list_capture_windows()
}

#[tauri::command]
pub async fn recording_capture_window_preview(
    app: tauri::AppHandle,
    window_id: String,
) -> Result<RecordingCaptureWindowPreview, String> {
    capture_window_preview(&app, &window_id)
}

#[tauri::command]
pub async fn recording_clear_window_previews(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(root) = recording_preview_root_if_exists(&app)? {
        prune_recording_previews(&root);
    }
    Ok(())
}

#[tauri::command]
pub async fn recording_check_permissions() -> Result<RecordingPermissionPreflight, String> {
    Ok(recording_permission_preflight())
}

#[tauri::command]
pub async fn recording_request_permission(
    key: RecordingPermissionKey,
) -> Result<RecordingPermissionPreflight, String> {
    request_recording_permission(key)
}

#[tauri::command]
pub async fn recording_open_permission_settings(key: RecordingPermissionKey) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = format!(
            "x-apple.systempreferences:com.apple.preference.security?{}",
            permission_settings_pane(&key)
        );
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|error| format!("Failed to open System Settings: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = key;
        Err("Opening capture permission settings is only supported on macOS.".to_string())
    }
}

#[tauri::command]
pub async fn recording_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecordingState>,
    request: RecordingStartRequest,
) -> Result<RecordingSession, String> {
    {
        let mut slot = state
            .active
            .lock()
            .map_err(|_| "recording state poisoned")?;
        match *slot {
            RecordingSlot::Idle => *slot = RecordingSlot::Starting,
            RecordingSlot::Starting | RecordingSlot::Active(_) => {
                return Err("A workflow recording is already active.".to_string());
            }
        }
    }

    // Reservation acquired; run the blocking capture/spawn work without holding
    // the state lock so concurrent IPC stays responsive. Any failure must
    // release the `Starting` reservation back to `Idle`.
    let started = build_active_recording(&app, request);
    let mut slot = state
        .active
        .lock()
        .map_err(|_| "recording state poisoned")?;
    match started {
        Ok(active) => {
            let session = active.session.clone();
            *slot = RecordingSlot::Active(active);
            Ok(session)
        }
        Err(error) => {
            *slot = RecordingSlot::Idle;
            Err(error)
        }
    }
}

/// Perform the blocking start work (directory creation, start keyframe capture,
/// backend spawn, marker write) outside the state lock. On any error the freshly
/// created output directory is removed so empty recording folders do not
/// accumulate, mirroring the prior in-lock behavior.
fn build_active_recording(
    app: &tauri::AppHandle,
    request: RecordingStartRequest,
) -> Result<ActiveRecording, String> {
    validate_recording_start_request(&request)?;
    ensure_native_recording_permissions(&request)?;

    let id = format!("recording-{}", Uuid::new_v4());
    let output_root = recording_output_root(app)?;
    let output_dir = recording_output_dir(&output_root, &id);
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("Failed to create recording output directory: {error}"))?;
    let session = build_recording_session(&request, id, &output_dir);
    let capture_window_platform_id = request_capture_window_platform_id(&request)?;
    let keyframes = capture_native_keyframe(&output_dir, "start", 0, 1, capture_window_platform_id)
        .into_iter()
        .collect::<Vec<_>>();
    let backend = match start_native_recording_backend(app, &request, &output_dir) {
        Ok(backend) => backend,
        Err(error) => {
            // The recorder never started, so the freshly created output
            // directory holds no artifacts. Remove it to avoid accumulating
            // empty recording folders on repeated start failures.
            let _ = fs::remove_dir_all(&output_dir);
            return Err(error);
        }
    };
    if let Some((pid, video_path)) = native_backend_marker_fields(&backend) {
        let _ = write_active_recorder_marker(
            &output_root,
            &ActiveRecorderMarker {
                pid,
                recording_id: session.id.clone(),
                output_dir: output_dir.to_string_lossy().into_owned(),
                video_path: video_path.to_string_lossy().into_owned(),
                started_at_ms: session.started_at_ms,
            },
        );
    }
    Ok(ActiveRecording {
        session,
        backend,
        markers: Vec::new(),
        next_keyframe_index: keyframes.len() + 1,
        keyframes,
        capture_window_platform_id,
        started_instant: Instant::now(),
    })
}

#[tauri::command]
pub async fn recording_stop(
    state: tauri::State<'_, RecordingState>,
) -> Result<Option<RecordingSession>, String> {
    let active = {
        let mut slot = state
            .active
            .lock()
            .map_err(|_| "recording state poisoned")?;
        match std::mem::replace(&mut *slot, RecordingSlot::Idle) {
            RecordingSlot::Active(active) => active,
            // A stop racing an in-flight start must not discard the start; put
            // the reservation back so `recording_start` can still publish it.
            RecordingSlot::Starting => {
                *slot = RecordingSlot::Starting;
                return Ok(None);
            }
            RecordingSlot::Idle => return Ok(None),
        }
    };
    let active_output_dir = active.session.output_dir.clone();

    // Snapshot the recording duration BEFORE finalizing. On macOS finalize
    // waits on SIGINT and runs avconvert, so taking it afterward would skew the
    // stop keyframe/trace timestamps toward finalize time, not recording end.
    let duration_ms = elapsed_marker_ms(active.started_instant);

    let artifacts = match stop_native_recording_backend(active.backend) {
        Ok(artifacts) => {
            clear_active_recorder_marker_for_output_dir(active_output_dir.as_deref());
            artifacts
        }
        Err(error) => {
            clear_active_recorder_marker_for_output_dir(active_output_dir.as_deref());
            // A failed finalize means no usable video was produced, so the
            // output directory only holds an empty/partial artifact. Remove it
            // rather than accumulating dead recording folders.
            if let Some(output_dir) = active.session.output_dir.as_deref() {
                let _ = fs::remove_dir_all(output_dir);
            }
            return Err(error);
        }
    };
    let mut session = active.session;
    // The video is finalized on disk. From here, sidecar/metadata writes are
    // best-effort: a tiny JSON write failure (e.g. disk full) must not discard a
    // perfectly good recording, so each falls back to its default on error.
    session.artifact_url = Some(file_url(&artifacts.video_path)?);
    session.mime_type = Some(artifacts.mime_type);
    session.size_bytes = Some(artifacts.size_bytes);
    session.capture_stats = artifacts.capture_stats;
    if !artifacts.normalized {
        session.max_video_height = 0;
    }
    session.marker_count = Some(active.markers.len() as u64);
    session.redacted_event_count = Some(0);
    session.trace_event_count = Some(0);
    session.trace_truncated = Some(false);
    match write_native_trace(
        &artifacts.output_dir,
        &session,
        &active.markers,
        duration_ms,
    ) {
        Ok(Some((trace_path, trace_event_count))) => match file_url(&trace_path) {
            Ok(url) => {
                session.trace_artifact_url = Some(url);
                session.trace_event_count = Some(trace_event_count as u64);
            }
            Err(error) => log::warn!("Failed to resolve recording trace URL: {error}"),
        },
        Ok(None) => {}
        Err(error) => log::warn!("Failed to write recording trace: {error}"),
    }
    session.transcript_segment_count = Some(0);
    let mut keyframes = active.keyframes;
    if active.next_keyframe_index <= MAX_NATIVE_KEYFRAMES {
        if let Some(stop_frame) = capture_native_keyframe(
            &artifacts.output_dir,
            "stop",
            duration_ms,
            active.next_keyframe_index,
            active.capture_window_platform_id,
        ) {
            keyframes.push(stop_frame);
        }
    }
    session.keyframe_count = Some(0);
    match write_native_keyframe_manifest(&artifacts.output_dir, &keyframes) {
        Ok(Some(keyframe_path)) => match file_url(&keyframe_path) {
            Ok(url) => {
                session.keyframe_artifact_url = Some(url);
                session.keyframe_count = Some(keyframes.len() as u64);
            }
            Err(error) => log::warn!("Failed to resolve recording keyframe URL: {error}"),
        },
        Ok(None) => {}
        Err(error) => log::warn!("Failed to write recording keyframe manifest: {error}"),
    }
    let (quality_status, quality_checks) = recording_quality(&session);
    session.quality_status = Some(quality_status);
    session.quality_checks = Some(quality_checks);
    match write_recording_metadata(&artifacts.output_dir, &session) {
        Ok(metadata_path) => match file_url(&metadata_path) {
            Ok(url) => session.metadata_artifact_url = Some(url),
            Err(error) => log::warn!("Failed to resolve recording metadata URL: {error}"),
        },
        Err(error) => log::warn!("Failed to write recording metadata: {error}"),
    }
    Ok(Some(session))
}

#[tauri::command]
pub async fn recording_add_marker(
    state: tauri::State<'_, RecordingState>,
    kind: RecordingMarkerKind,
) -> Result<(), String> {
    let (recording_id, needs_frontmost_context) = {
        let slot = state
            .active
            .lock()
            .map_err(|_| "recording state poisoned")?;
        let RecordingSlot::Active(active) = &*slot else {
            return Err("No workflow recording is active.".to_string());
        };
        (
            active.session.id.clone(),
            !matches!(active.session.target_kind, RecordingTargetKind::Window),
        )
    };
    let fallback_context = if needs_frontmost_context {
        frontmost_action_context()
    } else {
        None
    };
    let pending_keyframe = {
        let mut slot = state
            .active
            .lock()
            .map_err(|_| "recording state poisoned")?;
        let RecordingSlot::Active(active) = &mut *slot else {
            return Err("No workflow recording is active.".to_string());
        };
        if active.session.id != recording_id {
            return Err("No workflow recording is active.".to_string());
        }
        let context = recording_marker_action_context(active, fallback_context);
        let t_ms = elapsed_marker_ms(active.started_instant);
        active.markers.push(RecordingMarker {
            t_ms,
            kind: kind.clone(),
            context,
        });
        if active.next_keyframe_index < MAX_NATIVE_KEYFRAMES {
            active.session.output_dir.as_deref().map(|output_dir| {
                let index = active.next_keyframe_index;
                active.next_keyframe_index += 1;
                (
                    active.session.id.clone(),
                    PathBuf::from(output_dir),
                    marker_keyframe_reason(&kind).to_string(),
                    t_ms,
                    index,
                    active.capture_window_platform_id,
                )
            })
        } else {
            None
        }
    };

    if let Some((recording_id, output_dir, reason, t_ms, index, capture_window_platform_id)) =
        pending_keyframe
    {
        if let Some(frame) = capture_native_keyframe(
            &output_dir,
            &reason,
            t_ms,
            index,
            capture_window_platform_id,
        ) {
            let mut slot = state
                .active
                .lock()
                .map_err(|_| "recording state poisoned")?;
            match &mut *slot {
                RecordingSlot::Active(active)
                    if active.session.id == recording_id
                        && active.keyframes.len() < MAX_NATIVE_KEYFRAMES =>
                {
                    active.keyframes.push(frame);
                }
                _ => {
                    let _ = fs::remove_file(output_dir.join(&frame.file_name));
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRecordingSummary {
    pub id: String,
    pub output_dir: String,
    pub video_url: Option<String>,
    pub size_bytes: Option<u64>,
    pub started_at_ms: Option<i64>,
    pub target_kind: Option<String>,
    pub target_label: Option<String>,
    pub keyframe_count: Option<u64>,
    pub capture_stats: Option<RecordingCaptureStats>,
    pub has_metadata: bool,
}

fn local_recording_metadata_summary(
    metadata_path: &Path,
) -> (
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<u64>,
    Option<RecordingCaptureStats>,
    bool,
) {
    let Ok(bytes) = fs::read(metadata_path) else {
        return (None, None, None, None, None, false);
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return (None, None, None, None, None, false);
    };
    let started_at_ms = value["session"]["startedAtMs"].as_i64();
    let target_kind = value["session"]["targetKind"]
        .as_str()
        .map(|kind| kind.to_string());
    let target_label = value["session"]["targetLabel"]
        .as_str()
        .map(|label| label.to_string());
    let keyframe_count = value["capture"]["keyframeCount"].as_u64();
    let capture_stats =
        serde_json::from_value::<RecordingCaptureStats>(value["capture"]["stats"].clone()).ok();
    (
        started_at_ms,
        target_kind,
        target_label,
        keyframe_count,
        capture_stats,
        true,
    )
}

/// True only for a real on-disk directory (not a symlink), matching the
/// listing's `file_type().is_dir()` check so delete/reveal cannot follow a
/// planted `recording-*` symlink that the listing would have skipped.
fn is_real_recording_dir(dir: &Path) -> bool {
    fs::symlink_metadata(dir)
        .map(|metadata| metadata.file_type().is_dir())
        .unwrap_or(false)
}

fn local_recording_video_path(dir: &Path) -> PathBuf {
    let normalized = dir.join("workflow-recording-720p.m4v");
    if normalized.is_file() {
        normalized
    } else if dir.join("workflow-recording.avi").is_file() {
        dir.join("workflow-recording.avi")
    } else {
        dir.join("workflow-recording.mov")
    }
}

fn list_local_recordings_in(root: &Path) -> Vec<LocalRecordingSummary> {
    let mut recordings = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return recordings;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Some(id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if validate_local_recording_id(id).is_err() || !path_is_direct_child_of(root, &path) {
            continue;
        }
        let video_path = local_recording_video_path(&path);
        let (size_bytes, video_url) = match fs::metadata(&video_path) {
            Ok(metadata) => (Some(metadata.len()), file_url(&video_path).ok()),
            Err(_) => (None, None),
        };
        let (started_at_ms, target_kind, target_label, keyframe_count, capture_stats, has_metadata) =
            local_recording_metadata_summary(&path.join("workflow-metadata.json"));
        recordings.push(LocalRecordingSummary {
            id: id.to_string(),
            output_dir: path.to_string_lossy().into_owned(),
            video_url,
            size_bytes,
            started_at_ms,
            target_kind,
            target_label,
            keyframe_count,
            capture_stats,
            has_metadata,
        });
    }
    recordings.sort_by(|a, b| b.started_at_ms.cmp(&a.started_at_ms).then(b.id.cmp(&a.id)));
    recordings
}

fn validate_local_recording_id(id: &str) -> Result<(), String> {
    let suffix = id.strip_prefix("recording-").unwrap_or_default();
    let valid = !suffix.is_empty()
        && id == id.trim()
        && suffix
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-');
    if valid {
        Ok(())
    } else {
        Err(format!("Invalid recording id: {id}"))
    }
}

#[tauri::command]
pub async fn recording_list_local(
    app: tauri::AppHandle,
) -> Result<Vec<LocalRecordingSummary>, String> {
    let root = recording_output_root(&app)?;
    Ok(list_local_recordings_in(&root))
}

#[tauri::command]
pub async fn recording_delete_local(
    app: tauri::AppHandle,
    state: tauri::State<'_, RecordingState>,
    id: String,
) -> Result<(), String> {
    validate_local_recording_id(&id)?;
    {
        let slot = state
            .active
            .lock()
            .map_err(|_| "recording state poisoned")?;
        if let RecordingSlot::Active(active) = &*slot {
            if active.session.id == id {
                return Err("Stop the active recording before deleting it.".to_string());
            }
        }
    }
    let root = recording_output_root(&app)?;
    let dir = root.join(&id);
    if !path_is_direct_child_of(&root, &dir) {
        return Err("Recording is outside the recordings directory.".to_string());
    }
    if !is_real_recording_dir(&dir) {
        return Err(format!("Recording not found: {id}"));
    }
    fs::remove_dir_all(&dir).map_err(|error| format!("Failed to delete recording: {error}"))
}

#[tauri::command]
pub async fn recording_reveal_local(app: tauri::AppHandle, id: String) -> Result<(), String> {
    validate_local_recording_id(&id)?;
    let root = recording_output_root(&app)?;
    let dir = root.join(&id);
    if !path_is_direct_child_of(&root, &dir) {
        return Err("Recording is outside the recordings directory.".to_string());
    }
    if !is_real_recording_dir(&dir) {
        return Err(format!("Recording not found: {id}"));
    }

    #[cfg(target_os = "macos")]
    {
        let video_path = local_recording_video_path(&dir);
        let target = if video_path.is_file() {
            video_path
        } else {
            dir
        };
        Command::new("/usr/bin/open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map_err(|error| format!("Failed to reveal recording: {error}"))?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Revealing recordings in the file manager is only supported on macOS.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn start_request(
        target_id: &str,
        target_kind: RecordingRequestTargetKind,
    ) -> RecordingStartRequest {
        RecordingStartRequest {
            target_id: target_id.to_string(),
            target_kind,
            capture_window_id: None,
            capture_window: None,
            prep: RecordingPrep {
                goal: "Submit an invoice".to_string(),
                success_state: "Invoice is accepted".to_string(),
                variable_inputs: "Invoice PDF".to_string(),
                preferences: "Use defaults".to_string(),
                tos_acknowledged: true,
            },
            include_microphone: true,
            include_camera: false,
            executable_upgrade: true,
        }
    }

    #[test]
    fn recording_target_serializes_to_frontend_shape() {
        let target = RecordingTarget {
            id: "browser".to_string(),
            kind: RecordingTargetKind::Browser,
            label: "Browser".to_string(),
            detail: "Capture a browser workflow.".to_string(),
            is_available: true,
            capabilities: vec![RecordingCapability::Video, RecordingCapability::Cursor],
            limitations: vec!["Browser recording uses native capture.".to_string()],
        };

        let value = serde_json::to_value(target).expect("serialize target");

        assert_eq!(
            value,
            json!({
                "id": "browser",
                "kind": "browser",
                "label": "Browser",
                "detail": "Capture a browser workflow.",
                "isAvailable": true,
                "capabilities": ["video", "cursor"],
                "limitations": ["Browser recording uses native capture."]
            })
        );
    }

    #[test]
    fn recording_targets_separate_preview_support_from_video_backend() {
        let targets = recording_targets();
        let screen = targets
            .iter()
            .find(|target| target.id == "screen")
            .expect("screen target");
        let window = targets
            .iter()
            .find(|target| target.id == "window")
            .expect("window target");
        let browser = targets
            .iter()
            .find(|target| target.id == "browser")
            .expect("browser target");

        assert_eq!(
            screen.is_available,
            cfg!(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux"
            ))
        );
        assert_eq!(
            window.is_available,
            cfg!(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux"
            ))
        );
        assert!(window.capabilities.contains(&RecordingCapability::Video));
        assert!(window.capabilities.contains(&RecordingCapability::Cursor));
        assert_eq!(browser.is_available, screen.is_available);
        assert!(browser.capabilities.contains(&RecordingCapability::Video));
        assert!(browser.capabilities.contains(&RecordingCapability::Cursor));
        assert!(
            !browser
                .capabilities
                .contains(&RecordingCapability::ActionTrace)
        );
        assert!(
            browser
                .limitations
                .iter()
                .any(|limitation| limitation.contains("native video"))
        );
        assert!(!browser.limitations.iter().any(
            |limitation| limitation.contains("DOM tracing") || limitation.contains("extension")
        ));
        assert_eq!(
            window
                .capabilities
                .contains(&RecordingCapability::Microphone),
            cfg!(target_os = "macos")
        );
        assert!(
            !window
                .capabilities
                .contains(&RecordingCapability::Transcript)
        );
        if cfg!(any(target_os = "windows", target_os = "linux")) {
            assert!(
                window
                    .limitations
                    .iter()
                    .any(|limitation| limitation.contains("frame capture backend"))
            );
        }
    }

    #[test]
    fn capture_window_candidates_exclude_non_app_system_windows() {
        assert!(!is_capture_window_candidate("", 800, 600));
        assert!(!is_capture_window_candidate("Preview App", 0, 600));
        assert!(!is_capture_window_candidate("Preview App", 800, 0));
        assert!(is_capture_window_candidate("Preview App", 800, 600));
        assert!(is_browser_capture_app("Google Chrome"));
        assert!(is_browser_capture_app("Microsoft Edge"));
        assert!(is_browser_capture_app("Safari"));
        assert!(!is_browser_capture_app("Preview App"));

        if cfg!(target_os = "macos") {
            assert!(!is_capture_window_candidate("Control Center", 120, 60));
            assert!(!is_capture_window_candidate("loginwindow", 1728, 1117));
            assert!(!is_capture_window_candidate(
                "Notification Center",
                320,
                240
            ));
        } else {
            assert!(is_capture_window_candidate("Control Center", 120, 60));
        }
    }

    #[test]
    fn capture_window_summary_merge_prefers_primary_backend_by_platform_id() {
        let primary = RecordingCaptureWindow {
            id: "100".to_string(),
            platform_id: 100,
            pid: 10,
            app_name: "Firefox".to_string(),
            title: "Primary".to_string(),
            bounds: RecordingCaptureWindowBounds {
                x: 0,
                y: 0,
                width: 1200,
                height: 800,
            },
            is_focused: true,
            is_minimized: false,
            is_recordable: true,
        };
        let duplicate_fallback = RecordingCaptureWindow {
            title: "Fallback duplicate".to_string(),
            ..primary.clone()
        };
        let fallback_only = RecordingCaptureWindow {
            id: "200".to_string(),
            platform_id: 200,
            pid: 20,
            app_name: "Notes".to_string(),
            title: "Fallback".to_string(),
            bounds: RecordingCaptureWindowBounds {
                x: 10,
                y: 10,
                width: 640,
                height: 480,
            },
            is_focused: false,
            is_minimized: false,
            is_recordable: true,
        };

        let merged = merge_capture_window_summaries(
            vec![primary.clone()],
            vec![duplicate_fallback, fallback_only.clone()],
        );

        assert_eq!(merged, vec![primary, fallback_only]);
    }

    #[test]
    fn recording_permission_preflight_serializes_to_frontend_shape() {
        let preflight = recording_permission_preflight_for_statuses(
            "macos",
            RecordingPermissionStatus::Granted,
            RecordingPermissionStatus::Unknown,
            RecordingPermissionStatus::Unsupported,
            RecordingPermissionStatus::Prompt,
        );

        let value = serde_json::to_value(preflight).expect("serialize permission preflight");

        assert_eq!(
            value,
            json!({
                "platform": "macos",
                "checks": [
                    {
                        "key": "screen_recording",
                        "status": "granted",
                        "label": "Screen recording",
                        "message": "Screen recording permission is granted.",
                        "canRequest": false,
                        "requiredFor": ["screen", "window", "browser"]
                    },
                    {
                        "key": "microphone",
                        "status": "unknown",
                        "label": "Microphone",
                        "message": "Permission state will be checked by the platform capture backend before microphone capture.",
                        "canRequest": false,
                        "requiredFor": ["screen", "window", "browser"]
                    },
                    {
                        "key": "camera",
                        "status": "unsupported",
                        "label": "Camera",
                        "message": "Camera capture is not available for workflow recording targets yet.",
                        "canRequest": false,
                        "requiredFor": []
                    },
                    {
                        "key": "accessibility",
                        "status": "prompt",
                        "label": "Accessibility",
                        "message": "Grant Accessibility access in System Settings before executable capture.",
                        "canRequest": true,
                        "requiredFor": []
                    }
                ]
            })
        );
    }

    #[test]
    fn permission_requestability_is_scoped_to_supported_native_prompts() {
        assert!(permission_can_request(
            "macos",
            &RecordingPermissionKey::ScreenRecording,
            &RecordingPermissionStatus::Prompt
        ));
        assert!(permission_can_request(
            "macos",
            &RecordingPermissionKey::Accessibility,
            &RecordingPermissionStatus::Denied
        ));
        assert!(!permission_can_request(
            "macos",
            &RecordingPermissionKey::Microphone,
            &RecordingPermissionStatus::Prompt
        ));
        assert!(!permission_can_request(
            "linux",
            &RecordingPermissionKey::Accessibility,
            &RecordingPermissionStatus::Prompt
        ));
        assert!(!permission_can_request(
            "macos",
            &RecordingPermissionKey::Accessibility,
            &RecordingPermissionStatus::Granted
        ));
    }

    #[test]
    fn window_listing_requires_screen_recording_permission() {
        assert!(ensure_window_listing_permission(RecordingPermissionStatus::Granted).is_ok());
        let error = ensure_window_listing_permission(RecordingPermissionStatus::Prompt)
            .expect_err("prompt status should block window enumeration");

        assert!(error.contains("Grant Screen Recording access"));
        assert!(error.contains("restart"));
        assert!(error.contains("Seren"));
    }

    #[test]
    fn permission_settings_pane_targets_each_privacy_section() {
        assert_eq!(
            permission_settings_pane(&RecordingPermissionKey::ScreenRecording),
            "Privacy_ScreenCapture"
        );
        assert_eq!(
            permission_settings_pane(&RecordingPermissionKey::Microphone),
            "Privacy_Microphone"
        );
        assert_eq!(
            permission_settings_pane(&RecordingPermissionKey::Camera),
            "Privacy_Camera"
        );
        assert_eq!(
            permission_settings_pane(&RecordingPermissionKey::Accessibility),
            "Privacy_Accessibility"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_permission_status_maps_preflight_booleans() {
        assert_eq!(
            macos_permission_status(true),
            RecordingPermissionStatus::Granted
        );
        assert_eq!(
            macos_permission_status(false),
            RecordingPermissionStatus::Prompt
        );
    }

    #[test]
    fn recording_start_request_deserializes_from_frontend_shape() {
        let request: RecordingStartRequest = serde_json::from_value(json!({
            "targetId": "screen",
            "targetKind": "screen",
            "prep": {
                "goal": "Submit an invoice",
                "successState": "Invoice is accepted",
                "variableInputs": "Invoice PDF",
                "preferences": "Use defaults",
                "tosAcknowledged": true
            },
            "includeMicrophone": true,
            "includeCamera": false,
            "executableUpgrade": true
        }))
        .expect("deserialize request");

        assert_eq!(request.target_id, "screen");
        assert!(matches!(
            request.target_kind,
            RecordingRequestTargetKind::Screen
        ));
        assert_eq!(request.prep.goal, "Submit an invoice");
        assert_eq!(request.prep.success_state, "Invoice is accepted");
        assert_eq!(request.prep.variable_inputs, "Invoice PDF");
        assert_eq!(request.prep.preferences, "Use defaults");
        assert!(request.prep.tos_acknowledged);
        assert!(request.include_microphone);
        assert!(!request.include_camera);
        assert!(request.executable_upgrade);
        assert_eq!(request.capture_window_id, None);
        assert_eq!(request.capture_window, None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_screencapture_args_scope_window_recordings() {
        let video_path = Path::new("/tmp/workflow-recording.mov");
        let mut screen_request = start_request("screen", RecordingRequestTargetKind::Screen);
        screen_request.executable_upgrade = false;
        let screen_args = macos_screencapture_video_args(&screen_request, video_path)
            .expect("screen args")
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            screen_args,
            vec!["-v", "-x", "-C", "-k", "-g", "/tmp/workflow-recording.mov"]
        );

        let mut window_request = start_request("window", RecordingRequestTargetKind::Window);
        window_request.executable_upgrade = false;
        window_request.capture_window_id = Some("123".to_string());
        let window_args = macos_screencapture_video_args(&window_request, video_path)
            .expect("window args")
            .into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            window_args,
            vec![
                "-v",
                "-x",
                "-C",
                "-k",
                "-l",
                "123",
                "-g",
                "/tmp/workflow-recording.mov"
            ]
        );
    }

    #[test]
    fn recording_start_request_validation_rejects_unavailable_target() {
        let mut request = start_request("screen", RecordingRequestTargetKind::Screen);
        request.executable_upgrade = false;

        let target = RecordingTarget {
            id: "screen".to_string(),
            kind: RecordingTargetKind::Screen,
            label: "Full screen".to_string(),
            detail: "Capture the visible desktop with the native recorder.".to_string(),
            is_available: false,
            capabilities: vec![
                RecordingCapability::Video,
                RecordingCapability::Microphone,
                RecordingCapability::Cursor,
            ],
            limitations: vec![],
        };

        let err = validate_recording_start_request_against_targets(&request, &[target])
            .expect_err("target unavailable");

        assert_eq!(
            err,
            "Workflow recording target is not available: Full screen."
        );
    }

    #[test]
    fn recording_start_request_validation_rejects_unknown_target() {
        let request = start_request("missing", RecordingRequestTargetKind::Screen);

        let err = validate_recording_start_request(&request).expect_err("target unknown");

        assert_eq!(err, "Unknown workflow recording target.");
    }

    #[test]
    fn recording_start_request_validation_rejects_kind_mismatch() {
        let request = start_request("screen", RecordingRequestTargetKind::Browser);

        let err = validate_recording_start_request(&request).expect_err("target kind mismatch");

        assert_eq!(
            err,
            "Workflow recording target kind does not match the selected target."
        );
    }

    #[test]
    fn recording_start_request_validation_rejects_unsupported_capabilities() {
        let mut target = recording_targets()
            .into_iter()
            .find(|target| target.id == "screen")
            .expect("screen target");
        target.is_available = true;

        let mut camera_request = start_request("screen", RecordingRequestTargetKind::Screen);
        camera_request.include_microphone = false;
        camera_request.include_camera = true;
        camera_request.executable_upgrade = false;
        let err =
            validate_recording_start_request_against_targets(&camera_request, &[target.clone()])
                .expect_err("camera unsupported");
        assert_eq!(
            err,
            "Workflow recording target does not support camera capture."
        );

        let mut trace_request = start_request("screen", RecordingRequestTargetKind::Screen);
        trace_request.include_microphone = false;
        let err =
            validate_recording_start_request_against_targets(&trace_request, &[target.clone()])
                .expect_err("trace unsupported");
        assert_eq!(
            err,
            "Workflow recording target does not support executable action tracing."
        );

        target
            .capabilities
            .retain(|capability| *capability != RecordingCapability::Microphone);
        let mut microphone_request = start_request("screen", RecordingRequestTargetKind::Screen);
        microphone_request.executable_upgrade = false;
        let err = validate_recording_start_request_against_targets(&microphone_request, &[target])
            .expect_err("microphone unsupported");
        assert_eq!(
            err,
            "Workflow recording target does not support microphone capture."
        );
    }

    #[test]
    fn recording_start_request_validation_requires_browser_window_selection() {
        let Some(mut browser) = recording_targets()
            .into_iter()
            .find(|target| target.id == "browser")
        else {
            panic!("browser target");
        };
        browser.is_available = true;
        browser.capabilities = vec![RecordingCapability::Video, RecordingCapability::Cursor];
        let mut request = start_request("browser", RecordingRequestTargetKind::Browser);
        request.include_microphone = false;
        request.executable_upgrade = false;

        let err = validate_recording_start_request_against_targets(&request, &[browser.clone()])
            .expect_err("missing browser window");
        assert_eq!(err, "Select a browser window before recording.");

        request.capture_window_id = Some("123".to_string());
        request.capture_window = Some(RecordingCaptureWindowSelection {
            id: "123".to_string(),
            app_name: "Preview App".to_string(),
            title: "Workflow".to_string(),
            bounds: RecordingCaptureWindowBounds {
                x: 10,
                y: 20,
                width: 640,
                height: 480,
            },
        });
        let err = validate_recording_start_request_against_targets(&request, &[browser.clone()])
            .expect_err("not a browser window");
        assert_eq!(err, "Select a browser window before recording.");

        request.capture_window = Some(RecordingCaptureWindowSelection {
            id: "123".to_string(),
            app_name: "Google Chrome".to_string(),
            title: "Workflow".to_string(),
            bounds: RecordingCaptureWindowBounds {
                x: 10,
                y: 20,
                width: 640,
                height: 480,
            },
        });
        assert!(validate_recording_start_request_against_targets(&request, &[browser]).is_ok());
    }

    #[test]
    fn recording_start_request_validation_requires_window_selection() {
        let target = RecordingTarget {
            id: "window".to_string(),
            kind: RecordingTargetKind::Window,
            label: "App window".to_string(),
            detail: "Capture one app window.".to_string(),
            is_available: true,
            capabilities: vec![RecordingCapability::Video],
            limitations: Vec::new(),
        };
        let mut request = start_request("window", RecordingRequestTargetKind::Window);
        request.include_microphone = false;
        request.executable_upgrade = false;

        let err = validate_recording_start_request_against_targets(&request, &[target.clone()])
            .expect_err("missing window selection");
        assert_eq!(err, "Select an app window before recording.");

        request.capture_window_id = Some("../1".to_string());
        assert!(
            validate_recording_start_request_against_targets(&request, &[target.clone()]).is_err()
        );

        request.capture_window_id = Some("123".to_string());
        request.capture_window = Some(RecordingCaptureWindowSelection {
            id: "456".to_string(),
            app_name: "Preview App".to_string(),
            title: "Workflow".to_string(),
            bounds: RecordingCaptureWindowBounds {
                x: 10,
                y: 20,
                width: 640,
                height: 480,
            },
        });
        let err = validate_recording_start_request_against_targets(&request, &[target.clone()])
            .expect_err("metadata mismatch");
        assert_eq!(
            err,
            "Capture window metadata does not match the selected window."
        );

        request.capture_window = Some(RecordingCaptureWindowSelection {
            id: "123".to_string(),
            app_name: "Preview App".to_string(),
            title: "Workflow".to_string(),
            bounds: RecordingCaptureWindowBounds {
                x: 10,
                y: 20,
                width: 640,
                height: 480,
            },
        });
        assert!(validate_recording_start_request_against_targets(&request, &[target]).is_ok());
        assert_eq!(request_target_label(&request), "Preview App - Workflow");
    }

    #[test]
    fn recording_session_serializes_to_frontend_shape() {
        let session = RecordingSession {
            id: "recording-1".to_string(),
            target_kind: RecordingTargetKind::Window,
            target_label: "App window".to_string(),
            started_at_ms: 1234,
            output_dir: Some("/tmp/recording-1".to_string()),
            max_video_height: 720,
            artifact_url: Some("file:///tmp/recording-1/workflow.webm".to_string()),
            mime_type: Some("video/webm".to_string()),
            size_bytes: Some(2048),
            trace_artifact_url: Some("file:///tmp/recording-1/trace.json".to_string()),
            trace_event_count: Some(4),
            trace_truncated: Some(true),
            marker_count: Some(1),
            redacted_event_count: Some(2),
            transcript_artifact_url: Some("file:///tmp/recording-1/transcript.txt".to_string()),
            transcript_segment_count: Some(3),
            keyframe_artifact_url: Some("file:///tmp/recording-1/keyframes.json".to_string()),
            keyframe_count: Some(2),
            metadata_artifact_url: Some("file:///tmp/recording-1/metadata.json".to_string()),
            capture_stats: Some(RecordingCaptureStats {
                backend: "windows_xcap_mjpeg_avi".to_string(),
                frame_width: Some(1280),
                frame_height: Some(720),
                target_fps: Some(8),
                effective_fps: Some(7.5),
                frames_received: Some(40),
                frames_encoded: Some(15),
                frames_skipped: Some(25),
                encode_error_count: Some(0),
                duration_ms: Some(2000),
                time_to_first_frame_ms: Some(120),
            }),
            context: Some(RecordingSessionContext {
                target_id: "window".to_string(),
                capture_window_id: Some("123".to_string()),
                capture_window: Some(RecordingCaptureWindowSelection {
                    id: "123".to_string(),
                    app_name: "Preview App".to_string(),
                    title: "Workflow".to_string(),
                    bounds: RecordingCaptureWindowBounds {
                        x: 10,
                        y: 20,
                        width: 640,
                        height: 480,
                    },
                }),
                prep: RecordingPrep {
                    goal: "Submit an invoice".to_string(),
                    success_state: "Invoice accepted".to_string(),
                    variable_inputs: "Invoice PDF".to_string(),
                    preferences: "Use defaults".to_string(),
                    tos_acknowledged: true,
                },
                include_microphone: true,
                include_camera: false,
                executable_upgrade: true,
                trace_scope_note: Some("Focused app trace.".to_string()),
            }),
            quality_status: Some(RecordingQualityStatus::NeedsReview),
            quality_checks: Some(vec![
                RecordingQualityCheck {
                    key: RecordingQualityCheckKey::Video,
                    status: RecordingQualityCheckStatus::Pass,
                    label: "Video".to_string(),
                    message: "Video artifact is present.".to_string(),
                },
                RecordingQualityCheck {
                    key: RecordingQualityCheckKey::Target,
                    status: RecordingQualityCheckStatus::Warn,
                    label: "Target".to_string(),
                    message: "Recording target identity is incomplete.".to_string(),
                },
                RecordingQualityCheck {
                    key: RecordingQualityCheckKey::Transcript,
                    status: RecordingQualityCheckStatus::Pass,
                    label: "Transcript".to_string(),
                    message: "Transcript artifact is present.".to_string(),
                },
            ]),
        };

        let value = serde_json::to_value(session).expect("serialize session");

        assert_eq!(
            value,
            json!({
                "id": "recording-1",
                "targetKind": "window",
                "targetLabel": "App window",
                "startedAtMs": 1234,
                "outputDir": "/tmp/recording-1",
                "maxVideoHeight": 720,
                "artifactUrl": "file:///tmp/recording-1/workflow.webm",
                "mimeType": "video/webm",
                "sizeBytes": 2048,
                "traceArtifactUrl": "file:///tmp/recording-1/trace.json",
                "traceEventCount": 4,
                "traceTruncated": true,
                "markerCount": 1,
                "redactedEventCount": 2,
                "transcriptArtifactUrl": "file:///tmp/recording-1/transcript.txt",
                "transcriptSegmentCount": 3,
                "keyframeArtifactUrl": "file:///tmp/recording-1/keyframes.json",
                "keyframeCount": 2,
                "metadataArtifactUrl": "file:///tmp/recording-1/metadata.json",
                "captureStats": {
                    "backend": "windows_xcap_mjpeg_avi",
                    "frameWidth": 1280,
                    "frameHeight": 720,
                    "targetFps": 8,
                    "effectiveFps": 7.5,
                    "framesReceived": 40,
                    "framesEncoded": 15,
                    "framesSkipped": 25,
                    "encodeErrorCount": 0,
                    "durationMs": 2000,
                    "timeToFirstFrameMs": 120
                },
                "context": {
                    "targetId": "window",
                    "captureWindowId": "123",
                    "captureWindow": {
                        "id": "123",
                        "appName": "Preview App",
                        "title": "Workflow",
                        "bounds": {
                            "x": 10,
                            "y": 20,
                            "width": 640,
                            "height": 480
                        }
                    },
                    "prep": {
                        "goal": "Submit an invoice",
                        "successState": "Invoice accepted",
                        "variableInputs": "Invoice PDF",
                        "preferences": "Use defaults",
                        "tosAcknowledged": true
                    },
                    "includeMicrophone": true,
                    "includeCamera": false,
                    "executableUpgrade": true,
                    "traceScopeNote": "Focused app trace."
                },
                "qualityStatus": "needs_review",
                "qualityChecks": [
                    {
                        "key": "video",
                        "status": "pass",
                        "label": "Video",
                        "message": "Video artifact is present."
                    },
                    {
                        "key": "target",
                        "status": "warn",
                        "label": "Target",
                        "message": "Recording target identity is incomplete."
                    },
                    {
                        "key": "transcript",
                        "status": "pass",
                        "label": "Transcript",
                        "message": "Transcript artifact is present."
                    }
                ]
            })
        );
    }

    #[test]
    fn recording_marker_kind_deserializes_from_frontend_shape() {
        let kind: RecordingMarkerKind =
            serde_json::from_value(json!("important")).expect("deserialize marker");

        assert!(matches!(kind, RecordingMarkerKind::Important));
    }

    #[test]
    fn process_paths_map_to_app_names() {
        assert_eq!(
            app_name_from_process_path(r"C:\Program Files\Seren\Seren.exe"),
            Some("Seren".to_string())
        );
        assert_eq!(
            app_name_from_process_path("/Applications/Ghostty.app/Contents/MacOS/Ghostty"),
            Some("Ghostty".to_string())
        );
        assert_eq!(
            app_name_from_process_path(r"C:\Tools\CUSTOM.ExE"),
            Some("CUSTOM".to_string())
        );
        assert_eq!(app_name_from_process_path(""), None);
        assert_eq!(app_name_from_process_path(r"C:\Tools\"), None);
    }

    #[test]
    fn native_context_text_is_bounded_and_normalized() {
        assert_eq!(
            clean_native_context_text("  Expense\n\nForm\tWindow  ", 80),
            Some("Expense Form Window".to_string())
        );
        assert_eq!(clean_native_context_text(" \n\t ", 80), None);
        assert_eq!(
            clean_native_context_text("abcdefghijklmnopqrstuvwxyz", 8),
            Some("abcdefgh".to_string())
        );
    }

    #[test]
    fn marker_trace_writes_normalized_events() {
        let dir = tempfile::tempdir().expect("temp dir");
        let markers = vec![
            RecordingMarker {
                t_ms: 120,
                kind: RecordingMarkerKind::Important,
                context: Some(NativeActionContext {
                    source: NativeActionContextSource::Accessibility,
                    app_name: "Safari".to_string(),
                    window_title: Some("Expense Form".to_string()),
                }),
            },
            RecordingMarker {
                t_ms: 450,
                kind: RecordingMarkerKind::Confirm,
                context: None,
            },
        ];

        let session = build_recording_session(
            &start_request("screen", RecordingRequestTargetKind::Screen),
            "recording-1".to_string(),
            dir.path(),
        );
        let (path, event_count) = write_native_trace(dir.path(), &session, &markers, 600)
            .expect("write marker trace")
            .expect("marker trace path");
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read marker trace"))
                .expect("parse marker trace");

        assert_eq!(path.file_name().expect("file name"), "workflow-trace.json");
        assert_eq!(event_count, 4);
        assert_eq!(value["version"], json!(1));
        assert_eq!(value["source"], json!("native_desktop"));
        assert_eq!(value["truncated"], json!(false));
        assert_eq!(value["events"][0]["type"], json!("focus"));
        assert_eq!(value["events"][0]["tMs"], json!(0));
        assert_eq!(value["events"][0]["source"], json!("raw_input"));
        assert_eq!(value["events"][0]["target"]["role"], json!("screen"));
        assert_eq!(value["events"][0]["target"]["name"], json!("Desktop"));
        assert_eq!(
            value["events"][0]["target"]["selectors"][0],
            json!("capture_screen=visible_desktop")
        );
        assert_eq!(value["events"][1]["tMs"], json!(120));
        assert_eq!(value["events"][1]["type"], json!("marker"));
        assert_eq!(value["events"][1]["source"], json!("ax"));
        assert_eq!(value["events"][1]["markerKind"], json!("important"));
        assert_eq!(
            value["events"][1]["value"]["after"],
            json!("Important step")
        );
        assert_eq!(value["events"][1]["target"]["role"], json!("window"));
        assert_eq!(value["events"][1]["target"]["name"], json!("Expense Form"));
        assert_eq!(
            value["events"][1]["target"]["selectors"][0],
            json!("app=Safari")
        );
        assert_eq!(value["events"][2]["source"], json!("raw_input"));
        assert_eq!(value["events"][2]["markerKind"], json!("confirm"));
        assert_eq!(
            value["events"][2]["value"]["after"],
            json!("Needs confirmation")
        );
        assert_eq!(value["events"][3]["type"], json!("focus"));
        assert_eq!(value["events"][3]["tMs"], json!(600));
    }

    #[test]
    fn native_trace_adds_generic_screen_anchors() {
        let dir = tempfile::tempdir().expect("temp dir");
        let session = build_recording_session(
            &start_request("screen", RecordingRequestTargetKind::Screen),
            "recording-1".to_string(),
            dir.path(),
        );

        let (path, event_count) = write_native_trace(dir.path(), &session, &[], 600)
            .expect("write native trace")
            .expect("native trace path");
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read native trace"))
                .expect("parse native trace");

        assert_eq!(event_count, 2);
        assert_eq!(value["events"][0]["type"], json!("focus"));
        assert_eq!(value["events"][0]["tMs"], json!(0));
        assert_eq!(value["events"][0]["source"], json!("raw_input"));
        assert_eq!(value["events"][0]["target"]["role"], json!("screen"));
        assert_eq!(value["events"][0]["target"]["name"], json!("Desktop"));
        assert_eq!(
            value["events"][0]["target"]["selectors"][0],
            json!("capture_screen=visible_desktop")
        );
        assert_eq!(value["events"][1]["type"], json!("focus"));
        assert_eq!(value["events"][1]["tMs"], json!(600));
        assert_eq!(value["events"][1]["target"]["name"], json!("Desktop"));
        assert!(
            !value
                .to_string()
                .contains(dir.path().to_string_lossy().as_ref())
        );
    }

    #[test]
    fn native_trace_adds_generic_selected_window_anchors() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut request = start_request("window", RecordingRequestTargetKind::Window);
        request.capture_window_id = Some("123".to_string());
        request.capture_window = Some(RecordingCaptureWindowSelection {
            id: "123".to_string(),
            app_name: "Private App".to_string(),
            title: "Sensitive Customer Window".to_string(),
            bounds: RecordingCaptureWindowBounds {
                x: 10,
                y: 20,
                width: 640,
                height: 480,
            },
        });
        let session = build_recording_session(&request, "recording-1".to_string(), dir.path());
        let markers = vec![RecordingMarker {
            t_ms: 120,
            kind: RecordingMarkerKind::Important,
            context: selected_window_action_context(&session),
        }];

        let (path, event_count) = write_native_trace(dir.path(), &session, &markers, 600)
            .expect("write native trace")
            .expect("native trace path");
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read native trace"))
                .expect("parse native trace");

        assert_eq!(event_count, 3);
        assert_eq!(value["events"][0]["type"], json!("focus"));
        assert_eq!(value["events"][0]["tMs"], json!(0));
        assert_eq!(value["events"][0]["target"]["name"], json!("App window"));
        assert_eq!(
            value["events"][0]["target"]["selectors"][0],
            json!("capture_window=selected")
        );
        assert_eq!(value["events"][1]["type"], json!("marker"));
        assert_eq!(value["events"][1]["target"]["name"], json!("App window"));
        assert_eq!(value["events"][2]["type"], json!("focus"));
        assert_eq!(value["events"][2]["tMs"], json!(600));
        assert!(!value.to_string().contains("Private App"));
        assert!(!value.to_string().contains("Sensitive Customer Window"));
    }

    #[test]
    fn marker_context_prefers_selected_window_for_window_recordings() {
        let mut request = start_request("window", RecordingRequestTargetKind::Window);
        request.capture_window_id = Some("123".to_string());
        request.capture_window = Some(RecordingCaptureWindowSelection {
            id: "123".to_string(),
            app_name: "Preview App".to_string(),
            title: "Workflow".to_string(),
            bounds: RecordingCaptureWindowBounds {
                x: 10,
                y: 20,
                width: 640,
                height: 480,
            },
        });
        let session =
            build_recording_session(&request, "recording-1".to_string(), Path::new("/tmp"));
        let context = recording_marker_action_context_for_session(
            &session,
            Some(NativeActionContext {
                source: NativeActionContextSource::Accessibility,
                app_name: "Other App".to_string(),
                window_title: Some("Private Window".to_string()),
            }),
        )
        .expect("selected window context");

        assert!(matches!(
            context.source,
            NativeActionContextSource::CaptureWindow
        ));
        assert_eq!(context.app_name, "Preview App");
        assert_eq!(context.window_title.as_deref(), Some("Workflow"));
    }

    #[test]
    fn native_keyframe_manifest_is_local_only() {
        let dir = tempfile::tempdir().expect("temp dir");
        let frames = vec![
            NativeKeyframe {
                id: "keyframe-1".to_string(),
                t_ms: 0,
                reason: "start".to_string(),
                mime_type: "image/png".to_string(),
                file_name: native_keyframe_file_name(1, "start"),
                size_bytes: 123,
            },
            NativeKeyframe {
                id: "keyframe-2".to_string(),
                t_ms: 5000,
                reason: "stop".to_string(),
                mime_type: "image/png".to_string(),
                file_name: native_keyframe_file_name(2, "stop"),
                size_bytes: 456,
            },
        ];

        let path = write_native_keyframe_manifest(dir.path(), &frames)
            .expect("write keyframes")
            .expect("manifest path");
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read keyframes"))
                .expect("parse keyframes");

        assert_eq!(
            path.file_name().expect("file name"),
            "workflow-keyframes.json"
        );
        assert_eq!(value["version"], json!(1));
        assert_eq!(value["source"], json!("native_desktop"));
        assert_eq!(value["localOnly"], json!(true));
        assert_eq!(value["redactionStatus"], json!("not_scanned"));
        assert_eq!(
            value["frames"][0]["fileName"],
            json!("workflow-keyframe-01-start.png")
        );
        assert_eq!(value["frames"][1]["reason"], json!("stop"));
        assert!(
            !value
                .to_string()
                .contains(dir.path().to_string_lossy().as_ref()),
            "keyframe manifest must not embed absolute output paths"
        );
    }

    #[cfg(any(target_os = "windows", target_os = "linux"))]
    #[test]
    fn xcap_avi_artifact_rejects_zero_encoded_frames() {
        let dir = tempfile::tempdir().expect("temp dir");
        let video_path = dir.path().join("workflow-recording.avi");
        let writer = MjpegAviWriter::create(&video_path, 2, 2, 8).expect("create avi writer");

        let result = finish_xcap_avi_artifact(
            video_path.clone(),
            dir.path().to_path_buf(),
            xcap_screen_avi_backend_name(),
            Some(writer),
            Instant::now(),
            Some(2),
            Some(2),
            8,
            1,
            0,
            1,
            1,
            Some(10),
        );

        let Err(err) = result else {
            panic!("zero-frame artifact should be rejected");
        };
        assert_eq!(err, "Native recording did not encode any frames.");
        assert!(!video_path.exists());
    }

    #[test]
    fn marker_keyframe_reasons_are_filename_safe() {
        assert_eq!(
            marker_keyframe_reason(&RecordingMarkerKind::Important),
            "marker-important"
        );
        assert_eq!(
            marker_keyframe_reason(&RecordingMarkerKind::Varies),
            "marker-varies"
        );
        assert_eq!(
            marker_keyframe_reason(&RecordingMarkerKind::Ignore),
            "marker-ignore"
        );
        assert_eq!(
            marker_keyframe_reason(&RecordingMarkerKind::Confirm),
            "marker-confirm"
        );
    }

    #[test]
    fn recording_quality_marks_native_transcript_pending() {
        let dir = tempfile::tempdir().expect("temp dir");
        let request = start_request("screen", RecordingRequestTargetKind::Screen);
        let mut session = build_recording_session(&request, "recording-1".to_string(), dir.path());
        session.artifact_url = Some("file:///tmp/recording-1/workflow-recording.mov".to_string());
        session.mime_type = Some("video/quicktime".to_string());
        session.size_bytes = Some(4096);
        session.trace_event_count = Some(1);

        let (status, checks) = recording_quality(&session);
        let transcript = checks
            .iter()
            .find(|check| matches!(check.key, RecordingQualityCheckKey::Transcript))
            .expect("transcript check");

        assert!(matches!(status, RecordingQualityStatus::NeedsReview));
        assert!(matches!(
            transcript.status,
            RecordingQualityCheckStatus::Warn
        ));
        assert_eq!(
            transcript.message,
            "Native microphone audio may be present in the video, but transcript generation is pending."
        );
    }

    #[test]
    fn recording_quality_warns_when_video_not_normalized() {
        let dir = tempfile::tempdir().expect("temp dir");
        let request = start_request("screen", RecordingRequestTargetKind::Screen);
        let mut session = build_recording_session(&request, "recording-1".to_string(), dir.path());
        session.artifact_url = Some("file:///tmp/recording-1/workflow-recording.mov".to_string());
        session.mime_type = Some("video/quicktime".to_string());
        session.size_bytes = Some(4096);
        session.max_video_height = 0;
        session.context = Some(RecordingSessionContext {
            include_microphone: false,
            ..session.context.expect("context")
        });

        let (status, checks) = recording_quality(&session);
        let video = checks
            .iter()
            .find(|check| matches!(check.key, RecordingQualityCheckKey::Video))
            .expect("video check");

        assert!(matches!(status, RecordingQualityStatus::NeedsReview));
        assert!(matches!(video.status, RecordingQualityCheckStatus::Warn));
        assert_eq!(
            video.message,
            "Raw video artifact is present; 720p normalization was unavailable."
        );
    }

    #[test]
    fn recording_quality_treats_skipped_capture_frames_as_stats() {
        let dir = tempfile::tempdir().expect("temp dir");
        let request = start_request("screen", RecordingRequestTargetKind::Screen);
        let mut session = build_recording_session(&request, "recording-1".to_string(), dir.path());
        session.artifact_url = Some("file:///tmp/recording-1/workflow-recording.avi".to_string());
        session.mime_type = Some("video/x-msvideo".to_string());
        session.size_bytes = Some(4096);
        session.trace_event_count = Some(0);
        session.context = Some(RecordingSessionContext {
            include_microphone: false,
            executable_upgrade: false,
            ..session.context.expect("context")
        });
        session.capture_stats = Some(RecordingCaptureStats {
            backend: "windows_xcap_screen_mjpeg_avi".to_string(),
            frame_width: Some(1280),
            frame_height: Some(720),
            target_fps: Some(8),
            effective_fps: Some(7.5),
            frames_received: Some(40),
            frames_encoded: Some(15),
            frames_skipped: Some(25),
            encode_error_count: Some(0),
            duration_ms: Some(2000),
            time_to_first_frame_ms: Some(120),
        });

        let (status, checks) = recording_quality(&session);
        let capture = checks
            .iter()
            .find(|check| matches!(check.key, RecordingQualityCheckKey::CaptureHealth))
            .expect("capture check");

        assert!(matches!(status, RecordingQualityStatus::Ready));
        assert!(matches!(capture.status, RecordingQualityCheckStatus::Pass));
        assert_eq!(
            capture.message,
            "The windows_xcap_screen_mjpeg_avi backend reported a usable capture."
        );
    }

    #[test]
    fn recording_quality_warns_on_capture_encode_errors() {
        let dir = tempfile::tempdir().expect("temp dir");
        let request = start_request("screen", RecordingRequestTargetKind::Screen);
        let mut session = build_recording_session(&request, "recording-1".to_string(), dir.path());
        session.artifact_url = Some("file:///tmp/recording-1/workflow-recording.avi".to_string());
        session.mime_type = Some("video/x-msvideo".to_string());
        session.size_bytes = Some(4096);
        session.trace_event_count = Some(0);
        session.context = Some(RecordingSessionContext {
            include_microphone: false,
            executable_upgrade: false,
            ..session.context.expect("context")
        });
        session.capture_stats = Some(RecordingCaptureStats {
            backend: "windows_xcap_screen_mjpeg_avi".to_string(),
            frame_width: Some(1280),
            frame_height: Some(720),
            target_fps: Some(8),
            effective_fps: Some(7.5),
            frames_received: Some(40),
            frames_encoded: Some(15),
            frames_skipped: Some(25),
            encode_error_count: Some(2),
            duration_ms: Some(2000),
            time_to_first_frame_ms: Some(120),
        });

        let (status, checks) = recording_quality(&session);
        let capture = checks
            .iter()
            .find(|check| matches!(check.key, RecordingQualityCheckKey::CaptureHealth))
            .expect("capture check");

        assert!(matches!(status, RecordingQualityStatus::NeedsReview));
        assert!(matches!(capture.status, RecordingQualityCheckStatus::Warn));
        assert_eq!(
            capture.message,
            "The windows_xcap_screen_mjpeg_avi backend reported 2 encode error(s)."
        );
    }

    #[test]
    fn active_recorder_marker_round_trips() {
        let dir = tempfile::tempdir().expect("temp dir");
        let marker = ActiveRecorderMarker {
            pid: 4321,
            recording_id: "recording-abc".to_string(),
            output_dir: dir
                .path()
                .join("recording-abc")
                .to_string_lossy()
                .into_owned(),
            video_path: dir
                .path()
                .join("recording-abc/workflow-recording.mov")
                .to_string_lossy()
                .into_owned(),
            started_at_ms: 1234,
        };

        write_active_recorder_marker(dir.path(), &marker).expect("write marker");
        assert_eq!(read_active_recorder_marker(dir.path()), Some(marker));

        clear_active_recorder_marker(dir.path());
        assert_eq!(read_active_recorder_marker(dir.path()), None);
    }

    #[test]
    fn reap_clears_marker_and_removes_unusable_output() {
        let dir = tempfile::tempdir().expect("temp dir");
        let output_dir = dir.path().join("recording-orphan");
        fs::create_dir_all(&output_dir).expect("create output dir");
        let marker = ActiveRecorderMarker {
            // A PID that is not a live screencapture process: reap must not kill
            // anything, but must still clean up the stale marker + empty folder.
            pid: u32::MAX,
            recording_id: "recording-orphan".to_string(),
            output_dir: output_dir.to_string_lossy().into_owned(),
            video_path: output_dir
                .join("workflow-recording.mov")
                .to_string_lossy()
                .into_owned(),
            started_at_ms: 1,
        };
        write_active_recorder_marker(dir.path(), &marker).expect("write marker");

        reap_orphaned_recordings_in(dir.path());

        assert_eq!(read_active_recorder_marker(dir.path()), None);
        assert!(
            !output_dir.exists(),
            "empty orphan output dir should be removed"
        );
    }

    #[test]
    fn reap_keeps_non_empty_orphan_video() {
        let dir = tempfile::tempdir().expect("temp dir");
        let output_dir = dir.path().join("recording-partial");
        fs::create_dir_all(&output_dir).expect("create output dir");
        let video_path = output_dir.join("workflow-recording.mov");
        fs::write(&video_path, b"partial-but-present").expect("write partial video");
        let marker = ActiveRecorderMarker {
            pid: u32::MAX,
            recording_id: "recording-partial".to_string(),
            output_dir: output_dir.to_string_lossy().into_owned(),
            video_path: video_path.to_string_lossy().into_owned(),
            started_at_ms: 1,
        };
        write_active_recorder_marker(dir.path(), &marker).expect("write marker");

        reap_orphaned_recordings_in(dir.path());

        assert_eq!(read_active_recorder_marker(dir.path()), None);
        assert!(
            video_path.exists(),
            "non-empty orphan video must be retained"
        );
    }

    #[test]
    fn reap_clears_marker_without_removing_external_output_dir() {
        let root = tempfile::tempdir().expect("root dir");
        let external = tempfile::tempdir().expect("external dir");
        fs::write(external.path().join("keep.txt"), b"keep").expect("external file");
        let marker = ActiveRecorderMarker {
            pid: u32::MAX,
            recording_id: "recording-external".to_string(),
            output_dir: external.path().to_string_lossy().into_owned(),
            video_path: external
                .path()
                .join("workflow-recording.mov")
                .to_string_lossy()
                .into_owned(),
            started_at_ms: 1,
        };
        write_active_recorder_marker(root.path(), &marker).expect("write marker");

        reap_orphaned_recordings_in(root.path());

        assert_eq!(read_active_recorder_marker(root.path()), None);
        assert!(
            external.path().join("keep.txt").exists(),
            "reap must not delete paths outside the recordings root"
        );
    }

    #[test]
    fn active_marker_paths_must_match_recording_id() {
        let root = tempfile::tempdir().expect("root dir");
        let output_dir = root.path().join("recording-good");
        let marker = ActiveRecorderMarker {
            pid: 1,
            recording_id: "recording-good".to_string(),
            output_dir: output_dir.to_string_lossy().into_owned(),
            video_path: output_dir
                .join("workflow-recording.mov")
                .to_string_lossy()
                .into_owned(),
            started_at_ms: 1,
        };

        let resolved = active_marker_output_dir(root.path(), &marker).expect("valid output dir");
        assert_eq!(resolved, output_dir);
        assert_eq!(
            active_marker_video_path(&resolved, &marker),
            Some(resolved.join("workflow-recording.mov"))
        );

        let mut mismatched_output = marker.clone();
        mismatched_output.output_dir = root
            .path()
            .join("recording-other")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            active_marker_output_dir(root.path(), &mismatched_output),
            None
        );

        let mut mismatched_video = marker;
        mismatched_video.video_path = output_dir.join("other.mov").to_string_lossy().into_owned();
        assert_eq!(
            active_marker_video_path(&output_dir, &mismatched_video),
            None
        );
    }

    #[test]
    fn reap_with_no_marker_is_noop() {
        let dir = tempfile::tempdir().expect("temp dir");
        reap_orphaned_recordings_in(dir.path());
        assert_eq!(read_active_recorder_marker(dir.path()), None);
    }

    #[test]
    fn list_local_recordings_reports_metadata_and_ignores_non_recordings() {
        let root = tempfile::tempdir().expect("temp dir");

        let with_meta = root.path().join("recording-aaa");
        fs::create_dir_all(&with_meta).expect("create dir");
        fs::write(with_meta.join("workflow-recording.mov"), b"video-bytes").expect("video");
        fs::write(with_meta.join("workflow-recording.avi"), b"avi").expect("video");
        fs::write(with_meta.join("workflow-recording-720p.m4v"), b"normalized").expect("video");
        fs::write(
            with_meta.join("workflow-metadata.json"),
            serde_json::to_vec(&json!({
                "session": {
                    "startedAtMs": 2000,
                    "targetKind": "screen",
                    "targetLabel": "Full screen"
                },
                "capture": {
                    "keyframeCount": 2,
                    "stats": {
                        "backend": "windows_xcap_screen_mjpeg_avi",
                        "framesEncoded": 15,
                        "framesReceived": 40,
                        "framesSkipped": 25,
                        "effectiveFps": 7.5
                    }
                }
            }))
            .unwrap(),
        )
        .expect("metadata");

        let older = root.path().join("recording-bbb");
        fs::create_dir_all(&older).expect("create dir");
        fs::write(
            older.join("workflow-metadata.json"),
            serde_json::to_vec(&json!({
                "session": {
                    "startedAtMs": 1000,
                    "targetKind": "window",
                    "targetLabel": "Preview App"
                }
            }))
            .unwrap(),
        )
        .expect("metadata");

        // Non-recording entries must be ignored.
        fs::create_dir_all(root.path().join("not-a-recording")).expect("create dir");
        fs::create_dir_all(root.path().join("recording-bad id")).expect("create dir");
        fs::create_dir_all(root.path().join("recording-..")).expect("create dir");
        fs::write(root.path().join(".active-recorder.json"), b"{}").expect("marker");
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().expect("outside dir");
            std::os::unix::fs::symlink(outside.path(), root.path().join("recording-linked"))
                .expect("symlink recording dir");
        }

        let recordings = list_local_recordings_in(root.path());

        assert_eq!(recordings.len(), 2);
        // Newest first.
        assert_eq!(recordings[0].id, "recording-aaa");
        assert_eq!(recordings[0].size_bytes, Some(10));
        assert!(recordings[0].video_url.is_some());
        assert!(
            recordings[0]
                .video_url
                .as_deref()
                .unwrap_or_default()
                .contains("workflow-recording-720p.m4v")
        );
        assert_eq!(recordings[0].target_label.as_deref(), Some("Full screen"));
        assert_eq!(recordings[0].target_kind.as_deref(), Some("screen"));
        assert_eq!(recordings[0].keyframe_count, Some(2));
        assert_eq!(
            recordings[0]
                .capture_stats
                .as_ref()
                .map(|stats| stats.backend.as_str()),
            Some("windows_xcap_screen_mjpeg_avi")
        );
        assert_eq!(
            recordings[0]
                .capture_stats
                .as_ref()
                .and_then(|stats| stats.frames_encoded),
            Some(15)
        );
        assert_eq!(recordings[1].id, "recording-bbb");
        assert_eq!(recordings[1].size_bytes, None);
        assert!(recordings[1].video_url.is_none());
        assert_eq!(recordings[1].target_kind.as_deref(), Some("window"));
        assert_eq!(recordings[1].keyframe_count, None);

        let avi_only = root.path().join("recording-ccc");
        fs::create_dir_all(&avi_only).expect("create dir");
        fs::write(avi_only.join("workflow-recording.avi"), b"avi").expect("video");
        assert!(
            local_recording_video_path(&avi_only)
                .to_string_lossy()
                .contains("workflow-recording.avi")
        );
    }

    #[test]
    fn is_real_recording_dir_rejects_symlinks_and_files() {
        let root = tempfile::tempdir().expect("temp dir");
        let real = root.path().join("recording-real");
        fs::create_dir_all(&real).expect("create dir");
        assert!(is_real_recording_dir(&real));

        let file = root.path().join("recording-file");
        fs::write(&file, b"not a dir").expect("write file");
        assert!(!is_real_recording_dir(&file));

        assert!(!is_real_recording_dir(
            &root.path().join("recording-missing")
        ));

        // Delete/reveal must not follow a symlinked recording dir (the listing
        // already skips it via file_type), so this stays consistent.
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().expect("outside dir");
            let link = root.path().join("recording-linked");
            std::os::unix::fs::symlink(outside.path(), &link).expect("symlink");
            assert!(!is_real_recording_dir(&link));
        }
    }

    #[test]
    fn local_recording_id_validation_rejects_traversal() {
        assert!(validate_local_recording_id("recording-abc123").is_ok());
        assert!(validate_local_recording_id("recording-../secrets").is_err());
        assert!(validate_local_recording_id("recording-a/b").is_err());
        assert!(validate_local_recording_id("../recording-a").is_err());
        assert!(validate_local_recording_id("not-a-recording").is_err());
        assert!(validate_local_recording_id("recording-a ").is_err());
        assert!(validate_local_recording_id("recording-a b").is_err());
        assert!(validate_local_recording_id("recording-a.b").is_err());
        assert!(validate_local_recording_id("recording-").is_err());
    }

    #[test]
    fn capture_window_id_validation_accepts_only_platform_ids() {
        assert_eq!(validate_capture_window_id("12345"), Ok(12345));
        assert!(validate_capture_window_id("").is_err());
        assert!(validate_capture_window_id(" 12345").is_err());
        assert!(validate_capture_window_id("12345 ").is_err());
        assert!(validate_capture_window_id("window-12345").is_err());
        assert!(validate_capture_window_id("../12345").is_err());
        assert!(validate_capture_window_id("12345.png").is_err());
        assert!(validate_capture_window_id("99999999999999999999").is_err());
    }

    #[test]
    fn preview_pruning_removes_only_window_previews() {
        let root = tempfile::tempdir().expect("tempdir");
        fs::write(root.path().join("window-preview-1.png"), b"old").expect("preview");
        fs::write(root.path().join("window-preview-2.png"), b"old").expect("preview");
        fs::write(root.path().join("workflow-keyframe-01-start.png"), b"keep").expect("keyframe");
        fs::write(root.path().join("notes.txt"), b"keep").expect("notes");

        prune_recording_previews(root.path());

        assert!(!root.path().join("window-preview-1.png").exists());
        assert!(!root.path().join("window-preview-2.png").exists());
        assert!(root.path().join("workflow-keyframe-01-start.png").exists());
        assert!(root.path().join("notes.txt").exists());
    }

    #[test]
    fn startup_preview_pruning_uses_preview_subdirectory() {
        let root = tempfile::tempdir().expect("tempdir");
        let preview_root = root.path().join(".previews");
        fs::create_dir_all(&preview_root).expect("preview dir");
        fs::write(preview_root.join("window-preview-1.png"), b"old").expect("preview");
        fs::write(root.path().join("window-preview-2.png"), b"keep").expect("root file");

        prune_recording_previews_for_output_root(root.path());

        assert!(!preview_root.join("window-preview-1.png").exists());
        assert!(root.path().join("window-preview-2.png").exists());
    }

    #[test]
    fn preview_asset_scope_allows_hidden_preview_files() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let root = tempfile::tempdir().expect("tempdir");
        let preview_root = root.path().join(".previews");
        fs::create_dir_all(&preview_root).expect("preview dir");
        let path = preview_root.join("window-preview-123.png");
        fs::write(&path, b"png").expect("preview");

        assert!(!app.asset_protocol_scope().is_allowed(&path));

        allow_recording_preview_asset(app.handle(), &path).expect("allow preview");

        assert!(app.asset_protocol_scope().is_allowed(&path));
    }

    #[test]
    fn recording_slot_take_active_preserves_non_active_states() {
        // An idle slot yields nothing and stays idle.
        let mut idle = RecordingSlot::Idle;
        assert!(idle.take_active().is_none());
        assert!(matches!(idle, RecordingSlot::Idle));

        // A stop racing an in-flight start must not consume the reservation, so
        // `recording_start` can still publish the recording it is preparing.
        let mut starting = RecordingSlot::Starting;
        assert!(starting.take_active().is_none());
        assert!(matches!(starting, RecordingSlot::Starting));
    }
}
