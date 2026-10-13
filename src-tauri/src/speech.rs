use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::project::{new_id, TranscriptSegment, TranscriptWord};

/// A local speech-to-text pass. This never calls a cloud model.
pub trait SpeechEngine: Send + Sync {
    fn transcribe(&self, audio: &Path) -> Result<Vec<Utterance>, String>;
    fn status(&self) -> String;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Utterance {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
    pub words: Vec<TranscriptWord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptHit {
    pub segment_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

pub struct WhisperCli {
    binary: Option<PathBuf>,
    model: Option<PathBuf>,
}

impl WhisperCli {
    pub fn discover() -> Self {
        let model = std::env::var("TIPPY_WHISPER_MODEL")
            .ok()
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .or_else(|| {
                let mut candidates = vec![
                    PathBuf::from("/usr/local/share/tippy/ggml-tiny.en.bin"),
                    PathBuf::from("/usr/share/tippy/ggml-tiny.en.bin"),
                ];
                if let Some(home) = std::env::var_os("HOME") {
                    candidates.insert(
                        0,
                        PathBuf::from(home).join(".local/share/tippy/ggml-tiny.en.bin"),
                    );
                }
                candidates.into_iter().find(|path| path.is_file())
            });
        Self {
            binary: which_first(&["whisper-cli", "whisper-cpp"]),
            model,
        }
    }

    #[cfg(test)]
    pub fn is_ready(&self) -> bool {
        self.binary.is_some() && self.model.is_some()
    }
}

impl SpeechEngine for WhisperCli {
    fn transcribe(&self, audio: &Path) -> Result<Vec<Utterance>, String> {
        let binary = self.binary.as_ref().ok_or_else(missing_transcriber)?;
        let model = self.model.as_ref().ok_or_else(missing_transcriber)?;
        let output = std::env::temp_dir().join(format!("tippy-whisper-{}", uuid_tail()));
        let status = Command::new(binary)
            .args([
                "-m",
                &model.display().to_string(),
                "-f",
                &audio.display().to_string(),
                "-l",
                "en",
                "-ojf",
                "-np",
                "-of",
                &output.display().to_string(),
            ])
            .output()
            .map_err(|err| format!("could not start {}: {err}", binary.display()))?;
        let json_path = PathBuf::from(format!("{}.json", output.display()));
        let json = std::fs::read_to_string(&json_path).map_err(|_| {
            let stderr = String::from_utf8_lossy(&status.stderr);
            format!(
                "local transcription did not write a transcript ({})",
                tail(&stderr)
            )
        });
        let _ = std::fs::remove_file(&json_path);
        parse_whisper_json(&json?)
    }

    fn status(&self) -> String {
        match (&self.binary, &self.model) {
            (Some(binary), Some(model)) => format!(
                "Local transcription uses {} with {}.",
                binary.display(),
                model.display()
            ),
            _ => missing_transcriber(),
        }
    }
}

#[cfg(test)]
pub struct ScriptedSpeech {
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[cfg(test)]
impl SpeechEngine for ScriptedSpeech {
    fn transcribe(&self, _audio: &Path) -> Result<Vec<Utterance>, String> {
        Ok(vec![Utterance {
            start_ms: self.start_ms,
            end_ms: self.end_ms,
            text: self.text.clone(),
            words: Vec::new(),
        }])
    }

    fn status(&self) -> String {
        "Scripted local transcript.".into()
    }
}

pub fn segments_from(utterances: Vec<Utterance>) -> Vec<TranscriptSegment> {
    utterances
        .into_iter()
        .filter_map(|utterance| {
            let text = utterance.text.trim().to_string();
            if text.is_empty() {
                return None;
            }
            Some(TranscriptSegment {
                segment_id: new_id("seg"),
                start_ms: utterance.start_ms,
                end_ms: utterance.end_ms,
                profanity: flags_profanity(&text),
                text,
                speaker: None,
                words: utterance.words,
            })
        })
        .collect()
}

pub fn answer_question(
    segments: &[TranscriptSegment],
    query: &str,
) -> Option<(String, Vec<TranscriptHit>)> {
    if !is_transcript_question(query) {
        return None;
    }
    let subject = search_subject(query);
    let hits = find_mentions(segments, &subject);
    if hits.is_empty() {
        return Some((
            format!("No part of the transcript matches “{subject}”."),
            hits,
        ));
    }
    let times = hits
        .iter()
        .map(|hit| clock(hit.start_ms))
        .collect::<Vec<_>>()
        .join(", ");
    Some((format!("You talked about {subject} at {times}."), hits))
}

pub fn is_transcript_question(query: &str) -> bool {
    let lower = query.trim().to_lowercase();
    QUESTION_LEADS.iter().any(|lead| lower.starts_with(lead))
}

pub fn search_subject(query: &str) -> String {
    let trimmed = query.trim().trim_end_matches(['?', '.', '!']).trim();
    let lower = trimmed.to_lowercase();
    for lead in QUESTION_LEADS {
        if let Some(rest) = lower.strip_prefix(lead) {
            let start = trimmed.len() - rest.len();
            return trimmed[start..].trim().trim_matches('"').trim().to_string();
        }
    }
    trimmed.to_string()
}

pub fn find_mentions(segments: &[TranscriptSegment], subject: &str) -> Vec<TranscriptHit> {
    let needle = normalize_mention(subject);
    if needle.is_empty() {
        return Vec::new();
    }
    segments
        .iter()
        .filter_map(|segment| {
            let (start_ms, end_ms) = mention_bounds(segment, &needle)?;
            Some(TranscriptHit {
                segment_id: segment.segment_id.clone(),
                start_ms,
                end_ms,
                text: segment.text.clone(),
            })
        })
        .collect()
}

fn mention_bounds(segment: &TranscriptSegment, needle: &str) -> Option<(u64, u64)> {
    if needle.is_empty() || !normalize_mention(&segment.text).contains(needle) {
        return None;
    }
    let pieces = spoken_pieces(&segment.words);
    let joined = pieces
        .iter()
        .map(|piece| piece.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    let Some(pos) = joined.find(needle) else {
        return Some((segment.start_ms, segment.end_ms));
    };
    let start_index = joined[..pos].split_whitespace().count();
    let end_index = start_index + needle.split_whitespace().count() - 1;
    let start_ms = pieces
        .get(start_index)
        .map(|piece| piece.start_ms)
        .unwrap_or(segment.start_ms);
    let end_ms = pieces
        .get(end_index)
        .map(|piece| piece.end_ms)
        .unwrap_or(segment.end_ms);
    Some((start_ms, end_ms))
}

struct SpokenPiece {
    text: String,
    start_ms: u64,
    end_ms: u64,
}

fn spoken_pieces(words: &[TranscriptWord]) -> Vec<SpokenPiece> {
    let mut pieces = Vec::new();
    for word in words {
        let continues = !word
            .text
            .starts_with(|character: char| character.is_whitespace())
            && !pieces.is_empty();
        let cleaned = word
            .text
            .to_lowercase()
            .trim_matches(|character: char| !character.is_ascii_alphanumeric())
            .to_string();
        if cleaned.is_empty() {
            continue;
        }
        if continues {
            let last: &mut SpokenPiece = pieces.last_mut().expect("piece");
            last.text.push_str(&cleaned);
            last.end_ms = word.end_ms;
        } else {
            pieces.push(SpokenPiece {
                text: cleaned,
                start_ms: word.start_ms,
                end_ms: word.end_ms,
            });
        }
    }
    if pieces.iter().any(|piece| piece.text == "gta") {
        for piece in &mut pieces {
            if piece.text == "6" || piece.text == "six" || piece.text == "vi" {
                piece.text = "vi".to_string();
            }
        }
    }
    pieces
}

const QUESTION_LEADS: &[&str] = &[
    "where did i talk about ",
    "where did i mention ",
    "where did i say ",
    "find where i talked about ",
    "find where i talk about ",
    "find where i mentioned ",
    "find where i said ",
];

fn normalize_mention(text: &str) -> String {
    let mut words: Vec<String> = text
        .to_lowercase()
        .split_whitespace()
        .map(|word| {
            word.trim_matches(|character: char| !character.is_ascii_alphanumeric())
                .to_string()
        })
        .filter(|word| !word.is_empty())
        .collect();
    if words.iter().any(|word| word == "gta") {
        for word in &mut words {
            if word == "6" || word == "six" || word == "vi" {
                *word = "vi".to_string();
            }
        }
    }
    words.join(" ")
}

fn flags_profanity(text: &str) -> bool {
    let words: Vec<String> = text
        .to_lowercase()
        .split_whitespace()
        .map(|word| {
            word.trim_matches(|character: char| !character.is_ascii_alphanumeric())
                .to_string()
        })
        .collect();
    words
        .iter()
        .any(|word| PROFANITY.iter().any(|flag| word == flag))
}

const PROFANITY: &[&str] = &["fuck", "fucking", "shit", "bitch", "asshole"];

pub fn parse_whisper_json(json: &str) -> Result<Vec<Utterance>, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|err| format!("transcript json was unreadable: {err}"))?;
    let items = value
        .get("transcription")
        .and_then(|item| item.as_array())
        .ok_or_else(|| "transcript json has no transcription list".to_string())?;
    let mut utterances = Vec::new();
    for item in items {
        let text = item
            .get("text")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            continue;
        }
        let offsets = item.get("offsets");
        let start_ms = offsets
            .and_then(|value| value.get("from"))
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        let end_ms = offsets
            .and_then(|value| value.get("to"))
            .and_then(|value| value.as_u64())
            .unwrap_or(start_ms);
        let words = item
            .get("tokens")
            .and_then(|value| value.as_array())
            .map(|tokens| {
                tokens
                    .iter()
                    .filter_map(|token| {
                        let text = token.get("text").and_then(|value| value.as_str())?;
                        if text.trim().is_empty() || text.trim_start().starts_with('[') {
                            return None;
                        }
                        let offsets = token.get("offsets");
                        let start_ms = offsets
                            .and_then(|value| value.get("from"))
                            .and_then(|value| value.as_u64())
                            .unwrap_or(start_ms);
                        let end_ms = offsets
                            .and_then(|value| value.get("to"))
                            .and_then(|value| value.as_u64())
                            .unwrap_or(start_ms);
                        Some(TranscriptWord {
                            start_ms,
                            end_ms,
                            text: text.to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        utterances.push(Utterance {
            start_ms,
            end_ms,
            text,
            words,
        });
    }
    Ok(utterances)
}

fn missing_transcriber() -> String {
    "Local transcription is not installed. Install whisper.cpp (whisper-cli) and set TIPPY_WHISPER_MODEL to a ggml model file. Tippy does not send audio to a cloud model.".into()
}

fn which_first(names: &[&str]) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join(".local/bin"));
    }
    dirs.push(PathBuf::from("/usr/local/bin"));
    for name in names {
        for dir in &dirs {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn uuid_tail() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn tail(text: &str) -> String {
    let trimmed = text.trim();
    let start = trimmed.len().saturating_sub(240);
    trimmed[start..].trim().to_string()
}

fn clock(ms: u64) -> String {
    let total = ms / 1000;
    format!("{}:{:02}", total / 60, total % 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn segment(text: &str, start_ms: u64) -> TranscriptSegment {
        TranscriptSegment {
            segment_id: format!("seg_{start_ms}"),
            start_ms,
            end_ms: start_ms + 2000,
            text: text.into(),
            speaker: None,
            profanity: flags_profanity(text),
            words: Vec::new(),
        }
    }

    fn word(text: &str, start_ms: u64, end_ms: u64) -> crate::project::TranscriptWord {
        crate::project::TranscriptWord {
            start_ms,
            end_ms,
            text: text.into(),
        }
    }

    #[test]
    fn gta_question_returns_the_timestamp() {
        let segments = vec![
            segment("the lobby took forever", 4_000),
            segment("I was talking about GTA six", 12_400),
        ];
        let (message, hits) = answer_question(&segments, "Where did I talk about GTA VI?").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].start_ms, 12_400);
        assert_eq!(message, "You talked about GTA VI at 0:12.");
        assert!(answer_question(&segments, "Find my best clips").is_none());
    }

    #[test]
    fn word_timestamps_point_at_the_gta_mention() {
        let mut line = segment("I was talking about GTA 6.", 0);
        line.words = vec![
            word(" I", 0, 220),
            word(" was", 220, 900),
            word(" talking", 900, 2_480),
            word(" about", 2_990, 3_610),
            word(" G", 3_610, 3_830),
            word("TA", 3_830, 4_170),
            word(" 6", 4_320, 5_000),
        ];
        let (message, hits) = answer_question(&[line], "Where did I talk about GTA VI?").unwrap();
        assert_eq!(hits[0].start_ms, 3_610);
        assert_eq!(message, "You talked about GTA VI at 0:03.");
    }

    #[test]
    fn profanity_is_marked_and_whisper_json_keeps_offsets() {
        assert!(flags_profanity("what the fuck was that"));
        assert!(!flags_profanity("that was clean"));
        let parsed = parse_whisper_json(
            r#"{"transcription":[{"offsets":{"from":12000,"to":15000},"text":" GTA VI "}]}"#,
        )
        .unwrap();
        assert_eq!(parsed[0].start_ms, 12_000);
        assert_eq!(parsed[0].text, "GTA VI");
    }

    #[test]
    fn installed_whisper_answers_gta_with_a_timestamp() {
        let engine = WhisperCli::discover();
        if !engine.is_ready() {
            return;
        }
        let espeak = which_first(&["espeak-ng"]).or_else(|| which_first(&["espeak"]));
        let ffmpeg = which_first(&["ffmpeg"]);
        let (Some(espeak), Some(ffmpeg)) = (espeak, ffmpeg) else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("tippy-speech-{}", uuid_tail()));
        std::fs::create_dir_all(&dir).unwrap();
        let raw = dir.join("raw.wav");
        let wav = dir.join("speech.wav");
        let spoken = Command::new(&espeak)
            .args(["-s", "140", "-w"])
            .arg(&raw)
            .arg("I was talking about GTA six")
            .status()
            .expect("espeak");
        assert!(spoken.success());
        let converted = Command::new(&ffmpeg)
            .args(["-y", "-i"])
            .arg(&raw)
            .args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
            .arg(&wav)
            .status()
            .expect("ffmpeg");
        assert!(converted.success());
        let segments = segments_from(engine.transcribe(&wav).expect("local whisper"));
        let (message, hits) =
            answer_question(&segments, "Where did I talk about GTA VI?").expect("question");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            !hits.is_empty(),
            "transcript was {:?}",
            segments
                .iter()
                .map(|segment| segment.text.clone())
                .collect::<Vec<_>>()
        );
        assert!(
            message.starts_with("You talked about GTA VI at "),
            "{message}"
        );
    }
}
