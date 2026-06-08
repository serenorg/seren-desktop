// ABOUTME: Windows WASAPI loopback capture for the system ("Them") meeting stream.
// ABOUTME: Records the default render endpoint and normalizes to 16 kHz mono PCM.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::thread::JoinHandle;

use wasapi::{Direction, ShareMode, get_default_device, initialize_mta};

use super::{
    AudioCaptureSource, CaptureError, FrameSender, PcmFrame, spawn_with_readiness, to_mono_16k,
};

// How long to block waiting for the next WASAPI buffer before re-checking stop.
const EVENT_TIMEOUT_MS: u32 = 1000;

/// Captures the default render endpoint in loopback so the remote side of a call
/// (everything the speakers play) becomes the meeting "Them" stream.
pub struct WasapiLoopbackSource {
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl WasapiLoopbackSource {
    pub fn new() -> Self {
        Self {
            stop_flag: Arc::new(AtomicBool::new(false)),
            handle: None,
        }
    }
}

impl Default for WasapiLoopbackSource {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioCaptureSource for WasapiLoopbackSource {
    fn start(&mut self, sink: FrameSender) -> Result<(), CaptureError> {
        self.stop_flag.store(false, Ordering::SeqCst);
        let stop = self.stop_flag.clone();
        // The WASAPI client is not Send, so it is owned entirely on this thread.
        // Block until run_loopback reports the stream is live (or init failed) so
        // a real failure (no render endpoint, COM error) is returned to the caller
        // instead of leaving the "Them" worker blocked on a silent channel (#2157).
        let handle = spawn_with_readiness(move |ready| {
            run_loopback(&stop, &sink, &ready);
        })?;
        self.handle = Some(handle);
        Ok(())
    }

    fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Initialize WASAPI loopback capture, signal readiness through `ready`, then pump
/// frames until `stop` is set. The init result is reported on `ready` exactly once:
/// `Err` if any init step fails (the stream never started), or `Ok` after the
/// stream is live. Read failures during the capture loop only end the loop.
fn run_loopback(stop: &AtomicBool, sink: &FrameSender, ready: &SyncSender<Result<(), CaptureError>>) {
    // Report an init-step failure to the caller and stop: the device is not live.
    macro_rules! init {
        ($step:expr) => {
            match $step {
                Ok(value) => value,
                Err(err) => {
                    let _ = ready.send(Err(CaptureError::Device(err.to_string())));
                    return;
                }
            }
        };
    }

    init!(
        initialize_mta()
            .ok()
            .map_err(|err| format!("COM init failed: {err:?}"))
    );

    let device = init!(get_default_device(&Direction::Render).map_err(|err| err.to_string()));
    let mut audio_client = init!(device.get_iaudioclient().map_err(|err| err.to_string()));
    let format = init!(audio_client.get_mixformat().map_err(|err| err.to_string()));
    let (_default_period, min_period) =
        init!(audio_client.get_periods().map_err(|err| err.to_string()));

    init!(
        audio_client
            .initialize_client(
                &format,
                min_period,
                &Direction::Capture,
                &ShareMode::Shared,
                true,
            )
            .map_err(|err| err.to_string())
    );

    let h_event = init!(audio_client.set_get_eventhandle().map_err(|err| err.to_string()));
    let capture_client = init!(
        audio_client
            .get_audiocaptureclient()
            .map_err(|err| err.to_string())
    );

    let channels = format.get_nchannels();
    let sample_rate = format.get_samplespersec();
    let bits = format.get_bitspersample();
    let block_align = format.get_blockalign() as usize;

    init!(audio_client.start_stream().map_err(|err| err.to_string()));

    // The stream is live: report success. From here, errors only end the loop.
    let _ = ready.send(Ok(()));

    let mut bytes: VecDeque<u8> = VecDeque::new();
    while !stop.load(Ordering::SeqCst) {
        if let Err(err) = capture_client.read_from_device_to_deque(&mut bytes) {
            log::warn!("[wasapi] loopback read failed: {err}");
            break;
        }

        let frame_count = if block_align == 0 {
            0
        } else {
            bytes.len() / block_align
        };
        if frame_count > 0 {
            let sample_count = frame_count * channels as usize;
            let mut pcm: Vec<i16> = Vec::with_capacity(sample_count);
            for _ in 0..sample_count {
                pcm.push(read_sample(&mut bytes, bits));
            }
            let normalized = to_mono_16k(&pcm, channels, sample_rate);
            if !normalized.is_empty() {
                let _ = sink.send(PcmFrame { samples: normalized });
            }
        }

        let _ = h_event.wait_for_event(EVENT_TIMEOUT_MS);
    }

    let _ = audio_client.stop_stream();
}

/// Pop one interleaved sample from the byte queue and convert it to i16. The
/// WASAPI shared mix format is 32-bit float; 16-bit PCM is handled as a fallback.
fn read_sample(bytes: &mut VecDeque<u8>, bits: u16) -> i16 {
    match bits {
        32 => {
            let raw = [pop(bytes), pop(bytes), pop(bytes), pop(bytes)];
            let value = f32::from_le_bytes(raw).clamp(-1.0, 1.0);
            (value * i16::MAX as f32) as i16
        }
        16 => i16::from_le_bytes([pop(bytes), pop(bytes)]),
        other => {
            for _ in 0..(other / 8) {
                pop(bytes);
            }
            0
        }
    }
}

fn pop(bytes: &mut VecDeque<u8>) -> u8 {
    bytes.pop_front().unwrap_or(0)
}
