use std::cell::RefCell;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use serde::{Deserialize, Serialize};

use crate::error::DesktopError;

/// System FFmpeg only. Encodes with the built-in MPEG-4 Part 2 encoder and native AAC.
/// This crate does not vendor FFmpeg and does not pass `--enable-gpl` or `libx264`.
const VIDEO_CODEC: &str = "mpeg4";
const AUDIO_CODEC: &str = "aac";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    pub duration_ms: u64,
    pub width: u32,
    pub height: u32,
    pub frame_rate: f64,
    pub video_codec: String,
    pub audio_codec: String,
    pub size_bytes: u64,
}

impl ProbeInfo {
    pub fn has_audio(&self) -> bool {
        !self.audio_codec.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub ready: bool,
    pub ffmpeg: bool,
    pub ffprobe: bool,
    pub message: String,
}

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("{0}")]
    Message(String),
    #[error("ffmpeg failed: {0}")]
    Ffmpeg(String),
    #[error("ffprobe failed: {0}")]
    Ffprobe(String),
}

impl From<MediaError> for DesktopError {
    fn from(value: MediaError) -> Self {
        DesktopError::Message(value.to_string())
    }
}

pub struct RenderSegment {
    pub path: PathBuf,
    pub start_ms: u64,
    pub end_ms: u64,
}

pub trait MediaEngine: Send + Sync {
    fn availability(&self) -> EngineStatus;
    fn probe(&self, path: &Path) -> Result<ProbeInfo, MediaError>;
    fn create_proxy(
        &self,
        input: &Path,
        output: &Path,
        duration_ms: u64,
        has_audio: bool,
        progress: &mut dyn FnMut(f64),
    ) -> Result<(), MediaError>;
    fn extract_audio(&self, input: &Path, output: &Path) -> Result<(), MediaError>;
    fn trim(
        &self,
        input: &Path,
        output: &Path,
        start_ms: u64,
        end_ms: u64,
        has_audio: bool,
    ) -> Result<(), MediaError>;
    fn render_sequence(
        &self,
        segments: &[RenderSegment],
        output: &Path,
        has_audio: bool,
    ) -> Result<(), MediaError>;
    fn create_thumbnail(&self, input: &Path, output: &Path, at_ms: u64) -> Result<(), MediaError>;
    fn export_video(
        &self,
        input: &Path,
        output: &Path,
        duration_ms: u64,
        has_audio: bool,
        progress: &mut dyn FnMut(f64),
    ) -> Result<(), MediaError>;
}

#[derive(Debug, Default)]
pub struct FfmpegMediaEngine;

impl FfmpegMediaEngine {
    pub fn status() -> EngineStatus {
        let ffmpeg = binary_ok("ffmpeg");
        let ffprobe = binary_ok("ffprobe");
        if ffmpeg && ffprobe {
            return EngineStatus {
                ready: true,
                ffmpeg,
                ffprobe,
                message: "Using the system ffmpeg binary (MPEG-4 and AAC). No bundled GPL build."
                    .into(),
            };
        }
        EngineStatus {
            ready: false,
            ffmpeg,
            ffprobe,
            message: "FFmpeg was not found. Install the apt package `ffmpeg` (it includes ffprobe). Tippy calls that system binary and does not ship a GPL build.".into(),
        }
    }
}

impl MediaEngine for FfmpegMediaEngine {
    fn availability(&self) -> EngineStatus {
        Self::status()
    }

    fn probe(&self, path: &Path) -> Result<ProbeInfo, MediaError> {
        require_binary("ffprobe")?;
        if !path.is_file() {
            return Err(MediaError::Message(format!(
                "video file was not found: {}",
                path.display()
            )));
        }
        let output = Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_format",
                "-show_streams",
            ])
            .arg(path)
            .output()
            .map_err(|err| MediaError::Ffprobe(err.to_string()))?;
        if !output.status.success() {
            return Err(MediaError::Ffprobe(tail(&output.stderr)));
        }
        let value: serde_json::Value = serde_json::from_slice(&output.stdout)
            .map_err(|err| MediaError::Ffprobe(err.to_string()))?;
        let size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
        parse_probe(&value, size)
    }

    fn create_proxy(
        &self,
        input: &Path,
        output: &Path,
        duration_ms: u64,
        has_audio: bool,
        progress: &mut dyn FnMut(f64),
    ) -> Result<(), MediaError> {
        let mut args = base_args(input);
        args.push("-vf".into());
        args.push("scale=w='min(iw,960)':h=-2".into());
        args.extend(encode_args(has_audio, 6));
        args.extend(["-movflags".into(), "+faststart".into()]);
        args.push(output.display().to_string());
        ensure_parent(output)?;
        run_ffmpeg(&args, duration_ms, progress)
    }

    fn extract_audio(&self, input: &Path, output: &Path) -> Result<(), MediaError> {
        let args = vec![
            "-y".into(),
            "-i".into(),
            input.display().to_string(),
            "-vn".into(),
            "-ac".into(),
            "1".into(),
            "-ar".into(),
            "8000".into(),
            "-c:a".into(),
            "pcm_s16le".into(),
            output.display().to_string(),
        ];
        ensure_parent(output)?;
        run_ffmpeg(&args, 0, &mut |_| {})
    }

    fn trim(
        &self,
        input: &Path,
        output: &Path,
        start_ms: u64,
        end_ms: u64,
        has_audio: bool,
    ) -> Result<(), MediaError> {
        if end_ms <= start_ms {
            return Err(MediaError::Message(
                "trim end must be after the start".into(),
            ));
        }
        let mut args = vec![
            "-y".into(),
            "-ss".into(),
            ms_to_seconds(start_ms),
            "-to".into(),
            ms_to_seconds(end_ms),
            "-i".into(),
            input.display().to_string(),
        ];
        args.extend(encode_args(has_audio, 5));
        args.push(output.display().to_string());
        ensure_parent(output)?;
        run_ffmpeg(&args, end_ms.saturating_sub(start_ms), &mut |_| {})
    }

    fn render_sequence(
        &self,
        segments: &[RenderSegment],
        output: &Path,
        has_audio: bool,
    ) -> Result<(), MediaError> {
        if segments.is_empty() {
            return Err(MediaError::Message(
                "a sequence needs at least one segment".into(),
            ));
        }
        ensure_parent(output)?;
        let scratch = output.with_extension("segments");
        let _ = fs::remove_dir_all(&scratch);
        fs::create_dir_all(&scratch).map_err(|err| MediaError::Message(err.to_string()))?;
        let mut list = String::new();
        for (index, segment) in segments.iter().enumerate() {
            let piece = scratch.join(format!("piece-{index}.mp4"));
            self.trim(
                &segment.path,
                &piece,
                segment.start_ms,
                segment.end_ms,
                has_audio,
            )?;
            list.push_str(&format!("file '{}'\n", piece.display()));
        }
        let list_path = scratch.join("list.txt");
        fs::write(&list_path, list).map_err(|err| MediaError::Message(err.to_string()))?;
        let mut args = vec![
            "-y".into(),
            "-f".into(),
            "concat".into(),
            "-safe".into(),
            "0".into(),
            "-i".into(),
            list_path.display().to_string(),
        ];
        args.extend(encode_args(has_audio, 5));
        args.push(output.display().to_string());
        let result = run_ffmpeg(&args, 0, &mut |_| {});
        let _ = fs::remove_dir_all(&scratch);
        result
    }

    fn create_thumbnail(&self, input: &Path, output: &Path, at_ms: u64) -> Result<(), MediaError> {
        let args = vec![
            "-y".into(),
            "-ss".into(),
            ms_to_seconds(at_ms),
            "-i".into(),
            input.display().to_string(),
            "-frames:v".into(),
            "1".into(),
            output.display().to_string(),
        ];
        ensure_parent(output)?;
        run_ffmpeg(&args, 0, &mut |_| {})
    }

    fn export_video(
        &self,
        input: &Path,
        output: &Path,
        duration_ms: u64,
        has_audio: bool,
        progress: &mut dyn FnMut(f64),
    ) -> Result<(), MediaError> {
        let mut args = base_args(input);
        args.push("-vf".into());
        args.push("scale=w='min(iw,1280)':h=-2".into());
        args.extend(encode_args(has_audio, 3));
        args.extend(["-movflags".into(), "+faststart".into()]);
        args.push(output.display().to_string());
        ensure_parent(output)?;
        run_ffmpeg(&args, duration_ms, progress)
    }
}

pub fn waveform_peaks(path: &Path, buckets: usize) -> Result<Vec<f32>, MediaError> {
    let mut file = File::open(path).map_err(|err| MediaError::Message(err.to_string()))?;
    let mut header = [0u8; 12];
    file.read_exact(&mut header)
        .map_err(|err| MediaError::Message(err.to_string()))?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err(MediaError::Message("audio file is not a WAV".into()));
    }
    let mut data_size = 0usize;
    let mut channels = 1u16;
    let mut bits = 16u16;
    loop {
        let mut chunk = [0u8; 8];
        if file.read_exact(&mut chunk).is_err() {
            break;
        }
        let size = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]) as usize;
        let tag = &chunk[0..4];
        if tag == b"fmt " {
            let mut fmt = vec![0u8; size];
            file.read_exact(&mut fmt)
                .map_err(|err| MediaError::Message(err.to_string()))?;
            if fmt.len() >= 16 {
                channels = u16::from_le_bytes([fmt[2], fmt[3]]);
                bits = u16::from_le_bytes([fmt[14], fmt[15]]);
            }
        } else if tag == b"data" {
            data_size = size;
            break;
        } else {
            let mut skip = vec![0u8; size];
            file.read_exact(&mut skip)
                .map_err(|err| MediaError::Message(err.to_string()))?;
        }
    }
    if bits != 16 || channels == 0 || data_size < 2 {
        return Err(MediaError::Message(
            "waveform expects 16-bit PCM audio".into(),
        ));
    }
    let sample_count = data_size / 2 / channels as usize;
    let bucket_count = buckets.max(1);
    let per_bucket = (sample_count / bucket_count).max(1);
    let mut peaks = vec![0f32; bucket_count];
    let mut index = 0usize;
    let mut remaining = data_size;
    let mut buffer = [0u8; 4096];
    while remaining > 0 {
        let want = remaining.min(buffer.len());
        let read = file
            .read(&mut buffer[..want])
            .map_err(|err| MediaError::Message(err.to_string()))?;
        if read == 0 {
            break;
        }
        remaining = remaining.saturating_sub(read);
        let frames = read / 2 / channels as usize;
        for frame in 0..frames {
            let mut peak = 0i16;
            for channel in 0..channels as usize {
                let offset = (frame * channels as usize + channel) * 2;
                if offset + 1 >= read {
                    break;
                }
                let sample = i16::from_le_bytes([buffer[offset], buffer[offset + 1]]);
                peak = peak.max(sample.abs());
            }
            let bucket = (index / per_bucket).min(bucket_count - 1);
            let amplitude = peak as f32 / 32768.0;
            if amplitude > peaks[bucket] {
                peaks[bucket] = amplitude;
            }
            index += 1;
        }
    }
    Ok(peaks)
}

fn base_args(input: &Path) -> Vec<String> {
    vec!["-y".into(), "-i".into(), input.display().to_string()]
}

fn encode_args(has_audio: bool, quality: u8) -> Vec<String> {
    let mut args = vec![
        "-c:v".into(),
        VIDEO_CODEC.into(),
        "-q:v".into(),
        quality.to_string(),
    ];
    if has_audio {
        args.extend([
            "-c:a".into(),
            AUDIO_CODEC.into(),
            "-b:a".into(),
            "128k".into(),
        ]);
    } else {
        args.push("-an".into());
    }
    args
}

thread_local! {
    static ACTIVE_CANCEL: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
}

pub fn with_cancel<T>(flag: Arc<AtomicBool>, work: impl FnOnce() -> T) -> T {
    ACTIVE_CANCEL.with(|slot| *slot.borrow_mut() = Some(flag));
    let result = work();
    ACTIVE_CANCEL.with(|slot| *slot.borrow_mut() = None);
    result
}

fn cancel_requested() -> bool {
    ACTIVE_CANCEL.with(|slot| {
        slot.borrow()
            .as_ref()
            .map(|flag| flag.load(Ordering::Relaxed))
            .unwrap_or(false)
    })
}

fn run_ffmpeg(
    args: &[String],
    duration_ms: u64,
    progress: &mut dyn FnMut(f64),
) -> Result<(), MediaError> {
    require_binary("ffmpeg")?;
    assert_lgpl_args(args)?;
    let mut command_args = vec![
        "-hide_banner".to_string(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ];
    command_args.extend(args.iter().cloned());
    let mut child = Command::new("ffmpeg")
        .args(&command_args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| MediaError::Ffmpeg(err.to_string()))?;
    let pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| MediaError::Ffmpeg("ffmpeg returned no progress stream".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| MediaError::Ffmpeg("ffmpeg returned no error stream".into()))?;
    let err_handle = thread::spawn(move || {
        let mut text = String::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_string(&mut text);
        text
    });
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        if cancel_requested() {
            let _ = Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
            break;
        }
        let line = line.map_err(|err| MediaError::Ffmpeg(err.to_string()))?;
        if let Some(rest) = line.strip_prefix("out_time_ms=") {
            if let Ok(raw) = rest.parse::<u64>() {
                if duration_ms > 0 {
                    let elapsed_ms = if raw > duration_ms.saturating_mul(10) {
                        raw / 1000
                    } else {
                        raw
                    };
                    let fraction = elapsed_ms as f64 / duration_ms as f64;
                    progress(fraction.clamp(0.0, 0.99));
                }
            }
        }
        if line == "progress=end" {
            progress(1.0);
        }
    }
    let status = child
        .wait()
        .map_err(|err| MediaError::Ffmpeg(err.to_string()))?;
    let err_text = err_handle.join().unwrap_or_default();
    if cancel_requested() {
        return Err(MediaError::Message("cancelled".into()));
    }
    if !status.success() {
        return Err(MediaError::Ffmpeg(tail(err_text.as_bytes())));
    }
    Ok(())
}

fn assert_lgpl_args(args: &[String]) -> Result<(), MediaError> {
    if args
        .iter()
        .any(|arg| arg == "libx264" || arg.contains("enable-gpl"))
    {
        return Err(MediaError::Message(
            "refusing a GPL encoder path. Tippy uses the built-in mpeg4 encoder.".into(),
        ));
    }
    Ok(())
}

fn parse_probe(value: &serde_json::Value, size_fallback: u64) -> Result<ProbeInfo, MediaError> {
    let streams = value["streams"]
        .as_array()
        .ok_or_else(|| MediaError::Ffprobe("ffprobe returned no streams".into()))?;
    let video = streams
        .iter()
        .find(|stream| stream["codec_type"] == "video")
        .ok_or_else(|| MediaError::Ffprobe("file has no video stream".into()))?;
    let audio = streams
        .iter()
        .find(|stream| stream["codec_type"] == "audio");
    let duration_s = value["format"]["duration"]
        .as_str()
        .and_then(|text| text.parse::<f64>().ok())
        .or_else(|| {
            video["duration"]
                .as_str()
                .and_then(|text| text.parse::<f64>().ok())
        })
        .unwrap_or(0.0);
    let size_bytes = value["format"]["size"]
        .as_str()
        .and_then(|text| text.parse::<u64>().ok())
        .unwrap_or(size_fallback);
    Ok(ProbeInfo {
        duration_ms: (duration_s * 1000.0).round() as u64,
        width: video["width"].as_u64().unwrap_or(0) as u32,
        height: video["height"].as_u64().unwrap_or(0) as u32,
        frame_rate: parse_ratio(video["r_frame_rate"].as_str().unwrap_or("0/1")),
        video_codec: video["codec_name"]
            .as_str()
            .unwrap_or("unknown")
            .to_string(),
        audio_codec: audio
            .and_then(|stream| stream["codec_name"].as_str())
            .unwrap_or("")
            .to_string(),
        size_bytes,
    })
}

fn parse_ratio(value: &str) -> f64 {
    let mut parts = value.split('/');
    let numer = parts
        .next()
        .and_then(|part| part.parse::<f64>().ok())
        .unwrap_or(0.0);
    let denom = parts
        .next()
        .and_then(|part| part.parse::<f64>().ok())
        .unwrap_or(1.0);
    if denom == 0.0 {
        0.0
    } else {
        numer / denom
    }
}

fn ms_to_seconds(ms: u64) -> String {
    format!("{:.3}", ms as f64 / 1000.0)
}

fn ensure_parent(path: &Path) -> Result<(), MediaError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| MediaError::Message(err.to_string()))?;
    }
    Ok(())
}

fn binary_ok(name: &str) -> bool {
    Command::new(name)
        .arg("-version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn require_binary(name: &str) -> Result<(), MediaError> {
    if binary_ok(name) {
        return Ok(());
    }
    Err(MediaError::Message(format!(
        "{name} was not found. Install the apt package `ffmpeg`."
    )))
}

#[cfg(test)]
pub fn render_color_bars(output: &Path) -> Result<(), MediaError> {
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|err| MediaError::Message(err.to_string()))?;
    }
    let status = Command::new("ffmpeg")
        .args([
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=duration=2:size=320x180:rate=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=2",
            "-c:v",
            "mpeg4",
            "-q:v",
            "6",
            "-c:a",
            "aac",
            "-shortest",
        ])
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| MediaError::Ffmpeg(err.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(MediaError::Ffmpeg(
            "could not render the color-bar sample".into(),
        ))
    }
}

fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim();
    let start = trimmed.len().saturating_sub(500);
    trimmed[start..].to_string()
}

pub fn write_pcm16_wav(path: &Path, samples: &[i16]) -> Result<(), MediaError> {
    let data_bytes = samples.len() * 2;
    let mut bytes = Vec::with_capacity(44 + data_bytes);
    bytes.extend(b"RIFF");
    bytes.extend_from_slice(&(36 + data_bytes as u32).to_le_bytes());
    bytes.extend(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&8000u32.to_le_bytes());
    bytes.extend_from_slice(&(8000u32 * 2).to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend(b"data");
    bytes.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for sample in samples {
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| MediaError::Message(err.to_string()))?;
    }
    let mut file = File::create(path).map_err(|err| MediaError::Message(err.to_string()))?;
    file.write_all(&bytes)
        .map_err(|err| MediaError::Message(err.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoder_args_stay_on_the_lgpl_path() {
        let args = encode_args(true, 5);
        assert!(args.iter().any(|arg| arg == "mpeg4"));
        assert!(args.iter().any(|arg| arg == "aac"));
        assert!(assert_lgpl_args(&args).is_ok());
        let banned = vec!["libx264".to_string()];
        assert!(assert_lgpl_args(&banned).is_err());
    }

    #[test]
    fn waveform_peaks_follow_the_loudest_sample() {
        let dir = std::env::temp_dir().join(format!("tippy-wav-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("tone.wav");
        let mut samples = vec![0i16; 160];
        samples[10] = 16000;
        write_pcm16_wav(&path, &samples).unwrap();
        let peaks = waveform_peaks(&path, 4).unwrap();
        assert_eq!(peaks.len(), 4);
        assert!(peaks.iter().copied().fold(0f32, f32::max) > 0.4);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn ffmpeg_pipeline_on_color_bars() {
        let status = FfmpegMediaEngine::status();
        assert!(status.ready, "{}", status.message);
        let dir =
            std::env::temp_dir().join(format!("tippy-ffmpeg-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("bars.mp4");
        super::render_color_bars(&source).unwrap();
        let original = fs::read(&source).unwrap();
        let engine = FfmpegMediaEngine;
        let probe = engine.probe(&source).unwrap();
        assert!(probe.duration_ms >= 1500);
        assert!(probe.width > 0 && probe.height > 0);
        assert!(!probe.video_codec.is_empty());
        let proxy = dir.join("proxy.mp4");
        engine
            .create_proxy(
                &source,
                &proxy,
                probe.duration_ms,
                probe.has_audio(),
                &mut |_| {},
            )
            .unwrap();
        assert!(proxy.metadata().unwrap().len() > 0);
        let audio = dir.join("audio.wav");
        engine.extract_audio(&source, &audio).unwrap();
        let peaks = waveform_peaks(&audio, 32).unwrap();
        assert!(peaks.iter().any(|peak| *peak > 0.0));
        let thumb = dir.join("thumb.png");
        engine.create_thumbnail(&source, &thumb, 400).unwrap();
        assert!(thumb.metadata().unwrap().len() > 32);
        let trimmed = dir.join("trim.mp4");
        engine
            .trim(&source, &trimmed, 200, 1200, probe.has_audio())
            .unwrap();
        let exported = dir.join("export.mp4");
        engine
            .export_video(
                &source,
                &exported,
                probe.duration_ms,
                probe.has_audio(),
                &mut |_| {},
            )
            .unwrap();
        engine
            .render_sequence(
                &[RenderSegment {
                    path: source.clone(),
                    start_ms: 0,
                    end_ms: 800,
                }],
                &dir.join("sequence.mp4"),
                probe.has_audio(),
            )
            .unwrap();
        assert_eq!(fs::read(&source).unwrap(), original);
        let _ = fs::remove_dir_all(dir);
    }
}
