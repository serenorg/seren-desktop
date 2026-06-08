// ABOUTME: Live transcription orchestrator: frames -> chunk -> transcribe -> persist -> emit.
// ABOUTME: Owns per-meeting capture streams and the call-end drain; testable via a fake source.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicI64, Ordering};

use async_trait::async_trait;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use uuid::Uuid;

use crate::audio::capture::{AudioCaptureSource, PcmFrame};
use crate::audio::chunker::{Chunk, ChunkCfg, StreamingChunker};
use crate::audio::transcribe::{
    ChunkTranscriber, GatewayTranscriber, RetryConfig, transcribe_chunk_with_retry,
};
use crate::audio::types::{SegmentStatus, Speaker, SpeakerSource, TranscriptSegment};
use crate::commands::audio::{NewTranscriptSegment, insert_transcript_segment, now_ms};
use crate::services::database::DbPool;

/// Receives finished transcript segments (persist + emit in prod, collect in tests).
#[async_trait]
pub trait SegmentSink: Send + Sync {
    async fn segment(&self, segment: TranscriptSegment);
}

/// Drive one capture stream end to end: read frames, chunk on silence, transcribe
/// each window with retry, and hand finished segments to `sink`. A failed window
/// becomes a `Gap` segment so audio is never silently dropped.
pub async fn run_capture_stream(
    meeting_id: String,
    speaker: Speaker,
    mut frames: UnboundedReceiver<PcmFrame>,
    transcriber: Arc<dyn ChunkTranscriber + Send + Sync>,
    seq: Arc<AtomicI64>,
    cfg: ChunkCfg,
    retry: RetryConfig,
    sink: Arc<dyn SegmentSink>,
) {
    let mut chunker = StreamingChunker::new(cfg);
    while let Some(frame) = frames.recv().await {
        for chunk in chunker.push(&frame.samples) {
            emit_segment(&meeting_id, &speaker, chunk, transcriber.as_ref(), retry, &seq, sink.as_ref())
                .await;
        }
    }
    for chunk in chunker.finish() {
        emit_segment(&meeting_id, &speaker, chunk, transcriber.as_ref(), retry, &seq, sink.as_ref())
            .await;
    }
}

async fn emit_segment(
    meeting_id: &str,
    speaker: &Speaker,
    chunk: Chunk,
    transcriber: &(dyn ChunkTranscriber + Send + Sync),
    retry: RetryConfig,
    seq: &AtomicI64,
    sink: &dyn SegmentSink,
) {
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

/// Tauri-managed registry of active meeting captures, keyed by meeting id.
#[derive(Default)]
pub struct CaptureRegistry {
    active: Arc<StdMutex<HashMap<String, ActiveCapture>>>,
}

impl CaptureRegistry {
    /// Begin capturing the "Me" stream for `meeting_id`. Frames arrive via
    /// [`CaptureRegistry::push_frame`]; the worker transcribes and persists them.
    pub fn start(&self, app: &AppHandle, meeting_id: &str) {
        let mut active = self.active.lock().unwrap();
        if active.contains_key(meeting_id) {
            return;
        }
        // Me and Them share one sequence counter so segments order globally.
        let seq = Arc::new(AtomicI64::new(0));

        let me_transcriber: Arc<dyn ChunkTranscriber + Send + Sync> =
            Arc::new(GatewayTranscriber::new_diarized(app.clone()));
        let me_sink: Arc<dyn SegmentSink> = Arc::new(DbEmitSink { app: app.clone() });
        let (me_tx, me_rx) = unbounded_channel();
        let mut tasks = vec![tauri::async_runtime::spawn(run_capture_stream(
            meeting_id.to_string(),
            Speaker::Me,
            me_rx,
            me_transcriber,
            seq.clone(),
            ChunkCfg::default(),
            RetryConfig::default(),
            me_sink,
        ))];

        // System audio ("Them") via the native loopback/tap source, when supported.
        let mut them_tx = None;
        let mut system_source = system_audio_source();
        if let Some(source) = system_source.as_mut() {
            let them_transcriber: Arc<dyn ChunkTranscriber + Send + Sync> =
                Arc::new(GatewayTranscriber::new_diarized(app.clone()));
            let them_sink: Arc<dyn SegmentSink> = Arc::new(DbEmitSink { app: app.clone() });
            let (tx, rx) = unbounded_channel();
            tasks.push(tauri::async_runtime::spawn(run_capture_stream(
                meeting_id.to_string(),
                Speaker::Them,
                rx,
                them_transcriber,
                seq,
                ChunkCfg::default(),
                RetryConfig::default(),
                them_sink,
            )));
            match source.start(tx.clone()) {
                Ok(()) => them_tx = Some(tx),
                Err(err) => {
                    log::warn!("[meeting] system-audio capture unavailable: {err}")
                }
            }
        }

        active.insert(
            meeting_id.to_string(),
            ActiveCapture {
                me_tx,
                them_tx,
                system_source,
                tasks,
            },
        );
    }

    /// Whether a capture is currently active for `meeting_id`.
    pub fn is_active(&self, meeting_id: &str) -> bool {
        self.active.lock().unwrap().contains_key(meeting_id)
    }

    /// Push a normalized 16 kHz mono frame into the capture stream for `speaker`.
    pub fn push_frame(&self, meeting_id: &str, speaker: Speaker, samples: Vec<i16>) {
        let active = self.active.lock().unwrap();
        if let Some(capture) = active.get(meeting_id) {
            let sender = match speaker {
                Speaker::Me => Some(&capture.me_tx),
                // The system ("Them") stream arrives once native capture lands.
                Speaker::Them => capture.them_tx.as_ref(),
            };
            if let Some(sender) = sender {
                let _ = sender.send(PcmFrame { samples });
            }
        }
    }

    /// Stop capture for `meeting_id`, draining and finishing all worker tasks.
    pub async fn stop(&self, meeting_id: &str) {
        let capture = self.active.lock().unwrap().remove(meeting_id);
        let Some(mut capture) = capture else {
            return;
        };
        // Stop the native source first so it stops feeding the "Them" channel.
        if let Some(mut source) = capture.system_source.take() {
            let _ = tauri::async_runtime::spawn_blocking(move || source.stop()).await;
        }
        // Dropping the senders closes the channels so the workers flush and exit.
        drop(capture.me_tx);
        drop(capture.them_tx);
        for task in capture.tasks {
            let _ = task.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
        FakePcmSource::from_samples(samples, 1_000).start(tx).unwrap();

        let transcriber: Arc<dyn ChunkTranscriber + Send + Sync> = Arc::new(SequenceTranscriber {
            texts: Mutex::new(vec!["first".to_string(), "second".to_string()]),
        });
        let sink = Arc::new(CollectingSink::default());
        let collected: Arc<dyn SegmentSink> = sink.clone();

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
        FakePcmSource::from_samples(samples, 1_000).start(tx).unwrap();

        // No texts -> transcription always fails -> the window becomes a gap.
        let transcriber: Arc<dyn ChunkTranscriber + Send + Sync> = Arc::new(SequenceTranscriber {
            texts: Mutex::new(vec![]),
        });
        let sink = Arc::new(CollectingSink::default());
        let collected: Arc<dyn SegmentSink> = sink.clone();

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
        )
        .await;

        let segments = sink.segments.lock().unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].status, SegmentStatus::Gap);
        assert!(segments[0].text.is_empty());
    }
}
