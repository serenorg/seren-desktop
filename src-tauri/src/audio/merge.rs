// ABOUTME: Merges independently transcribed Me/Them streams by timestamp.
// ABOUTME: Preserves gap segments and assigns final chronological sequence ids.

use crate::audio::types::TranscriptSegment;

pub fn merge_segments(
    me: Vec<TranscriptSegment>,
    them: Vec<TranscriptSegment>,
) -> Vec<TranscriptSegment> {
    let mut indexed = Vec::with_capacity(me.len() + them.len());
    let mut index = 0usize;

    for segment in me {
        indexed.push((index, segment));
        index += 1;
    }
    for segment in them {
        indexed.push((index, segment));
        index += 1;
    }

    indexed.sort_by(|(left_index, left), (right_index, right)| {
        left.start_ms
            .cmp(&right.start_ms)
            .then_with(|| left_index.cmp(right_index))
    });

    indexed
        .into_iter()
        .enumerate()
        .map(|(seq, (_, mut segment))| {
            segment.seq = seq as i64;
            segment
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::types::{SegmentStatus, Speaker, SpeakerSource};

    fn segment(
        speaker: Speaker,
        seq: i64,
        start_ms: i64,
        status: SegmentStatus,
    ) -> TranscriptSegment {
        TranscriptSegment {
            id: format!("seg-{}-{}", seq, start_ms),
            meeting_id: "meeting-1".to_string(),
            seq,
            speaker,
            text: format!("segment {}", seq),
            start_ms,
            end_ms: start_ms + 100,
            status,
            speaker_label: None,
            speaker_source: SpeakerSource::Channel,
            created_at: 1,
        }
    }

    #[test]
    fn merge_segments_orders_interleaved_timestamps() {
        let me = vec![
            segment(Speaker::Me, 0, 100, SegmentStatus::Ok),
            segment(Speaker::Me, 1, 400, SegmentStatus::Ok),
        ];
        let them = vec![
            segment(Speaker::Them, 0, 200, SegmentStatus::Ok),
            segment(Speaker::Them, 1, 300, SegmentStatus::Ok),
        ];

        let merged = merge_segments(me, them);

        let starts: Vec<i64> = merged.iter().map(|segment| segment.start_ms).collect();
        let seqs: Vec<i64> = merged.iter().map(|segment| segment.seq).collect();
        assert_eq!(starts, vec![100, 200, 300, 400]);
        assert_eq!(seqs, vec![0, 1, 2, 3]);
    }

    #[test]
    fn merge_segments_keeps_stable_order_on_ties() {
        let me = vec![segment(Speaker::Me, 0, 100, SegmentStatus::Ok)];
        let them = vec![segment(Speaker::Them, 0, 100, SegmentStatus::Ok)];

        let merged = merge_segments(me, them);

        assert_eq!(merged[0].speaker, Speaker::Me);
        assert_eq!(merged[1].speaker, Speaker::Them);
    }

    #[test]
    fn merge_segments_preserves_gap_segments() {
        let me = vec![segment(Speaker::Me, 0, 100, SegmentStatus::Gap)];
        let them = vec![segment(Speaker::Them, 0, 50, SegmentStatus::Ok)];

        let merged = merge_segments(me, them);

        assert_eq!(merged[1].status, SegmentStatus::Gap);
    }
}
