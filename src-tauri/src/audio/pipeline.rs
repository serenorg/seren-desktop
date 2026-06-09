// ABOUTME: Live transcription orchestrator: frames -> chunk -> transcribe -> persist -> emit.
// ABOUTME: Owns per-meeting capture streams and the call-end drain; testable via a fake source.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use uuid::Uuid;

use crate::audio::capture::{AudioCaptureSource, CaptureError, PcmFrame, TARGET_SAMPLE_RATE};
use crate::audio::chunker::{Chunk, ChunkCfg, StreamingChunker};
use crate::audio::transcribe::{
    ChunkTranscriber, GatewayTranscriber, RetryConfig, TranscriptionMode,
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

    fn summary(&self, had_capture: bool, ingress: CaptureIngressSummary) -> CaptureStopSummary {
        CaptureStopSummary {
            had_capture,
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
        Err(_) => {
            // A failed window becomes a single Gap spanning the chunk so audio is
            // never silently dropped.
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

/// One in-flight meeting's capture streams and their worker tasks.
struct ActiveCapture {
    me_tx: UnboundedSender<PcmFrame>,
    them_tx: Option<UnboundedSender<PcmFrame>>,
    // Native system-audio source (WASAPI loopback / Core Audio tap) feeding `them_tx`.
    system_source: Option<Box<dyn AudioCaptureSource>>,
    tasks: Vec<JoinHandle<()>>,
    // Full Them PCM buffered in memory for the post-call diarization pass. The
    // Them worker appends frames here; `stop` takes it for [`reconcile_meeting_speakers`].
    them_audio: Arc<StdMutex<Vec<i16>>>,
    stats: Arc<CaptureStreamStats>,
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
/// Returns `None` where native capture is not yet available so the meeting still
/// captures the "Me" stream.
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

#[derive(Default)]
struct PreparedSystemAudioStream {
    source: Option<Box<dyn AudioCaptureSource>>,
    tx: Option<UnboundedSender<PcmFrame>>,
    rx: Option<UnboundedReceiver<PcmFrame>>,
}

impl PreparedSystemAudioStream {
    fn has_system_audio(&self) -> bool {
        self.tx.is_some()
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
                tx: Some(tx),
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
    /// Begin capturing the "Me" stream for `meeting_id`. Frames arrive via
    /// [`CaptureRegistry::push_frame`]; the worker transcribes and persists them.
    pub fn start(&self, app: &AppHandle, meeting_id: &str) -> Result<(), String> {
        log::info!("[meeting] capture registry start requested for {meeting_id}");
        let mut active = self.active.lock().unwrap();
        // Reject if the id is already live OR draining (`Stopping` tombstone): a
        // start that raced a still-running stop must not insert a second capture.
        if active.contains_key(meeting_id) {
            log::warn!("[meeting] capture start ignored; slot already occupied for {meeting_id}");
            return Ok(());
        }
        let prepared_system_audio = prepare_system_audio_stream(meeting_id, system_audio_source())
            .map_err(|err| format!("system-audio capture unavailable: {err}"))?;
        let PreparedSystemAudioStream {
            source: system_source,
            tx: system_tx,
            rx: system_rx,
        } = prepared_system_audio;
        let has_system_audio = system_tx.is_some();

        // Me and Them share one sequence counter so segments order globally.
        let seq = Arc::new(AtomicI64::new(0));
        let stats = Arc::new(CaptureStreamStats::default());
        self.reset_ingress_summary(meeting_id);

        // Me is the single-speaker mic -> plain whisper-1 text (cheap); only the
        // multi-speaker Them stream is diarized (#2152).
        let me_transcriber: Arc<dyn ChunkTranscriber + Send + Sync> = Arc::new(
            GatewayTranscriber::with_mode(app.clone(), transcription_mode_for(&Speaker::Me)),
        );
        let me_sink: Arc<dyn SegmentSink> = Arc::new(DbEmitSink { app: app.clone() });
        let (me_tx, me_rx) = unbounded_channel();
        // The Me mic is single-speaker; it is never buffered for the post-call pass.
        let mut tasks = vec![tauri::async_runtime::spawn(run_capture_stream(
            meeting_id.to_string(),
            Speaker::Me,
            me_rx,
            me_transcriber,
            seq.clone(),
            ChunkCfg::default(),
            RetryConfig::default(),
            me_sink,
            stats.clone(),
            None,
        ))];

        // Shared buffer the Them worker fills for the post-call diarization pass.
        let them_audio: Arc<StdMutex<Vec<i16>>> = Arc::new(StdMutex::new(Vec::new()));

        let mut them_tx = None;
        if let Some(rx) = system_rx {
            let them_transcriber: Arc<dyn ChunkTranscriber + Send + Sync> = Arc::new(
                GatewayTranscriber::with_mode(app.clone(), transcription_mode_for(&Speaker::Them)),
            );
            let them_sink: Arc<dyn SegmentSink> = Arc::new(DbEmitSink { app: app.clone() });
            tasks.push(tauri::async_runtime::spawn(run_capture_stream(
                meeting_id.to_string(),
                Speaker::Them,
                rx,
                them_transcriber,
                seq,
                ChunkCfg::default(),
                RetryConfig::default(),
                them_sink,
                stats.clone(),
                Some(them_audio.clone()),
            )));
            them_tx = system_tx;
        }

        active.insert(
            meeting_id.to_string(),
            CaptureSlot::Active(ActiveCapture {
                me_tx,
                them_tx,
                system_source,
                tasks,
                them_audio,
                stats,
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
    pub fn push_frame(&self, meeting_id: &str, speaker: Speaker, samples: Vec<i16>) {
        let sample_count = samples.len() as u64;
        let active = self.active.lock().unwrap();
        let drop_reason = match active.get(meeting_id) {
            Some(CaptureSlot::Active(capture)) => {
                let sender = match &speaker {
                    Speaker::Me => Some(&capture.me_tx),
                    // The system ("Them") stream arrives once native capture lands.
                    Speaker::Them => capture.them_tx.as_ref(),
                };
                if let Some(sender) = sender {
                    if sender.send(PcmFrame { samples }).is_ok() {
                        drop(active);
                        self.record_accepted_push_frame(meeting_id);
                        return;
                    }
                    "channel_closed"
                } else {
                    "speaker_not_captured"
                }
            }
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
    }

    fn reset_ingress_summary(&self, meeting_id: &str) {
        self.ingress
            .lock()
            .unwrap()
            .insert(meeting_id.to_string(), CaptureIngressSummary::default());
    }

    fn record_accepted_push_frame(&self, meeting_id: &str) {
        let mut ingress = self.ingress.lock().unwrap();
        let summary = ingress.entry(meeting_id.to_string()).or_default();
        summary.push_frame_count += 1;
        summary.accepted_push_frame_count += 1;
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
            return CaptureStreamStats::default().summary(false, ingress);
        };
        // Stop the native source first so it stops feeding the "Them" channel.
        if let Some(mut source) = capture.system_source.take() {
            let join = tauri::async_runtime::spawn_blocking(move || source.stop());
            if tokio::time::timeout(drain_timeout, join).await.is_err() {
                log::warn!("[meeting] native source stop timed out for {meeting_id}; detaching");
            }
        }
        // Dropping the senders closes the channels so the workers flush and exit.
        drop(capture.me_tx);
        drop(capture.them_tx);
        for task in capture.tasks.drain(..) {
            if tokio::time::timeout(drain_timeout, task).await.is_err() {
                log::warn!("[meeting] capture worker drain timed out for {meeting_id}; detaching");
            }
        }
        let ingress = self.take_ingress_summary(meeting_id);
        let summary = capture.stats.summary(true, ingress);
        log::info!(
            "[meeting] capture stop summary for {meeting_id}: push_frames={} accepted_push_frames={} dropped_push_frames={} dropped_push_samples={} frames={} speech_frames={} chunks={} emitted_segments={} emitted_gaps={}",
            summary.push_frame_count,
            summary.accepted_push_frame_count,
            summary.dropped_push_frame_count,
            summary.dropped_push_sample_count,
            summary.frame_count,
            summary.speech_frame_count,
            summary.chunk_count,
            summary.emitted_segment_count,
            summary.emitted_gap_count
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
        let summary = stats.summary(true, CaptureIngressSummary::default());
        assert!(summary.had_capture);
        assert!(summary.frame_count > 0);
        assert!(summary.speech_frame_count > 0);
        assert_eq!(summary.chunk_count, 1);
        assert_eq!(summary.emitted_segment_count, 1);
        assert_eq!(summary.emitted_gap_count, 1);
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
        let (me_tx, _me_rx) = unbounded_channel();
        registry.active.lock().unwrap().insert(
            "m1".to_string(),
            CaptureSlot::Active(ActiveCapture {
                me_tx,
                them_tx: None,
                system_source: None,
                tasks: Vec::new(),
                them_audio: Arc::new(StdMutex::new(Vec::new())),
                stats: Arc::new(CaptureStreamStats::default()),
            }),
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
        let (me_tx, me_rx) = unbounded_channel::<PcmFrame>();
        // A worker that never finishes, even after its channel closes.
        let hung = tauri::async_runtime::spawn(async move {
            let _keep_rx = me_rx;
            std::future::pending::<()>().await;
        });
        registry.active.lock().unwrap().insert(
            "m1".to_string(),
            CaptureSlot::Active(ActiveCapture {
                me_tx,
                them_tx: None,
                system_source: None,
                tasks: vec![hung],
                them_audio: Arc::new(StdMutex::new(Vec::new())),
                stats: Arc::new(CaptureStreamStats::default()),
            }),
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
        let (me_tx, _me_rx) = unbounded_channel();
        registry.active.lock().unwrap().insert(
            "m1".to_string(),
            CaptureSlot::Active(ActiveCapture {
                me_tx,
                them_tx: None,
                system_source: None,
                tasks: Vec::new(),
                them_audio: Arc::new(StdMutex::new(Vec::new())),
                stats: Arc::new(CaptureStreamStats::default()),
            }),
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
