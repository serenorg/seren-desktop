// ABOUTME: Energy-based VAD chunker for near-real-time Whisper windows.
// ABOUTME: Splits 16-bit mono PCM on sustained silence with max-window guards.

#[derive(Debug, Clone, Copy)]
pub struct ChunkCfg {
    pub sample_rate: u32,
    pub frame_ms: u32,
    pub silence_ms: u32,
    pub min_window_ms: u32,
    pub max_window_ms: u32,
    pub rms_threshold: f32,
}

impl Default for ChunkCfg {
    fn default() -> Self {
        Self {
            sample_rate: 16_000,
            frame_ms: 20,
            silence_ms: 500,
            min_window_ms: 250,
            max_window_ms: 20_000,
            rms_threshold: 350.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub start_ms: u32,
    pub end_ms: u32,
    pub samples: Vec<i16>,
}

/// Split a complete PCM buffer into speech chunks on silence boundaries.
pub fn chunk(samples: &[i16], cfg: ChunkCfg) -> Vec<Chunk> {
    chunk_stream(samples, cfg, true).0
}

/// Split a PCM buffer, returning `(completed_chunks, consumed_samples)`.
///
/// When `at_end` is false the trailing in-progress utterance is NOT emitted and
/// is left unconsumed (its start index is the keep-point) so a live stream can
/// finish it once more audio arrives. `consumed_samples` is the prefix the caller
/// may discard. When `at_end` is true the remainder is flushed and fully consumed.
pub fn chunk_stream(samples: &[i16], cfg: ChunkCfg, at_end: bool) -> (Vec<Chunk>, usize) {
    if samples.is_empty() || cfg.sample_rate == 0 || cfg.frame_ms == 0 {
        return (Vec::new(), samples.len());
    }

    let frame_samples = samples_for_ms(cfg.sample_rate, cfg.frame_ms).max(1);
    let silence_frames_needed = (cfg.silence_ms / cfg.frame_ms).max(1);
    let mut chunks = Vec::new();
    let mut speech_start: Option<usize> = None;
    let mut last_speech_end = 0usize;
    let mut silent_frames = 0u32;
    let mut frame_start = 0usize;

    while frame_start < samples.len() {
        let frame_end = (frame_start + frame_samples).min(samples.len());
        let frame = &samples[frame_start..frame_end];
        let is_speech = rms(frame) >= cfg.rms_threshold;

        if is_speech {
            if speech_start.is_none() {
                speech_start = Some(frame_start);
            }
            silent_frames = 0;
            last_speech_end = frame_end;
        } else if speech_start.is_some() {
            silent_frames += 1;
        }

        if let Some(start) = speech_start {
            let current_ms = duration_ms(start, frame_end, cfg.sample_rate);
            if current_ms >= cfg.max_window_ms {
                push_chunk(&mut chunks, samples, start, frame_end, cfg.sample_rate);
                speech_start = None;
                last_speech_end = 0;
                silent_frames = 0;
            } else if silent_frames >= silence_frames_needed {
                let window_ms = duration_ms(start, last_speech_end, cfg.sample_rate);
                if window_ms >= cfg.min_window_ms {
                    push_chunk(
                        &mut chunks,
                        samples,
                        start,
                        last_speech_end,
                        cfg.sample_rate,
                    );
                }
                speech_start = None;
                last_speech_end = 0;
                silent_frames = 0;
            }
        }

        frame_start = frame_end;
    }

    let consumed = if at_end {
        if let Some(start) = speech_start {
            let end = if last_speech_end > start {
                last_speech_end
            } else {
                samples.len()
            };
            if duration_ms(start, end, cfg.sample_rate) >= cfg.min_window_ms {
                push_chunk(&mut chunks, samples, start, end, cfg.sample_rate);
            }
        }
        samples.len()
    } else {
        // Keep only the in-progress utterance; everything before it is resolved.
        speech_start.unwrap_or(samples.len())
    };

    (chunks, consumed)
}

/// Stateful driver that feeds a live stream into [`chunk_stream`], emitting
/// completed chunks with absolute timestamps and discarding consumed audio.
pub struct StreamingChunker {
    cfg: ChunkCfg,
    buffer: Vec<i16>,
    base_sample: usize,
}

impl StreamingChunker {
    pub fn new(cfg: ChunkCfg) -> Self {
        Self {
            cfg,
            buffer: Vec::new(),
            base_sample: 0,
        }
    }

    /// Append samples and return any chunks that just completed (absolute ms).
    pub fn push(&mut self, samples: &[i16]) -> Vec<Chunk> {
        self.buffer.extend_from_slice(samples);
        self.drain(false)
    }

    /// Flush the final in-progress utterance at end of stream (absolute ms).
    pub fn finish(&mut self) -> Vec<Chunk> {
        self.drain(true)
    }

    /// Absolute ms of audio consumed so far — the position the next chunk starts
    /// from. Used to anchor a pause-gap marker at the current point in the
    /// transcript timeline.
    pub fn base_ms(&self) -> u32 {
        sample_to_ms(self.base_sample, self.cfg.sample_rate)
    }

    fn drain(&mut self, at_end: bool) -> Vec<Chunk> {
        let base_ms = sample_to_ms(self.base_sample, self.cfg.sample_rate);
        let (mut chunks, consumed) = chunk_stream(&self.buffer, self.cfg, at_end);
        for chunk in &mut chunks {
            chunk.start_ms = chunk.start_ms.saturating_add(base_ms);
            chunk.end_ms = chunk.end_ms.saturating_add(base_ms);
        }
        let consumed = consumed.min(self.buffer.len());
        self.buffer.drain(0..consumed);
        self.base_sample += consumed;
        chunks
    }
}

fn push_chunk(
    chunks: &mut Vec<Chunk>,
    samples: &[i16],
    start: usize,
    end: usize,
    sample_rate: u32,
) {
    chunks.push(Chunk {
        start_ms: sample_to_ms(start, sample_rate),
        end_ms: sample_to_ms(end, sample_rate),
        samples: samples[start..end].to_vec(),
    });
}

fn samples_for_ms(sample_rate: u32, ms: u32) -> usize {
    ((sample_rate as u64 * ms as u64) / 1000) as usize
}

fn sample_to_ms(sample: usize, sample_rate: u32) -> u32 {
    ((sample as u64 * 1000) / sample_rate as u64) as u32
}

fn duration_ms(start: usize, end: usize, sample_rate: u32) -> u32 {
    sample_to_ms(end.saturating_sub(start), sample_rate)
}

fn rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }

    let sum = samples
        .iter()
        .map(|sample| {
            let value = *sample as f64;
            value * value
        })
        .sum::<f64>();

    (sum / samples.len() as f64).sqrt() as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ChunkCfg {
        ChunkCfg {
            sample_rate: 1_000,
            frame_ms: 10,
            silence_ms: 50,
            min_window_ms: 40,
            max_window_ms: 200,
            rms_threshold: 100.0,
        }
    }

    fn pcm(value: i16, ms: usize) -> Vec<i16> {
        vec![value; ms]
    }

    #[test]
    fn chunk_one_utterance_between_silences() {
        let samples = [pcm(0, 100), pcm(1_000, 80), pcm(0, 100)].concat();

        let chunks = chunk(&samples, cfg());

        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].start_ms, 100);
        assert_eq!(chunks[0].end_ms, 180);
    }

    #[test]
    fn chunk_two_utterances_split_by_long_pause() {
        let samples = [
            pcm(0, 50),
            pcm(1_000, 60),
            pcm(0, 70),
            pcm(1_000, 60),
            pcm(0, 50),
        ]
        .concat();

        let chunks = chunk(&samples, cfg());

        assert_eq!(chunks.len(), 2);
        assert_eq!((chunks[0].start_ms, chunks[0].end_ms), (50, 110));
        assert_eq!((chunks[1].start_ms, chunks[1].end_ms), (180, 240));
    }

    #[test]
    fn chunk_forces_split_at_max_window() {
        let samples = [pcm(0, 20), pcm(1_000, 450), pcm(0, 20)].concat();

        let chunks = chunk(&samples, cfg());

        assert_eq!(chunks.len(), 3);
        assert_eq!((chunks[0].start_ms, chunks[0].end_ms), (20, 220));
        assert_eq!((chunks[1].start_ms, chunks[1].end_ms), (220, 420));
        assert_eq!((chunks[2].start_ms, chunks[2].end_ms), (420, 470));
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk.end_ms - chunk.start_ms <= cfg().max_window_ms)
        );
    }

    #[test]
    fn chunk_all_silence_returns_no_chunks() {
        let samples = pcm(0, 500);

        let chunks = chunk(&samples, cfg());

        assert!(chunks.is_empty());
    }

    #[test]
    fn streaming_chunker_emits_on_close_and_flushes_remainder() {
        let mut streaming = StreamingChunker::new(cfg());

        // In-progress speech (no trailing silence) emits nothing yet.
        let first = streaming.push(&[pcm(0, 50), pcm(1_000, 80)].concat());
        assert!(first.is_empty());

        // A following silence closes the utterance into one chunk, with absolute ms.
        let second = streaming.push(&pcm(0, 60));
        assert_eq!(second.len(), 1);
        assert_eq!((second[0].start_ms, second[0].end_ms), (50, 130));

        // A new utterance stays buffered until the stream ends.
        let third = streaming.push(&pcm(1_000, 50));
        assert!(third.is_empty());
        let flushed = streaming.finish();
        assert_eq!(flushed.len(), 1);
    }
}
