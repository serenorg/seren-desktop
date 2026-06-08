// ABOUTME: Maps meeting-stable diarization labels onto live Them transcript segments.
// ABOUTME: Pure time-overlap reconciliation, unit-tested independent of any I/O.

use crate::audio::transcribe::DiarizedSegment;
use crate::audio::types::TranscriptSegment;

/// Milliseconds of overlap between two `[start, end)` time spans (0 if disjoint).
fn overlap_ms(a_start: i64, a_end: i64, b_start: i64, b_end: i64) -> i64 {
    (a_end.min(b_end) - a_start.max(b_start)).max(0)
}

/// Reconcile meeting-stable diarization labels from a single full-recording pass
/// onto the live Them segments captured per streaming chunk.
///
/// For each live Them segment, find the diarized segments overlapping it in time
/// and pick the label with the most total overlap duration; ties resolve to the
/// label whose first overlapping diarized segment starts earliest. A live segment
/// with no diarized overlap is skipped entirely (its existing label is left
/// untouched). Returns `(segment_id, new_speaker_label)` only for segments that
/// matched, so callers never write a label they didn't derive from overlap.
pub fn reconcile_speaker_labels(
    live_them: &[TranscriptSegment],
    diarized: &[DiarizedSegment],
) -> Vec<(String, String)> {
    let mut mapping = Vec::new();

    for live in live_them {
        // (total overlap ms, earliest diarized start ms) per candidate label.
        let mut totals: Vec<(String, i64, i64)> = Vec::new();
        for seg in diarized {
            let Some(label) = seg.speaker_label.as_ref() else {
                continue;
            };
            let overlap = overlap_ms(live.start_ms, live.end_ms, seg.start_ms, seg.end_ms);
            if overlap <= 0 {
                continue;
            }
            match totals.iter_mut().find(|(l, _, _)| l == label) {
                Some(entry) => {
                    entry.1 += overlap;
                    entry.2 = entry.2.min(seg.start_ms);
                }
                None => totals.push((label.clone(), overlap, seg.start_ms)),
            }
        }

        // Most overlap wins; ties go to the earliest-starting diarized label.
        let best = totals.into_iter().max_by(|a, b| {
            a.1.cmp(&b.1) // larger total overlap first
                .then_with(|| b.2.cmp(&a.2)) // then earlier start (smaller ms) first
        });
        if let Some((label, _, _)) = best {
            mapping.push((live.id.clone(), label));
        }
    }

    mapping
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::types::{SegmentStatus, Speaker, SpeakerSource};

    fn live(id: &str, start_ms: i64, end_ms: i64) -> TranscriptSegment {
        TranscriptSegment {
            id: id.to_string(),
            meeting_id: "m1".to_string(),
            seq: 0,
            speaker: Speaker::Them,
            text: "hello".to_string(),
            start_ms,
            end_ms,
            status: SegmentStatus::Ok,
            speaker_label: None,
            speaker_source: SpeakerSource::Channel,
            created_at: 0,
        }
    }

    fn diar(label: &str, start_ms: i64, end_ms: i64) -> DiarizedSegment {
        DiarizedSegment {
            speaker_label: Some(label.to_string()),
            start_ms,
            end_ms,
            text: "x".to_string(),
        }
    }

    #[test]
    fn clean_overlap_maps_each_segment_to_its_diarized_label() {
        let live_them = vec![live("s1", 0, 1_000), live("s2", 1_200, 2_000)];
        let diarized = vec![diar("A", 0, 1_000), diar("B", 1_200, 2_000)];

        let mapping = reconcile_speaker_labels(&live_them, &diarized);

        assert_eq!(
            mapping,
            vec![
                ("s1".to_string(), "A".to_string()),
                ("s2".to_string(), "B".to_string()),
            ]
        );
    }

    #[test]
    fn dominant_overlap_wins_when_a_segment_spans_two_labels() {
        // Live [0,1000) overlaps A for 800ms ([0,800)) and B for 200ms ([800,1000)).
        let live_them = vec![live("s1", 0, 1_000)];
        let diarized = vec![diar("A", 0, 800), diar("B", 800, 2_000)];

        let mapping = reconcile_speaker_labels(&live_them, &diarized);

        assert_eq!(mapping, vec![("s1".to_string(), "A".to_string())]);
    }

    #[test]
    fn equal_overlap_tie_breaks_to_the_earliest_starting_label() {
        // Live [0,1000) overlaps B for 500ms ([500,1000)) and A for 500ms ([0,500)).
        // Equal overlap -> the earlier-starting label (A, start 0) wins.
        let live_them = vec![live("s1", 0, 1_000)];
        let diarized = vec![diar("B", 500, 1_000), diar("A", 0, 500)];

        let mapping = reconcile_speaker_labels(&live_them, &diarized);

        assert_eq!(mapping, vec![("s1".to_string(), "A".to_string())]);
    }

    #[test]
    fn segments_without_any_overlap_are_skipped() {
        // s2 falls in a gap with no diarized coverage -> no mapping for it.
        let live_them = vec![live("s1", 0, 1_000), live("s2", 5_000, 6_000)];
        let diarized = vec![diar("A", 0, 1_000)];

        let mapping = reconcile_speaker_labels(&live_them, &diarized);

        assert_eq!(mapping, vec![("s1".to_string(), "A".to_string())]);
    }

    #[test]
    fn empty_inputs_yield_no_mapping() {
        assert!(reconcile_speaker_labels(&[], &[diar("A", 0, 1_000)]).is_empty());
        assert!(reconcile_speaker_labels(&[live("s1", 0, 1_000)], &[]).is_empty());
        assert!(reconcile_speaker_labels(&[], &[]).is_empty());
    }

    #[test]
    fn diarized_segments_with_no_label_are_ignored() {
        // A full-recording pass that returned a labelless segment must not produce
        // a mapping from it (no stable speaker identity to assign).
        let live_them = vec![live("s1", 0, 1_000)];
        let diarized = vec![DiarizedSegment {
            speaker_label: None,
            start_ms: 0,
            end_ms: 1_000,
            text: "x".to_string(),
        }];

        assert!(reconcile_speaker_labels(&live_them, &diarized).is_empty());
    }
}
