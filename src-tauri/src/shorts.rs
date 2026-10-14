use crate::media::SilenceSpan;
use crate::project::{
    new_id, CaptionCue, Moment, ReviewChange, Sequence, SequenceClip, TranscriptSegment,
};

pub const THEME_BOLD: &str = "Bold";
pub const PRESET_SHORT: &str = "Short 9:16";
pub const ASPECT_VERTICAL: &str = "9:16";
pub const ASPECT_SOURCE: &str = "source";
pub const VARIATION_ORIGINAL: &str = "original";
pub const VARIATION_TIPPY: &str = "tippy";

const MIN_PIECE_MS: u64 = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeechPiece {
    pub start_ms: u64,
    pub end_ms: u64,
}

pub fn asks_for_four_shorts(text: &str) -> bool {
    let lower = text
        .trim()
        .trim_matches(|ch: char| matches!(ch, '?' | '!' | '.'))
        .trim()
        .to_lowercase();
    lower == "create 4 shorts" || lower == "create four shorts"
}

pub fn clock(ms: u64) -> String {
    let total = (ms as f64 / 1000.0).round() as u64;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

pub fn seconds_label(ms: u64) -> String {
    let tenths = (ms as f64 / 100.0).round() as u64;
    if tenths % 10 == 0 {
        format!("{}", tenths / 10)
    } else {
        format!("{}.{}", tenths / 10, tenths % 10)
    }
}

/// Cut silence out of a moment. Pieces shorter than 200 ms are dropped.
/// If that leaves nothing, the original range is kept and no silence is claimed.
pub fn speech_ranges(
    start_ms: u64,
    end_ms: u64,
    silences: &[SilenceSpan],
) -> (Vec<SpeechPiece>, u64) {
    if end_ms <= start_ms {
        return (Vec::new(), 0);
    }
    let mut pieces = vec![(start_ms, end_ms)];
    for silence in silences {
        if silence.end_ms <= silence.start_ms {
            continue;
        }
        let mut next = Vec::new();
        for (start, end) in pieces {
            let cut_start = silence.start_ms.max(start);
            let cut_end = silence.end_ms.min(end);
            if cut_end <= cut_start {
                next.push((start, end));
                continue;
            }
            if cut_start > start {
                next.push((start, cut_start));
            }
            if cut_end < end {
                next.push((cut_end, end));
            }
        }
        pieces = next;
    }
    pieces.retain(|(start, end)| end.saturating_sub(*start) >= MIN_PIECE_MS);
    if pieces.is_empty() {
        return (vec![SpeechPiece { start_ms, end_ms }], 0);
    }
    let kept: u64 = pieces
        .iter()
        .map(|(start, end)| end.saturating_sub(*start))
        .sum();
    let removed = end_ms.saturating_sub(start_ms).saturating_sub(kept);
    (
        pieces
            .into_iter()
            .map(|(start_ms, end_ms)| SpeechPiece { start_ms, end_ms })
            .collect(),
        removed,
    )
}

pub fn map_span(start_ms: u64, end_ms: u64, pieces: &[SpeechPiece]) -> Option<(u64, u64)> {
    if end_ms <= start_ms {
        return None;
    }
    let mut cursor = 0u64;
    let mut out_start = None;
    let mut out_end = None;
    for piece in pieces {
        let len = piece.end_ms.saturating_sub(piece.start_ms);
        let overlap_start = start_ms.max(piece.start_ms);
        let overlap_end = end_ms.min(piece.end_ms);
        if overlap_end > overlap_start {
            let mapped_start = cursor + overlap_start.saturating_sub(piece.start_ms);
            let mapped_end = cursor + overlap_end.saturating_sub(piece.start_ms);
            if out_start.is_none() {
                out_start = Some(mapped_start);
            }
            out_end = Some(mapped_end);
        }
        cursor += len;
    }
    match (out_start, out_end) {
        (Some(start), Some(end)) if end > start => Some((start, end)),
        _ => None,
    }
}

pub fn captions_for(pieces: &[SpeechPiece], segments: &[TranscriptSegment]) -> Vec<CaptionCue> {
    let mut raw = Vec::new();
    for segment in segments {
        if segment.words.is_empty() {
            let text = clean_caption(&segment.text);
            if !text.is_empty() {
                raw.push((segment.start_ms, segment.end_ms, text));
            }
        } else {
            for word in &segment.words {
                let text = clean_caption(&word.text);
                if !text.is_empty() {
                    raw.push((word.start_ms, word.end_ms, text));
                }
            }
        }
    }
    raw.sort_by_key(|item| item.0);
    let mut mapped = Vec::new();
    for (start_ms, end_ms, text) in raw {
        if let Some((start_ms, end_ms)) = map_span(start_ms, end_ms, pieces) {
            mapped.push((start_ms, end_ms.max(start_ms + MIN_PIECE_MS), text));
        }
    }
    chunk_captions(&mapped)
}

fn chunk_captions(words: &[(u64, u64, String)]) -> Vec<CaptionCue> {
    const MAX_WORDS: usize = 5;
    const MAX_SPAN_MS: u64 = 2_400;
    let mut captions = Vec::new();
    let mut bucket: Vec<&(u64, u64, String)> = Vec::new();
    let flush = |bucket: &mut Vec<&(u64, u64, String)>, captions: &mut Vec<CaptionCue>| {
        if bucket.is_empty() {
            return;
        }
        let start_ms = bucket[0].0;
        let end_ms = bucket
            .last()
            .map(|word| word.1)
            .unwrap_or(start_ms)
            .max(start_ms + 400);
        let text = bucket
            .iter()
            .map(|word| word.2.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        captions.push(CaptionCue {
            caption_id: new_id("cap"),
            start_ms,
            end_ms,
            text,
        });
        bucket.clear();
    };
    for word in words {
        let start = bucket.first().map(|item| item.0).unwrap_or(word.0);
        let would_span = word.1.saturating_sub(start);
        if !bucket.is_empty() && (bucket.len() >= MAX_WORDS || would_span > MAX_SPAN_MS) {
            flush(&mut bucket, &mut captions);
        }
        bucket.push(word);
    }
    flush(&mut bucket, &mut captions);
    captions
}

fn clean_caption(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub struct DraftInput<'a> {
    pub rank: usize,
    pub moment: &'a Moment,
    pub silences: &'a [SilenceSpan],
    pub segments: &'a [TranscriptSegment],
}

pub fn draft_variations(input: DraftInput<'_>) -> (Sequence, Sequence) {
    let moment = input.moment;
    let rank = input.rank.max(1);
    let (pieces, removed_ms) = speech_ranges(moment.start_ms, moment.end_ms, input.silences);
    let pieces = if pieces.is_empty() {
        vec![SpeechPiece {
            start_ms: moment.start_ms,
            end_ms: moment.end_ms,
        }]
    } else {
        pieces
    };
    let media_id = moment.media_id.clone();
    let original = Sequence {
        sequence_id: new_id("seq"),
        name: format!("Short {rank} · Original"),
        clips: vec![SequenceClip {
            media_id: media_id.clone(),
            start_ms: moment.start_ms,
            end_ms: moment.end_ms,
        }],
        moment_id: moment.moment_id.clone(),
        variation: VARIATION_ORIGINAL.into(),
        aspect_ratio: ASPECT_SOURCE.into(),
        caption_theme: String::new(),
        export_preset: String::new(),
        captions: Vec::new(),
        changes: vec![change("original", "Kept this moment as recorded")],
        preview_path: None,
        source_start_ms: moment.start_ms,
        source_end_ms: moment.end_ms,
    };
    let captions = captions_for(&pieces, input.segments);
    let mut changes = vec![change(
        "trim",
        &format!(
            "Trimmed the moment to {}–{}",
            clock(moment.start_ms),
            clock(moment.end_ms)
        ),
    )];
    if removed_ms > 0 {
        changes.push(change(
            "silence",
            &format!("Removed {} sec of silence", seconds_label(removed_ms)),
        ));
    }
    changes.push(change("crop", "Cropped the frame to 9:16"));
    if !captions.is_empty() {
        let noun = if captions.len() == 1 {
            "caption"
        } else {
            "captions"
        };
        changes.push(change(
            "captions",
            &format!("Added {} {noun}", captions.len()),
        ));
    }
    changes.push(change(
        "theme",
        &format!("Applied the {THEME_BOLD} caption theme"),
    ));
    changes.push(change(
        "preset",
        &format!("Set the {PRESET_SHORT} export preset"),
    ));
    let tippy = Sequence {
        sequence_id: new_id("seq"),
        name: format!("Short {rank} · Tippy / {}", moment.category),
        clips: pieces
            .iter()
            .map(|piece| SequenceClip {
                media_id: media_id.clone(),
                start_ms: piece.start_ms,
                end_ms: piece.end_ms,
            })
            .collect(),
        moment_id: moment.moment_id.clone(),
        variation: VARIATION_TIPPY.into(),
        aspect_ratio: ASPECT_VERTICAL.into(),
        caption_theme: THEME_BOLD.into(),
        export_preset: PRESET_SHORT.into(),
        captions,
        changes,
        preview_path: None,
        source_start_ms: moment.start_ms,
        source_end_ms: moment.end_ms,
    };
    (original, tippy)
}

fn change(kind: &str, label: &str) -> ReviewChange {
    ReviewChange {
        change_id: new_id("chg"),
        kind: kind.into(),
        label: label.into(),
        undone: false,
        accepted: false,
    }
}

/// Reverse the latest change that is still applied. The sequence stays.
pub fn undo_last(sequence: &mut Sequence) -> Option<String> {
    let index = sequence.changes.iter().rposition(|change| !change.undone)?;
    let kind = sequence.changes[index].kind.clone();
    sequence.changes[index].undone = true;
    sequence.changes[index].accepted = false;
    match kind.as_str() {
        "captions" => sequence.captions.clear(),
        "crop" => sequence.aspect_ratio = ASPECT_SOURCE.into(),
        "theme" => sequence.caption_theme.clear(),
        "preset" => sequence.export_preset.clear(),
        "silence" => {
            let media_id = sequence
                .clips
                .first()
                .map(|clip| clip.media_id.clone())
                .unwrap_or_default();
            sequence.clips = vec![SequenceClip {
                media_id,
                start_ms: sequence.source_start_ms,
                end_ms: sequence.source_end_ms,
            }];
        }
        _ => {}
    }
    Some(kind)
}

pub fn accept_all(sequence: &mut Sequence) {
    for change in &mut sequence.changes {
        if !change.undone {
            change.accepted = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{MomentScores, TranscriptWord};

    fn moment() -> Moment {
        Moment {
            moment_id: "moment_1".into(),
            media_id: "media_1".into(),
            start_ms: 0,
            end_ms: 10_000,
            usable_ms: 7_500,
            category: "Gameplay".into(),
            quote: "clutch".into(),
            explanation: "A clear payoff.".into(),
            preview_path: None,
            scores: MomentScores {
                hook_strength: 0.5,
                emotion: 0.4,
                clarity: 0.6,
                payoff: 0.7,
                pacing: 0.5,
                standalone_context: 0.4,
            },
        }
    }

    fn segment(start: u64, end: u64, text: &str) -> TranscriptSegment {
        TranscriptSegment {
            segment_id: format!("seg_{start}"),
            start_ms: start,
            end_ms: end,
            text: text.into(),
            speaker: None,
            profanity: false,
            words: vec![TranscriptWord {
                start_ms: start,
                end_ms: end,
                text: text.into(),
            }],
        }
    }

    #[test]
    fn silence_removal_shrinks_the_moment_and_remaps_captions() {
        let silences = vec![
            SilenceSpan {
                start_ms: 2_000,
                end_ms: 4_000,
            },
            SilenceSpan {
                start_ms: 7_000,
                end_ms: 7_500,
            },
        ];
        let (pieces, removed) = speech_ranges(0, 10_000, &silences);
        assert_eq!(removed, 2_500);
        assert_eq!(pieces.len(), 3);
        let captions = captions_for(
            &pieces,
            &[
                segment(1_000, 1_400, "hello"),
                segment(2_100, 3_900, "gone"),
                segment(8_000, 8_400, "back"),
            ],
        );
        assert!(captions.iter().any(|caption| caption.text == "hello"));
        assert!(captions
            .iter()
            .all(|caption| !caption.text.contains("gone")));
        let back = captions
            .iter()
            .find(|caption| caption.text == "back")
            .unwrap();
        assert_eq!(back.start_ms, 5_500);
        let (original, tippy) = draft_variations(DraftInput {
            rank: 2,
            moment: &moment(),
            silences: &silences,
            segments: &[
                segment(1_000, 1_500, "hello"),
                segment(4_000, 4_600, "back"),
            ],
        });
        assert_eq!(original.name, "Short 2 · Original");
        assert_eq!(tippy.name, "Short 2 · Tippy / Gameplay");
        assert_ne!(original.sequence_id, tippy.sequence_id);
        assert_eq!(original.clips.len(), 1);
        assert!(tippy.clips.len() > 1);
        assert_eq!(tippy.aspect_ratio, "9:16");
        assert_eq!(tippy.caption_theme, "Bold");
        assert_eq!(tippy.export_preset, "Short 9:16");
        assert!(tippy
            .changes
            .iter()
            .any(|change| change.label == "Removed 2.5 sec of silence"));
        assert!(tippy
            .changes
            .iter()
            .any(|change| change.label == "Cropped the frame to 9:16"));
        assert!(tippy
            .changes
            .iter()
            .all(|change| !change.label.to_lowercase().contains("viral")));
        let tippy_span: u64 = tippy
            .clips
            .iter()
            .map(|clip| clip.end_ms.saturating_sub(clip.start_ms))
            .sum();
        assert!(tippy_span < 10_000);
    }

    #[test]
    fn undo_walks_the_change_log_without_deleting_the_sequence() {
        let (_, mut tippy) = draft_variations(DraftInput {
            rank: 1,
            moment: &moment(),
            silences: &[SilenceSpan {
                start_ms: 2_000,
                end_ms: 3_200,
            }],
            segments: &[segment(500, 900, "hook")],
        });
        assert_eq!(undo_last(&mut tippy).as_deref(), Some("preset"));
        assert!(tippy.export_preset.is_empty());
        assert_eq!(undo_last(&mut tippy).as_deref(), Some("theme"));
        assert!(tippy.caption_theme.is_empty());
        assert_eq!(undo_last(&mut tippy).as_deref(), Some("captions"));
        assert!(tippy.captions.is_empty());
        assert!(tippy
            .changes
            .iter()
            .any(|change| change.kind == "captions" && change.undone));
        assert_eq!(undo_last(&mut tippy).as_deref(), Some("crop"));
        assert_eq!(tippy.aspect_ratio, "source");
        assert_eq!(undo_last(&mut tippy).as_deref(), Some("silence"));
        assert_eq!(tippy.clips.len(), 1);
        assert_eq!(tippy.clips[0].start_ms, 0);
        assert_eq!(tippy.clips[0].end_ms, 10_000);
        assert_eq!(undo_last(&mut tippy).as_deref(), Some("trim"));
        assert!(!tippy.sequence_id.is_empty());
        assert_eq!(tippy.clips.len(), 1);
        accept_all(&mut tippy);
        assert!(tippy
            .changes
            .iter()
            .all(|change| change.undone || change.accepted));
    }

    #[test]
    fn four_shorts_phrase_does_not_match_other_questions() {
        assert!(asks_for_four_shorts("Create 4 Shorts"));
        assert!(asks_for_four_shorts("create four shorts"));
        assert!(!asks_for_four_shorts("Find my best clips"));
        assert!(!asks_for_four_shorts("Where did I talk about GTA VI?"));
        assert_eq!(clock(8_072_000), "2:14:32");
        assert_eq!(seconds_label(1_200), "1.2");
        assert_eq!(seconds_label(7_800), "7.8");
    }

    #[test]
    fn a_scrap_of_silence_does_not_empty_the_moment() {
        let (pieces, removed) = speech_ranges(
            0,
            1_000,
            &[SilenceSpan {
                start_ms: 0,
                end_ms: 900,
            }],
        );
        assert_eq!(removed, 0);
        assert_eq!(pieces.len(), 1);
        assert_eq!(pieces[0].end_ms - pieces[0].start_ms, 1_000);
    }
}
