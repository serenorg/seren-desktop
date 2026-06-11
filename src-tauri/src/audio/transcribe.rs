// ABOUTME: Retryable transcription boundary for Whisper chunk requests.
// ABOUTME: Keeps retry policy deterministic and injectable for unit tests.

use async_trait::async_trait;
use base64::Engine;
use serde_json::json;
use tauri::AppHandle;
use thiserror::Error;

use crate::audio::capture::TARGET_SAMPLE_RATE;
use crate::audio::chunker::Chunk;
use crate::orchestrator::gateway_envelope::{publisher_status, unwrap_publisher_body};

const GATEWAY_BASE_URL: &str = "https://api.serendb.com";
const WHISPER_PUBLISHER: &str = "seren-whisper";
const WHISPER_MODEL: &str = "whisper-1";
const DIARIZE_MODEL: &str = "gpt-4o-transcribe-diarize";
const DIARIZE_RESPONSE_FORMAT: &str = "diarized_json";
const DIARIZE_CHUNKING_STRATEGY: &str = "auto";

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum TranscribeError {
    #[error("transcription transport failed: {0}")]
    Transport(String),
    #[error("transcription returned no text")]
    Empty,
}

/// One diarized utterance returned by the transcriber. `speaker_label` is the raw
/// model label (e.g. "A", "speaker_0") when diarization is available, else `None`.
/// `start_ms`/`end_ms` are relative to the start of the chunk (offset is applied by
/// the pipeline). Plain-text responses yield a single segment with `speaker_label`
/// `None` spanning the whole chunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiarizedSegment {
    pub speaker_label: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Copy)]
pub struct RetryConfig {
    pub max_attempts: usize,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
    /// When false, an empty response is not retried — silence is a terminal
    /// outcome for callers that already VAD-gate their input (dictation, #2349).
    pub retry_on_empty: bool,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            initial_backoff_ms: 250,
            max_backoff_ms: 2_000,
            retry_on_empty: true,
        }
    }
}

#[async_trait]
pub trait ChunkTranscriber {
    async fn transcribe(&self, chunk: &Chunk) -> Result<Vec<DiarizedSegment>, TranscribeError>;
}

/// A transcription result is "empty" when it has no segment carrying non-blank text.
fn has_text(segments: &[DiarizedSegment]) -> bool {
    segments.iter().any(|segment| !segment.text.trim().is_empty())
}

pub async fn transcribe_chunk_with_retry<T>(
    transcriber: &T,
    chunk: &Chunk,
    cfg: RetryConfig,
) -> Result<Vec<DiarizedSegment>, TranscribeError>
where
    T: ChunkTranscriber + Sync + ?Sized,
{
    let attempts = cfg.max_attempts.max(1);
    let mut backoff_ms = cfg.initial_backoff_ms;
    let mut last_error = TranscribeError::Empty;

    for attempt in 1..=attempts {
        match transcriber.transcribe(chunk).await {
            Ok(segments) if has_text(&segments) => return Ok(segments),
            Ok(_) => {
                if !cfg.retry_on_empty {
                    return Err(TranscribeError::Empty);
                }
                last_error = TranscribeError::Empty;
            }
            Err(err) => last_error = err,
        }

        if attempt < attempts && backoff_ms > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(backoff_ms)).await;
            backoff_ms = next_backoff(backoff_ms, cfg.max_backoff_ms);
        }
    }

    Err(last_error)
}

fn next_backoff(current: u64, max: u64) -> u64 {
    if max == 0 {
        return 0;
    }
    current.saturating_mul(2).min(max)
}

/// Encode 16 kHz mono PCM as a WAV byte buffer (RIFF / PCM16, little-endian).
pub fn pcm16_to_wav(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    const CHANNELS: u16 = 1;
    const BITS_PER_SAMPLE: u16 = 16;
    let block_align = CHANNELS * (BITS_PER_SAMPLE / 8);
    let byte_rate = sample_rate * block_align as u32;
    let data_len = (samples.len() as u32) * (BITS_PER_SAMPLE / 8) as u32;

    let mut buf = Vec::with_capacity(44 + data_len as usize);
    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&(36 + data_len).to_le_bytes());
    buf.extend_from_slice(b"WAVE");
    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    buf.extend_from_slice(&1u16.to_le_bytes()); // audio format = PCM
    buf.extend_from_slice(&CHANNELS.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    buf.extend_from_slice(&block_align.to_le_bytes());
    buf.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_len.to_le_bytes());
    for sample in samples {
        buf.extend_from_slice(&sample.to_le_bytes());
    }
    buf
}

/// Build the Gateway multipart-envelope body for a plain-text Whisper request.
/// Used by dictation, which stays on `whisper-1` text transcription.
pub fn build_whisper_envelope(wav: &[u8]) -> serde_json::Value {
    let encoded = base64::engine::general_purpose::STANDARD.encode(wav);
    json!({
        "parts": [
            { "name": "model", "value": WHISPER_MODEL },
            {
                "name": "file",
                "filename": "audio.wav",
                "content_type": "audio/wav",
                "data": encoded
            }
        ]
    })
}

/// Build the Gateway multipart-envelope body for a diarized transcription request.
/// Adds `model`, `response_format`, and `chunking_strategy` so the proxied OpenAI
/// call returns per-speaker `diarized_json` segments.
pub fn build_diarized_envelope(wav: &[u8]) -> serde_json::Value {
    let encoded = base64::engine::general_purpose::STANDARD.encode(wav);
    json!({
        "parts": [
            { "name": "model", "value": DIARIZE_MODEL },
            { "name": "response_format", "value": DIARIZE_RESPONSE_FORMAT },
            { "name": "chunking_strategy", "value": DIARIZE_CHUNKING_STRATEGY },
            {
                "name": "file",
                "filename": "audio.wav",
                "content_type": "audio/wav",
                "data": encoded
            }
        ]
    })
}

/// Whether a transcriber requests diarized segments or plain whisper text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptionMode {
    /// `gpt-4o-transcribe-diarize` -> `diarized_json` (Meeting Mode).
    Diarized,
    /// `whisper-1` plain text (dictation).
    Text,
}

/// Parse an unwrapped transcription body into diarized segments.
///
/// If the body carries a diarized `segments` array, each entry maps to a
/// [`DiarizedSegment`] with its model speaker label and start/end converted from
/// seconds to milliseconds relative to the chunk. If there is no segments array
/// but there is a `text` field, returns a single segment spanning the chunk with
/// no speaker label, so plain-text (non-diarized) responses still work. Empty or
/// whitespace-only text yields [`TranscribeError::Empty`].
fn parse_diarized_body(
    body: &serde_json::Value,
    chunk_len_ms: i64,
) -> Result<Vec<DiarizedSegment>, TranscribeError> {
    // Tolerate either "segments" (documented) or "chunks" as the array key.
    let array = body
        .get("segments")
        .or_else(|| body.get("chunks"))
        .and_then(serde_json::Value::as_array);

    if let Some(entries) = array {
        let segments: Vec<DiarizedSegment> = entries
            .iter()
            .filter_map(|entry| {
                let text = entry
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if text.is_empty() {
                    return None;
                }
                let speaker_label = entry
                    .get("speaker")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
                    .filter(|label| !label.is_empty());
                let start_ms = seconds_to_ms(entry.get("start"));
                let end_ms = seconds_to_ms(entry.get("end")).max(start_ms);
                Some(DiarizedSegment {
                    speaker_label,
                    start_ms,
                    end_ms,
                    text,
                })
            })
            .collect();
        if !segments.is_empty() {
            return Ok(segments);
        }
        // An empty/all-blank segments array still falls through to the top-level
        // `text` (if any) so a partly-populated response is not silently dropped.
    }

    // Plain-text fallback: a single segment spanning the whole chunk.
    let text = body
        .get("text")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(TranscribeError::Empty);
    }
    Ok(vec![DiarizedSegment {
        speaker_label: None,
        start_ms: 0,
        end_ms: chunk_len_ms,
        text,
    }])
}

/// Read an OpenAI timestamp (float seconds) into milliseconds, defaulting to 0.
fn seconds_to_ms(value: Option<&serde_json::Value>) -> i64 {
    value
        .and_then(serde_json::Value::as_f64)
        .map(|seconds| (seconds * 1000.0).round() as i64)
        .filter(|ms| *ms >= 0)
        .unwrap_or(0)
}

/// Real [`ChunkTranscriber`] that POSTs a chunk to the Seren Whisper publisher.
pub struct GatewayTranscriber {
    app: AppHandle,
    client: reqwest::Client,
    mode: TranscriptionMode,
}

impl GatewayTranscriber {
    /// A transcriber for the given [`TranscriptionMode`].
    pub fn with_mode(app: AppHandle, mode: TranscriptionMode) -> Self {
        Self {
            app,
            client: reqwest::Client::new(),
            mode,
        }
    }

    /// A plain-text whisper transcriber (dictation, and the meeting "Me" mic).
    pub fn new(app: AppHandle) -> Self {
        Self::with_mode(app, TranscriptionMode::Text)
    }

    /// A diarized transcriber (the meeting "Them" system-audio stream).
    pub fn new_diarized(app: AppHandle) -> Self {
        Self::with_mode(app, TranscriptionMode::Diarized)
    }
}

/// POST one already-built envelope body to the Whisper publisher and return the
/// unwrapped publisher body. Shared by the per-chunk live transcriber and the
/// post-call full-recording pass so both speak to the Gateway the same way.
async fn post_transcription(
    app: &AppHandle,
    client: &reqwest::Client,
    body: String,
) -> Result<serde_json::Value, TranscribeError> {
    let url = format!(
        "{}/publishers/{}/audio/transcriptions",
        GATEWAY_BASE_URL, WHISPER_PUBLISHER
    );

    let response = crate::auth::authenticated_request(app, client, move |client, token| {
        client
            .post(&url)
            .header("Content-Type", "application/json")
            .bearer_auth(token)
            .body(body.clone())
    })
    .await
    .map_err(TranscribeError::Transport)?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(TranscribeError::Transport(format!(
            "whisper http {status}: {detail}"
        )));
    }

    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|err| TranscribeError::Transport(err.to_string()))?;

    if let Some(status) = publisher_status(&value) {
        if status != 200 {
            let body = unwrap_publisher_body(&value);
            let message = body
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("upstream error");
            return Err(TranscribeError::Transport(format!(
                "whisper upstream {status}: {message}"
            )));
        }
    }

    Ok(unwrap_publisher_body(&value).clone())
}

#[async_trait]
impl ChunkTranscriber for GatewayTranscriber {
    async fn transcribe(&self, chunk: &Chunk) -> Result<Vec<DiarizedSegment>, TranscribeError> {
        let wav = pcm16_to_wav(&chunk.samples, TARGET_SAMPLE_RATE);
        let body = match self.mode {
            TranscriptionMode::Diarized => build_diarized_envelope(&wav).to_string(),
            TranscriptionMode::Text => build_whisper_envelope(&wav).to_string(),
        };

        let body = post_transcription(&self.app, &self.client, body).await?;
        let chunk_len_ms = (chunk.end_ms as i64 - chunk.start_ms as i64).max(0);
        parse_diarized_body(&body, chunk_len_ms)
    }
}

/// OpenAI's transcription upload cap is ~25 MB. 16 kHz mono PCM16 is 32 KB/s, so
/// a WAV stays under ~24 MB up to ~12.5 minutes. We split the full recording into
/// the fewest segments at or under [`MAX_SPLIT_SAMPLES`] so each upload fits, then
/// offset and concatenate the returned segments (see [`split_offsets`]).
///
/// 16 kHz * 60 s * 12 min = 11_520_000 samples (~23 MB WAV) — a safe margin
/// below the 25 MB cap that leaves room for the 44-byte header and rounding.
const MAX_SPLIT_SAMPLES: usize = TARGET_SAMPLE_RATE as usize * 60 * 12;

/// Compute split boundaries over `total_samples` so each piece is at most
/// `max_samples`. Returns `(start_sample, len_samples, cumulative_start_ms)` per
/// piece, where `cumulative_start_ms` is the offset to add to each returned
/// segment's timestamps so they line up against the original recording.
///
/// Labels reset across these few splits (each is an independent diarized call) —
/// acceptable because splitting only happens for very long recordings, and the
/// reconcile pass matches by time overlap, not by label identity.
fn split_offsets(total_samples: usize, max_samples: usize) -> Vec<(usize, usize, i64)> {
    if total_samples == 0 {
        return Vec::new();
    }
    let max = max_samples.max(1);
    let mut pieces = Vec::new();
    let mut start = 0usize;
    while start < total_samples {
        let len = max.min(total_samples - start);
        // ms = sample_index / sample_rate * 1000, integer-floored.
        let cumulative_start_ms = (start as i64 * 1000) / TARGET_SAMPLE_RATE as i64;
        pieces.push((start, len, cumulative_start_ms));
        start += len;
    }
    pieces
}

/// Run ONE diarized pass over a full meeting recording and return its segments
/// with timestamps relative to the start of the recording.
///
/// Stable speaker labels come from diarizing the WHOLE recording in one call (a
/// fresh per-chunk pass resets labels every chunk — that is what #2127 hit). When
/// the recording exceeds the OpenAI upload cap we fall back to the fewest splits
/// and offset each piece's timestamps; labels reset across those splits, which is
/// why reconcile matches by time, not by raw label.
pub async fn transcribe_full_recording(
    app: &AppHandle,
    pcm: &[i16],
) -> Result<Vec<DiarizedSegment>, TranscribeError> {
    let client = reqwest::Client::new();
    let pieces = split_offsets(pcm.len(), MAX_SPLIT_SAMPLES);
    let mut all = Vec::new();
    for (start, len, offset_ms) in pieces {
        let slice = &pcm[start..start + len];
        let wav = pcm16_to_wav(slice, TARGET_SAMPLE_RATE);
        let body = build_diarized_envelope(&wav).to_string();
        let unwrapped = post_transcription(app, &client, body).await?;
        let piece_len_ms = (len as i64 * 1000) / TARGET_SAMPLE_RATE as i64;
        let segments = parse_diarized_body(&unwrapped, piece_len_ms)?;
        for mut segment in segments {
            segment.start_ms += offset_ms;
            segment.end_ms += offset_ms;
            all.push(segment);
        }
    }
    Ok(all)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    struct FakeTranscriber {
        responses: Mutex<Vec<Result<Vec<DiarizedSegment>, TranscribeError>>>,
        attempts: AtomicUsize,
    }

    impl FakeTranscriber {
        fn new(responses: Vec<Result<Vec<DiarizedSegment>, TranscribeError>>) -> Self {
            Self {
                responses: Mutex::new(responses),
                attempts: AtomicUsize::new(0),
            }
        }

        fn attempts(&self) -> usize {
            self.attempts.load(Ordering::SeqCst)
        }
    }

    /// Build a single plain-text segment, mirroring the text fallback shape.
    fn text_segment(text: &str) -> Vec<DiarizedSegment> {
        vec![DiarizedSegment {
            speaker_label: None,
            start_ms: 0,
            end_ms: 100,
            text: text.to_string(),
        }]
    }

    #[async_trait]
    impl ChunkTranscriber for Arc<FakeTranscriber> {
        async fn transcribe(&self, _chunk: &Chunk) -> Result<Vec<DiarizedSegment>, TranscribeError> {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            self.responses.lock().unwrap().remove(0)
        }
    }

    fn chunk() -> Chunk {
        Chunk {
            start_ms: 0,
            end_ms: 100,
            samples: vec![1, 2, 3],
        }
    }

    fn cfg() -> RetryConfig {
        RetryConfig {
            max_attempts: 3,
            initial_backoff_ms: 0,
            max_backoff_ms: 0,
            retry_on_empty: true,
        }
    }

    #[tokio::test]
    async fn transcribe_chunk_returns_successful_text() {
        let transcriber = Arc::new(FakeTranscriber::new(vec![Ok(text_segment("hello"))]));

        let result = transcribe_chunk_with_retry(&transcriber, &chunk(), cfg()).await;

        assert_eq!(result.unwrap(), text_segment("hello"));
        assert_eq!(transcriber.attempts(), 1);
    }

    #[tokio::test]
    async fn transcribe_chunk_retries_before_success() {
        let transcriber = Arc::new(FakeTranscriber::new(vec![
            Err(TranscribeError::Transport("timeout".to_string())),
            Err(TranscribeError::Transport("502".to_string())),
            Ok(text_segment("eventually")),
        ]));

        let result = transcribe_chunk_with_retry(&transcriber, &chunk(), cfg()).await;

        assert_eq!(result.unwrap(), text_segment("eventually"));
        assert_eq!(transcriber.attempts(), 3);
    }

    #[tokio::test]
    async fn transcribe_chunk_does_not_retry_empty_when_disabled() {
        // #2349: dictation VAD-gates its input, so an empty whisper response is a
        // terminal "silence" outcome — three retries waste round-trips and amplify
        // hallucination risk on already-marginal audio.
        let transcriber = Arc::new(FakeTranscriber::new(vec![Ok(text_segment("   "))]));
        let cfg = RetryConfig {
            retry_on_empty: false,
            ..cfg()
        };

        let result = transcribe_chunk_with_retry(&transcriber, &chunk(), cfg).await;

        assert_eq!(result.unwrap_err(), TranscribeError::Empty);
        assert_eq!(
            transcriber.attempts(),
            1,
            "empty response must not retry when retry_on_empty=false"
        );
    }

    #[tokio::test]
    async fn transcribe_chunk_returns_error_after_attempts_exhausted() {
        let transcriber = Arc::new(FakeTranscriber::new(vec![
            Err(TranscribeError::Transport("timeout".to_string())),
            Err(TranscribeError::Transport("502".to_string())),
            Err(TranscribeError::Transport("500".to_string())),
        ]));

        let result = transcribe_chunk_with_retry(&transcriber, &chunk(), cfg()).await;

        assert_eq!(
            result.unwrap_err(),
            TranscribeError::Transport("500".to_string())
        );
        assert_eq!(transcriber.attempts(), 3);
    }

    #[test]
    fn pcm16_to_wav_writes_a_valid_riff_pcm_header() {
        let wav = pcm16_to_wav(&[0, 1, -1, 32_767], 16_000);

        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            16_000
        );
        // 4 samples * 2 bytes = 8 bytes of data; 44-byte header.
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 8);
        assert_eq!(wav.len(), 44 + 8);
    }

    #[test]
    fn build_whisper_envelope_carries_model_and_base64_file() {
        let envelope = build_whisper_envelope(&[0x52, 0x49, 0x46, 0x46]);
        let parts = envelope["parts"].as_array().unwrap();

        assert_eq!(parts[0]["name"], "model");
        assert_eq!(parts[0]["value"], "whisper-1");
        assert_eq!(parts[1]["name"], "file");
        assert_eq!(parts[1]["content_type"], "audio/wav");
        assert!(!parts[1]["data"].as_str().unwrap().is_empty());
    }

    #[test]
    fn build_diarized_envelope_carries_diarize_params_and_file() {
        let envelope = build_diarized_envelope(&[0x52, 0x49, 0x46, 0x46]);
        let parts = envelope["parts"].as_array().unwrap();

        assert_eq!(parts[0]["name"], "model");
        assert_eq!(parts[0]["value"], "gpt-4o-transcribe-diarize");
        assert_eq!(parts[1]["name"], "response_format");
        assert_eq!(parts[1]["value"], "diarized_json");
        assert_eq!(parts[2]["name"], "chunking_strategy");
        assert_eq!(parts[2]["value"], "auto");
        assert_eq!(parts[3]["name"], "file");
        assert!(!parts[3]["data"].as_str().unwrap().is_empty());
    }

    #[test]
    fn parse_diarized_body_maps_segments_with_labels_and_ms() {
        // Representative diarized_json body: segments with speaker labels and
        // float-second start/end timestamps relative to the chunk.
        let body = serde_json::json!({
            "task": "transcribe",
            "duration": 3.0,
            "text": "Hi there. Hello.",
            "segments": [
                {
                    "type": "transcript.text.segment",
                    "id": "seg_0",
                    "start": 0.0,
                    "end": 1.5,
                    "speaker": "A",
                    "text": " Hi there. "
                },
                {
                    "type": "transcript.text.segment",
                    "id": "seg_1",
                    "start": 1.8,
                    "end": 3.0,
                    "speaker": "B",
                    "text": "Hello."
                }
            ]
        });

        let segments = parse_diarized_body(&body, 3_000).unwrap();

        assert_eq!(segments.len(), 2);
        assert_eq!(segments[0].speaker_label.as_deref(), Some("A"));
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 1_500);
        assert_eq!(segments[0].text, "Hi there.");
        assert_eq!(segments[1].speaker_label.as_deref(), Some("B"));
        assert_eq!(segments[1].start_ms, 1_800);
        assert_eq!(segments[1].end_ms, 3_000);
        assert_eq!(segments[1].text, "Hello.");
    }

    #[test]
    fn parse_diarized_body_falls_back_to_single_text_segment() {
        // No segments array (diarization unavailable) -> one whole-chunk segment.
        let body = serde_json::json!({ "text": "  plain transcript  " });

        let segments = parse_diarized_body(&body, 4_200).unwrap();

        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].speaker_label, None);
        assert_eq!(segments[0].start_ms, 0);
        assert_eq!(segments[0].end_ms, 4_200);
        assert_eq!(segments[0].text, "plain transcript");
    }

    #[test]
    fn parse_diarized_body_empty_text_is_empty_error() {
        let body = serde_json::json!({ "text": "   " });
        assert_eq!(
            parse_diarized_body(&body, 1_000).unwrap_err(),
            TranscribeError::Empty
        );
    }

    #[test]
    fn parse_diarized_body_all_blank_segments_is_empty_error() {
        let body = serde_json::json!({
            "segments": [ { "speaker": "A", "start": 0.0, "end": 1.0, "text": "  " } ]
        });
        assert_eq!(
            parse_diarized_body(&body, 1_000).unwrap_err(),
            TranscribeError::Empty
        );
    }

    #[test]
    fn split_offsets_keeps_one_piece_under_the_cap() {
        // A recording that fits in one upload is a single piece at offset 0.
        let pieces = split_offsets(16_000 * 5, 16_000 * 12 * 60);
        assert_eq!(pieces, vec![(0, 16_000 * 5, 0)]);
    }

    #[test]
    fn split_offsets_partitions_with_cumulative_ms_offsets() {
        // 25s of 16kHz samples split at a 10s cap -> 3 pieces (10s, 10s, 5s) with
        // cumulative-start offsets of 0ms, 10_000ms, 20_000ms.
        let max = 16_000 * 10;
        let total = 16_000 * 25;
        let pieces = split_offsets(total, max);
        assert_eq!(
            pieces,
            vec![
                (0, 16_000 * 10, 0),
                (16_000 * 10, 16_000 * 10, 10_000),
                (16_000 * 20, 16_000 * 5, 20_000),
            ]
        );
        // The pieces fully cover the recording with no gaps or overlaps.
        let covered: usize = pieces.iter().map(|(_, len, _)| len).sum();
        assert_eq!(covered, total);
    }

    #[test]
    fn split_offsets_handles_an_exact_multiple_of_the_cap() {
        // Exactly two caps' worth -> two full pieces, no trailing empty piece.
        let max = 16_000 * 10;
        let pieces = split_offsets(max * 2, max);
        assert_eq!(pieces, vec![(0, max, 0), (max, max, 10_000)]);
    }

    #[test]
    fn split_offsets_is_empty_for_empty_input() {
        assert!(split_offsets(0, 16_000 * 12 * 60).is_empty());
    }
}
