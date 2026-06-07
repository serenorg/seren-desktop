// ABOUTME: Deterministic capture source that replays preloaded PCM frames.
// ABOUTME: Drives pipeline tests and dev runs without real audio hardware.

use super::{AudioCaptureSource, CaptureError, FrameSender, PcmFrame};

/// A capture source that emits a fixed list of frames, then closes the stream.
///
/// Used by pipeline tests and dev replay: `start` synchronously pushes every
/// frame into the sink and returns, dropping the sink so the channel closes and
/// the consumer sees end-of-stream. Fully deterministic — no threads, no clock.
pub struct FakePcmSource {
    frames: Vec<Vec<i16>>,
}

impl FakePcmSource {
    /// Build a source from one contiguous buffer split into fixed-size frames.
    pub fn from_samples(samples: Vec<i16>, frame_len: usize) -> Self {
        let frame_len = frame_len.max(1);
        let frames = samples
            .chunks(frame_len)
            .map(<[i16]>::to_vec)
            .collect::<Vec<_>>();
        Self { frames }
    }

    /// Build a source from explicit frames.
    pub fn from_frames(frames: Vec<Vec<i16>>) -> Self {
        Self { frames }
    }
}

impl AudioCaptureSource for FakePcmSource {
    fn start(&mut self, sink: FrameSender) -> Result<(), CaptureError> {
        for samples in self.frames.drain(..) {
            // A dropped receiver is not an error for a replay source.
            let _ = sink.send(PcmFrame { samples });
        }
        Ok(())
    }

    fn stop(&mut self) {
        self.frames.clear();
    }
}
