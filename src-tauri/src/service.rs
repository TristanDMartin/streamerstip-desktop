use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use serde_json::json;

use crate::account::{self, LocalAccount};
use crate::error::{DesktopError, DesktopResult};
use crate::flags::{self, FeatureFlags};
use crate::jobs::JobState;
use crate::log::log_line;
use crate::media::{waveform_peaks, EngineStatus, MediaEngine, ProbeInfo};
use crate::project::{
    new_id, now_iso, ExportRecord, MediaAsset, Project, ProjectCard, ProjectStore, Sequence,
    SequenceClip,
};
use crate::runtime::{
    derived_dir, record_action, record_version, refresh_dependency_states, BusEvent, CostEntry,
    CostMeter, Orchestrator, TaskNode,
};
use crate::speech::SpeechEngine;

pub struct AppState {
    pub store: Mutex<ProjectStore>,
    pub engine: Box<dyn MediaEngine>,
    pub meter: Mutex<CostMeter>,
    pub flags: FeatureFlags,
    pub account: LocalAccount,
    pub log_path: PathBuf,
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub preview_origin: String,
    pub speech: Box<dyn SpeechEngine>,
}

impl AppState {
    pub fn open(
        root: PathBuf,
        engine: Box<dyn MediaEngine>,
        speech: Box<dyn SpeechEngine>,
    ) -> DesktopResult<Self> {
        std::fs::create_dir_all(&root)?;
        let store = ProjectStore::new(root.clone())?;
        let account = account::load_or_create(&root.join("account.json"))?;
        let flags = flags::load_or_create(&root.join("flags.json"))?;
        let meter = CostMeter::open(root.join("cost-meter.json"))?;
        let log_path = root.join("logs").join("tippy.log");
        let router = crate::ai::ModelRouter::new();
        let cloud_route = router.route(&crate::ai::RouteRequest {
            class: crate::ai::ModelClass::ReasoningPremium,
            privacy: crate::ai::PrivacyMode::LocalFirst,
            prefer_cloud: true,
            cloud_cost_is_lower: true,
        });
        log_line(
            &log_path,
            "info",
            &format!(
                "data directory ready owner={} workers={} tools={} actions={} local_only_premium={cloud_route:?}",
                account.owner_id,
                crate::runtime::WORKERS.len(),
                crate::runtime::tools().len(),
                crate::actions::registry().len(),
            ),
        );
        let _ = crate::runtime::plan_goal("not connected");
        let _ = flags.desktop_multi_agent;
        log_line(&log_path, "info", &speech.status());
        Ok(Self {
            store: Mutex::new(store),
            engine,
            meter: Mutex::new(meter),
            flags,
            account,
            log_path,
            cancels: Mutex::new(HashMap::new()),
            preview_origin: String::new(),
            speech,
        })
    }

    pub fn engine_status(&self) -> EngineStatus {
        self.engine.availability()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobListItem {
    pub job_id: String,
    pub project_id: String,
    pub project_name: String,
    pub job_type: String,
    pub state: JobState,
    pub progress: f64,
    pub error: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub projects: Vec<ProjectCard>,
    pub jobs: Vec<JobListItem>,
}

pub fn recover_all(state: &AppState) -> Vec<String> {
    let ids = match lock(&state.store).list_ids() {
        Ok(ids) => ids,
        Err(err) => {
            log_line(&state.log_path, "error", &err.to_string());
            return Vec::new();
        }
    };
    let mut recovered = Vec::new();
    for id in ids {
        match lock(&state.store).recover_on_launch(&id) {
            Ok(project) => {
                log_line(
                    &state.log_path,
                    "info",
                    &format!("recovered {} ({})", project.name, project.project_id),
                );
                recovered.push(id);
            }
            Err(err) => log_line(&state.log_path, "error", &format!("{id}: {err}")),
        }
    }
    recovered
}

pub fn workspace(state: &AppState) -> DesktopResult<Workspace> {
    let store = lock(&state.store);
    let mut projects = Vec::new();
    let mut jobs = Vec::new();
    for id in store.list_ids()? {
        match store.load_project(&id) {
            Ok(project) => {
                for job in &project.jobs {
                    jobs.push(JobListItem {
                        job_id: job.job_id.clone(),
                        project_id: project.project_id.clone(),
                        project_name: project.name.clone(),
                        job_type: job.job_type.clone(),
                        state: job.state,
                        progress: job.progress,
                        error: job.error.clone(),
                        message: job.message.clone(),
                    });
                }
                projects.push(ProjectCard {
                    project_id: project.project_id,
                    name: project.name,
                    updated_at: project.updated_at,
                    media_count: project.media.len(),
                    error: None,
                });
            }
            Err(err) => projects.push(ProjectCard {
                project_id: id,
                name: "Unreadable project".into(),
                updated_at: String::new(),
                media_count: 0,
                error: Some(err.to_string()),
            }),
        }
    }
    projects.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    jobs.sort_by(|left, right| {
        let rank = |job: &JobListItem| {
            if !job.state.is_terminal() {
                0
            } else if matches!(
                job.job_type.as_str(),
                "create_short" | "refresh_short" | "export_short"
            ) {
                1
            } else {
                2
            }
        };
        rank(left)
            .cmp(&rank(right))
            .then_with(|| right.job_id.cmp(&left.job_id))
    });
    Ok(Workspace { projects, jobs })
}

pub fn create_project(state: &AppState, name: &str) -> DesktopResult<Project> {
    let project = lock(&state.store).create_project(name, &state.account.owner_id)?;
    log_line(
        &state.log_path,
        "info",
        &format!("created project {} {}", project.project_id, project.name),
    );
    Ok(project)
}

pub fn open_project(state: &AppState, project_id: &str) -> DesktopResult<Project> {
    lock(&state.store).load_project(project_id)
}

pub fn import_video(state: &AppState, project_id: &str, source: &Path) -> DesktopResult<Project> {
    if !source.is_file() {
        return Err(DesktopError::Message(format!(
            "video file was not found: {}",
            source.display()
        )));
    }
    let store = lock(&state.store);
    let mut project = store.load_project(project_id)?;
    let media_id = new_id("media");
    let file_name = source
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "video.mp4".into());
    project.media.push(MediaAsset {
        media_id: media_id.clone(),
        original_path: source.display().to_string(),
        file_name,
        proxy_path: None,
        audio_path: None,
        thumbnail_path: None,
        waveform: Vec::new(),
        probe: None,
        imported_at: now_iso(),
        scenes: Vec::new(),
        silences: Vec::new(),
    });
    project.sequences.push(Sequence {
        sequence_id: new_id("seq"),
        name: "Assembly".into(),
        clips: vec![SequenceClip {
            media_id: media_id.clone(),
            start_ms: 0,
            end_ms: 0,
        }],
        moment_id: String::new(),
        variation: String::new(),
        aspect_ratio: String::new(),
        caption_theme: String::new(),
        export_preset: String::new(),
        captions: Vec::new(),
        changes: Vec::new(),
        preview_path: None,
        source_start_ms: 0,
        source_end_ms: 0,
    });
    record_version(&mut project, "Imported video");
    Orchestrator.enqueue(&mut project, &media_id, &crate::runtime::plan_import());
    store.save_project(&project, true)?;
    log_line(
        &state.log_path,
        "info",
        &format!("imported {} into {}", source.display(), project.project_id),
    );
    Ok(project)
}

pub fn export_video(state: &AppState, project_id: &str, media_id: &str) -> DesktopResult<Project> {
    let store = lock(&state.store);
    let mut project = store.load_project(project_id)?;
    let media = project
        .media
        .iter()
        .find(|item| item.media_id == media_id)
        .ok_or_else(|| DesktopError::Message("that video is not in the project".into()))?;
    if media.probe.is_none() {
        return Err(DesktopError::Message(
            "Probe the video before exporting.".into(),
        ));
    }
    Orchestrator.enqueue(&mut project, media_id, &crate::runtime::plan_export());
    store.save_project(&project, true)?;
    Ok(project)
}

pub fn ask_tippy(state: &AppState, project_id: Option<&str>, text: &str) -> crate::ai::TippyReply {
    log_line(
        &state.log_path,
        "info",
        "tippy composer submitted; no model was called",
    );
    if let Some(project_id) = project_id {
        let loaded = {
            let store = lock(&state.store);
            store.load_project(project_id)
        };
        if let Ok(project) = loaded {
            if let Some((message, hits)) =
                crate::speech::answer_question(&project.transcript.segments, text)
            {
                log_line(
                    &state.log_path,
                    "info",
                    "answered from the local transcript",
                );
                return crate::ai::TippyReply {
                    connected: false,
                    handled: true,
                    message,
                    hits: hits
                        .into_iter()
                        .map(|hit| crate::ai::TippyHit {
                            segment_id: hit.segment_id,
                            start_ms: hit.start_ms,
                            end_ms: hit.end_ms,
                            text: hit.text,
                        })
                        .collect(),
                };
            }
            if crate::shorts::asks_for_four_shorts(text) {
                return match queue_four_shorts(state, project_id) {
                    Ok((_project, message)) => {
                        log_line(
                            &state.log_path,
                            "info",
                            "queued local shorts; no model was called",
                        );
                        crate::ai::TippyReply {
                            connected: false,
                            handled: true,
                            message,
                            hits: Vec::new(),
                        }
                    }
                    Err(err) => crate::ai::TippyReply {
                        connected: false,
                        handled: true,
                        message: err.to_string(),
                        hits: Vec::new(),
                    },
                };
            }
            if let Some((message, start_ms, end_ms, moment_id)) =
                crate::scout::answer_best_clips(&project.moments, text)
            {
                log_line(
                    &state.log_path,
                    "info",
                    "answered from the local moment shortlist",
                );
                let hits = if moment_id.is_empty() {
                    Vec::new()
                } else {
                    vec![crate::ai::TippyHit {
                        segment_id: moment_id,
                        start_ms,
                        end_ms,
                        text: message.clone(),
                    }]
                };
                return crate::ai::TippyReply {
                    connected: false,
                    handled: true,
                    message,
                    hits,
                };
            }
        }
    }
    let reply = crate::ai::submit_tippy_message(text);
    crate::ai::TippyReply {
        handled: false,
        hits: Vec::new(),
        ..reply
    }
}

pub fn cancel_job(state: &AppState, project_id: &str, job_id: &str) -> DesktopResult<Project> {
    if let Some(flag) = lock(&state.cancels).get(job_id) {
        flag.store(true, Ordering::Relaxed);
    }
    let store = lock(&state.store);
    let mut project = store.load_project(project_id)?;
    if let Some(job) = project.jobs.iter_mut().find(|job| job.job_id == job_id) {
        if !job.state.is_terminal() && job.state != JobState::Running {
            job.state = JobState::Cancelled;
            job.message = "Cancelled".into();
            job.completed_at = Some(now_iso());
        }
    }
    refresh_dependency_states(&mut project.jobs);
    project.touch();
    store.save_project(&project, true)?;
    Ok(project)
}

struct Claimed {
    job_id: String,
    job_type: String,
    media_id: String,
    subject_id: String,
    input: PathBuf,
    duration_ms: u64,
    has_audio: bool,
    cancel: Arc<AtomicBool>,
}

pub fn run_pending(
    state: &AppState,
    project_id: &str,
    on_update: &mut dyn FnMut(&Project, &BusEvent),
) -> Result<(), String> {
    loop {
        let batch = match claim_batch(state, project_id) {
            Ok(batch) if batch.is_empty() => break,
            Ok(batch) => batch,
            Err(err) => return Err(err.to_string()),
        };
        for claimed in &batch {
            publish(state, project_id, &claimed.job_id, on_update);
        }
        let finished = if batch.len() == 1 {
            let claimed = &batch[0];
            let started = Instant::now();
            let outcome = crate::media::with_cancel(claimed.cancel.clone(), || {
                execute(state, project_id, claimed, on_update)
            });
            vec![(outcome, started.elapsed().as_secs_f64() * 1000.0)]
        } else {
            std::thread::scope(|scope| {
                let mut handles = Vec::new();
                for claimed in &batch {
                    handles.push(scope.spawn(|| {
                        let started = Instant::now();
                        let outcome = crate::media::with_cancel(claimed.cancel.clone(), || {
                            execute(state, project_id, claimed, &mut |_project, _event| {})
                        });
                        (outcome, started.elapsed().as_secs_f64() * 1000.0)
                    }));
                }
                handles
                    .into_iter()
                    .map(|handle| {
                        handle
                            .join()
                            .unwrap_or_else(|_| (Err("short worker stopped".into()), 0.0))
                    })
                    .collect()
            })
        };
        for (claimed, (outcome, elapsed_ms)) in batch.iter().zip(finished) {
            finalize(state, project_id, claimed, outcome, elapsed_ms);
            publish(state, project_id, &claimed.job_id, on_update);
        }
    }
    Ok(())
}

fn claim_batch(state: &AppState, project_id: &str) -> DesktopResult<Vec<Claimed>> {
    let store = lock(&state.store);
    let mut project = store.load_project(project_id)?;
    let changed = refresh_dependency_states(&mut project.jobs);
    let indexes = crate::runtime::runnable_batch(&project.jobs, crate::runtime::parallel_limit());
    if indexes.is_empty() {
        if changed {
            project.touch();
            store.save_project(&project, true)?;
        }
        return Ok(Vec::new());
    }
    let mut claimed = Vec::new();
    for index in indexes {
        let media_id = project.jobs[index].media_id.clone();
        let job_id = project.jobs[index].job_id.clone();
        let job_type = project.jobs[index].job_type.clone();
        let subject_id = project.jobs[index].subject_id.clone();
        let media = project.media.iter().find(|item| item.media_id == media_id);
        let input = media
            .map(|item| PathBuf::from(&item.original_path))
            .unwrap_or_default();
        let duration_ms = media
            .and_then(|item| item.probe.as_ref())
            .map(|probe| probe.duration_ms)
            .unwrap_or(0);
        let has_audio = media
            .and_then(|item| item.probe.as_ref())
            .map(ProbeInfo::has_audio)
            .unwrap_or(true);
        let cancel = Arc::new(AtomicBool::new(false));
        lock(&state.cancels).insert(job_id.clone(), cancel.clone());
        project.jobs[index].state = JobState::Running;
        project.jobs[index].started_at = Some(now_iso());
        project.jobs[index].message = running_message(&job_type).into();
        claimed.push(Claimed {
            job_id,
            job_type,
            media_id,
            subject_id,
            input,
            duration_ms,
            has_audio,
            cancel,
        });
    }
    project.touch();
    store.save_project(&project, true)?;
    Ok(claimed)
}

fn execute(
    state: &AppState,
    project_id: &str,
    claimed: &Claimed,
    on_update: &mut dyn FnMut(&Project, &BusEvent),
) -> Result<Execution, String> {
    let root = lock(&state.store).root().to_path_buf();
    let folder = derived_dir(&root, project_id, &claimed.media_id);
    let mut last_tick = Instant::now()
        .checked_sub(std::time::Duration::from_secs(1))
        .unwrap_or_else(Instant::now);
    let mut report = |fraction: f64| {
        if last_tick.elapsed() < std::time::Duration::from_millis(180) && fraction < 0.99 {
            return;
        }
        last_tick = Instant::now();
        if let Ok(store) = state.store.lock() {
            if let Ok(mut project) = store.load_project(project_id) {
                if let Some(job) = project
                    .jobs
                    .iter_mut()
                    .find(|job| job.job_id == claimed.job_id)
                {
                    job.progress = fraction;
                    job.message = running_message(&claimed.job_type).into();
                }
                project.touch();
                let _ = store.save_project(&project, false);
                let event = project
                    .jobs
                    .iter()
                    .find(|job| job.job_id == claimed.job_id)
                    .map(|job| BusEvent::job(project_id, job));
                drop(store);
                if let Some(event) = event {
                    on_update(&project, &event);
                }
            }
        }
    };
    match claimed.job_type.as_str() {
        "probe_media" => {
            let probe = state
                .engine
                .probe(&claimed.input)
                .map_err(|err| err.to_string())?;
            report(1.0);
            Ok(Execution::Probe(probe))
        }
        "create_proxy" => {
            let output = folder.join("proxy.mp4");
            state
                .engine
                .create_proxy(
                    &claimed.input,
                    &output,
                    claimed.duration_ms,
                    claimed.has_audio,
                    &mut report,
                )
                .map_err(|err| err.to_string())?;
            Ok(Execution::Proxy(output))
        }
        "extract_audio" => {
            let output = folder.join("audio.wav");
            state
                .engine
                .extract_audio(&claimed.input, &output)
                .map_err(|err| err.to_string())?;
            let peaks = waveform_peaks(&output, 96).map_err(|err| err.to_string())?;
            report(1.0);
            Ok(Execution::Audio {
                path: output,
                peaks,
            })
        }
        "create_thumbnail" => {
            let output = folder.join("thumb.png");
            let at = if claimed.duration_ms > 500 { 400 } else { 0 };
            state
                .engine
                .create_thumbnail(&claimed.input, &output, at)
                .map_err(|err| err.to_string())?;
            report(1.0);
            Ok(Execution::Thumbnail(output))
        }
        "detect_scenes" => {
            let scenes = state
                .engine
                .detect_scenes(&claimed.input, claimed.duration_ms)
                .map_err(|err| err.to_string())?;
            let mut stored = Vec::new();
            for (index, mut scene) in scenes.into_iter().take(8).enumerate() {
                let output = folder.join(format!("scene-{index}.png"));
                if state
                    .engine
                    .create_thumbnail(&claimed.input, &output, scene.start_ms)
                    .is_ok()
                {
                    scene.thumbnail_path = Some(output.display().to_string());
                }
                stored.push(scene);
                report((index as f64 + 1.0) / 8.0);
            }
            Ok(Execution::Scenes(stored))
        }
        "detect_silence" => {
            let audio = stored_path(state, project_id, &claimed.media_id, true)?;
            let silences = state
                .engine
                .detect_silence(&audio, claimed.duration_ms)
                .map_err(|err| err.to_string())?;
            report(1.0);
            Ok(Execution::Silences(silences))
        }
        "transcribe_media" => {
            let speech_wav = folder.join("speech.wav");
            state
                .engine
                .extract_speech(&claimed.input, &speech_wav)
                .map_err(|err| err.to_string())?;
            let utterances = state
                .speech
                .transcribe(&speech_wav)
                .map_err(|err| err.to_string())?;
            report(1.0);
            Ok(Execution::Transcript(crate::speech::segments_from(
                utterances,
            )))
        }
        "scout_moments" => {
            let material = load_scout_material(state, project_id, &claimed.media_id)?;
            let mut moments = crate::scout::rank_moments(&crate::scout::ScoutInput {
                media_id: &claimed.media_id,
                duration_ms: material.duration_ms,
                segments: &material.segments,
                scenes: &material.scenes,
                silences: &material.silences,
                waveform: &material.waveform,
            });
            let total = moments.len().max(1);
            for (index, moment) in moments.iter_mut().enumerate() {
                let output = folder.join(format!("moment-{index}.png"));
                let at = moment.start_ms.min(material.duration_ms.saturating_sub(1));
                if state
                    .engine
                    .create_thumbnail(&claimed.input, &output, at)
                    .is_ok()
                {
                    moment.preview_path = Some(output.display().to_string());
                }
                report((index as f64 + 1.0) / total as f64);
            }
            Ok(Execution::Moments(moments))
        }
        "create_short" => {
            let built = build_short_sequences(state, project_id, &claimed.subject_id)?;
            let mut tippy = built.tippy;
            let output = folder.join(format!("short-{}.mp4", tippy.sequence_id));
            render_current(state, claimed, &tippy, &output, &mut report)?;
            tippy.preview_path = Some(output.display().to_string());
            report(1.0);
            Ok(Execution::Shorts(vec![built.original, tippy]))
        }
        "refresh_short" => {
            let sequence = load_sequence(state, project_id, &claimed.subject_id)?;
            let output = folder.join(format!("short-{}.mp4", sequence.sequence_id));
            render_current(state, claimed, &sequence, &output, &mut report)?;
            report(1.0);
            Ok(Execution::Preview {
                sequence_id: sequence.sequence_id,
                path: output,
            })
        }
        "export_short" => {
            let sequence = load_sequence(state, project_id, &claimed.subject_id)?;
            let output = root
                .join("projects")
                .join(project_id)
                .join("derived")
                .join("exports")
                .join(format!("{}.mp4", sequence.sequence_id));
            render_current(state, claimed, &sequence, &output, &mut report)?;
            Ok(Execution::Export {
                path: output,
                sequence_id: sequence.sequence_id,
            })
        }
        "create_export" => {
            let output = root
                .join("projects")
                .join(project_id)
                .join("derived")
                .join("exports")
                .join(format!("{}.mp4", claimed.job_id));
            state
                .engine
                .export_video(
                    &claimed.input,
                    &output,
                    claimed.duration_ms,
                    claimed.has_audio,
                    &mut report,
                )
                .map_err(|err| err.to_string())?;
            Ok(Execution::Export {
                path: output,
                sequence_id: String::new(),
            })
        }
        other => Err(format!(
            "{other} is registered but not running in this phase"
        )),
    }
}

enum Execution {
    Probe(ProbeInfo),
    Proxy(PathBuf),
    Audio { path: PathBuf, peaks: Vec<f32> },
    Thumbnail(PathBuf),
    Scenes(Vec<crate::media::SceneSpan>),
    Silences(Vec<crate::media::SilenceSpan>),
    Transcript(Vec<crate::project::TranscriptSegment>),
    Moments(Vec<crate::project::Moment>),
    Shorts(Vec<Sequence>),
    Preview { sequence_id: String, path: PathBuf },
    Export { path: PathBuf, sequence_id: String },
}

struct ScoutMaterial {
    duration_ms: u64,
    segments: Vec<crate::project::TranscriptSegment>,
    scenes: Vec<crate::media::SceneSpan>,
    silences: Vec<crate::media::SilenceSpan>,
    waveform: Vec<f32>,
}

fn load_scout_material(
    state: &AppState,
    project_id: &str,
    media_id: &str,
) -> Result<ScoutMaterial, String> {
    let store = lock(&state.store);
    let project = store
        .load_project(project_id)
        .map_err(|err| err.to_string())?;
    let media = project
        .media
        .iter()
        .find(|item| item.media_id == media_id)
        .ok_or_else(|| "that video is not in the project".to_string())?;
    let duration_ms = media
        .probe
        .as_ref()
        .map(|probe| probe.duration_ms)
        .unwrap_or(0);
    Ok(ScoutMaterial {
        duration_ms,
        segments: project.transcript.segments.clone(),
        scenes: media.scenes.clone(),
        silences: media.silences.clone(),
        waveform: media.waveform.clone(),
    })
}

fn stored_path(
    state: &AppState,
    project_id: &str,
    media_id: &str,
    audio: bool,
) -> Result<PathBuf, String> {
    let store = lock(&state.store);
    let project = store
        .load_project(project_id)
        .map_err(|err| err.to_string())?;
    let media = project
        .media
        .iter()
        .find(|item| item.media_id == media_id)
        .ok_or_else(|| "that video is not in the project".to_string())?;
    let path = if audio {
        media.audio_path.clone()
    } else {
        media.proxy_path.clone()
    };
    path.map(PathBuf::from)
        .ok_or_else(|| "the audio pass has not finished".to_string())
}

fn finalize(
    state: &AppState,
    project_id: &str,
    claimed: &Claimed,
    outcome: Result<Execution, String>,
    elapsed_ms: f64,
) {
    let store = lock(&state.store);
    let Ok(mut project) = store.load_project(project_id) else {
        return;
    };
    let cancelled = claimed.cancel.load(Ordering::Relaxed)
        || matches!(outcome.as_ref(), Err(message) if message == "cancelled");
    let transcribed = !cancelled && claimed.job_type == "transcribe_media" && outcome.is_ok();
    let made_short = !cancelled && claimed.job_type == "create_short" && outcome.is_ok();
    let moment_count = match outcome.as_ref() {
        Ok(Execution::Moments(moments)) if !cancelled => moments.len(),
        _ => 0,
    };
    let Some(index) = project
        .jobs
        .iter()
        .position(|job| job.job_id == claimed.job_id)
    else {
        return;
    };
    if cancelled {
        project.jobs[index].state = JobState::Cancelled;
        project.jobs[index].message = "Cancelled".into();
        project.jobs[index].error = None;
        project.jobs[index].completed_at = Some(now_iso());
    } else {
        match outcome {
            Ok(execution) => {
                apply_execution(&mut project, &claimed.media_id, execution);
                project.jobs[index].state = JobState::Completed;
                project.jobs[index].progress = 1.0;
                project.jobs[index].message = "Done".into();
                project.jobs[index].error = None;
                project.jobs[index].completed_at = Some(now_iso());
                record_action(
                    &mut project,
                    &claimed.job_type,
                    json!({ "jobId": claimed.job_id, "mediaId": claimed.media_id }),
                );
                if claimed.job_type == "create_export" {
                    record_version(&mut project, "Exported video");
                }
                if claimed.job_type == "transcribe_media" {
                    record_version(&mut project, "Transcribed video");
                }
                if claimed.job_type == "scout_moments" {
                    record_version(&mut project, "Scouted moments");
                }
                if claimed.job_type == "create_short" {
                    record_version(&mut project, "Created a Short");
                }
                if claimed.job_type == "export_short" {
                    record_version(&mut project, "Exported a Short");
                }
            }
            Err(message) => {
                project.jobs[index].state = JobState::Failed;
                project.jobs[index].error = Some(trim_message(&message));
                project.jobs[index].message = "Failed".into();
                project.jobs[index].completed_at = Some(now_iso());
            }
        }
    }
    refresh_dependency_states(&mut project.jobs);
    project.touch();
    let _ = store.save_project(&project, true);
    drop(store);
    lock(&state.cancels).remove(&claimed.job_id);
    if let Ok(meter) = state.meter.lock() {
        let _ = meter.record(CostEntry {
            project_id: project_id.into(),
            kind: "local_process_ms".into(),
            amount: elapsed_ms,
            at: now_iso(),
        });
        if claimed.job_type == "create_export" {
            let _ = meter.record(CostEntry {
                project_id: project_id.into(),
                kind: "export".into(),
                amount: 1.0,
                at: now_iso(),
            });
        }
        if transcribed {
            let _ = meter.record(CostEntry {
                project_id: project_id.into(),
                kind: "transcription_ms".into(),
                amount: claimed.duration_ms as f64,
                at: now_iso(),
            });
        }
        if moment_count > 0 {
            let _ = meter.record(CostEntry {
                project_id: project_id.into(),
                kind: "moments".into(),
                amount: moment_count as f64,
                at: now_iso(),
            });
        }
        if made_short {
            let _ = meter.record(CostEntry {
                project_id: project_id.into(),
                kind: "shorts".into(),
                amount: 1.0,
                at: now_iso(),
            });
        }
    }
    log_line(
        &state.log_path,
        "info",
        &format!("{project_id} {} finished", claimed.job_type),
    );
}

fn apply_execution(project: &mut Project, media_id: &str, execution: Execution) {
    match execution {
        Execution::Probe(probe) => {
            let duration = probe.duration_ms;
            if let Some(media) = project
                .media
                .iter_mut()
                .find(|item| item.media_id == media_id)
            {
                media.probe = Some(probe);
            }
            for sequence in &mut project.sequences {
                for clip in &mut sequence.clips {
                    if clip.media_id == media_id && clip.end_ms == 0 {
                        clip.end_ms = duration;
                    }
                }
            }
        }
        Execution::Proxy(path) => {
            if let Some(media) = project
                .media
                .iter_mut()
                .find(|item| item.media_id == media_id)
            {
                media.proxy_path = Some(path.display().to_string());
            }
        }
        Execution::Audio { path, peaks } => {
            if let Some(media) = project
                .media
                .iter_mut()
                .find(|item| item.media_id == media_id)
            {
                media.audio_path = Some(path.display().to_string());
                media.waveform = peaks;
            }
        }
        Execution::Thumbnail(path) => {
            if let Some(media) = project
                .media
                .iter_mut()
                .find(|item| item.media_id == media_id)
            {
                media.thumbnail_path = Some(path.display().to_string());
            }
        }
        Execution::Scenes(scenes) => {
            if let Some(media) = project
                .media
                .iter_mut()
                .find(|item| item.media_id == media_id)
            {
                media.scenes = scenes;
            }
        }
        Execution::Silences(silences) => {
            if let Some(media) = project
                .media
                .iter_mut()
                .find(|item| item.media_id == media_id)
            {
                media.silences = silences;
            }
        }
        Execution::Transcript(segments) => {
            project.transcript.media_id = media_id.into();
            project.transcript.segments = segments;
        }
        Execution::Moments(moments) => {
            project.moments.retain(|moment| moment.media_id != media_id);
            project.moments.extend(moments);
        }
        Execution::Shorts(sequences) => {
            let moment_ids: Vec<String> = sequences
                .iter()
                .map(|sequence| sequence.moment_id.clone())
                .filter(|moment_id| !moment_id.is_empty())
                .collect();
            project.sequences.retain(|sequence| {
                sequence.moment_id.is_empty()
                    || !moment_ids
                        .iter()
                        .any(|moment_id| moment_id == &sequence.moment_id)
            });
            project.sequences.extend(sequences);
        }
        Execution::Preview { sequence_id, path } => {
            if let Some(sequence) = project
                .sequences
                .iter_mut()
                .find(|sequence| sequence.sequence_id == sequence_id)
            {
                sequence.preview_path = Some(path.display().to_string());
            }
        }
        Execution::Export { path, sequence_id } => {
            project.exports.push(ExportRecord {
                export_id: new_id("exp"),
                media_id: media_id.into(),
                path: path.display().to_string(),
                created_at: now_iso(),
                sequence_id,
            });
        }
    }
}

fn publish(
    state: &AppState,
    project_id: &str,
    job_id: &str,
    on_update: &mut dyn FnMut(&Project, &BusEvent),
) {
    let Ok(store) = state.store.lock() else {
        return;
    };
    let Ok(project) = store.load_project(project_id) else {
        return;
    };
    let Some(job) = project.jobs.iter().find(|job| job.job_id == job_id) else {
        return;
    };
    let event = BusEvent::job(project_id, job);
    drop(store);
    on_update(&project, &event);
}

fn running_message(job_type: &str) -> &'static str {
    match job_type {
        "probe_media" => "Reading media",
        "create_proxy" => "Creating proxy",
        "extract_audio" => "Building waveform",
        "create_thumbnail" => "Creating thumbnail",
        "detect_scenes" => "Detecting scenes",
        "detect_silence" => "Detecting silence",
        "transcribe_media" => "Transcribing",
        "scout_moments" => "Finding moments",
        "create_short" => "Making a Short",
        "refresh_short" => "Updating the Short",
        "export_short" => "Exporting a Short",
        "create_export" => "Exporting",
        _ => "Working",
    }
}

fn trim_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.chars().count() <= 500 {
        return trimmed.to_string();
    }
    trimmed.chars().take(500).collect()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}

pub fn enqueue_plan(project: &mut Project, media_id: &str, nodes: &[TaskNode]) -> Vec<String> {
    Orchestrator.enqueue(project, media_id, nodes)
}

pub fn queue_short(state: &AppState, project_id: &str, moment_id: &str) -> DesktopResult<Project> {
    let store = lock(&state.store);
    let mut project = store.load_project(project_id)?;
    let moment = project
        .moments
        .iter()
        .find(|moment| moment.moment_id == moment_id)
        .cloned()
        .ok_or_else(|| DesktopError::Message("that moment is not in the project".into()))?;
    let already = project.jobs.iter().any(|job| {
        job.job_type == "create_short" && job.subject_id == moment_id && !job.state.is_terminal()
    });
    if !already {
        let plan = crate::runtime::plan_shorts(&[moment_id.to_string()]);
        Orchestrator.enqueue(&mut project, &moment.media_id, &plan);
        store.save_project(&project, true)?;
    }
    Ok(project)
}

pub fn queue_four_shorts(state: &AppState, project_id: &str) -> DesktopResult<(Project, String)> {
    let store = lock(&state.store);
    let mut project = store.load_project(project_id)?;
    if project.moments.is_empty() {
        return Ok((project, "Scout moments before creating Shorts.".into()));
    }
    let mut chosen: Vec<(String, String)> = Vec::new();
    for moment in &project.moments {
        if chosen.len() == 4 {
            break;
        }
        let has_tippy = project.sequences.iter().any(|sequence| {
            sequence.moment_id == moment.moment_id
                && sequence.variation == crate::shorts::VARIATION_TIPPY
        });
        let queued = project.jobs.iter().any(|job| {
            job.job_type == "create_short"
                && job.subject_id == moment.moment_id
                && !job.state.is_terminal()
        });
        if has_tippy || queued {
            continue;
        }
        chosen.push((moment.moment_id.clone(), moment.media_id.clone()));
    }
    if chosen.is_empty() {
        return Ok((project, "Those moments already have Shorts.".into()));
    }
    let mut by_media: Vec<(String, Vec<String>)> = Vec::new();
    for (moment_id, media_id) in chosen {
        if let Some((_, ids)) = by_media.iter_mut().find(|(id, _)| id == &media_id) {
            ids.push(moment_id);
        } else {
            by_media.push((media_id, vec![moment_id]));
        }
    }
    let count: usize = by_media.iter().map(|(_, ids)| ids.len()).sum();
    for (media_id, ids) in &by_media {
        let plan = crate::runtime::plan_shorts(ids);
        Orchestrator.enqueue(&mut project, media_id, &plan);
    }
    store.save_project(&project, true)?;
    let noun = if count == 1 { "Short" } else { "Shorts" };
    Ok((project, format!("Tippy is making {count} {noun}.")))
}

pub fn undo_short_change(
    state: &AppState,
    project_id: &str,
    sequence_id: &str,
) -> DesktopResult<Project> {
    let store = lock(&state.store);
    let mut project = store.load_project(project_id)?;
    let Some(sequence) = project
        .sequences
        .iter_mut()
        .find(|sequence| sequence.sequence_id == sequence_id)
    else {
        return Err(DesktopError::Message(
            "that Short is not in the project".into(),
        ));
    };
    if crate::shorts::undo_last(sequence).is_none() {
        return Err(DesktopError::Message(
            "There is nothing left to undo.".into(),
        ));
    }
    let variation = sequence.variation.clone();
    let media_id = sequence
        .clips
        .first()
        .map(|clip| clip.media_id.clone())
        .unwrap_or_default();
    record_version(&mut project, "Undid a change");
    if variation == crate::shorts::VARIATION_TIPPY && !media_id.is_empty() {
        let plan = crate::runtime::plan_short_followup("refresh_short", sequence_id);
        Orchestrator.enqueue(&mut project, &media_id, &plan);
    }
    project.touch();
    store.save_project(&project, true)?;
    Ok(project)
}

pub fn accept_short_changes(
    state: &AppState,
    project_id: &str,
    sequence_id: &str,
) -> DesktopResult<Project> {
    let store = lock(&state.store);
    let mut project = store.load_project(project_id)?;
    let Some(sequence) = project
        .sequences
        .iter_mut()
        .find(|sequence| sequence.sequence_id == sequence_id)
    else {
        return Err(DesktopError::Message(
            "that Short is not in the project".into(),
        ));
    };
    crate::shorts::accept_all(sequence);
    record_version(&mut project, "Accepted the changes");
    project.touch();
    store.save_project(&project, true)?;
    Ok(project)
}

pub fn export_short(
    state: &AppState,
    project_id: &str,
    sequence_id: &str,
) -> DesktopResult<Project> {
    let store = lock(&state.store);
    let mut project = store.load_project(project_id)?;
    let sequence = project
        .sequences
        .iter()
        .find(|sequence| sequence.sequence_id == sequence_id)
        .ok_or_else(|| DesktopError::Message("that Short is not in the project".into()))?;
    let media_id = sequence
        .clips
        .first()
        .map(|clip| clip.media_id.clone())
        .unwrap_or_default();
    if media_id.is_empty() {
        return Err(DesktopError::Message(
            "this Short has no picture yet".into(),
        ));
    }
    let already = project.jobs.iter().any(|job| {
        job.job_type == "export_short" && job.subject_id == sequence_id && !job.state.is_terminal()
    });
    if !already {
        let plan = crate::runtime::plan_short_followup("export_short", sequence_id);
        Orchestrator.enqueue(&mut project, &media_id, &plan);
        store.save_project(&project, true)?;
    }
    Ok(project)
}

struct BuiltShorts {
    original: Sequence,
    tippy: Sequence,
}

fn build_short_sequences(
    state: &AppState,
    project_id: &str,
    moment_id: &str,
) -> Result<BuiltShorts, String> {
    let store = lock(&state.store);
    let project = store
        .load_project(project_id)
        .map_err(|err| err.to_string())?;
    let rank = project
        .moments
        .iter()
        .position(|moment| moment.moment_id == moment_id)
        .ok_or_else(|| "that moment is not in the project".to_string())?
        + 1;
    let moment = project
        .moments
        .iter()
        .find(|moment| moment.moment_id == moment_id)
        .cloned()
        .ok_or_else(|| "that moment is not in the project".to_string())?;
    let silences = project
        .media
        .iter()
        .find(|media| media.media_id == moment.media_id)
        .map(|media| media.silences.clone())
        .unwrap_or_default();
    let segments = project.transcript.segments.clone();
    drop(store);
    let (original, tippy) = crate::shorts::draft_variations(crate::shorts::DraftInput {
        rank,
        moment: &moment,
        silences: &silences,
        segments: &segments,
    });
    Ok(BuiltShorts { original, tippy })
}

fn load_sequence(
    state: &AppState,
    project_id: &str,
    sequence_id: &str,
) -> Result<Sequence, String> {
    let store = lock(&state.store);
    let project = store
        .load_project(project_id)
        .map_err(|err| err.to_string())?;
    project
        .sequences
        .iter()
        .find(|sequence| sequence.sequence_id == sequence_id)
        .cloned()
        .ok_or_else(|| "that Short is not in the project".to_string())
}

fn render_current(
    state: &AppState,
    claimed: &Claimed,
    sequence: &Sequence,
    output: &Path,
    report: &mut dyn FnMut(f64),
) -> Result<(), String> {
    let segments: Vec<crate::media::RenderSegment> = sequence
        .clips
        .iter()
        .filter(|clip| clip.end_ms > clip.start_ms)
        .map(|clip| crate::media::RenderSegment {
            path: claimed.input.clone(),
            start_ms: clip.start_ms,
            end_ms: clip.end_ms,
        })
        .collect();
    if segments.is_empty() {
        return Err("this Short has no picture yet".into());
    }
    let captions: Vec<crate::media::ShortCaption> = sequence
        .captions
        .iter()
        .map(|caption| crate::media::ShortCaption {
            start_ms: caption.start_ms,
            end_ms: caption.end_ms,
            text: caption.text.clone(),
        })
        .collect();
    let vertical = sequence.aspect_ratio == crate::shorts::ASPECT_VERTICAL;
    state
        .engine
        .render_short(
            &segments,
            &captions,
            vertical,
            output,
            claimed.has_audio,
            report,
        )
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::JobState;
    use crate::media::{write_pcm16_wav, EngineStatus, FfmpegMediaEngine, MediaError, ProbeInfo};
    use std::path::Path;

    struct FakeEngine;

    impl MediaEngine for FakeEngine {
        fn availability(&self) -> EngineStatus {
            EngineStatus {
                ready: true,
                ffmpeg: true,
                ffprobe: true,
                message: "fake".into(),
            }
        }

        fn probe(&self, path: &Path) -> Result<ProbeInfo, MediaError> {
            if !path.is_file() {
                return Err(MediaError::Message("missing file".into()));
            }
            Ok(ProbeInfo {
                duration_ms: 2000,
                width: 320,
                height: 180,
                frame_rate: 24.0,
                video_codec: "mpeg4".into(),
                audio_codec: "aac".into(),
                size_bytes: 12,
            })
        }

        fn create_proxy(
            &self,
            _input: &Path,
            output: &Path,
            _duration_ms: u64,
            _has_audio: bool,
            progress: &mut dyn FnMut(f64),
        ) -> Result<(), MediaError> {
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(output, b"proxy").unwrap();
            progress(1.0);
            Ok(())
        }

        fn extract_audio(&self, _input: &Path, output: &Path) -> Result<(), MediaError> {
            let mut samples = vec![0i16; 96];
            samples[4] = 22000;
            write_pcm16_wav(output, &samples)
        }

        fn trim(
            &self,
            _input: &Path,
            output: &Path,
            _start_ms: u64,
            _end_ms: u64,
            _has_audio: bool,
        ) -> Result<(), MediaError> {
            std::fs::write(output, b"trim").map_err(|err| MediaError::Message(err.to_string()))
        }

        fn render_sequence(
            &self,
            _segments: &[crate::media::RenderSegment],
            output: &Path,
            _has_audio: bool,
        ) -> Result<(), MediaError> {
            std::fs::write(output, b"sequence").map_err(|err| MediaError::Message(err.to_string()))
        }

        fn render_short(
            &self,
            _segments: &[crate::media::RenderSegment],
            _captions: &[crate::media::ShortCaption],
            _vertical: bool,
            output: &Path,
            _has_audio: bool,
            progress: &mut dyn FnMut(f64),
        ) -> Result<(), MediaError> {
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(output, b"short").map_err(|err| MediaError::Message(err.to_string()))?;
            progress(1.0);
            Ok(())
        }

        fn create_thumbnail(
            &self,
            _input: &Path,
            output: &Path,
            _at_ms: u64,
        ) -> Result<(), MediaError> {
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(output, b"png").map_err(|err| MediaError::Message(err.to_string()))
        }

        fn detect_scenes(
            &self,
            _input: &Path,
            duration_ms: u64,
        ) -> Result<Vec<crate::media::SceneSpan>, MediaError> {
            Ok(vec![crate::media::SceneSpan {
                start_ms: 0,
                end_ms: duration_ms,
                thumbnail_path: None,
            }])
        }

        fn detect_silence(
            &self,
            _input: &Path,
            _duration_ms: u64,
        ) -> Result<Vec<crate::media::SilenceSpan>, MediaError> {
            Ok(vec![crate::media::SilenceSpan {
                start_ms: 100,
                end_ms: 400,
            }])
        }

        fn extract_speech(&self, _input: &Path, output: &Path) -> Result<(), MediaError> {
            write_pcm16_wav(output, &[0, 1000, 0])
        }

        fn export_video(
            &self,
            _input: &Path,
            output: &Path,
            _duration_ms: u64,
            _has_audio: bool,
            progress: &mut dyn FnMut(f64),
        ) -> Result<(), MediaError> {
            if let Some(parent) = output.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(output, b"export").unwrap();
            progress(1.0);
            Ok(())
        }
    }

    fn scripted_speech() -> crate::speech::ScriptedSpeech {
        crate::speech::ScriptedSpeech {
            text: "I was talking about GTA six".into(),
            start_ms: 12_400,
            end_ms: 15_000,
        }
    }

    fn state() -> (PathBuf, AppState) {
        let root =
            std::env::temp_dir().join(format!("tippy-svc-{}", uuid::Uuid::new_v4().simple()));
        let state = AppState::open(
            root.clone(),
            Box::new(FakeEngine),
            Box::new(scripted_speech()),
        )
        .unwrap();
        (root, state)
    }

    #[test]
    fn import_proxy_waveform_export_and_reopen() {
        let (root, state) = state();
        let source = root.join("clip.mp4");
        std::fs::write(&source, b"original-bytes").unwrap();
        let created = create_project(&state, "Evening stream").unwrap();
        let imported = import_video(&state, &created.project_id, &source).unwrap();
        assert_eq!(imported.jobs.len(), 8);
        assert!(imported
            .jobs
            .iter()
            .any(|job| job.state == JobState::Queued));
        assert!(imported
            .jobs
            .iter()
            .any(|job| job.state == JobState::WaitingForDependency));
        run_pending(&state, &created.project_id, &mut |_project, event| {
            assert!(crate::runtime::event_is_small(event));
        })
        .unwrap();
        let mut project = open_project(&state, &created.project_id).unwrap();
        let media = &project.media[0];
        assert_eq!(media.probe.as_ref().unwrap().width, 320);
        assert!(media.proxy_path.as_ref().unwrap().ends_with("proxy.mp4"));
        assert!(!media.waveform.is_empty());
        assert!(media.waveform.iter().copied().fold(0f32, f32::max) > 0.4);
        assert!(media.thumbnail_path.is_some());
        assert!(!media.scenes.is_empty());
        assert_eq!(media.silences.len(), 1);
        assert_eq!(
            project.transcript.segments[0].text,
            "I was talking about GTA six"
        );
        let (message, hits) = crate::speech::answer_question(
            &project.transcript.segments,
            "Where did I talk about GTA VI?",
        )
        .unwrap();
        assert_eq!(hits[0].start_ms, 12_400);
        assert!(message.contains("0:12"));
        assert_eq!(project.moments.len(), 1);
        assert_eq!(project.moments[0].category, "Gameplay");
        assert!(project.moments[0].quote.to_lowercase().contains("gta"));
        assert!(!project.moments[0].explanation.is_empty());
        assert!(project.moments[0].preview_path.is_some());
        assert!(project.moments[0].end_ms > project.moments[0].start_ms);
        let encoded = serde_json::to_value(&project.moments[0]).unwrap();
        assert!(encoded.get("score").is_none());
        assert!(encoded.get("viralScore").is_none());
        let reply = ask_tippy(&state, Some(&project.project_id), "Find my best clips");
        assert!(reply.handled);
        assert!(!reply.connected);
        assert!(reply.message.contains("Gameplay"));
        assert_eq!(reply.hits[0].start_ms, project.moments[0].start_ms);
        assert!(project
            .jobs
            .iter()
            .all(|job| job.state == JobState::Completed));
        assert!(project
            .tippy_context
            .versions
            .iter()
            .any(|version| version.label == "Scouted moments"));
        assert!(project
            .tippy_context
            .versions
            .iter()
            .any(|version| version.label == "Transcribed video"));
        assert_eq!(std::fs::read(&source).unwrap(), b"original-bytes");
        export_video(&state, &project.project_id, &media.media_id).unwrap();
        run_pending(&state, &project.project_id, &mut |_, _| {}).unwrap();
        project = open_project(&state, &project.project_id).unwrap();
        assert_eq!(project.exports.len(), 1);
        assert!(project
            .tippy_context
            .versions
            .iter()
            .any(|version| version.label == "Exported video"));
        let reopened = AppState::open(
            root.clone(),
            Box::new(FakeEngine),
            Box::new(scripted_speech()),
        )
        .unwrap();
        let again = open_project(&reopened, &project.project_id).unwrap();
        assert_eq!(again.name, "Evening stream");
        assert_eq!(again.media.len(), 1);
        assert_eq!(again.owner_id, reopened.account.owner_id);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn create_four_shorts_stays_local_and_can_be_undone() {
        let (root, state) = state();
        let source = root.join("clip.mp4");
        std::fs::write(&source, b"original-bytes").unwrap();
        let created = create_project(&state, "Shorts").unwrap();
        import_video(&state, &created.project_id, &source).unwrap();
        run_pending(&state, &created.project_id, &mut |_, _| {}).unwrap();
        let reply = ask_tippy(&state, Some(&created.project_id), "Create 4 Shorts");
        assert!(reply.handled);
        assert!(!reply.connected);
        assert_eq!(reply.message, "Tippy is making 1 Short.");
        let queued = open_project(&state, &created.project_id).unwrap();
        let short_jobs: Vec<_> = queued
            .jobs
            .iter()
            .filter(|job| job.job_type == "create_short")
            .collect();
        assert_eq!(short_jobs.len(), 1);
        assert_eq!(short_jobs[0].subject_id, queued.moments[0].moment_id);
        assert_eq!(short_jobs[0].agent, "clip_editor");
        run_pending(&state, &created.project_id, &mut |_, _| {}).unwrap();
        let project = open_project(&state, &created.project_id).unwrap();
        let original = project
            .sequences
            .iter()
            .find(|sequence| sequence.variation == "original")
            .unwrap();
        let tippy = project
            .sequences
            .iter()
            .find(|sequence| sequence.variation == "tippy")
            .unwrap();
        assert_ne!(original.sequence_id, tippy.sequence_id);
        assert_eq!(original.clips.len(), 1);
        assert_eq!(tippy.aspect_ratio, "9:16");
        assert_eq!(tippy.caption_theme, "Bold");
        assert_eq!(tippy.export_preset, "Short 9:16");
        assert!(!tippy.captions.is_empty());
        assert!(tippy.preview_path.as_ref().unwrap().ends_with(".mp4"));
        assert!(tippy
            .changes
            .iter()
            .all(|change| !change.label.to_lowercase().contains("viral")));
        assert!(tippy
            .changes
            .iter()
            .any(|change| change.label.contains("9:16")));
        assert!(project
            .sequences
            .iter()
            .any(|sequence| sequence.name == "Assembly"));
        let again = ask_tippy(&state, Some(&created.project_id), "Create 4 Shorts");
        assert_eq!(again.message, "Those moments already have Shorts.");
        let undone = undo_short_change(&state, &created.project_id, &tippy.sequence_id).unwrap();
        let tippy = undone
            .sequences
            .iter()
            .find(|sequence| sequence.variation == "tippy")
            .unwrap();
        assert!(tippy.export_preset.is_empty());
        assert!(undone
            .jobs
            .iter()
            .any(|job| job.job_type == "refresh_short"));
        run_pending(&state, &created.project_id, &mut |_, _| {}).unwrap();
        accept_short_changes(&state, &created.project_id, &tippy.sequence_id).unwrap();
        export_short(&state, &created.project_id, &tippy.sequence_id).unwrap();
        run_pending(&state, &created.project_id, &mut |_, _| {}).unwrap();
        let exported = open_project(&state, &created.project_id).unwrap();
        assert!(exported
            .exports
            .iter()
            .any(|item| item.sequence_id == tippy.sequence_id));
        assert!(exported
            .tippy_context
            .versions
            .iter()
            .any(|version| version.label == "Created a Short"));
        assert!(exported
            .tippy_context
            .versions
            .iter()
            .any(|version| version.label == "Undid a change"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn interrupted_running_job_retries_after_relaunch() {
        let (root, state) = state();
        let source = root.join("clip.mp4");
        std::fs::write(&source, b"bytes").unwrap();
        let project = create_project(&state, "Crash").unwrap();
        import_video(&state, &project.project_id, &source).unwrap();
        {
            let store = lock(&state.store);
            let mut saved = store.load_project(&project.project_id).unwrap();
            saved.jobs[0].state = JobState::Running;
            store.save_project(&saved, true).unwrap();
        }
        drop(state);
        let relaunched = AppState::open(
            root.clone(),
            Box::new(FakeEngine),
            Box::new(scripted_speech()),
        )
        .unwrap();
        let ids = recover_all(&relaunched);
        assert_eq!(ids, vec![project.project_id.clone()]);
        let recovered = open_project(&relaunched, &project.project_id).unwrap();
        assert!(recovered
            .jobs
            .iter()
            .any(|job| job.state == JobState::Retrying));
        run_pending(&relaunched, &project.project_id, &mut |_, _| {}).unwrap();
        let done = open_project(&relaunched, &project.project_id).unwrap();
        assert!(done.jobs.iter().all(|job| job.state == JobState::Completed));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn killed_writer_keeps_the_last_snapshot() {
        let (root, state) = state();
        let project = create_project(&state, "Autosave").unwrap();
        let dir = root.join("projects").join(&project.project_id);
        std::fs::write(dir.join("project.json"), b"{not-json").unwrap();
        let recovered = lock(&state.store)
            .recover_on_launch(&project.project_id)
            .unwrap();
        assert_eq!(recovered.name, "Autosave");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn real_ffmpeg_import_round_trip() {
        let engine = FfmpegMediaEngine::status();
        assert!(engine.ready, "{}", engine.message);
        let root =
            std::env::temp_dir().join(format!("tippy-real-{}", uuid::Uuid::new_v4().simple()));
        let state = AppState::open(
            root.clone(),
            Box::new(FfmpegMediaEngine),
            Box::new(scripted_speech()),
        )
        .unwrap();
        let source = root.join("bars.mp4");
        crate::media::render_color_bars(&source).unwrap();
        let project = create_project(&state, "Color bars").unwrap();
        import_video(&state, &project.project_id, &source).unwrap();
        run_pending(&state, &project.project_id, &mut |_, _| {}).unwrap();
        let loaded = open_project(&state, &project.project_id).unwrap();
        let media = &loaded.media[0];
        assert!(media.probe.as_ref().unwrap().duration_ms >= 1500);
        assert!(std::path::Path::new(media.proxy_path.as_ref().unwrap()).is_file());
        assert!(media.waveform.iter().any(|peak| *peak > 0.0));
        export_video(&state, &loaded.project_id, &media.media_id).unwrap();
        run_pending(&state, &loaded.project_id, &mut |_, _| {}).unwrap();
        let exported = open_project(&state, &loaded.project_id).unwrap();
        assert!(std::path::Path::new(&exported.exports[0].path).is_file());
        let _ = std::fs::remove_dir_all(root);
    }
}
