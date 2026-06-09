// ABOUTME: WebRTC-style audio processing for native Meeting Mode microphone capture.
// ABOUTME: Applies stable capture-side cleanup before Me reaches transcription.

use serde::Serialize;
use sonora::config::{
    AdaptiveDigital, GainController2, HighPassFilter, NoiseSuppression, NoiseSuppressionLevel,
};
use sonora::{AudioProcessing, Config, StreamConfig};

use crate::audio::capture::TARGET_SAMPLE_RATE;

/// Sonora/WebRTC APM processes fixed 10 ms frames.
const APM_FRAME_SAMPLES: usize = TARGET_SAMPLE_RATE as usize / 100;
const I16_SCALE: f32 = i16::MAX as f32;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApmDiagnostics {
    pub initialized: bool,
    pub active: bool,
    pub echo_canceller_enabled: bool,
    pub render_frame_count: u64,
    pub capture_frame_count: u64,
    pub processed_sample_count: u64,
    pub last_error: Option<String>,
}

impl Default for ApmDiagnostics {
    fn default() -> Self {
        Self {
            initialized: false,
            active: false,
            echo_canceller_enabled: false,
            render_frame_count: 0,
            capture_frame_count: 0,
            processed_sample_count: 0,
            last_error: None,
        }
    }
}

/// Owns capture-side cleanup state for one active meeting capture.
pub struct MeetingAudioProcessor {
    apm: AudioProcessing,
    capture_buffer: Vec<i16>,
    render_buffer: Vec<i16>,
    diagnostics: ApmDiagnostics,
}

impl MeetingAudioProcessor {
    pub fn new() -> Self {
        let config = meeting_apm_config();
        let echo_canceller_enabled = config.echo_canceller.is_some();
        let stream = StreamConfig::new(TARGET_SAMPLE_RATE, 1);
        let mut apm = AudioProcessing::builder()
            .config(config)
            .capture_config(stream)
            .render_config(stream)
            .echo_detector(true)
            .build();
        let _ = apm.set_stream_delay_ms(0);
        Self {
            apm,
            capture_buffer: Vec::with_capacity(APM_FRAME_SAMPLES * 2),
            render_buffer: Vec::with_capacity(APM_FRAME_SAMPLES * 2),
            diagnostics: ApmDiagnostics {
                initialized: true,
                active: true,
                echo_canceller_enabled,
                ..Default::default()
            },
        }
    }

    pub fn diagnostics(&self) -> ApmDiagnostics {
        self.diagnostics.clone()
    }

    pub fn accept_render_reference(&mut self, samples: &[i16]) {
        self.render_buffer.extend_from_slice(samples);
        while self.render_buffer.len() >= APM_FRAME_SAMPLES {
            let frame = self
                .render_buffer
                .drain(..APM_FRAME_SAMPLES)
                .collect::<Vec<_>>();
            if let Err(err) = self.process_render_frame(&frame) {
                self.diagnostics.last_error = Some(err.to_string());
                log::warn!("[meeting] APM render processing failed: {err}");
            }
        }
    }

    pub fn process_capture(&mut self, samples: &[i16]) -> Vec<i16> {
        self.capture_buffer.extend_from_slice(samples);
        let mut out = Vec::new();
        while self.capture_buffer.len() >= APM_FRAME_SAMPLES {
            let frame = self
                .capture_buffer
                .drain(..APM_FRAME_SAMPLES)
                .collect::<Vec<_>>();
            match self.process_capture_frame(&frame) {
                Ok(mut processed) => out.append(&mut processed),
                Err(err) => {
                    self.diagnostics.last_error = Some(err.to_string());
                    log::warn!("[meeting] APM capture processing failed: {err}");
                }
            }
        }
        out
    }

    fn process_render_frame(&mut self, frame: &[i16]) -> Result<(), sonora::Error> {
        let src = i16_to_f32(frame);
        let mut dest = vec![0.0_f32; frame.len()];
        self.apm.process_render_f32(&[&src], &mut [&mut dest])?;
        self.diagnostics.render_frame_count += 1;
        Ok(())
    }

    fn process_capture_frame(&mut self, frame: &[i16]) -> Result<Vec<i16>, sonora::Error> {
        let src = i16_to_f32(frame);
        let mut dest = vec![0.0_f32; frame.len()];
        self.apm.process_capture_f32(&[&src], &mut [&mut dest])?;
        self.diagnostics.capture_frame_count += 1;
        self.diagnostics.processed_sample_count += dest.len() as u64;
        Ok(f32_to_i16(&dest))
    }
}

fn meeting_apm_config() -> Config {
    Config {
        // Sonora AEC3 can panic while resizing its adaptive FIR filter after
        // live echo-path changes. Keep non-AEC processing enabled so capture
        // stays reliable instead of crashing mid-meeting.
        echo_canceller: None,
        noise_suppression: Some(NoiseSuppression {
            level: NoiseSuppressionLevel::High,
            ..Default::default()
        }),
        high_pass_filter: Some(HighPassFilter::default()),
        gain_controller2: Some(GainController2 {
            input_volume_controller: false,
            adaptive_digital: Some(AdaptiveDigital::default()),
            ..Default::default()
        }),
        ..Default::default()
    }
}

impl Default for MeetingAudioProcessor {
    fn default() -> Self {
        Self::new()
    }
}

fn i16_to_f32(samples: &[i16]) -> Vec<f32> {
    samples
        .iter()
        .map(|sample| (*sample as f32 / I16_SCALE).clamp(-1.0, 1.0))
        .collect()
}

fn f32_to_i16(samples: &[f32]) -> Vec<i16> {
    samples
        .iter()
        .map(|sample| (sample.clamp(-1.0, 1.0) * I16_SCALE).round() as i16)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(samples: usize, amplitude: i16) -> Vec<i16> {
        (0..samples)
            .map(|index| {
                let phase = index as f32 / 8.0;
                (phase.sin() * amplitude as f32).round() as i16
            })
            .collect()
    }

    #[test]
    fn meeting_apm_config_disables_unstable_echo_canceller() {
        let config = meeting_apm_config();

        assert!(config.echo_canceller.is_none());
        assert!(config.noise_suppression.is_some());
        assert!(config.high_pass_filter.is_some());
        assert!(config.gain_controller2.is_some());
    }

    #[test]
    fn apm_initializes_with_noise_and_gain_path_active() {
        let apm = MeetingAudioProcessor::new();

        let diagnostics = apm.diagnostics();

        assert!(diagnostics.initialized);
        assert!(diagnostics.active);
        assert!(!diagnostics.echo_canceller_enabled);
        assert_eq!(diagnostics.render_frame_count, 0);
        assert_eq!(diagnostics.capture_frame_count, 0);
    }

    #[test]
    fn apm_accepts_render_reference_and_processes_capture_frames() {
        let mut apm = MeetingAudioProcessor::new();
        let render = tone(APM_FRAME_SAMPLES, 2_000);
        let capture = tone(APM_FRAME_SAMPLES, 4_000);

        apm.accept_render_reference(&render);
        let processed = apm.process_capture(&capture);

        assert_eq!(processed.len(), APM_FRAME_SAMPLES);
        let diagnostics = apm.diagnostics();
        assert_eq!(diagnostics.render_frame_count, 1);
        assert_eq!(diagnostics.capture_frame_count, 1);
        assert_eq!(diagnostics.processed_sample_count, APM_FRAME_SAMPLES as u64);
        assert!(diagnostics.last_error.is_none());
    }

    #[test]
    fn apm_handles_sustained_render_and_capture_without_panic() {
        let mut apm = MeetingAudioProcessor::new();
        let render = tone(APM_FRAME_SAMPLES, 7_500);
        let capture = tone(APM_FRAME_SAMPLES, 5_500);
        let mut processed_sample_count = 0usize;

        for frame_index in 0..700 {
            if frame_index == 400 {
                apm.apm.set_stream_delay_ms(50).unwrap();
            }
            apm.accept_render_reference(&render);
            processed_sample_count += apm.process_capture(&capture).len();
        }

        let diagnostics = apm.diagnostics();
        assert_eq!(diagnostics.render_frame_count, 700);
        assert_eq!(diagnostics.capture_frame_count, 700);
        assert_eq!(processed_sample_count, 700 * APM_FRAME_SAMPLES);
        assert!(diagnostics.last_error.is_none());
    }
}
