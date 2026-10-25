use serde::Deserialize;

use crate::error::{DesktopError, DesktopResult};
use crate::project::{new_id, CaptionCue, EditorClip, EditorSnapshot, EditorState, Sequence};

const HISTORY_LIMIT: usize = 20;
pub const PUNCH_IN_MS: u64 = 800;
pub const CROSSFADE_MS: u64 = 400;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEdit {
    pub op: String,
    #[serde(default)]
    pub clip_id: String,
    #[serde(default)]
    pub caption_id: String,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub start_ms: u64,
    #[serde(default)]
    pub end_ms: u64,
    #[serde(default)]
    pub at_ms: u64,
    #[serde(default)]
    pub volume: f64,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub kind: String,
}

impl Default for TimelineEdit {
    fn default() -> Self {
        Self {
            op: String::new(),
            clip_id: String::new(),
            caption_id: String::new(),
            text: String::new(),
            start_ms: 0,
            end_ms: 0,
            at_ms: 0,
            volume: 1.0,
            enabled: false,
            kind: String::new(),
        }
    }
}

pub fn seed_assembly(media_id: &str, duration_ms: u64) -> EditorState {
    let duration = duration_ms;
    let half = duration / 2;
    let audio_two_end = duration.min(2_500);
    EditorState {
        clips: vec![
            clip("v1", media_id, 0, duration, 0, 1.0),
            clip("v2", media_id, half, duration, half, 1.0),
            clip("a1", media_id, 0, duration, 0, 1.0),
            clip("a2", media_id, 0, audio_two_end, 0, 0.45),
        ],
        crop: String::new(),
        punch_in: false,
        punch_in_ms: 0,
        transition: "cut".into(),
        overlay_text: String::new(),
        overlay_start_ms: 0,
        overlay_end_ms: duration.min(2_000),
        history: Vec::new(),
    }
}

pub fn opening_caption(duration_ms: u64) -> CaptionCue {
    let end = if duration_ms == 0 {
        2_000
    } else {
        duration_ms.min(2_400).max(400)
    };
    CaptionCue {
        caption_id: new_id("cap"),
        start_ms: 0,
        end_ms: end,
        text: "Caption".into(),
    }
}

pub fn materialize(sequence: &mut Sequence, media_id: &str, duration_ms: u64) {
    if duration_ms == 0 || !sequence.variation.is_empty() || !sequence.moment_id.is_empty() {
        return;
    }
    let pending = sequence.editor.clips.is_empty()
        || sequence
            .editor
            .clips
            .iter()
            .all(|item| item.source_out_ms == 0);
    if pending {
        let history = sequence.editor.history.clone();
        sequence.editor = seed_assembly(media_id, duration_ms);
        sequence.editor.history = history;
    }
    if sequence.captions.is_empty() {
        sequence.captions.push(opening_caption(duration_ms));
    }
    for caption in &mut sequence.captions {
        if caption.end_ms > duration_ms {
            caption.end_ms = duration_ms;
        }
        if caption.start_ms >= caption.end_ms {
            caption.start_ms = 0;
            caption.end_ms = duration_ms.min(400).max(1);
        }
    }
}

pub fn apply(sequence: &mut Sequence, edit: &TimelineEdit) -> DesktopResult<()> {
    match edit.op.as_str() {
        "split" => split_clip(sequence, &edit.clip_id, edit.at_ms),
        "delete" => delete_clip(sequence, &edit.clip_id),
        "delete_caption" => delete_caption(sequence, &edit.caption_id),
        "set_caption" => set_caption(sequence, edit),
        "set_volume" => set_volume(sequence, &edit.clip_id, edit.volume),
        "set_crop" => {
            remember(sequence);
            sequence.editor.crop = if edit.enabled {
                "center".into()
            } else {
                String::new()
            };
            Ok(())
        }
        "set_punch_in" => {
            remember(sequence);
            sequence.editor.punch_in = edit.enabled;
            if edit.enabled {
                sequence.editor.punch_in_ms = edit.at_ms;
            }
            Ok(())
        }
        "set_transition" => set_transition(sequence, &edit.kind),
        "set_overlay" => set_overlay(sequence, edit),
        "undo" => undo(sequence),
        _ => Err(DesktopError::Message("That edit is not available.".into())),
    }
}

fn clip(
    track: &str,
    media_id: &str,
    source_in_ms: u64,
    source_out_ms: u64,
    timeline_in_ms: u64,
    volume: f64,
) -> EditorClip {
    EditorClip {
        clip_id: new_id("clip"),
        track: track.into(),
        media_id: media_id.into(),
        source_in_ms,
        source_out_ms,
        timeline_in_ms,
        volume,
    }
}

fn snapshot(sequence: &Sequence) -> EditorSnapshot {
    EditorSnapshot {
        clips: sequence.editor.clips.clone(),
        captions: sequence.captions.clone(),
        crop: sequence.editor.crop.clone(),
        punch_in: sequence.editor.punch_in,
        punch_in_ms: sequence.editor.punch_in_ms,
        transition: sequence.editor.transition.clone(),
        overlay_text: sequence.editor.overlay_text.clone(),
        overlay_start_ms: sequence.editor.overlay_start_ms,
        overlay_end_ms: sequence.editor.overlay_end_ms,
    }
}

fn remember(sequence: &mut Sequence) {
    sequence.editor.history.push(snapshot(sequence));
    if sequence.editor.history.len() > HISTORY_LIMIT {
        let extra = sequence.editor.history.len() - HISTORY_LIMIT;
        sequence.editor.history.drain(0..extra);
    }
}

fn split_clip(sequence: &mut Sequence, clip_id: &str, at_ms: u64) -> DesktopResult<()> {
    let index = sequence
        .editor
        .clips
        .iter()
        .position(|item| item.clip_id == clip_id)
        .ok_or_else(|| DesktopError::Message("Select a clip to split.".into()))?;
    let current = sequence.editor.clips[index].clone();
    let span = current.source_out_ms.saturating_sub(current.source_in_ms);
    let timeline_end = current.timeline_in_ms + span;
    if at_ms <= current.timeline_in_ms + 40 || at_ms + 40 >= timeline_end {
        return Err(DesktopError::Message(
            "Move the playhead inside the clip to split it.".into(),
        ));
    }
    let delta = at_ms - current.timeline_in_ms;
    remember(sequence);
    let current = sequence.editor.clips[index].clone();
    let mut right = current.clone();
    right.clip_id = new_id("clip");
    right.source_in_ms = current.source_in_ms + delta;
    right.timeline_in_ms = at_ms;
    sequence.editor.clips[index].source_out_ms = current.source_in_ms + delta;
    sequence.editor.clips.insert(index + 1, right);
    Ok(())
}

fn delete_clip(sequence: &mut Sequence, clip_id: &str) -> DesktopResult<()> {
    let index = sequence
        .editor
        .clips
        .iter()
        .position(|item| item.clip_id == clip_id)
        .ok_or_else(|| DesktopError::Message("Select a clip to delete.".into()))?;
    remember(sequence);
    sequence.editor.clips.remove(index);
    Ok(())
}

fn delete_caption(sequence: &mut Sequence, caption_id: &str) -> DesktopResult<()> {
    let index = sequence
        .captions
        .iter()
        .position(|item| item.caption_id == caption_id)
        .ok_or_else(|| DesktopError::Message("Select a caption to delete.".into()))?;
    remember(sequence);
    sequence.captions.remove(index);
    Ok(())
}

fn set_caption(sequence: &mut Sequence, edit: &TimelineEdit) -> DesktopResult<()> {
    if edit.end_ms <= edit.start_ms {
        return Err(DesktopError::Message(
            "Caption end has to be after the start.".into(),
        ));
    }
    let index = if edit.caption_id.is_empty() {
        if sequence.captions.is_empty() {
            None
        } else {
            Some(0)
        }
    } else {
        sequence
            .captions
            .iter()
            .position(|item| item.caption_id == edit.caption_id)
    };
    remember(sequence);
    if let Some(index) = index {
        let caption = &mut sequence.captions[index];
        caption.text = edit.text.clone();
        caption.start_ms = edit.start_ms;
        caption.end_ms = edit.end_ms;
        return Ok(());
    }
    sequence.captions.push(CaptionCue {
        caption_id: new_id("cap"),
        start_ms: edit.start_ms,
        end_ms: edit.end_ms,
        text: edit.text.clone(),
    });
    Ok(())
}

fn set_volume(sequence: &mut Sequence, clip_id: &str, volume: f64) -> DesktopResult<()> {
    let index = sequence
        .editor
        .clips
        .iter()
        .position(|item| item.clip_id == clip_id)
        .ok_or_else(|| DesktopError::Message("Select an audio clip.".into()))?;
    if sequence.editor.clips[index].track != "a1" && sequence.editor.clips[index].track != "a2" {
        return Err(DesktopError::Message(
            "Volume applies to an audio clip.".into(),
        ));
    }
    remember(sequence);
    sequence.editor.clips[index].volume = volume.clamp(0.0, 1.0);
    Ok(())
}

fn set_transition(sequence: &mut Sequence, kind: &str) -> DesktopResult<()> {
    let next = match kind {
        "cut" => "cut",
        "crossfade" => "crossfade",
        _ => {
            return Err(DesktopError::Message(
                "Use a cut or a short crossfade.".into(),
            ))
        }
    };
    remember(sequence);
    sequence.editor.transition = next.into();
    Ok(())
}

fn set_overlay(sequence: &mut Sequence, edit: &TimelineEdit) -> DesktopResult<()> {
    let start = edit.start_ms;
    let end = if edit.end_ms > start {
        edit.end_ms
    } else {
        start + 1_000
    };
    remember(sequence);
    sequence.editor.overlay_text = edit.text.clone();
    sequence.editor.overlay_start_ms = start;
    sequence.editor.overlay_end_ms = end;
    Ok(())
}

fn undo(sequence: &mut Sequence) -> DesktopResult<()> {
    let Some(previous) = sequence.editor.history.pop() else {
        return Err(DesktopError::Message("Nothing to undo.".into()));
    };
    sequence.editor.clips = previous.clips;
    sequence.captions = previous.captions;
    sequence.editor.crop = previous.crop;
    sequence.editor.punch_in = previous.punch_in;
    sequence.editor.punch_in_ms = previous.punch_in_ms;
    sequence.editor.transition = previous.transition;
    sequence.editor.overlay_text = previous.overlay_text;
    sequence.editor.overlay_start_ms = previous.overlay_start_ms;
    sequence.editor.overlay_end_ms = previous.overlay_end_ms;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assembly(duration: u64) -> Sequence {
        let mut sequence = Sequence {
            sequence_id: "seq_1".into(),
            name: "Assembly".into(),
            clips: Vec::new(),
            moment_id: String::new(),
            variation: String::new(),
            aspect_ratio: String::new(),
            caption_theme: String::new(),
            export_preset: String::new(),
            captions: vec![opening_caption(duration)],
            changes: Vec::new(),
            preview_path: None,
            source_start_ms: 0,
            source_end_ms: 0,
            editor: seed_assembly("media_1", duration),
        };
        materialize(&mut sequence, "media_1", duration);
        sequence
    }

    fn tracks(sequence: &Sequence) -> Vec<&str> {
        sequence
            .editor
            .clips
            .iter()
            .map(|item| item.track.as_str())
            .collect()
    }

    #[test]
    fn seed_has_two_video_and_two_audio_tracks() {
        let sequence = assembly(8_000);
        assert_eq!(tracks(&sequence), vec!["v1", "v2", "a1", "a2"]);
        assert_eq!(sequence.captions.len(), 1);
        assert_eq!(sequence.editor.transition, "cut");
        let video_two = sequence
            .editor
            .clips
            .iter()
            .find(|item| item.track == "v2")
            .unwrap();
        assert_eq!(video_two.timeline_in_ms, 4_000);
    }

    #[test]
    fn split_delete_caption_volume_and_undo() {
        let mut sequence = assembly(8_000);
        let clip_id = sequence
            .editor
            .clips
            .iter()
            .find(|item| item.track == "v1")
            .unwrap()
            .clip_id
            .clone();
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "split".into(),
                clip_id: clip_id.clone(),
                at_ms: 3_000,
                ..TimelineEdit::default()
            },
        )
        .unwrap();
        assert_eq!(
            sequence
                .editor
                .clips
                .iter()
                .filter(|item| item.track == "v1")
                .count(),
            2
        );
        let caption_id = sequence.captions[0].caption_id.clone();
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "set_caption".into(),
                caption_id,
                text: "clutch line".into(),
                start_ms: 200,
                end_ms: 1_800,
                ..TimelineEdit::default()
            },
        )
        .unwrap();
        assert_eq!(sequence.captions[0].text, "clutch line");
        assert_eq!(sequence.captions[0].start_ms, 200);
        let audio_id = sequence
            .editor
            .clips
            .iter()
            .find(|item| item.track == "a1")
            .unwrap()
            .clip_id
            .clone();
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "set_volume".into(),
                clip_id: audio_id,
                volume: 0.4,
                ..TimelineEdit::default()
            },
        )
        .unwrap();
        assert_eq!(
            sequence
                .editor
                .clips
                .iter()
                .find(|item| item.track == "a1")
                .unwrap()
                .volume,
            0.4
        );
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "undo".into(),
                ..TimelineEdit::default()
            },
        )
        .unwrap();
        assert_eq!(
            sequence
                .editor
                .clips
                .iter()
                .find(|item| item.track == "a1")
                .unwrap()
                .volume,
            1.0
        );
        let extra = sequence
            .editor
            .clips
            .iter()
            .filter(|item| item.track == "v1")
            .nth(1)
            .unwrap()
            .clip_id
            .clone();
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "delete".into(),
                clip_id: extra,
                ..TimelineEdit::default()
            },
        )
        .unwrap();
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "undo".into(),
                ..TimelineEdit::default()
            },
        )
        .unwrap();
        assert_eq!(
            sequence
                .editor
                .clips
                .iter()
                .filter(|item| item.track == "v1")
                .count(),
            2
        );
    }

    #[test]
    fn one_punch_in_one_transition_and_overlay() {
        let mut sequence = assembly(8_000);
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "set_punch_in".into(),
                enabled: true,
                at_ms: 1_000,
                ..TimelineEdit::default()
            },
        )
        .unwrap();
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "set_punch_in".into(),
                enabled: true,
                at_ms: 4_200,
                ..TimelineEdit::default()
            },
        )
        .unwrap();
        assert!(sequence.editor.punch_in);
        assert_eq!(sequence.editor.punch_in_ms, 4_200);
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "set_transition".into(),
                kind: "crossfade".into(),
                ..TimelineEdit::default()
            },
        )
        .unwrap();
        assert_eq!(sequence.editor.transition, "crossfade");
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "set_crop".into(),
                enabled: true,
                ..TimelineEdit::default()
            },
        )
        .unwrap();
        assert_eq!(sequence.editor.crop, "center");
        assert_eq!(CROSSFADE_MS, 400);
        assert_eq!(PUNCH_IN_MS, 800);
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "set_overlay".into(),
                text: "Tippy".into(),
                start_ms: 500,
                end_ms: 2_000,
                ..TimelineEdit::default()
            },
        )
        .unwrap();
        assert_eq!(sequence.editor.overlay_text, "Tippy");
        apply(
            &mut sequence,
            &TimelineEdit {
                op: "set_transition".into(),
                kind: "wipe".into(),
                ..TimelineEdit::default()
            },
        )
        .unwrap_err();
        assert_eq!(sequence.editor.transition, "crossfade");
    }
}
