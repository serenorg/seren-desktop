// ABOUTME: Capture-source abstraction and PCM format utilities for Meeting Mode.
// ABOUTME: Sources emit 16 kHz mono i16 frames; downmix/resample math is unit-tested.

pub mod fake;

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub mod mic;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub mod windows;

use std::sync::mpsc::SyncSender;
use std::thread::JoinHandle;

use thiserror::Error;
use tokio::sync::mpsc::UnboundedSender;

/// Pipeline-facing sample rate. Every source normalizes to this before emitting.
pub const TARGET_SAMPLE_RATE: u32 = 16_000;

/// A buffer of 16 kHz mono signed-16 PCM samples produced by a capture source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PcmFrame {
    pub samples: Vec<i16>,
}

/// Channel a source pushes frames into. Dropping every sender closes the stream.
pub type FrameSender = UnboundedSender<PcmFrame>;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CaptureError {
    #[error("audio device unavailable: {0}")]
    Device(String),
    #[error("audio capture permission denied: {0}")]
    Permission(String),
    #[error("audio capture unsupported on this platform/build: {0}")]
    Unsupported(String),
}

/// A single capture stream (mic, system audio, …) normalized to 16 kHz mono PCM.
///
/// `start` begins delivering frames into `sink` and returns once capture is live;
/// frames continue asynchronously until `stop` is called or the source ends (which
/// it signals by dropping its `sink`, closing the channel). Implementations must be
/// `Send` so the pipeline can own them across threads.
pub trait AudioCaptureSource: Send {
    fn start(&mut self, sink: FrameSender) -> Result<(), CaptureError>;
    fn stop(&mut self);
}

/// Spawn `worker` on a dedicated OS thread and block until it reports readiness.
///
/// The worker must send exactly one verdict on the channel: `Ok(())` once its
/// capture stream is live, or `Err(_)` if initialization failed. This returns the
/// running thread handle once `Ok` is seen, the worker's error (after joining) on
/// failure, or a `Device` error if the worker exits without signaling (panic /
/// early return). It exists so sources whose real init runs on a non-`Send` worker
/// thread (WASAPI loopback) can report the *true* init result to their caller
/// instead of an unconditional `Ok` that masks a dead stream (#2157).
pub fn spawn_with_readiness<F>(worker: F) -> Result<JoinHandle<()>, CaptureError>
where
    F: FnOnce(SyncSender<Result<(), CaptureError>>) + Send + 'static,
{
    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
    let handle = std::thread::spawn(move || worker(ready_tx));
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(handle),
        Ok(Err(err)) => {
            let _ = handle.join();
            Err(err)
        }
        Err(_) => {
            let _ = handle.join();
            Err(CaptureError::Device(
                "capture worker exited before signaling readiness".to_string(),
            ))
        }
    }
}

/// Downmix interleaved PCM to mono and resample to [`TARGET_SAMPLE_RATE`].
///
/// `channels` is the interleaved channel count of `samples`; `sample_rate` is its
/// source rate. Pure and deterministic — this is the critical math under test.
pub fn to_mono_16k(samples: &[i16], channels: u16, sample_rate: u32) -> Vec<i16> {
    let mono = downmix_to_mono(samples, channels);
    resample_to_16k(&mono, sample_rate)
}

/// Average interleaved channels into a single mono track.
pub fn downmix_to_mono(samples: &[i16], channels: u16) -> Vec<i16> {
    if channels <= 1 {
        return samples.to_vec();
    }
    let channels = channels as usize;
    samples
        .chunks(channels)
        .map(|frame| {
            let sum: i32 = frame.iter().map(|s| *s as i32).sum();
            (sum / frame.len() as i32) as i16
        })
        .collect()
}

/// Linearly resample a mono track to [`TARGET_SAMPLE_RATE`].
pub fn resample_to_16k(mono: &[i16], sample_rate: u32) -> Vec<i16> {
    if sample_rate == TARGET_SAMPLE_RATE || mono.is_empty() || sample_rate == 0 {
        return mono.to_vec();
    }

    let out_len = ((mono.len() as u64 * TARGET_SAMPLE_RATE as u64) / sample_rate as u64) as usize;
    if out_len == 0 {
        return Vec::new();
    }

    let ratio = sample_rate as f64 / TARGET_SAMPLE_RATE as f64;
    let last = mono.len() - 1;
    (0..out_len)
        .map(|i| {
            let src_pos = i as f64 * ratio;
            let idx = src_pos.floor() as usize;
            let frac = src_pos - idx as f64;
            let a = mono[idx.min(last)] as f64;
            let b = mono[(idx + 1).min(last)] as f64;
            (a + (b - a) * frac).round() as i16
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn spawn_with_readiness_returns_handle_when_worker_signals_ok() {
        let ran = Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        let handle = spawn_with_readiness(move |ready| {
            flag.store(true, Ordering::SeqCst);
            ready.send(Ok(())).unwrap();
        })
        .expect("a worker that signals Ok yields a running handle");
        handle.join().unwrap();
        assert!(ran.load(Ordering::SeqCst));
    }

    #[test]
    fn spawn_with_readiness_propagates_worker_init_error() {
        // An init failure on the worker thread must surface to the caller, not be
        // swallowed as a phantom-live stream (the #2157 regression).
        let err = spawn_with_readiness(|ready| {
            ready
                .send(Err(CaptureError::Device("no render endpoint".to_string())))
                .unwrap();
        })
        .expect_err("init failure must be returned");
        assert_eq!(err, CaptureError::Device("no render endpoint".to_string()));
    }

    #[test]
    fn spawn_with_readiness_errors_when_worker_exits_without_signaling() {
        // A worker that drops its sender without sending (panic / early return)
        // must not be reported as a live capture.
        let err = spawn_with_readiness(|_ready| {})
            .expect_err("a silent worker exit must surface as an error");
        assert!(matches!(err, CaptureError::Device(_)));
    }

    #[test]
    fn mono_at_target_rate_passes_through_unchanged() {
        let samples = vec![0, 100, -100, 32_000];
        assert_eq!(to_mono_16k(&samples, 1, TARGET_SAMPLE_RATE), samples);
    }

    #[test]
    fn stereo_downmix_averages_channel_pairs() {
        // [L,R, L,R] at 16 kHz -> [(100+300)/2, (200+400)/2]
        let samples = vec![100, 300, 200, 400];
        assert_eq!(to_mono_16k(&samples, 2, TARGET_SAMPLE_RATE), vec![200, 300]);
    }

    #[test]
    fn downsample_48k_to_16k_picks_every_third_sample() {
        // 6 mono samples at 48 kHz -> 2 at 16 kHz (ratio 3.0, integer taps).
        let mono = vec![0, 10, 20, 30, 40, 50];
        let out = resample_to_16k(&mono, 48_000);
        assert_eq!(out.len(), 2);
        assert_eq!(out, vec![0, 30]);
    }

    #[test]
    fn upsample_8k_to_16k_interpolates_between_samples() {
        // 2 mono samples at 8 kHz -> 4 at 16 kHz (ratio 0.5), linear interpolation.
        let mono = vec![0, 100];
        let out = resample_to_16k(&mono, 8_000);
        assert_eq!(out, vec![0, 50, 100, 100]);
    }

    #[test]
    fn empty_input_yields_empty_output() {
        assert!(to_mono_16k(&[], 2, 48_000).is_empty());
    }
}
