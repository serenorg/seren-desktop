// ABOUTME: CPAL-backed native microphone source for Meeting Mode's Me stream.
// ABOUTME: Owns the platform stream on a worker thread; self-heals on device loss.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, Sample, SampleFormat, StreamConfig};

use super::{
    AudioCaptureSource, CaptureError, FrameSender, MicHealth, PcmFrame, spawn_with_readiness,
    to_mono_16k,
};

const IDLE_SLEEP: Duration = Duration::from_millis(50);
/// First re-acquire delay after a mid-capture loss; doubles up to the cap.
const RECOVERY_BACKOFF_START: Duration = Duration::from_millis(250);
/// Ceiling on the re-acquire backoff so a permanently-gone device is retried at
/// a steady, cheap cadence (the device may return at any time) until stop.
const RECOVERY_BACKOFF_MAX: Duration = Duration::from_secs(2);

/// Captures the default input device so Meeting Mode no longer depends on
/// renderer-owned WebAudio frames for the local speaker ("Me").
pub struct CpalMicSource {
    stop_flag: Arc<AtomicBool>,
    health: Arc<MicHealth>,
    handle: Option<JoinHandle<()>>,
}

impl CpalMicSource {
    pub fn new() -> Self {
        Self {
            stop_flag: Arc::new(AtomicBool::new(false)),
            health: Arc::new(MicHealth::default()),
            handle: None,
        }
    }
}

impl Default for CpalMicSource {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioCaptureSource for CpalMicSource {
    fn start(&mut self, sink: FrameSender) -> Result<(), CaptureError> {
        self.stop_flag.store(false, Ordering::SeqCst);
        let stop = self.stop_flag.clone();
        let health = self.health.clone();
        let handle = spawn_with_readiness(move |ready| {
            run_input(&stop, sink, &health, &ready);
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

    fn mic_health(&self) -> Option<Arc<MicHealth>> {
        Some(self.health.clone())
    }
}

impl Drop for CpalMicSource {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A built, playing cpal input stream paired with the flag its error callback
/// flips when the device dies. `run_input` polls `lost()` to drive recovery.
struct LiveStream {
    // Held to keep the platform stream playing; dropped to tear it down.
    _stream: cpal::Stream,
    lost: Arc<AtomicBool>,
}

impl LiveStream {
    fn lost(&self) -> bool {
        self.lost.load(Ordering::SeqCst)
    }
}

/// Capture the default input device, re-acquiring it whenever the live stream is
/// lost mid-capture (Bluetooth/USB drop, default-device switch) so the "Me"
/// track self-heals instead of silently freezing for the rest of the meeting.
fn run_input(
    stop: &AtomicBool,
    sink: FrameSender,
    health: &MicHealth,
    ready: &SyncSender<Result<(), CaptureError>>,
) {
    // The first acquisition is the readiness verdict. A startup failure is
    // terminal and propagates so the UI surfaces the real permission/device
    // cause rather than recording silence; recovery only covers *mid-capture*
    // loss after a stream was once live.
    let mut stream = match acquire_stream(&sink) {
        Ok(stream) => stream,
        Err(err) => {
            let _ = ready.send(Err(err));
            return;
        }
    };
    health.mark_live();
    let _ = ready.send(Ok(()));

    loop {
        // Hold the live stream until a stop is requested or the device drops.
        while !stop.load(Ordering::SeqCst) && !stream.lost() {
            std::thread::sleep(IDLE_SLEEP);
        }
        if stop.load(Ordering::SeqCst) {
            return; // stream drops at scope end
        }
        // Mid-capture device loss. Surface it, tear the dead stream down, and
        // self-heal onto whatever input device is now default (#2608).
        let count = health.mark_lost();
        log::warn!(
            "[meeting] native mic lost mid-capture (disconnect #{count}); re-acquiring input device"
        );
        drop(stream);
        match recover_stream(stop, &sink) {
            Some(fresh) => {
                health.mark_live();
                log::info!("[meeting] native mic re-acquired after disconnect #{count}");
                stream = fresh;
            }
            None => return, // stop requested before a device came back
        }
    }
}

/// Open the current default input device and start delivering frames into `sink`.
fn acquire_stream(sink: &FrameSender) -> Result<LiveStream, CaptureError> {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        return Err(CaptureError::Device(
            "no default input device is available".to_string(),
        ));
    };
    let supported = match device.default_input_config() {
        Ok(config) => config,
        Err(err) => {
            return Err(map_cpal_error("default input config unavailable", &err));
        }
    };
    let sample_format = supported.sample_format();
    let channels = supported.channels();
    let sample_rate = supported.sample_rate();
    let config: StreamConfig = supported.into();

    let lost = Arc::new(AtomicBool::new(false));
    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(
            &device,
            &config,
            channels,
            sample_rate,
            sink.clone(),
            lost.clone(),
        ),
        SampleFormat::I16 => build_stream::<i16>(
            &device,
            &config,
            channels,
            sample_rate,
            sink.clone(),
            lost.clone(),
        ),
        SampleFormat::U16 => build_stream::<u16>(
            &device,
            &config,
            channels,
            sample_rate,
            sink.clone(),
            lost.clone(),
        ),
        other => Err(CaptureError::Unsupported(format!(
            "default input sample format {other} is not supported"
        ))),
    }?;

    if let Err(err) = stream.play() {
        return Err(map_cpal_error("input stream could not start", &err));
    }
    Ok(LiveStream {
        _stream: stream,
        lost,
    })
}

/// Re-acquire the default input device after a mid-capture loss, retrying with
/// capped backoff until a device returns or a stop is requested. `None` means
/// the capture was stopped before recovery.
fn recover_stream(stop: &AtomicBool, sink: &FrameSender) -> Option<LiveStream> {
    let mut backoff = RECOVERY_BACKOFF_START;
    loop {
        if stop.load(Ordering::SeqCst) {
            return None;
        }
        match acquire_stream(sink) {
            Ok(stream) => return Some(stream),
            Err(err) => {
                log::debug!(
                    "[meeting] native mic re-acquire failed ({err}); retrying in {backoff:?}"
                );
            }
        }
        if !sleep_until_stop(stop, backoff) {
            return None;
        }
        backoff = (backoff * 2).min(RECOVERY_BACKOFF_MAX);
    }
}

/// Sleep up to `dur` in short increments, returning `false` as soon as a stop is
/// requested so a stopping capture never waits a full backoff to exit.
fn sleep_until_stop(stop: &AtomicBool, dur: Duration) -> bool {
    let mut waited = Duration::ZERO;
    while waited < dur {
        if stop.load(Ordering::SeqCst) {
            return false;
        }
        let step = IDLE_SLEEP.min(dur - waited);
        std::thread::sleep(step);
        waited += step;
    }
    !stop.load(Ordering::SeqCst)
}

/// Whether a cpal stream error means the stream is dead and must be rebuilt. A
/// `DeviceChanged` reroute leaves the current stream live, so it is not fatal;
/// every other error (device gone, config invalidated) requires re-acquisition.
fn is_fatal_stream_error(kind: ErrorKind) -> bool {
    kind != ErrorKind::DeviceChanged
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: u16,
    sample_rate: u32,
    sink: FrameSender,
    lost: Arc<AtomicBool>,
) -> Result<cpal::Stream, CaptureError>
where
    T: cpal::Sample + cpal::SizedSample + Copy + Send + 'static,
    i16: cpal::FromSample<T>,
{
    let err_fn = move |err: cpal::Error| {
        if is_fatal_stream_error(err.kind()) {
            log::warn!("[meeting] native mic stream error: {err}");
            lost.store(true, Ordering::SeqCst);
        } else {
            log::info!("[meeting] native mic route changed; staying on current stream: {err}");
        }
    };
    device
        .build_input_stream(
            config.clone(),
            move |data: &[T], _| {
                let pcm = convert_input_to_i16(data);
                let normalized = to_mono_16k(&pcm, channels.max(1), sample_rate);
                if !normalized.is_empty() {
                    let _ = sink.send(PcmFrame {
                        samples: normalized,
                    });
                }
            },
            err_fn,
            None,
        )
        .map_err(|err| map_cpal_error("input stream could not be built", &err))
}

pub fn convert_input_to_i16<T>(samples: &[T]) -> Vec<i16>
where
    T: cpal::Sample + Copy,
    i16: cpal::FromSample<T>,
{
    samples
        .iter()
        .map(|sample| i16::from_sample(*sample))
        .collect()
}

fn map_cpal_error(context: &str, err: &cpal::Error) -> CaptureError {
    let message = format!("{context}: {err}");
    match err.kind() {
        ErrorKind::PermissionDenied => CaptureError::Permission(message),
        ErrorKind::DeviceNotAvailable | ErrorKind::HostUnavailable => CaptureError::Device(message),
        ErrorKind::UnsupportedConfig | ErrorKind::UnsupportedOperation => {
            CaptureError::Unsupported(message)
        }
        _ => CaptureError::Device(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn assert_send<T: Send>() {}

    #[test]
    fn cpal_mic_source_is_send_without_storing_platform_stream() {
        assert_send::<CpalMicSource>();
    }

    #[test]
    fn converts_supported_sample_formats_to_signed_i16() {
        let f32_samples = convert_input_to_i16(&[-1.0_f32, 0.0, 1.0]);
        assert_eq!(f32_samples[0], i16::MIN);
        assert_eq!(f32_samples[1], 0);
        assert_eq!(f32_samples[2], i16::MAX);

        let i16_samples = convert_input_to_i16(&[-100_i16, 0, 100]);
        assert_eq!(i16_samples, vec![-100, 0, 100]);

        let u16_samples = convert_input_to_i16(&[0_u16, 32_768, u16::MAX]);
        assert_eq!(u16_samples[0], i16::MIN);
        assert_eq!(u16_samples[1], 0);
        assert_eq!(u16_samples[2], i16::MAX);
    }

    #[test]
    fn cpal_permission_error_maps_precisely() {
        let err = cpal::Error::new(ErrorKind::PermissionDenied);
        assert!(matches!(
            map_cpal_error("open mic", &err),
            CaptureError::Permission(_)
        ));
    }

    #[test]
    fn cpal_unsupported_config_error_maps_precisely() {
        let err = cpal::Error::new(ErrorKind::UnsupportedConfig);
        assert!(matches!(
            map_cpal_error("open mic", &err),
            CaptureError::Unsupported(_)
        ));
    }

    #[test]
    fn only_device_changed_reroute_keeps_the_stream_alive() {
        // A reroute must NOT tear down the live stream, but a real disconnect or
        // an invalidated config must trigger re-acquisition (#2608).
        assert!(!is_fatal_stream_error(ErrorKind::DeviceChanged));
        assert!(is_fatal_stream_error(ErrorKind::DeviceNotAvailable));
        assert!(is_fatal_stream_error(ErrorKind::StreamInvalidated));
    }

    #[test]
    fn sleep_until_stop_returns_immediately_when_already_stopped() {
        // Recovery backoff must not delay a stopping capture: an already-set stop
        // flag returns false without sleeping the full duration.
        let stop = AtomicBool::new(true);
        assert!(!sleep_until_stop(&stop, Duration::from_secs(30)));
    }
}
