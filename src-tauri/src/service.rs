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

pub struct AppState {
    pub store: Mutex<ProjectStore>,
    pub engine: Box<dyn MediaEngine>,
    pub meter: Mutex<CostMeter>,
    pub flags: FeatureFlags,
    pub account: LocalAccount,
    pub log_path: PathBuf,
    pub cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub preview_origin: String,
}

impl AppState {
    pub fn open(root: PathBuf, engine: Box<dyn MediaEngine>) -> DesktopResult<Self> {
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
        Ok(Self {
            store: Mutex::new(store),
            engine,
            meter: Mutex::new(meter),
            flags,
            account,
            log_path,
            cancels: Mutex::new(HashMap::new()),
            preview_origin: String::new(),
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
    jobs.sort_by(|left, right| right.job_id.cmp(&left.job_id));
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
    });
    project.sequences.push(Sequence {
        sequence_id: new_id("seq"),
        name: "Assembly".into(),
        clips: vec![SequenceClip {
            media_id: media_id.clone(),
            start_ms: 0,
            end_ms: 0,
        }],
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
        let claimed = match claim_next(state, project_id) {
            Ok(Some(claimed)) => claimed,
            Ok(None) => break,
            Err(err) => return Err(err.to_string()),
        };
        publish(state, project_id, &claimed.job_id, on_update);
        let started = Instant::now();
        let outcome = crate::media::with_cancel(claimed.cancel.clone(), || {
            execute(state, project_id, &claimed, on_update)
        });
        finalize(
            state,
            project_id,
            &claimed,
            outcome,
            started.elapsed().as_secs_f64() * 1000.0,
        );
        publish(state, project_id, &claimed.job_id, on_update);
    }
    Ok(())
}

fn claim_next(state: &AppState, project_id: &str) -> DesktopResult<Option<Claimed>> {
    let store = lock(&state.store);
    let mut project = store.load_project(project_id)?;
    let changed = refresh_dependency_states(&mut project.jobs);
    let Some(index) = crate::runtime::next_runnable(&project.jobs) else {
        if changed {
            project.touch();
            store.save_project(&project, true)?;
        }
        return Ok(None);
    };
    let media_id = project.jobs[index].media_id.clone();
    let job_id = project.jobs[index].job_id.clone();
    let job_type = project.jobs[index].job_type.clone();
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
    if cancel.load(Ordering::Relaxed) {
        project.jobs[index].state = JobState::Cancelled;
        project.jobs[index].message = "Cancelled".into();
        project.jobs[index].completed_at = Some(now_iso());
        project.touch();
        store.save_project(&project, true)?;
        return Ok(None);
    }
    project.jobs[index].state = JobState::Running;
    project.jobs[index].started_at = Some(now_iso());
    project.jobs[index].message = running_message(&job_type).into();
    project.touch();
    store.save_project(&project, true)?;
    Ok(Some(Claimed {
        job_id,
        job_type,
        media_id,
        input,
        duration_ms,
        has_audio,
        cancel,
    }))
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
            Ok(Execution::Export(output))
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
    Export(PathBuf),
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
                    if clip.media_id == media_id {
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
        Execution::Export(path) => {
            project.exports.push(ExportRecord {
                export_id: new_id("exp"),
                media_id: media_id.into(),
                path: path.display().to_string(),
                created_at: now_iso(),
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

    fn state() -> (PathBuf, AppState) {
        let root =
            std::env::temp_dir().join(format!("tippy-svc-{}", uuid::Uuid::new_v4().simple()));
        let state = AppState::open(root.clone(), Box::new(FakeEngine)).unwrap();
        (root, state)
    }

    #[test]
    fn import_proxy_waveform_export_and_reopen() {
        let (root, state) = state();
        let source = root.join("clip.mp4");
        std::fs::write(&source, b"original-bytes").unwrap();
        let created = create_project(&state, "Evening stream").unwrap();
        let imported = import_video(&state, &created.project_id, &source).unwrap();
        assert_eq!(imported.jobs.len(), 4);
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
        assert!(project
            .jobs
            .iter()
            .all(|job| job.state == JobState::Completed));
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
        let reopened = AppState::open(root.clone(), Box::new(FakeEngine)).unwrap();
        let again = open_project(&reopened, &project.project_id).unwrap();
        assert_eq!(again.name, "Evening stream");
        assert_eq!(again.media.len(), 1);
        assert_eq!(again.owner_id, reopened.account.owner_id);
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
        let relaunched = AppState::open(root.clone(), Box::new(FakeEngine)).unwrap();
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
        let state = AppState::open(root.clone(), Box::new(FfmpegMediaEngine)).unwrap();
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
