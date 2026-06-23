// ABOUTME: Live transcription orchestrator: frames -> chunk -> transcribe -> persist -> emit.
// ABOUTME: Owns per-meeting capture streams and the call-end drain; testable via a fake source.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use uuid::Uuid;

use crate::audio::apm::{ApmDiagnostics, MeetingAudioProcessor};
use crate::audio::capture::{AudioCaptureSource, CaptureError, PcmFrame, TARGET_SAMPLE_RATE};
use crate::audio::chunker::{Chunk, ChunkCfg, StreamingChunker};
use crate::audio::transcribe::{
    ChunkTranscriber, GatewayTranscriber, RetryConfig, TranscribeError, TranscriptionMode,
    transcribe_chunk_with_retry,
};
use crate::audio::types::{SegmentStatus, Speaker, SpeakerSource, TranscriptSegment};
use crate::commands::audio::{NewTranscriptSegment, insert_transcript_segment, now_ms};
use crate::services::database::DbPool;

/// Receives finished transcript segments (persist + emit in prod, collect in tests).
#[async_trait]
pub trait SegmentSink: Send + Sync {
    async fn segment(&self, segment: TranscriptSegment);
}

/// Cap on the in-memory Them PCM buffer kept for the post-call diarization pass:
/// ~90 minutes of 16 kHz mono i16 (≈173 MB). Past this the buffer stops growing
/// so a marathon meeting can't exhaust memory; the post-call pass still covers the
/// first ~90 minutes. Nothing is written to disk (privacy rule #2125).
const MAX_THEM_BUFFER_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 60 * 90;

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStopSummary {
    pub had_capture: bool,
    pub native_mic_ready: bool,
    pub system_audio_ready: bool,
    pub apm_ready: bool,
    pub apm_active: bool,
    pub native_mic_frame_count: u64,
    pub system_audio_frame_count: u64,
    pub level_event_count: u64,
    pub push_frame_count: u64,
    pub accepted_push_frame_count: u64,
    pub dropped_push_frame_count: u64,
    pub dropped_push_sample_count: u64,
    pub frame_count: u64,
    pub sample_count: u64,
    pub speech_frame_count: u64,
    pub chunk_count: u64,
    pub emitted_segment_count: u64,
    pub emitted_gap_count: u64,
    /// The most recent transport-level transcription failure (e.g. an upstream
    /// `429 insufficient_quota`) seen during the capture, if any. `None` when no
    /// chunk hit a backend error — an empty transcript was genuine silence, not
    /// a service outage. Lets the stop path name the real cause instead of a
    /// generic "no words transcribed" guess.
    pub transcription_error: Option<String>,
    pub apm: ApmDiagnostics,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CaptureIngressSummary {
    push_frame_count: u64,
    accepted_push_frame_count: u64,
    dropped_push_frame_count: u64,
    dropped_push_sample_count: u64,
}

#[derive(Default)]
pub struct CaptureStreamStats {
    frame_count: AtomicU64,
    sample_count: AtomicU64,
    speech_frame_count: AtomicU64,
    chunk_count: AtomicU64,
    emitted_segment_count: AtomicU64,
    emitted_gap_count: AtomicU64,
    transport_failure_count: AtomicU64,
    last_transport_error: StdMutex<Option<String>>,
}

#[derive(Default)]
struct CaptureSourceStats {
    native_mic_frame_count: AtomicU64,
    system_audio_frame_count: AtomicU64,
    level_event_count: AtomicU64,
}

impl CaptureSourceStats {
    fn record_native_mic_frame(&self) {
        self.native_mic_frame_count.fetch_add(1, Ordering::Relaxed);
    }

    fn record_system_audio_frame(&self) {
        self.system_audio_frame_count
            .fetch_add(1, Ordering::Relaxed);
    }

    fn record_level_event(&self) {
        self.level_event_count.fetch_add(1, Ordering::Relaxed);
    }
}

impl CaptureStreamStats {
    fn record_frame(&self, samples: &[i16], speech_threshold: f32) {
        self.frame_count.fetch_add(1, Ordering::Relaxed);
        self.sample_count
            .fetch_add(samples.len() as u64, Ordering::Relaxed);
        if rms(samples) >= speech_threshold {
            self.speech_frame_count.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn record_chunk(&self) {
        self.chunk_count.fetch_add(1, Ordering::Relaxed);
    }

    fn record_ok_segment(&self) {
        self.emitted_segment_count.fetch_add(1, Ordering::Relaxed);
    }

    fn record_gap_segment(&self) {
        self.emitted_segment_count.fetch_add(1, Ordering::Relaxed);
        self.emitted_gap_count.fetch_add(1, Ordering::Relaxed);
    }

    /// Record a chunk's transcription failure. Only transport-level errors
    /// (network/auth/quota/5xx) are kept as the surfaced cause; a terminal
    /// `Empty` is genuine silence, not a service outage, so it stays a plain
    /// gap. The first transport failure of a capture logs once at WARN; the
    /// rest update the stored cause without spamming the log (a sustained
    /// outage can fail every chunk).
    fn record_transcription_failure(&self, err: &TranscribeError) {
        let TranscribeError::Transport(detail) = err else {
            return;
        };
        let first = self.transport_failure_count.fetch_add(1, Ordering::Relaxed) == 0;
        *self.last_transport_error.lock().unwrap() = Some(detail.clone());
        if first {
            log::warn!(
                "[meeting] transcription transport error (further errors this capture are counted but not re-logged): {detail}"
            );
        }
    }

    fn summary(
        &self,
        had_capture: bool,
        ingress: CaptureIngressSummary,
        source: &CaptureSourceStats,
        native_mic_ready: bool,
        system_audio_ready: bool,
        apm: ApmDiagnostics,
    ) -> CaptureStopSummary {
        CaptureStopSummary {
            had_capture,
            native_mic_ready,
            system_audio_ready,
            apm_ready: apm.initialized,
            apm_active: apm.active,
            native_mic_frame_count: source.native_mic_frame_count.load(Ordering::Relaxed),
            system_audio_frame_count: source.system_audio_frame_count.load(Ordering::Relaxed),
            level_event_count: source.level_event_count.load(Ordering::Relaxed),
            push_frame_count: ingress.push_frame_count,
            accepted_push_frame_count: ingress.accepted_push_frame_count,
            dropped_push_frame_count: ingress.dropped_push_frame_count,
            dropped_push_sample_count: ingress.dropped_push_sample_count,
            frame_count: self.frame_count.load(Ordering::Relaxed),
            sample_count: self.sample_count.load(Ordering::Relaxed),
            speech_frame_count: self.speech_frame_count.load(Ordering::Relaxed),
            chunk_count: self.chunk_count.load(Ordering::Relaxed),
            emitted_segment_count: self.emitted_segment_count.load(Ordering::Relaxed),
            emitted_gap_count: self.emitted_gap_count.load(Ordering::Relaxed),
            transcription_error: self.last_transport_error.lock().unwrap().clone(),
            apm,
        }
    }
}

fn rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum = samples
        .iter()
        .map(|sample| {
            let value = *sample as f64;
            value * value
        })
        .sum::<f64>();
    (sum / samples.len() as f64).sqrt() as f32
}

/// Drive one capture stream end to end: read frames, chunk on silence, transcribe
/// each window with retry, and hand finished segments to `sink`. A failed window
/// becomes a `Gap` segment so audio is never silently dropped.
///
/// When `them_buffer` is `Some` (the Them stream only), each frame's samples are
/// also appended to the shared buffer for the post-call diarization pass, capped
/// at [`MAX_THEM_BUFFER_SAMPLES`]. The Me stream passes `None` and is never
/// buffered. The lock-and-extend is per-frame and off the transcription path, so
/// it does not slow the chunk/transcribe loop.
pub async fn run_capture_stream(
    meeting_id: String,
    speaker: Speaker,
    mut frames: UnboundedReceiver<PcmFrame>,
    transcriber: Arc<dyn ChunkTranscriber + Send + Sync>,
    seq: Arc<AtomicI64>,
    cfg: ChunkCfg,
    retry: RetryConfig,
    sink: Arc<dyn SegmentSink>,
    stats: Arc<CaptureStreamStats>,
    them_buffer: Option<Arc<StdMutex<Vec<i16>>>>,
) {
    let mut chunker = StreamingChunker::new(cfg);
    while let Some(frame) = frames.recv().await {
        stats.record_frame(&frame.samples, cfg.rms_threshold);
        if let Some(buffer) = them_buffer.as_ref() {
            buffer_them_samples(buffer, &frame.samples);
        }
        for chunk in chunker.push(&frame.samples) {
            emit_segment(
                &meeting_id,
                &speaker,
                chunk,
                transcriber.as_ref(),
                retry,
                &seq,
                sink.as_ref(),
                stats.as_ref(),
            )
            .await;
        }
    }
    for chunk in chunker.finish() {
        emit_segment(
            &meeting_id,
            &speaker,
            chunk,
            transcriber.as_ref(),
            retry,
            &seq,
            sink.as_ref(),
            stats.as_ref(),
        )
        .await;
    }
}

/// Append a frame's samples to the Them buffer, stopping at the cap. Once full the
/// buffer is frozen rather than ring-rotated so the post-call pass keeps a single
/// contiguous timeline that lines up with the live segment timestamps.
fn buffer_them_samples(buffer: &StdMutex<Vec<i16>>, samples: &[i16]) {
    let mut buffer = buffer.lock().unwrap();
    if buffer.len() >= MAX_THEM_BUFFER_SAMPLES {
        return;
    }
    let remaining = MAX_THEM_BUFFER_SAMPLES - buffer.len();
    let take = remaining.min(samples.len());
    buffer.extend_from_slice(&samples[..take]);
}

async fn emit_segment(
    meeting_id: &str,
    speaker: &Speaker,
    chunk: Chunk,
    transcriber: &(dyn ChunkTranscriber + Send + Sync),
    retry: RetryConfig,
    seq: &AtomicI64,
    sink: &dyn SegmentSink,
    stats: &CaptureStreamStats,
) {
    stats.record_chunk();
    let chunk_start = chunk.start_ms as i64;
    let chunk_end = chunk.end_ms as i64;
    match transcribe_chunk_with_retry(transcriber, &chunk, retry).await {
        Ok(diarized) => {
            // One transcript segment per diarized utterance. The capture channel
            // still decides Me/Them; the model label is metadata for a future
            // per-speaker correction UI. Offset each utterance by the chunk start.
            for utterance in diarized {
                let speaker_source = if utterance.speaker_label.is_some() {
                    SpeakerSource::Diarization
                } else {
                    SpeakerSource::Channel
                };
                let segment = TranscriptSegment {
                    id: Uuid::new_v4().to_string(),
                    meeting_id: meeting_id.to_string(),
                    seq: seq.fetch_add(1, Ordering::SeqCst),
                    speaker: speaker.clone(),
                    text: utterance.text,
                    start_ms: chunk_start + utterance.start_ms,
                    end_ms: chunk_start + utterance.end_ms,
                    status: SegmentStatus::Ok,
                    speaker_label: utterance.speaker_label,
                    speaker_source,
                    created_at: now_ms(),
                };
                sink.segment(segment).await;
                stats.record_ok_segment();
            }
        }
        Err(err) => {
            // A failed window becomes a single Gap spanning the chunk so audio is
            // never silently dropped. Record the cause so a backend outage
            // (quota/auth/5xx) surfaces in the stop summary instead of looking
            // like silence.
            stats.record_transcription_failure(&err);
            let segment = TranscriptSegment {
                id: Uuid::new_v4().to_string(),
                meeting_id: meeting_id.to_string(),
                seq: seq.fetch_add(1, Ordering::SeqCst),
                speaker: speaker.clone(),
                text: String::new(),
                start_ms: chunk_start,
                end_ms: chunk_end,
                status: SegmentStatus::Gap,
                speaker_label: None,
                speaker_source: SpeakerSource::Channel,
                created_at: now_ms(),
            };
            sink.segment(segment).await;
            stats.record_gap_segment();
        }
    }
}

/// Production sink: persist the segment to SQLite, then emit it to the webview.
struct DbEmitSink {
    app: AppHandle,
}

#[async_trait]
impl SegmentSink for DbEmitSink {
    async fn segment(&self, segment: TranscriptSegment) {
        let app = self.app.clone();
        let row = NewTranscriptSegment {
            id: segment.id.clone(),
            meeting_id: segment.meeting_id.clone(),
            seq: segment.seq,
            speaker: segment.speaker.clone(),
            text: segment.text.clone(),
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            status: segment.status.clone(),
            speaker_label: segment.speaker_label.clone(),
            speaker_source: segment.speaker_source,
            created_at: segment.created_at,
        };
        let persisted = tauri::async_runtime::spawn_blocking(move || {
            let pool = app.state::<DbPool>();
            pool.with_connection(|conn| insert_transcript_segment(conn, row))
        })
        .await;
        match persisted {
            Ok(Ok(_)) => {}
            Ok(Err(err)) => {
                log::warn!("[meeting] failed to persist transcript segment: {err}")
            }
            Err(err) => log::warn!("[meeting] transcript persist task failed: {err}"),
        }
        let _ = self.app.emit("meeting://transcript-chunk", &segment);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureLevelEvent {
    pub meeting_id: String,
    pub speaker: Speaker,
    pub level: f32,
}

enum ApmInput {
    Capture(PcmFrame),
    Render(PcmFrame),
}

async fn run_mic_apm_stream(
    app: Option<AppHandle>,
    meeting_id: String,
    mut input: UnboundedReceiver<ApmInput>,
    processed_tx: UnboundedSender<PcmFrame>,
    source_stats: Arc<CaptureSourceStats>,
    apm_diagnostics: Arc<StdMutex<ApmDiagnostics>>,
) {
    let mut processor = MeetingAudioProcessor::new();
    let mut last_level_emit = Instant::now()
        .checked_sub(Duration::from_millis(100))
        .unwrap_or_else(Instant::now);
    while let Some(item) = input.recv().await {
        match item {
            ApmInput::Render(frame) => {
                processor.accept_render_reference(&frame.samples);
            }
            ApmInput::Capture(frame) => {
                let processed = processor.process_capture(&frame.samples);
                if processed.is_empty() {
                    continue;
                }
                maybe_emit_level(
                    app.as_ref(),
                    &meeting_id,
                    &processed,
                    &source_stats,
                    &mut last_level_emit,
                );
                if processed_tx.send(PcmFrame { samples: processed }).is_err() {
                    break;
                }
            }
        }
        *apm_diagnostics.lock().unwrap() = processor.diagnostics();
    }
    *apm_diagnostics.lock().unwrap() = processor.diagnostics();
}

async fn route_mic_to_apm(
    mut rx: UnboundedReceiver<PcmFrame>,
    apm_tx: UnboundedSender<ApmInput>,
    source_stats: Arc<CaptureSourceStats>,
) {
    while let Some(frame) = rx.recv().await {
        source_stats.record_native_mic_frame();
        if apm_tx.send(ApmInput::Capture(frame)).is_err() {
            break;
        }
    }
}

async fn route_system_to_them_and_apm(
    mut rx: UnboundedReceiver<PcmFrame>,
    them_tx: UnboundedSender<PcmFrame>,
    apm_tx: UnboundedSender<ApmInput>,
    source_stats: Arc<CaptureSourceStats>,
) {
    while let Some(frame) = rx.recv().await {
        source_stats.record_system_audio_frame();
        let _ = them_tx.send(frame.clone());
        if apm_tx.send(ApmInput::Render(frame)).is_err() {
            break;
        }
    }
}

async fn route_system_to_them(
    mut rx: UnboundedReceiver<PcmFrame>,
    them_tx: UnboundedSender<PcmFrame>,
    source_stats: Arc<CaptureSourceStats>,
) {
    while let Some(frame) = rx.recv().await {
        source_stats.record_system_audio_frame();
        if them_tx.send(frame).is_err() {
            break;
        }
    }
}

fn maybe_emit_level(
    app: Option<&AppHandle>,
    meeting_id: &str,
    samples: &[i16],
    source_stats: &CaptureSourceStats,
    last_emit: &mut Instant,
) {
    if last_emit.elapsed() < Duration::from_millis(60) {
        return;
    }
    *last_emit = Instant::now();
    source_stats.record_level_event();
    let level = (rms(samples) / i16::MAX as f32).clamp(0.0, 1.0);
    if let Some(app) = app {
        let _ = app.emit(
            "meeting://capture-level",
            CaptureLevelEvent {
                meeting_id: meeting_id.to_string(),
                speaker: Speaker::Me,
                level,
            },
        );
    }
}

/// One in-flight meeting's capture streams and their worker tasks.
struct ActiveCapture {
    // Native mic source feeding the APM stage.
    mic_source: Option<Box<dyn AudioCaptureSource>>,
    // Native system-audio source feeding Them transcription and the APM render reference.
    system_source: Option<Box<dyn AudioCaptureSource>>,
    tasks: Vec<JoinHandle<()>>,
    // Full Them PCM buffered in memory for the post-call diarization pass. The
    // Them worker appends frames here; `stop` takes it for [`reconcile_meeting_speakers`].
    them_audio: Arc<StdMutex<Vec<i16>>>,
    stats: Arc<CaptureStreamStats>,
    source_stats: Arc<CaptureSourceStats>,
    apm_diagnostics: Arc<StdMutex<ApmDiagnostics>>,
    e2e_injection_enabled: bool,
    native_mic_ready: bool,
    system_audio_ready: bool,
}

/// A meeting's slot in the registry. `Stopping` is a tombstone left in the map
/// while `stop` drains its workers off the lock (up to ~1s joining the WASAPI
/// thread on Windows). It keeps the id occupied so a racing `start` can't slip
/// past the guard and insert a second coexisting capture (#2164).
enum CaptureSlot {
    Active(ActiveCapture),
    Stopping,
}

/// The platform's system-audio ("Them") capture source, if this build supports it.
/// Returns `None` where native render capture is not yet available.
fn system_audio_source() -> Option<Box<dyn AudioCaptureSource>> {
    #[cfg(target_os = "windows")]
    {
        return Some(Box::new(
            crate::audio::capture::windows::WasapiLoopbackSource::new(),
        ));
    }
    #[cfg(target_os = "macos")]
    {
        return Some(Box::new(
            crate::audio::capture::macos::CoreAudioTapSource::new(),
        ));
    }
    #[allow(unreachable_code)]
    {
        None
    }
}

/// The platform's native microphone ("Me") capture source.
fn mic_audio_source() -> Option<Box<dyn AudioCaptureSource>> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        return Some(Box::new(crate::audio::capture::mic::CpalMicSource::new()));
    }
    #[allow(unreachable_code)]
    {
        None
    }
}

#[derive(Default)]
struct PreparedMicAudioStream {
    source: Option<Box<dyn AudioCaptureSource>>,
    rx: Option<UnboundedReceiver<PcmFrame>>,
}

impl PreparedMicAudioStream {
    fn has_mic(&self) -> bool {
        self.rx.is_some()
    }
}

fn prepare_mic_audio_stream(
    meeting_id: &str,
    mic_source: Option<Box<dyn AudioCaptureSource>>,
) -> Result<PreparedMicAudioStream, CaptureError> {
    let Some(mut source) = mic_source else {
        return Err(CaptureError::Unsupported(
            "native microphone capture is not compiled for this platform".to_string(),
        ));
    };
    let (tx, rx) = unbounded_channel();
    match source.start(tx) {
        Ok(()) => {
            log::info!("[meeting] native mic capture started for {meeting_id}");
            Ok(PreparedMicAudioStream {
                source: Some(source),
                rx: Some(rx),
            })
        }
        Err(err) => {
            log::warn!("[meeting] native mic capture startup failed for {meeting_id}: {err}");
            Err(err)
        }
    }
}

#[derive(Default)]
struct PreparedSystemAudioStream {
    source: Option<Box<dyn AudioCaptureSource>>,
    rx: Option<UnboundedReceiver<PcmFrame>>,
}

impl PreparedSystemAudioStream {
    #[cfg(test)]
    fn has_system_audio(&self) -> bool {
        self.rx.is_some()
    }
}

/// Start the native system-audio source before marking a meeting capture active.
/// Unsupported platforms/builds stay mic-only; a supported source that fails to
/// initialize must reject startup so the UI can surface the real permission or
/// device cause instead of recording an empty transcript (#2217).
fn prepare_system_audio_stream(
    meeting_id: &str,
    system_source: Option<Box<dyn AudioCaptureSource>>,
) -> Result<PreparedSystemAudioStream, CaptureError> {
    let Some(mut source) = system_source else {
        log::info!("[meeting] system-audio capture unsupported on this platform");
        return Ok(PreparedSystemAudioStream::default());
    };

    let (tx, rx) = unbounded_channel();
    match source.start(tx.clone()) {
        Ok(()) => {
            log::info!("[meeting] system-audio capture started for {meeting_id}");
            Ok(PreparedSystemAudioStream {
                source: Some(source),
                rx: Some(rx),
            })
        }
        Err(CaptureError::Unsupported(reason)) => {
            log::info!(
                "[meeting] system-audio capture unsupported for {meeting_id}: {reason}; continuing mic-only"
            );
            Ok(PreparedSystemAudioStream::default())
        }
        Err(err) => {
            log::warn!("[meeting] system-audio capture startup failed for {meeting_id}: {err}");
            Err(err)
        }
    }
}

/// The transcription mode for a capture stream. The single-speaker microphone
/// ("Me") uses plain `whisper-1` text; only the multi-speaker system stream
/// ("Them") is diarized — diarizing the mono mic is pure cost with no payoff
/// (see #2152).
pub fn transcription_mode_for(speaker: &Speaker) -> TranscriptionMode {
    match speaker {
        Speaker::Me => TranscriptionMode::Text,
        Speaker::Them => TranscriptionMode::Diarized,
    }
}

fn e2e_capture_injection_enabled() -> bool {
    std::env::var("SEREN_E2E_CAPTURE_INJECTION")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// Upper bound on each `stop` drain step (native source stop, then each worker
/// join). Generous enough that a healthy drain never hits it, so it only fires on
/// a genuinely wedged task / WASAPI thread (#2175).
const STOP_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

/// Tauri-managed registry of active meeting captures, keyed by meeting id.
///
/// `Clone` shares the same `active` map (it only wraps an `Arc`), so the start
/// command can hand a handle to a blocking thread without copying state (#2176).
#[derive(Default, Clone)]
pub struct CaptureRegistry {
    active: Arc<StdMutex<HashMap<String, CaptureSlot>>>,
    ingress: Arc<StdMutex<HashMap<String, CaptureIngressSummary>>>,
    // Them PCM handed off by `stop`, keyed by meeting id, awaiting the post-call
    // diarization pass. `reconcile_meeting_speakers` removes its entry; the buffer
    // lives only in memory and is dropped once consumed (privacy rule #2125).
    finished_them_audio: Arc<StdMutex<HashMap<String, Vec<i16>>>>,
}

impl CaptureRegistry {
    /// Begin native capture for `meeting_id`. Rust owns both the microphone
    /// ("Me") and system-audio ("Them") streams before the slot becomes active.
    pub fn start(&self, app: &AppHandle, meeting_id: &str) -> Result<(), String> {
        log::info!("[meeting] capture registry start requested for {meeting_id}");
        let me_transcriber: Arc<dyn ChunkTranscriber + Send + Sync> = Arc::new(
            GatewayTranscriber::with_mode(app.clone(), transcription_mode_for(&Speaker::Me)),
        );
        let them_transcriber: Arc<dyn ChunkTranscriber + Send + Sync> = Arc::new(
            GatewayTranscriber::with_mode(app.clone(), transcription_mode_for(&Speaker::Them)),
        );
        let sink: Arc<dyn SegmentSink> = Arc::new(DbEmitSink { app: app.clone() });
        self.start_with_sources(
            Some(app.clone()),
            meeting_id,
            mic_audio_source(),
            system_audio_source(),
            me_transcriber,
            them_transcriber,
            sink,
        )
    }

    fn start_with_sources(
        &self,
        app: Option<AppHandle>,
        meeting_id: &str,
        mic_source: Option<Box<dyn AudioCaptureSource>>,
        system_source: Option<Box<dyn AudioCaptureSource>>,
        me_transcriber: Arc<dyn ChunkTranscriber + Send + Sync>,
        them_transcriber: Arc<dyn ChunkTranscriber + Send + Sync>,
        sink: Arc<dyn SegmentSink>,
    ) -> Result<(), String> {
        let mut active = self.active.lock().unwrap();
        // Reject if the id is already live OR draining (`Stopping` tombstone): a
        // start that raced a still-running stop must not insert a second capture.
        if active.contains_key(meeting_id) {
            log::warn!("[meeting] capture start ignored; slot already occupied for {meeting_id}");
            return Ok(());
        }

        let prepared_system_audio = prepare_system_audio_stream(meeting_id, system_source)
            .map_err(|err| format!("system-audio capture unavailable: {err}"))?;
        let PreparedSystemAudioStream {
            source: system_source,
            rx: system_rx,
        } = prepared_system_audio;
        let has_system_audio = system_rx.is_some();
        let prepared_mic = match prepare_mic_audio_stream(meeting_id, mic_source) {
            Ok(prepared) => prepared,
            Err(err) if has_system_audio => {
                log::warn!(
                    "[meeting] native mic unavailable for {meeting_id}; continuing system-audio-only: {err}"
                );
                PreparedMicAudioStream::default()
            }
            Err(err) => return Err(format!("native microphone capture unavailable: {err}")),
        };
        let has_mic = prepared_mic.has_mic();

        // Me and Them share one sequence counter so segments order globally.
        let seq = Arc::new(AtomicI64::new(0));
        let stats = Arc::new(CaptureStreamStats::default());
        let source_stats = Arc::new(CaptureSourceStats::default());
        let apm_diagnostics = Arc::new(StdMutex::new(ApmDiagnostics::default()));
        self.reset_ingress_summary(meeting_id);

        let mut tasks = Vec::new();
        let apm_tx = if has_mic {
            let (me_tx, me_rx) = unbounded_channel();
            let (apm_tx, apm_rx) = unbounded_channel();
            *apm_diagnostics.lock().unwrap() = ApmDiagnostics {
                initialized: true,
                active: true,
                ..Default::default()
            };
            // The Me mic is single-speaker; it is never buffered for the post-call pass.
            tasks.push(tauri::async_runtime::spawn(run_capture_stream(
                meeting_id.to_string(),
                Speaker::Me,
                me_rx,
                me_transcriber,
                seq.clone(),
                ChunkCfg::default(),
                RetryConfig::default(),
                sink.clone(),
                stats.clone(),
                None,
            )));
            tasks.push(tauri::async_runtime::spawn(run_mic_apm_stream(
                app,
                meeting_id.to_string(),
                apm_rx,
                me_tx,
                source_stats.clone(),
                apm_diagnostics.clone(),
            )));
            if let Some(mic_rx) = prepared_mic.rx {
                tasks.push(tauri::async_runtime::spawn(route_mic_to_apm(
                    mic_rx,
                    apm_tx.clone(),
                    source_stats.clone(),
                )));
            }
            Some(apm_tx)
        } else {
            None
        };

        // Shared buffer the Them worker fills for the post-call diarization pass.
        let them_audio: Arc<StdMutex<Vec<i16>>> = Arc::new(StdMutex::new(Vec::new()));

        if let Some(rx) = system_rx {
            let (them_tx, them_rx) = unbounded_channel();
            let e2e_injection_enabled = e2e_capture_injection_enabled();
            tasks.push(tauri::async_runtime::spawn(run_capture_stream(
                meeting_id.to_string(),
                Speaker::Them,
                them_rx,
                them_transcriber,
                seq,
                ChunkCfg::default(),
                RetryConfig::default(),
                sink,
                stats.clone(),
                Some(them_audio.clone()),
            )));
            if let Some(apm_tx) = apm_tx.clone() {
                tasks.push(tauri::async_runtime::spawn(route_system_to_them_and_apm(
                    rx,
                    them_tx,
                    apm_tx,
                    source_stats.clone(),
                )));
            } else {
                tasks.push(tauri::async_runtime::spawn(route_system_to_them(
                    rx,
                    them_tx,
                    source_stats.clone(),
                )));
            }
            active.insert(
                meeting_id.to_string(),
                CaptureSlot::Active(ActiveCapture {
                    mic_source: prepared_mic.source,
                    system_source,
                    tasks,
                    them_audio,
                    stats,
                    source_stats,
                    apm_diagnostics,
                    e2e_injection_enabled,
                    native_mic_ready: has_mic,
                    system_audio_ready: has_system_audio,
                }),
            );
            log::info!(
                "[meeting] capture registry active for {meeting_id}; system_audio={}",
                has_system_audio
            );
            return Ok(());
        }
        drop(apm_tx);

        active.insert(
            meeting_id.to_string(),
            CaptureSlot::Active(ActiveCapture {
                mic_source: prepared_mic.source,
                system_source,
                tasks,
                them_audio,
                stats,
                source_stats,
                apm_diagnostics,
                e2e_injection_enabled: false,
                native_mic_ready: has_mic,
                system_audio_ready: has_system_audio,
            }),
        );
        log::info!(
            "[meeting] capture registry active for {meeting_id}; system_audio={}",
            has_system_audio
        );
        Ok(())
    }

    /// Whether a capture is currently live for `meeting_id`. A draining
    /// (`Stopping`) slot reports `false` — it is no longer capturing.
    pub fn is_active(&self, meeting_id: &str) -> bool {
        matches!(
            self.active.lock().unwrap().get(meeting_id),
            Some(CaptureSlot::Active(_))
        )
    }

    /// Whether the registry slot for `meeting_id` is taken (live or draining).
    /// This is the predicate `start` guards on, so a draining slot blocks a
    /// new capture for the same id until the drain completes.
    pub fn slot_occupied(&self, meeting_id: &str) -> bool {
        self.active.lock().unwrap().contains_key(meeting_id)
    }

    /// Push a normalized 16 kHz mono frame into the capture stream for `speaker`.
    pub fn push_frame(&self, meeting_id: &str, speaker: Speaker, samples: Vec<i16>) -> bool {
        let sample_count = samples.len() as u64;
        let accepted = {
            let active = self.active.lock().unwrap();
            match active.get(meeting_id) {
                Some(CaptureSlot::Active(capture)) if capture.e2e_injection_enabled => Some((
                    capture.stats.clone(),
                    capture.source_stats.clone(),
                    capture.system_audio_ready,
                )),
                _ => None,
            }
        };
        if let Some((stats, source_stats, system_audio_ready)) = accepted {
            if system_audio_ready {
                source_stats.record_system_audio_frame();
            }
            stats.record_frame(&samples, ChunkCfg::default().rms_threshold);
            self.record_accepted_push_frame(meeting_id, sample_count);
            return true;
        }

        let active = self.active.lock().unwrap();
        let drop_reason = match active.get(meeting_id) {
            Some(CaptureSlot::Active(_capture)) => "renderer_push_disabled",
            Some(CaptureSlot::Stopping) => "stopping",
            None => "no_slot",
        };
        drop(active);

        let ingress = self.record_dropped_push_frame(meeting_id, sample_count);
        if should_log_dropped_push(ingress.dropped_push_frame_count) {
            log::warn!(
                "[meeting] capture frame dropped for {meeting_id}; speaker={} reason={} dropped_frames={} dropped_samples={}",
                speaker.as_str(),
                drop_reason,
                ingress.dropped_push_frame_count,
                ingress.dropped_push_sample_count
            );
        }
        false
    }

    fn reset_ingress_summary(&self, meeting_id: &str) {
        self.ingress
            .lock()
            .unwrap()
            .insert(meeting_id.to_string(), CaptureIngressSummary::default());
    }

    fn record_dropped_push_frame(
        &self,
        meeting_id: &str,
        sample_count: u64,
    ) -> CaptureIngressSummary {
        let mut ingress = self.ingress.lock().unwrap();
        let summary = ingress.entry(meeting_id.to_string()).or_default();
        summary.push_frame_count += 1;
        summary.dropped_push_frame_count += 1;
        summary.dropped_push_sample_count += sample_count;
        *summary
    }

    fn record_accepted_push_frame(&self, meeting_id: &str, sample_count: u64) {
        let mut ingress = self.ingress.lock().unwrap();
        let summary = ingress.entry(meeting_id.to_string()).or_default();
        summary.push_frame_count += 1;
        summary.accepted_push_frame_count += 1;
        log::info!(
            "[meeting] accepted e2e capture frame for {meeting_id}; accepted_push_frames={} samples={}",
            summary.accepted_push_frame_count,
            sample_count
        );
    }

    fn take_ingress_summary(&self, meeting_id: &str) -> CaptureIngressSummary {
        self.ingress
            .lock()
            .unwrap()
            .remove(meeting_id)
            .unwrap_or_default()
    }

    /// Take the active capture for draining and leave a `Stopping` tombstone, all
    /// under the lock. Returns `None` if the id is absent or already draining, so a
    /// second concurrent stop is a no-op. The tombstone outlives the lock so a
    /// racing `start` is rejected until [`CaptureRegistry::finish_stop`] clears it.
    fn begin_stop(&self, meeting_id: &str) -> Option<ActiveCapture> {
        let mut active = self.active.lock().unwrap();
        match active.remove(meeting_id) {
            Some(CaptureSlot::Active(capture)) => {
                active.insert(meeting_id.to_string(), CaptureSlot::Stopping);
                Some(capture)
            }
            // Already draining: restore the tombstone and report nothing to do.
            Some(CaptureSlot::Stopping) => {
                active.insert(meeting_id.to_string(), CaptureSlot::Stopping);
                None
            }
            None => None,
        }
    }

    /// Clear the `Stopping` tombstone once the drain has completed, freeing the id.
    fn finish_stop(&self, meeting_id: &str) {
        self.active.lock().unwrap().remove(meeting_id);
    }

    /// Stop capture for `meeting_id`, draining and finishing all worker tasks. The
    /// slot is held as a `Stopping` tombstone across the drain so a concurrent
    /// `start` for the same id can't insert a second coexisting capture (#2164).
    pub async fn stop(&self, meeting_id: &str) -> CaptureStopSummary {
        self.stop_with_timeout(meeting_id, STOP_DRAIN_TIMEOUT).await
    }

    /// Stop with an explicit per-step drain timeout (the public [`stop`] uses
    /// [`STOP_DRAIN_TIMEOUT`]). Bounding each drain step and *always* clearing the
    /// `Stopping` tombstone guarantees a wedged worker (e.g. a stuck transcribe)
    /// or a hung native `source.stop()` (joining a wedged WASAPI thread) can't
    /// leave the meeting id permanently un-restartable (#2175). A timed-out task
    /// is detached, not joined.
    ///
    /// [`stop`]: CaptureRegistry::stop
    async fn stop_with_timeout(
        &self,
        meeting_id: &str,
        drain_timeout: Duration,
    ) -> CaptureStopSummary {
        let Some(mut capture) = self.begin_stop(meeting_id) else {
            let ingress = self.take_ingress_summary(meeting_id);
            return CaptureStreamStats::default().summary(
                false,
                ingress,
                &CaptureSourceStats::default(),
                false,
                false,
                ApmDiagnostics::default(),
            );
        };
        // Stop native sources first so their channels close and routers can exit.
        if let Some(mut source) = capture.mic_source.take() {
            let join = tauri::async_runtime::spawn_blocking(move || source.stop());
            if tokio::time::timeout(drain_timeout, join).await.is_err() {
                log::warn!(
                    "[meeting] native mic source stop timed out for {meeting_id}; detaching"
                );
            }
        }
        if let Some(mut source) = capture.system_source.take() {
            let join = tauri::async_runtime::spawn_blocking(move || source.stop());
            if tokio::time::timeout(drain_timeout, join).await.is_err() {
                log::warn!("[meeting] native source stop timed out for {meeting_id}; detaching");
            }
        }
        for task in capture.tasks.drain(..) {
            if tokio::time::timeout(drain_timeout, task).await.is_err() {
                log::warn!("[meeting] capture worker drain timed out for {meeting_id}; detaching");
            }
        }
        let ingress = self.take_ingress_summary(meeting_id);
        let apm = capture.apm_diagnostics.lock().unwrap().clone();
        let summary = capture.stats.summary(
            true,
            ingress,
            capture.source_stats.as_ref(),
            capture.native_mic_ready,
            capture.system_audio_ready,
            apm,
        );
        log::info!(
            "[meeting] capture stop summary for {meeting_id}: native_mic_ready={} system_audio_ready={} apm_ready={} mic_source_frames={} system_source_frames={} push_frames={} accepted_push_frames={} dropped_push_frames={} dropped_push_samples={} frames={} speech_frames={} chunks={} emitted_segments={} emitted_gaps={} transcription_error={:?}",
            summary.native_mic_ready,
            summary.system_audio_ready,
            summary.apm_ready,
            summary.native_mic_frame_count,
            summary.system_audio_frame_count,
            summary.push_frame_count,
            summary.accepted_push_frame_count,
            summary.dropped_push_frame_count,
            summary.dropped_push_sample_count,
            summary.frame_count,
            summary.speech_frame_count,
            summary.chunk_count,
            summary.emitted_segment_count,
            summary.emitted_gap_count,
            summary.transcription_error
        );
        // The workers have flushed: take the buffered Them PCM out of the capture
        // (before it drops) and hand it to the post-call diarization pass. Done
        // after the drain so any tail frames the Them worker buffered are included.
        let buffered = std::mem::take(&mut *capture.them_audio.lock().unwrap());
        if !buffered.is_empty() {
            self.finished_them_audio
                .lock()
                .unwrap()
                .insert(meeting_id.to_string(), buffered);
        }
        // Always clear the tombstone — even on a timed-out drain — so the id is
        // never permanently blocked from a fresh capture (#2175).
        self.finish_stop(meeting_id);
        summary
    }

    /// Remove and return the Them PCM buffered for `meeting_id`'s post-call pass,
    /// if any. The buffer is consumed once: a second call returns `None`, so the
    /// in-memory audio is not retained after the reconcile pass reads it.
    pub fn take_finished_them_audio(&self, meeting_id: &str) -> Option<Vec<i16>> {
        self.finished_them_audio.lock().unwrap().remove(meeting_id)
    }
}

fn should_log_dropped_push(drop_count: u64) -> bool {
    drop_count <= 5 || drop_count.is_power_of_two()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::capture::FrameSender;
    use std::sync::Mutex;

    struct SequenceTranscriber {
        texts: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl ChunkTranscriber for SequenceTranscriber {
        async fn transcribe(
            &self,
            _chunk: &Chunk,
        ) -> Result<
            Vec<crate::audio::transcribe::DiarizedSegment>,
            crate::audio::transcribe::TranscribeError,
        > {
            let mut texts = self.texts.lock().unwrap();
            if texts.is_empty() {
                Err(crate::audio::transcribe::TranscribeError::Empty)
            } else {
                Ok(vec![crate::audio::transcribe::DiarizedSegment {
                    speaker_label: None,
                    start_ms: 0,
                    end_ms: 100,
                    text: texts.remove(0),
                }])
            }
        }
    }

    #[derive(Default)]
    struct CollectingSink {
        segments: Mutex<Vec<TranscriptSegment>>,
    }

    #[async_trait]
    impl SegmentSink for CollectingSink {
        async fn segment(&self, segment: TranscriptSegment) {
            self.segments.lock().unwrap().push(segment);
        }
    }

    fn test_cfg() -> ChunkCfg {
        ChunkCfg {
            sample_rate: 1_000,
            frame_ms: 10,
            silence_ms: 50,
            min_window_ms: 40,
            max_window_ms: 200,
            rms_threshold: 100.0,
        }
    }

    fn pcm(value: i16, ms: usize) -> Vec<i16> {
        vec![value; ms]
    }

    fn tone(samples: usize, amplitude: i16) -> Vec<i16> {
        (0..samples)
            .map(|index| {
                let phase = index as f32 / 8.0;
                (phase.sin() * amplitude as f32).round() as i16
            })
            .collect()
    }

    fn active_capture_for_test(
        tasks: Vec<JoinHandle<()>>,
        stats: Arc<CaptureStreamStats>,
    ) -> ActiveCapture {
        ActiveCapture {
            mic_source: None,
            system_source: None,
            tasks,
            them_audio: Arc::new(StdMutex::new(Vec::new())),
            stats,
            source_stats: Arc::new(CaptureSourceStats::default()),
            apm_diagnostics: Arc::new(StdMutex::new(ApmDiagnostics::default())),
            e2e_injection_enabled: false,
            native_mic_ready: true,
            system_audio_ready: false,
        }
    }

    #[tokio::test]
    async fn pipeline_yields_ordered_segments_from_a_fake_source() {
        use crate::audio::capture::AudioCaptureSource;
        use crate::audio::capture::fake::FakePcmSource;

        // Two utterances separated by silence -> two transcribed segments.
        let samples = [pcm(1_000, 80), pcm(0, 60), pcm(1_000, 80), pcm(0, 60)].concat();
        let (tx, rx) = unbounded_channel();
        FakePcmSource::from_samples(samples, 1_000)
            .start(tx)
            .unwrap();

        let transcriber: Arc<dyn ChunkTranscriber + Send + Sync> = Arc::new(SequenceTranscriber {
            texts: Mutex::new(vec!["first".to_string(), "second".to_string()]),
        });
        let sink = Arc::new(CollectingSink::default());
        let collected: Arc<dyn SegmentSink> = sink.clone();
        let stats = Arc::new(CaptureStreamStats::default());

        run_capture_stream(
            "meeting-1".to_string(),
            Speaker::Me,
            rx,
            transcriber,
            Arc::new(AtomicI64::new(0)),
            test_cfg(),
            RetryConfig {
                max_attempts: 1,
                initial_backoff_ms: 0,
                max_backoff_ms: 0,
                retry_on_empty: true,
            },
            collected,
            stats,
            None,
        )
        .await;

        let segments = sink.segments.lock().unwrap();
        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].text, "first");
        assert_eq!(segments[0].seq, 0);
        assert_eq!(segments[0].speaker, Speaker::Me);
        assert_eq!(segments[1].text, "second");
        assert_eq!(segments[1].seq, 1);
        assert_eq!(segments[1].status, SegmentStatus::Ok);
    }

    #[tokio::test]
    async fn pipeline_marks_failed_windows_as_gaps() {
        use crate::audio::capture::AudioCaptureSource;
        use crate::audio::capture::fake::FakePcmSource;

        let samples = [pcm(1_000, 80), pcm(0, 60)].concat();
        let (tx, rx) = unbounded_channel();
        FakePcmSource::from_samples(samples, 1_000)
            .start(tx)
            .unwrap();

        // No texts -> transcription always fails -> the window becomes a gap.
        let transcriber: Arc<dyn ChunkTranscriber + Send + Sync> = Arc::new(SequenceTranscriber {
            texts: Mutex::new(vec![]),
        });
        let sink = Arc::new(CollectingSink::default());
        let collected: Arc<dyn SegmentSink> = sink.clone();
        let stats = Arc::new(CaptureStreamStats::default());

        run_capture_stream(
            "meeting-1".to_string(),
            Speaker::Me,
            rx,
            transcriber,
            Arc::new(AtomicI64::new(0)),
            test_cfg(),
            RetryConfig {
                max_attempts: 1,
                initial_backoff_ms: 0,
                max_backoff_ms: 0,
                retry_on_empty: true,
            },
            collected,
            stats.clone(),
            None,
        )
        .await;

        let segments = sink.segments.lock().unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].status, SegmentStatus::Gap);
        assert!(segments[0].text.is_empty());
        let summary = stats.summary(
            true,
            CaptureIngressSummary::default(),
            &CaptureSourceStats::default(),
            true,
            false,
            ApmDiagnostics::default(),
        );
        assert!(summary.had_capture);
        assert!(summary.frame_count > 0);
        assert!(summary.speech_frame_count > 0);
        assert_eq!(summary.chunk_count, 1);
        assert_eq!(summary.emitted_segment_count, 1);
        assert_eq!(summary.emitted_gap_count, 1);
        // Empty is genuine silence, not a service outage: no surfaced cause.
        assert_eq!(summary.transcription_error, None);
    }

    #[test]
    fn transport_failure_surfaces_in_summary_but_empty_does_not() {
        // #2606: a terminal Empty stays a plain gap (real silence), but a
        // transport failure (quota/auth/5xx) is the actionable cause and must
        // surface so the stop path can name it instead of blaming the user.
        let stats = CaptureStreamStats::default();

        stats.record_transcription_failure(&TranscribeError::Empty);
        let summary = stats.summary(
            true,
            CaptureIngressSummary::default(),
            &CaptureSourceStats::default(),
            true,
            false,
            ApmDiagnostics::default(),
        );
        assert_eq!(summary.transcription_error, None);

        stats.record_transcription_failure(&TranscribeError::Transport(
            "whisper upstream 429: insufficient_quota".to_string(),
        ));
        let summary = stats.summary(
            true,
            CaptureIngressSummary::default(),
            &CaptureSourceStats::default(),
            true,
            false,
            ApmDiagnostics::default(),
        );
        assert_eq!(
            summary.transcription_error.as_deref(),
            Some("whisper upstream 429: insufficient_quota")
        );
    }

    #[test]
    fn me_uses_plain_text_and_them_is_diarized() {
        // #2152 cost contract: the single-speaker mic must NOT use the costly
        // diarize model; only the multi-speaker system stream is diarized.
        assert_eq!(
            transcription_mode_for(&Speaker::Me),
            TranscriptionMode::Text
        );
        assert_eq!(
            transcription_mode_for(&Speaker::Them),
            TranscriptionMode::Diarized
        );
    }

    #[test]
    fn stop_keeps_tombstone_until_drain_completes_so_start_cannot_double_insert() {
        // #2164: stop() removes the entry then awaits the drain off the lock. A
        // racing start(id) used to pass the contains_key guard and insert a second
        // ActiveCapture. The Stopping tombstone keeps the slot occupied for the
        // whole drain so start() is rejected until finish_stop clears it.
        let registry = CaptureRegistry::default();
        registry.active.lock().unwrap().insert(
            "m1".to_string(),
            CaptureSlot::Active(active_capture_for_test(
                Vec::new(),
                Arc::new(CaptureStreamStats::default()),
            )),
        );
        assert!(registry.is_active("m1"));
        assert!(registry.slot_occupied("m1"));

        // Drain begins: the capture is taken and a tombstone left behind.
        let taken = registry.begin_stop("m1");
        assert!(taken.is_some());
        // Mid-drain the slot is occupied (start() guards on this) but not "active",
        // so a racing start is rejected rather than inserting a second capture.
        assert!(registry.slot_occupied("m1"));
        assert!(!registry.is_active("m1"));
        // A second concurrent stop while draining is a no-op.
        assert!(registry.begin_stop("m1").is_none());
        assert!(registry.slot_occupied("m1"));

        // Drain done: the tombstone clears and the id is free for a new capture.
        registry.finish_stop("m1");
        assert!(!registry.slot_occupied("m1"));
        assert!(!registry.is_active("m1"));
    }

    #[tokio::test]
    async fn stop_clears_tombstone_even_when_a_worker_hangs() {
        // #2175: stop() left a Stopping tombstone and awaited the drain unbounded.
        // A wedged worker (e.g. a stuck transcribe) or a hung native source.stop()
        // would never reach finish_stop, leaving the id permanently un-restartable.
        // The bounded drain must always clear the tombstone.
        let registry = CaptureRegistry::default();
        let (_me_tx, me_rx) = unbounded_channel::<PcmFrame>();
        // A worker that never finishes, even after its channel closes.
        let hung = tauri::async_runtime::spawn(async move {
            let _keep_rx = me_rx;
            std::future::pending::<()>().await;
        });
        registry.active.lock().unwrap().insert(
            "m1".to_string(),
            CaptureSlot::Active(active_capture_for_test(
                vec![hung],
                Arc::new(CaptureStreamStats::default()),
            )),
        );

        // A short per-step timeout keeps the test fast; production uses 5s.
        registry
            .stop_with_timeout("m1", Duration::from_millis(50))
            .await;

        // The id is freed for a fresh capture, not leaked behind a tombstone.
        assert!(!registry.slot_occupied("m1"));
        assert!(!registry.is_active("m1"));
    }

    #[tokio::test]
    async fn stop_summary_reports_active_capture_without_frames() {
        let registry = CaptureRegistry::default();
        registry.active.lock().unwrap().insert(
            "m1".to_string(),
            CaptureSlot::Active(active_capture_for_test(
                Vec::new(),
                Arc::new(CaptureStreamStats::default()),
            )),
        );

        let summary = registry
            .stop_with_timeout("m1", Duration::from_millis(50))
            .await;

        assert!(summary.had_capture);
        assert_eq!(summary.frame_count, 0);
        assert_eq!(summary.chunk_count, 0);
        assert_eq!(summary.emitted_segment_count, 0);
        assert_eq!(summary.push_frame_count, 0);
        assert_eq!(summary.dropped_push_frame_count, 0);
        assert!(!registry.slot_occupied("m1"));
    }

    #[tokio::test]
    async fn stop_summary_reports_frames_dropped_before_active_capture() {
        let registry = CaptureRegistry::default();

        registry.push_frame("m1", Speaker::Me, vec![1, 2, 3]);

        let summary = registry
            .stop_with_timeout("m1", Duration::from_millis(50))
            .await;

        assert!(!summary.had_capture);
        assert_eq!(summary.frame_count, 0);
        assert_eq!(summary.push_frame_count, 1);
        assert_eq!(summary.accepted_push_frame_count, 0);
        assert_eq!(summary.dropped_push_frame_count, 1);
        assert_eq!(summary.dropped_push_sample_count, 3);
    }

    #[tokio::test]
    async fn push_frame_accepts_when_e2e_injection_is_enabled() {
        let registry = CaptureRegistry::default();
        let mut capture =
            active_capture_for_test(Vec::new(), Arc::new(CaptureStreamStats::default()));
        capture.e2e_injection_enabled = true;
        capture.native_mic_ready = false;
        capture.system_audio_ready = true;
        registry
            .active
            .lock()
            .unwrap()
            .insert("m1".to_string(), CaptureSlot::Active(capture));
        registry.reset_ingress_summary("m1");

        assert!(registry.push_frame(
            "m1",
            Speaker::Them,
            tone(TARGET_SAMPLE_RATE as usize / 2, 8_000),
        ));
        let summary = registry
            .stop_with_timeout("m1", Duration::from_millis(50))
            .await;

        assert!(summary.had_capture);
        assert!(!summary.native_mic_ready);
        assert!(summary.system_audio_ready);
        assert_eq!(summary.push_frame_count, 1);
        assert_eq!(summary.accepted_push_frame_count, 1);
        assert_eq!(summary.dropped_push_frame_count, 0);
        assert_eq!(summary.system_audio_frame_count, 1);
        assert_eq!(summary.frame_count, 1);
        assert!(summary.speech_frame_count > 0);
    }

    #[tokio::test]
    async fn registry_start_owns_native_mic_without_renderer_pushes() {
        use crate::audio::capture::fake::FakePcmSource;

        let registry = CaptureRegistry::default();
        let samples = [
            tone(TARGET_SAMPLE_RATE as usize / 2, 8_000),
            vec![0; TARGET_SAMPLE_RATE as usize * 3 / 5],
        ]
        .concat();
        let mic_source = FakePcmSource::from_samples(samples, TARGET_SAMPLE_RATE as usize / 100);
        let me_transcriber: Arc<dyn ChunkTranscriber + Send + Sync> =
            Arc::new(SequenceTranscriber {
                texts: Mutex::new(vec!["native me".to_string()]),
            });
        let them_transcriber: Arc<dyn ChunkTranscriber + Send + Sync> =
            Arc::new(SequenceTranscriber {
                texts: Mutex::new(vec!["native them".to_string()]),
            });
        let sink = Arc::new(CollectingSink::default());
        let collected: Arc<dyn SegmentSink> = sink.clone();

        registry
            .start_with_sources(
                None,
                "m1",
                Some(Box::new(mic_source)),
                None,
                me_transcriber,
                them_transcriber,
                collected,
            )
            .expect("native mic source should start without renderer audio");

        let summary = registry
            .stop_with_timeout("m1", Duration::from_secs(1))
            .await;

        let segments = sink.segments.lock().unwrap();
        assert!(summary.had_capture);
        assert!(summary.native_mic_ready);
        assert!(summary.apm_ready);
        assert!(summary.apm_active);
        assert!(!summary.apm.echo_canceller_enabled);
        assert!(summary.native_mic_frame_count > 0);
        assert_eq!(summary.push_frame_count, 0);
        assert_eq!(summary.accepted_push_frame_count, 0);
        assert_eq!(summary.dropped_push_frame_count, 0);
        assert!(summary.frame_count > 0);
        assert!(segments.iter().any(|segment| {
            segment.speaker == Speaker::Me
                && segment.status == SegmentStatus::Ok
                && segment.text == "native me"
        }));
    }

    #[tokio::test]
    async fn registry_start_degrades_to_system_audio_when_mic_is_unavailable() {
        use crate::audio::capture::fake::FakePcmSource;

        let registry = CaptureRegistry::default();
        let system_source = FakePcmSource::from_samples(
            [
                tone(TARGET_SAMPLE_RATE as usize / 2, 8_000),
                vec![0; TARGET_SAMPLE_RATE as usize],
            ]
            .concat(),
            TARGET_SAMPLE_RATE as usize / 100,
        );
        let me_transcriber: Arc<dyn ChunkTranscriber + Send + Sync> =
            Arc::new(SequenceTranscriber {
                texts: Mutex::new(vec!["native me should not run".to_string()]),
            });
        let them_transcriber: Arc<dyn ChunkTranscriber + Send + Sync> =
            Arc::new(SequenceTranscriber {
                texts: Mutex::new(vec!["native them".to_string()]),
            });
        let sink = Arc::new(CollectingSink::default());
        let collected: Arc<dyn SegmentSink> = sink.clone();

        registry
            .start_with_sources(
                None,
                "m1",
                Some(Box::new(FailingSource {
                    error: CaptureError::Device("no default input device is available".to_string()),
                })),
                Some(Box::new(system_source)),
                me_transcriber,
                them_transcriber,
                collected,
            )
            .expect("system audio should start even when the mic is unavailable");

        let summary = registry
            .stop_with_timeout("m1", Duration::from_secs(1))
            .await;

        let segments = sink.segments.lock().unwrap();
        assert!(summary.had_capture);
        assert!(!summary.native_mic_ready);
        assert!(summary.system_audio_ready);
        assert!(!summary.apm_ready);
        assert!(!summary.apm_active);
        assert_eq!(summary.native_mic_frame_count, 0);
        assert!(summary.system_audio_frame_count > 0);
        assert!(summary.frame_count > 0);
        assert!(segments.iter().any(|segment| {
            segment.speaker == Speaker::Them
                && segment.status == SegmentStatus::Ok
                && segment.text == "native them"
        }));
        assert!(
            !segments
                .iter()
                .any(|segment| segment.speaker == Speaker::Me)
        );
    }

    struct FailingSource {
        error: CaptureError,
    }

    impl AudioCaptureSource for FailingSource {
        fn start(&mut self, _sink: FrameSender) -> Result<(), CaptureError> {
            Err(self.error.clone())
        }

        fn stop(&mut self) {}
    }

    #[test]
    fn system_audio_permission_failure_is_capture_startup_error() {
        // #2217: on supported native capture platforms, a failed system-audio
        // tap/loopback must reject startup instead of recording a mic-only
        // session that later fails with an empty transcript.
        let result = prepare_system_audio_stream(
            "m1",
            Some(Box::new(FailingSource {
                error: CaptureError::Permission("audio-capture permission denied".to_string()),
            })),
        );

        match result {
            Err(err) => assert_eq!(
                err,
                CaptureError::Permission("audio-capture permission denied".to_string())
            ),
            Ok(_) => panic!("permission failures must reject capture startup"),
        }
    }

    #[test]
    fn unsupported_system_audio_remains_mic_only() {
        // Unsupported platform/build remains a valid mic-only capture path; only
        // a supported source that fails to initialize is fatal.
        let stream = prepare_system_audio_stream(
            "m1",
            Some(Box::new(FailingSource {
                error: CaptureError::Unsupported(
                    "system-audio capture unsupported on this platform".to_string(),
                ),
            })),
        )
        .expect("unsupported system audio should degrade to mic-only");

        assert!(!stream.has_system_audio());
    }
}
