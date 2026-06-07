// ABOUTME: Windows WASAPI loopback capture for the system ("Them") meeting stream.
// ABOUTME: Records the default render endpoint and normalizes to 16 kHz mono PCM.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

use wasapi::{Direction, ShareMode, get_default_device, initialize_mta};

use super::{AudioCaptureSource, CaptureError, FrameSender, PcmFrame, to_mono_16k};

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
        let handle = std::thread::spawn(move || {
            if let Err(err) = run_loopback(&stop, &sink) {
                log::warn!("[wasapi] loopback capture stopped: {err}");
            }
        });
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

fn run_loopback(stop: &AtomicBool, sink: &FrameSender) -> Result<(), String> {
    initialize_mta()
        .ok()
        .map_err(|err| format!("COM init failed: {err:?}"))?;

    let device = get_default_device(&Direction::Render).map_err(|err| err.to_string())?;
    let mut audio_client = device.get_iaudioclient().map_err(|err| err.to_string())?;
    let format = audio_client.get_mixformat().map_err(|err| err.to_string())?;
    let (_default_period, min_period) =
        audio_client.get_periods().map_err(|err| err.to_string())?;

    audio_client
        .initialize_client(
            &format,
            min_period,
            &Direction::Capture,
            &ShareMode::Shared,
            true,
        )
        .map_err(|err| err.to_string())?;

    let h_event = audio_client.set_get_eventhandle().map_err(|err| err.to_string())?;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|err| err.to_string())?;

    let channels = format.get_nchannels();
    let sample_rate = format.get_samplespersec();
    let bits = format.get_bitspersample();
    let block_align = format.get_blockalign() as usize;

    audio_client.start_stream().map_err(|err| err.to_string())?;

    let mut bytes: VecDeque<u8> = VecDeque::new();
    while !stop.load(Ordering::SeqCst) {
        capture_client
            .read_from_device_to_deque(&mut bytes)
            .map_err(|err| err.to_string())?;

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
    Ok(())
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
