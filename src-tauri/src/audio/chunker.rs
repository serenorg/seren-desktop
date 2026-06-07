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

pub fn chunk(samples: &[i16], cfg: ChunkCfg) -> Vec<Chunk> {
    if samples.is_empty() || cfg.sample_rate == 0 || cfg.frame_ms == 0 {
        return Vec::new();
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

    chunks
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
}
