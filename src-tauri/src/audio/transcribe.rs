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

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum TranscribeError {
    #[error("transcription transport failed: {0}")]
    Transport(String),
    #[error("transcription returned no text")]
    Empty,
}

#[derive(Debug, Clone, Copy)]
pub struct RetryConfig {
    pub max_attempts: usize,
    pub initial_backoff_ms: u64,
    pub max_backoff_ms: u64,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            initial_backoff_ms: 250,
            max_backoff_ms: 2_000,
        }
    }
}

#[async_trait]
pub trait ChunkTranscriber {
    async fn transcribe(&self, chunk: &Chunk) -> Result<String, TranscribeError>;
}

pub async fn transcribe_chunk_with_retry<T>(
    transcriber: &T,
    chunk: &Chunk,
    cfg: RetryConfig,
) -> Result<String, TranscribeError>
where
    T: ChunkTranscriber + Sync + ?Sized,
{
    let attempts = cfg.max_attempts.max(1);
    let mut backoff_ms = cfg.initial_backoff_ms;
    let mut last_error = TranscribeError::Empty;

    for attempt in 1..=attempts {
        match transcriber.transcribe(chunk).await {
            Ok(text) if !text.trim().is_empty() => return Ok(text),
            Ok(_) => last_error = TranscribeError::Empty,
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

/// Build the Gateway multipart-envelope body for a Whisper transcription request.
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

/// Real [`ChunkTranscriber`] that POSTs a chunk to the Seren Whisper publisher.
pub struct GatewayTranscriber {
    app: AppHandle,
    client: reqwest::Client,
}

impl GatewayTranscriber {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            client: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl ChunkTranscriber for GatewayTranscriber {
    async fn transcribe(&self, chunk: &Chunk) -> Result<String, TranscribeError> {
        let wav = pcm16_to_wav(&chunk.samples, TARGET_SAMPLE_RATE);
        let body = build_whisper_envelope(&wav).to_string();
        let url = format!(
            "{}/publishers/{}/audio/transcriptions",
            GATEWAY_BASE_URL, WHISPER_PUBLISHER
        );

        let response =
            crate::auth::authenticated_request(&self.app, &self.client, move |client, token| {
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

        let body = unwrap_publisher_body(&value);
        let text = body
            .get("text")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if text.is_empty() {
            return Err(TranscribeError::Empty);
        }
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    struct FakeTranscriber {
        responses: Mutex<Vec<Result<String, TranscribeError>>>,
        attempts: AtomicUsize,
    }

    impl FakeTranscriber {
        fn new(responses: Vec<Result<String, TranscribeError>>) -> Self {
            Self {
                responses: Mutex::new(responses),
                attempts: AtomicUsize::new(0),
            }
        }

        fn attempts(&self) -> usize {
            self.attempts.load(Ordering::SeqCst)
        }
    }

    #[async_trait]
    impl ChunkTranscriber for Arc<FakeTranscriber> {
        async fn transcribe(&self, _chunk: &Chunk) -> Result<String, TranscribeError> {
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
        }
    }

    #[tokio::test]
    async fn transcribe_chunk_returns_successful_text() {
        let transcriber = Arc::new(FakeTranscriber::new(vec![Ok("hello".to_string())]));

        let result = transcribe_chunk_with_retry(&transcriber, &chunk(), cfg()).await;

        assert_eq!(result.unwrap(), "hello");
        assert_eq!(transcriber.attempts(), 1);
    }

    #[tokio::test]
    async fn transcribe_chunk_retries_before_success() {
        let transcriber = Arc::new(FakeTranscriber::new(vec![
            Err(TranscribeError::Transport("timeout".to_string())),
            Err(TranscribeError::Transport("502".to_string())),
            Ok("eventually".to_string()),
        ]));

        let result = transcribe_chunk_with_retry(&transcriber, &chunk(), cfg()).await;

        assert_eq!(result.unwrap(), "eventually");
        assert_eq!(transcriber.attempts(), 3);
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
}
