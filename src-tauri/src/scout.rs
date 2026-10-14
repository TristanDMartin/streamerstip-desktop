use crate::media::{SceneSpan, SilenceSpan};
use crate::project::{new_id, Moment, MomentScores, TranscriptSegment};

const SHORTLIST: usize = 12;
const MAX_WINDOW_MS: u64 = 42_000;

pub struct ScoutInput<'a> {
    pub media_id: &'a str,
    pub duration_ms: u64,
    pub segments: &'a [TranscriptSegment],
    pub scenes: &'a [SceneSpan],
    pub silences: &'a [SilenceSpan],
    pub waveform: &'a [f32],
}

pub fn rank_moments(input: &ScoutInput<'_>) -> Vec<Moment> {
    let mut moments: Vec<Moment> = windows(input)
        .into_iter()
        .filter_map(|window| score_window(input, window))
        .collect();
    moments.sort_by(|left, right| {
        right
            .scores
            .total()
            .total_cmp(&left.scores.total())
            .then_with(|| left.start_ms.cmp(&right.start_ms))
    });
    moments.truncate(SHORTLIST);
    moments
}

pub fn answer_best_clips(moments: &[Moment], query: &str) -> Option<(String, u64, u64, String)> {
    let normalized = query
        .trim()
        .trim_end_matches(['?', '.', '!'])
        .trim()
        .to_lowercase();
    if !MOMENT_ASKS.iter().any(|ask| normalized == *ask) {
        return None;
    }
    if moments.is_empty() {
        return Some((
            "Moment Scout has not found a spoken moment in this recording.".into(),
            0,
            0,
            String::new(),
        ));
    }
    let top = &moments[0];
    let count = moments.len();
    let label = if count == 1 { "moment" } else { "moments" };
    Some((
        format!(
            "{count} {label}. The first is {} at {}.",
            top.category,
            clock(top.start_ms)
        ),
        top.start_ms,
        top.end_ms,
        top.moment_id.clone(),
    ))
}

const MOMENT_ASKS: &[&str] = &[
    "find my best clips",
    "find my best moments",
    "show my best clips",
    "show my best moments",
    "what are my best clips",
    "what are my best moments",
];

struct Window {
    start_ms: u64,
    end_ms: u64,
    speech_ms: u64,
    text: String,
    profanity: bool,
}

fn windows(input: &ScoutInput<'_>) -> Vec<Window> {
    let mut segments: Vec<&TranscriptSegment> = input
        .segments
        .iter()
        .filter(|segment| !segment.text.trim().is_empty())
        .collect();
    segments.sort_by_key(|segment| segment.start_ms);
    let mut windows = Vec::new();
    let mut current: Option<Window> = None;
    for segment in segments {
        let blocked = current.as_ref().is_some_and(|window| {
            let gap_start = window.end_ms;
            let gap_end = segment.start_ms;
            segment.start_ms.saturating_sub(window.end_ms) > 1_500
                || segment.end_ms.saturating_sub(window.start_ms) > MAX_WINDOW_MS
                || silence_overlap(input.silences, gap_start, gap_end) > 800
                || scene_boundary_between(input.scenes, gap_start, gap_end)
        });
        if blocked {
            if let Some(window) = current.take() {
                windows.push(window);
            }
        }
        match current.as_mut() {
            Some(window) => {
                window.end_ms = segment.end_ms.max(window.end_ms);
                window.speech_ms += segment.end_ms.saturating_sub(segment.start_ms);
                window.profanity |= segment.profanity;
                window.text.push(' ');
                window.text.push_str(segment.text.trim());
            }
            None => {
                current = Some(Window {
                    start_ms: segment.start_ms,
                    end_ms: segment.end_ms,
                    speech_ms: segment.end_ms.saturating_sub(segment.start_ms),
                    text: segment.text.trim().to_string(),
                    profanity: segment.profanity,
                });
            }
        }
    }
    if let Some(window) = current {
        windows.push(window);
    }
    windows
}

fn score_window(input: &ScoutInput<'_>, window: Window) -> Option<Moment> {
    let quote = window.text.split_whitespace().collect::<Vec<_>>().join(" ");
    let tokens = tokenize(&quote);
    if tokens.len() < 4 || window.speech_ms < 1_500 {
        return None;
    }
    let window_ms = window.end_ms.saturating_sub(window.start_ms).max(1);
    let silence_ms = silence_overlap(input.silences, window.start_ms, window.end_ms);
    let energy = energy_between(input, window.start_ms, window.end_ms);
    let early_end = window.start_ms + window_ms / 2;
    let early_energy = energy_between(input, window.start_ms, early_end);
    let late_energy = energy_between(input, early_end, window.end_ms);
    let scores = MomentScores {
        hook_strength: hook_strength(&tokens),
        emotion: emotion_score(&tokens, window.profanity, energy),
        clarity: clarity_score(&tokens, window.speech_ms, window_ms),
        payoff: payoff_score(&tokens, late_energy, early_energy),
        pacing: pacing_score(window_ms, silence_ms, scene_changes(input.scenes, &window)),
        standalone_context: standalone_context(&tokens),
    };
    let category = category_for(&tokens, scores.emotion, energy);
    let explanation = explain(&category, &scores);
    Some(Moment {
        moment_id: new_id("mom"),
        media_id: input.media_id.to_string(),
        start_ms: window.start_ms,
        end_ms: window.end_ms,
        usable_ms: window.speech_ms,
        category,
        quote,
        explanation,
        preview_path: None,
        scores,
    })
}

impl MomentScores {
    fn total(&self) -> f64 {
        self.hook_strength
            + self.emotion
            + self.clarity
            + self.payoff
            + self.pacing
            + self.standalone_context
    }
}

fn hook_strength(tokens: &[String]) -> f64 {
    let head = tokens.iter().take(8);
    let mut score = 0.2;
    if head.clone().any(|token| listed(token, HOOK)) {
        score += 0.5;
    }
    if (4..=18).contains(&tokens.len()) {
        score += 0.3;
    }
    clamp01(score)
}

fn emotion_score(tokens: &[String], profanity: bool, energy: f64) -> f64 {
    let hits = tokens.iter().filter(|token| listed(token, EMOTION)).count();
    let mut score = (hits as f64 / 3.0).min(0.6);
    if profanity {
        score += 0.15;
    }
    if tokens.iter().any(|token| listed(token, FUNNY)) {
        score += 0.15;
    }
    score += energy * 0.25;
    clamp01(score)
}

fn clarity_score(tokens: &[String], speech_ms: u64, window_ms: u64) -> f64 {
    if tokens.len() < 4 {
        return 0.1;
    }
    let speech_ratio = (speech_ms as f64 / window_ms as f64).clamp(0.0, 1.0);
    let words_per_second = tokens.len() as f64 / (window_ms as f64 / 1000.0).max(0.1);
    let rate = if (1.2..=4.2).contains(&words_per_second) {
        1.0
    } else if (0.7..=5.5).contains(&words_per_second) {
        0.55
    } else {
        0.2
    };
    clamp01(0.55 * speech_ratio + 0.45 * rate)
}

fn payoff_score(tokens: &[String], late_energy: f64, early_energy: f64) -> f64 {
    let tail_from = tokens.len() * 3 / 5;
    let mut score = 0.15;
    if tokens[tail_from..]
        .iter()
        .any(|token| listed(token, PAYOFF))
    {
        score += 0.55;
    }
    if late_energy + 0.02 >= early_energy && late_energy > 0.05 {
        score += 0.2;
    }
    clamp01(score)
}

fn pacing_score(window_ms: u64, silence_ms: u64, scene_changes: usize) -> f64 {
    let seconds = window_ms as f64 / 1000.0;
    let mut score = if (12.0..=45.0).contains(&seconds) {
        0.8
    } else if (5.0..=70.0).contains(&seconds) {
        0.5
    } else {
        0.28
    };
    let silence_ratio = (silence_ms as f64 / window_ms.max(1) as f64).min(0.85);
    score *= 1.0 - silence_ratio;
    if scene_changes == 1 {
        score += 0.08;
    }
    clamp01(score)
}

fn standalone_context(tokens: &[String]) -> f64 {
    if tokens.is_empty() {
        return 0.0;
    }
    let fillers = tokens.iter().filter(|token| listed(token, FILLER)).count();
    let filler_ratio = fillers as f64 / tokens.len() as f64;
    if filler_ratio > 0.55 {
        return 0.22;
    }
    let content = tokens.len() - fillers;
    let mut score = 0.15;
    if tokens.len() >= 6 {
        score += 0.2;
    }
    if content >= 3 {
        score += 0.4;
    }
    if !STARTS_WEAK.iter().any(|word| tokens[0] == *word) {
        score += 0.2;
    }
    clamp01(score)
}

fn category_for(tokens: &[String], emotion: f64, energy: f64) -> String {
    let hits = |list: &[&str]| tokens.iter().filter(|token| listed(token, list)).count();
    if hits(GAME) > 0 {
        "Gameplay".into()
    } else if hits(FUNNY) > 0 {
        "Funny".into()
    } else if hits(TEACH) > 0 {
        "Educational".into()
    } else if hits(STORY) > 0 {
        "Story".into()
    } else if emotion >= 0.4 || hits(EMOTION) > 0 {
        "Reaction".into()
    } else if energy >= 0.55 {
        "High energy".into()
    } else {
        "Story".into()
    }
}

fn explain(category: &str, scores: &MomentScores) -> String {
    let mut parts = [
        ("hook", scores.hook_strength, "it opens on a clear hook"),
        ("emotion", scores.emotion, "the reaction comes through"),
        ("clarity", scores.clarity, "the line is easy to follow"),
        ("payoff", scores.payoff, "the payoff lands at the end"),
        ("pacing", scores.pacing, "the pacing stays inside a short"),
        (
            "context",
            scores.standalone_context,
            "it can stand on its own",
        ),
    ];
    parts.sort_by(|left, right| right.1.total_cmp(&left.1));
    format!("{category}. {} and {}.", capitalize(parts[0].2), parts[1].2)
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn tokenize(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split_whitespace()
        .map(|word| {
            word.trim_matches(|character: char| !character.is_ascii_alphanumeric())
                .to_string()
        })
        .filter(|word| !word.is_empty())
        .collect()
}

fn silence_overlap(silences: &[SilenceSpan], start_ms: u64, end_ms: u64) -> u64 {
    silences
        .iter()
        .map(|span| {
            let start = span.start_ms.max(start_ms);
            let end = span.end_ms.min(end_ms);
            end.saturating_sub(start)
        })
        .sum()
}

fn scene_boundary_between(scenes: &[SceneSpan], start_ms: u64, end_ms: u64) -> bool {
    scenes
        .iter()
        .any(|scene| scene.start_ms > start_ms && scene.start_ms < end_ms && scene.start_ms != 0)
}

fn scene_changes(scenes: &[SceneSpan], window: &Window) -> usize {
    scenes
        .iter()
        .filter(|scene| scene.start_ms > window.start_ms && scene.start_ms < window.end_ms)
        .count()
}

fn energy_between(input: &ScoutInput<'_>, start_ms: u64, end_ms: u64) -> f64 {
    if input.waveform.is_empty() || input.duration_ms == 0 || end_ms <= start_ms {
        return 0.0;
    }
    let count = input.waveform.len() as u64;
    let first = (start_ms.saturating_mul(count) / input.duration_ms).min(count - 1) as usize;
    let last =
        (end_ms.saturating_mul(count) / input.duration_ms).clamp(first as u64 + 1, count) as usize;
    let slice = &input.waveform[first..last];
    if slice.is_empty() {
        return 0.0;
    }
    let mean = slice.iter().sum::<f32>() / slice.len() as f32;
    mean as f64
}

fn listed(token: &str, list: &[&str]) -> bool {
    list.iter().any(|word| token == *word)
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

fn clock(ms: u64) -> String {
    let total = ms / 1000;
    let hours = total / 3600;
    let minutes = (total % 3600) / 60;
    let seconds = total % 60;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{seconds:02}")
    } else {
        format!("{minutes}:{seconds:02}")
    }
}

const HOOK: &[&str] = &[
    "what", "why", "how", "wait", "look", "watch", "oh", "stop", "listen", "check", "gta",
];
const EMOTION: &[&str] = &[
    "laugh", "haha", "hahaha", "lol", "funny", "insane", "crazy", "wow", "scream", "god", "clutch",
    "cooked", "love", "hate", "win", "won",
];
const FUNNY: &[&str] = &[
    "laugh",
    "haha",
    "hahaha",
    "lol",
    "funny",
    "joke",
    "hilarious",
];
const GAME: &[&str] = &[
    "gta", "game", "games", "boss", "clutch", "kill", "killed", "lobby", "match", "win", "won",
    "gameplay",
];
const TEACH: &[&str] = &["because", "reason", "step", "tutorial", "explain", "works"];
const STORY: &[&str] = &["yesterday", "remembered", "remember", "story"];
const PAYOFF: &[&str] = &[
    "finally", "won", "win", "clutch", "done", "killed", "boss", "got", "insane", "six", "funny",
];
const FILLER: &[&str] = &[
    "i", "me", "my", "you", "the", "a", "an", "and", "was", "were", "it", "that", "this", "to",
    "of", "we", "can", "just", "yeah", "okay", "ok", "um", "on",
];
const STARTS_WEAK: &[&str] = &["and", "but", "so", "because", "yeah", "okay", "ok", "um"];

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(text: &str, start_ms: u64, end_ms: u64) -> TranscriptSegment {
        TranscriptSegment {
            segment_id: format!("seg_{start_ms}"),
            start_ms,
            end_ms,
            text: text.into(),
            speaker: None,
            profanity: false,
            words: Vec::new(),
        }
    }

    #[test]
    fn a_long_recording_becomes_a_shortlist_without_a_viral_score() {
        let excited_at = 2 * 3_600_000 + 14 * 60_000 + 32_000;
        let mut segments = Vec::new();
        for index in 0..30 {
            let start = index * 240_000;
            if start == 2_400_000 {
                continue;
            }
            segments.push(segment("yeah okay we can keep going", start, start + 4_000));
        }
        segments.push(segment(
            "oh my god that clutch win on GTA was insane hahaha",
            excited_at,
            excited_at + 8_000,
        ));
        segments.push(segment(
            "here is how the first step works because the reason matters",
            90 * 60_000,
            90 * 60_000 + 8_000,
        ));
        let input = ScoutInput {
            media_id: "media_long",
            duration_ms: 3 * 3_600_000,
            segments: &segments,
            scenes: &[],
            silences: &[],
            waveform: &[],
        };
        let moments = rank_moments(&input);
        assert_eq!(moments.len(), SHORTLIST);
        assert!(moments.len() < segments.len());
        assert_eq!(moments[0].category, "Gameplay");
        assert!(moments[0].quote.to_lowercase().contains("clutch"));
        assert_eq!(moments[0].start_ms, excited_at);
        assert!(!moments[0].explanation.is_empty());
        assert!(moments[0].end_ms > moments[0].start_ms);
        assert!(moments[0].usable_ms >= 1_500);
        let encoded = serde_json::to_value(&moments[0]).unwrap();
        assert!(encoded.get("score").is_none());
        assert!(encoded.get("viralScore").is_none());
        let mut keys: Vec<_> = encoded["scores"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "clarity",
                "emotion",
                "hookStrength",
                "pacing",
                "payoff",
                "standaloneContext",
            ]
        );
        for value in encoded["scores"].as_object().unwrap().values() {
            let score = value.as_f64().unwrap();
            assert!((0.0..=1.0).contains(&score));
        }
        let (message, start_ms, _, _) = answer_best_clips(&moments, "Find my best clips").unwrap();
        assert_eq!(start_ms, excited_at);
        assert!(message.contains("Gameplay"));
        assert!(message.contains("2:14:32"));
        assert!(!message.to_lowercase().contains("viral"));
        assert!(answer_best_clips(&moments, "Where did I talk about GTA VI?").is_none());
    }

    #[test]
    fn silence_lowers_pacing_against_a_clean_line() {
        let clean = segment("I was talking about GTA six", 3_000, 6_000);
        let buried = segment("I was talking about GTA six", 20_000, 23_000);
        let silences = vec![SilenceSpan {
            start_ms: 20_000,
            end_ms: 22_400,
        }];
        let clean_moments = rank_moments(&ScoutInput {
            media_id: "media_a",
            duration_ms: 30_000,
            segments: &[clean],
            scenes: &[],
            silences: &[],
            waveform: &[],
        });
        let buried_moments = rank_moments(&ScoutInput {
            media_id: "media_a",
            duration_ms: 30_000,
            segments: &[buried],
            scenes: &[],
            silences: &silences,
            waveform: &[],
        });
        assert_eq!(clean_moments[0].category, "Gameplay");
        assert!(clean_moments[0].scores.pacing > buried_moments[0].scores.pacing);
    }
}
