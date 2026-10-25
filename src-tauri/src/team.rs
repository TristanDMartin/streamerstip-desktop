use crate::jobs::{Job, JobState};
use crate::project::{new_id, Moment, PackageDraft, QaFinding, Sequence};
use crate::shorts::VARIATION_TIPPY;

pub fn explanation_for(action_id: &str) -> &'static str {
    match action_id {
        "probe_media" => "Reading the video so Tippy knows the length, picture, and sound.",
        "create_proxy" => "Making a lighter copy so the preview stays smooth.",
        "extract_audio" => "Pulling the sound so Tippy can hear the stream.",
        "create_thumbnail" => "Grabbing a still so this video is easy to recognize.",
        "detect_scenes" => "Noting where the picture changes.",
        "detect_silence" => "Finding quiet stretches that can come out of a Short.",
        "transcribe_media" => "Writing down what was said, with timestamps.",
        "scout_moments" => "Looking for moments that can stand on their own.",
        "create_short" | "refresh_short" => "Making a vertical Short from this moment.",
        "export_short" | "create_export" => "Writing a playable file on this machine.",
        "package_content" => "Writing a title and hook from the moment. Nothing is published.",
        "qa_content" => "Checking the Short is vertical, captioned, and ready to review.",
        _ => "Working on this project.",
    }
}

pub fn mark_paused(job: &mut Job) -> bool {
    if job.state.is_terminal() || job.state == JobState::Paused {
        return false;
    }
    job.state = JobState::Paused;
    job.message = "Paused".into();
    job.completed_at = None;
    true
}

pub fn mark_resumed(job: &mut Job, dependencies_met: bool) -> bool {
    if job.state != JobState::Paused {
        return false;
    }
    job.state = if dependencies_met {
        JobState::Queued
    } else {
        JobState::WaitingForDependency
    };
    job.message = "Ready".into();
    job.completed_at = None;
    true
}

pub fn mark_retried(job: &mut Job) -> bool {
    if !matches!(job.state, JobState::Failed | JobState::Cancelled) {
        return false;
    }
    job.state = JobState::Retrying;
    job.error = None;
    job.progress = 0.0;
    job.completed_at = None;
    job.message = "Retrying".into();
    true
}

pub fn draft_packages(sequences: &[Sequence], moments: &[Moment]) -> Vec<PackageDraft> {
    let mut drafts = Vec::new();
    for sequence in sequences {
        if sequence.variation != VARIATION_TIPPY || sequence.moment_id.is_empty() {
            continue;
        }
        let Some(moment) = moments
            .iter()
            .find(|moment| moment.moment_id == sequence.moment_id)
        else {
            continue;
        };
        let quote = moment
            .quote
            .trim()
            .trim_matches(|ch: char| ch == '.' || ch.is_whitespace());
        let title = if quote.is_empty() {
            format!("{} Short", moment.category.trim())
        } else {
            format!("{} — {quote}", moment.category.trim())
        };
        let hook = if moment.explanation.trim().is_empty() {
            "A moment that can stand on its own.".into()
        } else {
            moment.explanation.clone()
        };
        drafts.push(PackageDraft {
            package_id: new_id("pkg"),
            sequence_id: sequence.sequence_id.clone(),
            moment_id: moment.moment_id.clone(),
            title,
            hook,
        });
    }
    drafts
}

pub fn assess_sequence(sequence: &Sequence, preview_ready: bool) -> (bool, String) {
    let vertical = sequence.aspect_ratio == "9:16";
    let captions = !sequence.captions.is_empty();
    let passed = vertical && captions && preview_ready;
    let summary = if passed {
        "The Short is vertical, captioned, and ready to review.".into()
    } else if !vertical {
        "The Short is not a 9:16 frame yet.".into()
    } else if !captions {
        "The Short is missing captions.".into()
    } else {
        "The Short preview is not ready yet.".into()
    };
    (passed, summary)
}

pub fn draft_findings(
    sequences: &[Sequence],
    preview_ready: impl Fn(&Sequence) -> bool,
) -> Vec<QaFinding> {
    sequences
        .iter()
        .filter(|sequence| sequence.variation == VARIATION_TIPPY)
        .map(|sequence| {
            let (passed, summary) = assess_sequence(sequence, preview_ready(sequence));
            QaFinding {
                finding_id: new_id("qa"),
                sequence_id: sequence.sequence_id.clone(),
                passed,
                summary,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::MomentScores;

    fn moment(id: &str) -> Moment {
        Moment {
            moment_id: id.into(),
            media_id: "media_1".into(),
            start_ms: 0,
            end_ms: 4000,
            usable_ms: 4000,
            category: "Gameplay".into(),
            quote: "clutch will on GTA 1".into(),
            explanation: "A clear payoff.".into(),
            preview_path: None,
            scores: MomentScores {
                hook_strength: 0.5,
                emotion: 0.5,
                clarity: 0.5,
                payoff: 0.8,
                pacing: 0.5,
                standalone_context: 0.5,
            },
        }
    }

    fn tippy(id: &str, aspect: &str, captions: bool) -> Sequence {
        Sequence {
            sequence_id: id.into(),
            name: "Short 1 · Tippy / Gameplay".into(),
            clips: Vec::new(),
            moment_id: "moment_1".into(),
            variation: VARIATION_TIPPY.into(),
            aspect_ratio: aspect.into(),
            caption_theme: "Bold".into(),
            export_preset: "Short 9:16".into(),
            captions: if captions {
                vec![crate::project::CaptionCue {
                    caption_id: "cap_1".into(),
                    start_ms: 0,
                    end_ms: 1000,
                    text: "clutch will on GTA 1".into(),
                }]
            } else {
                Vec::new()
            },
            changes: Vec::new(),
            preview_path: Some("short.mp4".into()),
            source_start_ms: 0,
            source_end_ms: 4000,
        }
    }

    fn bare_job(state: JobState) -> Job {
        Job {
            job_id: "job_1".into(),
            project_id: "proj_1".into(),
            job_type: "qa_content".into(),
            agent: "qa_agent".into(),
            state,
            progress: 0.2,
            dependencies: vec!["pkg".into()],
            created_at: "2026-10-14T00:00:00Z".into(),
            started_at: None,
            completed_at: Some("2026-10-14T00:01:00Z".into()),
            error: Some("nope".into()),
            media_id: "media_1".into(),
            message: String::new(),
            subject_id: String::new(),
            explanation: explanation_for("qa_content").into(),
        }
    }

    #[test]
    fn pause_resume_and_retry_keep_the_worker_on_the_goal() {
        let mut waiting = bare_job(JobState::WaitingForDependency);
        assert!(mark_paused(&mut waiting));
        assert_eq!(waiting.state, JobState::Paused);
        assert!(mark_resumed(&mut waiting, false));
        assert_eq!(waiting.state, JobState::WaitingForDependency);
        assert!(mark_paused(&mut waiting));
        assert!(mark_resumed(&mut waiting, true));
        assert_eq!(waiting.state, JobState::Queued);

        let mut failed = bare_job(JobState::Failed);
        assert!(mark_retried(&mut failed));
        assert_eq!(failed.state, JobState::Retrying);
        assert!(failed.error.is_none());
        assert_eq!(failed.progress, 0.0);
        assert!(!mark_paused(&mut bare_job(JobState::Completed)));
    }

    #[test]
    fn packaging_is_local_copy_and_qa_checks_the_short() {
        let sequences = vec![tippy("seq_1", "9:16", true)];
        let drafts = draft_packages(&sequences, &[moment("moment_1")]);
        assert_eq!(drafts.len(), 1);
        assert!(drafts[0].title.contains("Gameplay"));
        assert!(drafts[0].title.contains("clutch will on GTA 1"));
        assert!(!drafts[0].title.to_lowercase().contains("viral"));
        assert_eq!(drafts[0].hook, "A clear payoff.");
        let (passed, summary) = assess_sequence(&sequences[0], true);
        assert!(passed);
        assert!(summary.contains("ready to review"));
        let (missing, _) = assess_sequence(&tippy("seq_2", "9:16", false), true);
        assert!(!missing);
        let (wide, _) = assess_sequence(&tippy("seq_3", "source", true), true);
        assert!(!wide);
        let findings = draft_findings(&sequences, |_| false);
        assert!(!findings[0].passed);
        assert!(explanation_for("package_content").contains("Nothing is published"));
    }
}
