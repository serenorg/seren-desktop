// ABOUTME: Retryable transcription boundary for Whisper chunk requests.
// ABOUTME: Keeps retry policy deterministic and injectable for unit tests.

use async_trait::async_trait;
use thiserror::Error;

use crate::audio::chunker::Chunk;

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
    T: ChunkTranscriber + Sync,
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
}
