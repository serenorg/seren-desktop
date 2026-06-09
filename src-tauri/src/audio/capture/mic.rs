// ABOUTME: CPAL-backed native microphone source for Meeting Mode's Me stream.
// ABOUTME: Owns the platform stream on a worker thread and emits 16 kHz mono PCM.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::SyncSender;
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{ErrorKind, Sample, SampleFormat, StreamConfig};

use super::{
    AudioCaptureSource, CaptureError, FrameSender, PcmFrame, spawn_with_readiness, to_mono_16k,
};

const IDLE_SLEEP: Duration = Duration::from_millis(50);

/// Captures the default input device so Meeting Mode no longer depends on
/// renderer-owned WebAudio frames for the local speaker ("Me").
pub struct CpalMicSource {
    stop_flag: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl CpalMicSource {
    pub fn new() -> Self {
        Self {
            stop_flag: Arc::new(AtomicBool::new(false)),
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
        let handle = spawn_with_readiness(move |ready| {
            run_input(&stop, sink, &ready);
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

impl Drop for CpalMicSource {
    fn drop(&mut self) {
        self.stop();
    }
}

fn run_input(stop: &AtomicBool, sink: FrameSender, ready: &SyncSender<Result<(), CaptureError>>) {
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        let _ = ready.send(Err(CaptureError::Device(
            "no default input device is available".to_string(),
        )));
        return;
    };
    let supported = match device.default_input_config() {
        Ok(config) => config,
        Err(err) => {
            let _ = ready.send(Err(map_cpal_error(
                "default input config unavailable",
                &err,
            )));
            return;
        }
    };
    let sample_format = supported.sample_format();
    let channels = supported.channels();
    let sample_rate = supported.sample_rate();
    let config: StreamConfig = supported.into();

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(&device, &config, channels, sample_rate, sink),
        SampleFormat::I16 => build_stream::<i16>(&device, &config, channels, sample_rate, sink),
        SampleFormat::U16 => build_stream::<u16>(&device, &config, channels, sample_rate, sink),
        other => Err(CaptureError::Unsupported(format!(
            "default input sample format {other} is not supported"
        ))),
    };
    let stream = match stream {
        Ok(stream) => stream,
        Err(err) => {
            let _ = ready.send(Err(err));
            return;
        }
    };

    if let Err(err) = stream.play() {
        let _ = ready.send(Err(map_cpal_error("input stream could not start", &err)));
        return;
    }

    let _ = ready.send(Ok(()));
    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(IDLE_SLEEP);
    }
    drop(stream);
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: u16,
    sample_rate: u32,
    sink: FrameSender,
) -> Result<cpal::Stream, CaptureError>
where
    T: cpal::Sample + cpal::SizedSample + Copy + Send + 'static,
    i16: cpal::FromSample<T>,
{
    let err_fn = |err| {
        log::warn!("[meeting] native mic stream error: {err}");
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
}
