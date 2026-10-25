mod account;
mod actions;
mod ai;
mod atomic;
mod editor;
mod error;
mod flags;
mod jobs;
mod log;
mod media;
mod preview;
mod project;
mod runtime;
mod scout;
mod service;
mod shorts;
mod speech;
mod team;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::account::LocalAccount;
use crate::ai::TippyReply;
use crate::flags::FeatureFlags;
use crate::media::EngineStatus;
use crate::project::Project;
use crate::service::{AppState, Workspace};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppMeta {
    schema_version: u32,
    engine: EngineStatus,
    account: LocalAccount,
    flags: FeatureFlags,
    data_dir: String,
    preview_origin: String,
}

#[tauri::command]
fn app_meta(state: State<'_, AppState>) -> AppMeta {
    let data_dir = state
        .store
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .root()
        .display()
        .to_string();
    AppMeta {
        schema_version: project::APP_SCHEMA_VERSION,
        engine: state.engine_status(),
        account: state.account.clone(),
        flags: state.flags.clone(),
        data_dir,
        preview_origin: state.preview_origin.clone(),
    }
}

#[tauri::command]
fn list_workspace(state: State<'_, AppState>) -> Result<Workspace, String> {
    service::workspace(state.inner()).map_err(|err| err.to_string())
}

#[tauri::command]
fn create_project(state: State<'_, AppState>, name: String) -> Result<Project, String> {
    service::create_project(state.inner(), &name).map_err(|err| err.to_string())
}

#[tauri::command]
fn open_project(state: State<'_, AppState>, project_id: String) -> Result<Project, String> {
    service::open_project(state.inner(), &project_id).map_err(|err| err.to_string())
}

#[tauri::command]
async fn pick_video(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Video", &["mp4", "mov", "mkv", "webm", "m4v"])
        .set_title("Import video")
        .blocking_pick_file();
    match picked {
        Some(path) => Ok(Some(
            path.into_path()
                .map_err(|err| err.to_string())?
                .display()
                .to_string(),
        )),
        None => Ok(None),
    }
}

#[tauri::command]
fn import_video(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<Project, String> {
    let project = service::import_video(state.inner(), &project_id, std::path::Path::new(&path))
        .map_err(|err| err.to_string())?;
    kick(&app, &project_id);
    Ok(project)
}

#[tauri::command]
fn export_video(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    media_id: String,
) -> Result<Project, String> {
    let project = service::export_video(state.inner(), &project_id, &media_id)
        .map_err(|err| err.to_string())?;
    kick(&app, &project_id);
    Ok(project)
}

#[tauri::command]
fn cancel_job(
    state: State<'_, AppState>,
    project_id: String,
    job_id: String,
) -> Result<Project, String> {
    service::cancel_job(state.inner(), &project_id, &job_id).map_err(|err| err.to_string())
}

#[tauri::command]
fn pause_job(
    state: State<'_, AppState>,
    project_id: String,
    job_id: String,
) -> Result<Project, String> {
    service::pause_job(state.inner(), &project_id, &job_id).map_err(|err| err.to_string())
}

#[tauri::command]
fn resume_job(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    job_id: String,
) -> Result<Project, String> {
    let project =
        service::resume_job(state.inner(), &project_id, &job_id).map_err(|err| err.to_string())?;
    kick(&app, &project_id);
    Ok(project)
}

#[tauri::command]
fn retry_job(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    job_id: String,
) -> Result<Project, String> {
    let project =
        service::retry_job(state.inner(), &project_id, &job_id).map_err(|err| err.to_string())?;
    kick(&app, &project_id);
    Ok(project)
}

#[tauri::command]
fn submit_tippy(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    project_id: Option<String>,
) -> TippyReply {
    let reply = service::ask_tippy(state.inner(), project_id.as_deref(), &text);
    if reply.handled {
        if let Some(project_id) = project_id.as_deref() {
            kick(&app, project_id);
        }
    }
    reply
}

#[tauri::command]
fn create_short(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    moment_id: String,
) -> Result<Project, String> {
    let project = service::queue_short(state.inner(), &project_id, &moment_id)
        .map_err(|err| err.to_string())?;
    kick(&app, &project_id);
    Ok(project)
}

#[tauri::command]
fn undo_short_change(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    sequence_id: String,
) -> Result<Project, String> {
    let project = service::undo_short_change(state.inner(), &project_id, &sequence_id)
        .map_err(|err| err.to_string())?;
    kick(&app, &project_id);
    Ok(project)
}

#[tauri::command]
fn accept_short_changes(
    state: State<'_, AppState>,
    project_id: String,
    sequence_id: String,
) -> Result<Project, String> {
    service::accept_short_changes(state.inner(), &project_id, &sequence_id)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn edit_timeline(
    state: State<'_, AppState>,
    project_id: String,
    edit: editor::TimelineEdit,
) -> Result<Project, String> {
    service::edit_timeline(state.inner(), &project_id, edit).map_err(|err| err.to_string())
}

#[tauri::command]
fn export_short(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    sequence_id: String,
) -> Result<Project, String> {
    let project = service::export_short(state.inner(), &project_id, &sequence_id)
        .map_err(|err| err.to_string())?;
    kick(&app, &project_id);
    Ok(project)
}

fn kick(app: &AppHandle, project_id: &str) {
    let app = app.clone();
    let project_id = project_id.to_string();
    std::thread::spawn(move || {
        let state = app.state::<AppState>();
        let gate = drain_gate(&project_id);
        let _guard = gate.lock().unwrap_or_else(|err| err.into_inner());
        let emitter = app.clone();
        let _ = service::run_pending(state.inner(), &project_id, &mut |_project, event| {
            let _ = emitter.emit("tippy-event", event.clone());
        });
    });
}

fn drain_gate(project_id: &str) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let gates = GATES.get_or_init(|| Mutex::new(HashMap::new()));
    let mut map = gates.lock().unwrap_or_else(|err| err.into_inner());
    map.entry(project_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn data_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Ok(path) = std::env::var("TIPPY_DATA_DIR") {
        if !path.trim().is_empty() {
            return Ok(PathBuf::from(path));
        }
    }
    Ok(app.path().app_data_dir()?)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = data_dir(app)?;
            let mut state = AppState::open(
                dir.clone(),
                Box::new(media::FfmpegMediaEngine),
                Box::new(speech::WhisperCli::discover()),
            )?;
            match preview::serve(dir) {
                Ok(origin) => {
                    log::log_line(&state.log_path, "info", &format!("preview server {origin}"));
                    state.preview_origin = origin;
                }
                Err(err) => {
                    log::log_line(
                        &state.log_path,
                        "error",
                        &format!("preview server failed: {err}"),
                    );
                }
            }
            let status = state.engine_status();
            log::log_line(&state.log_path, "info", &status.message);
            let ids = service::recover_all(&state);
            app.manage(state);
            for id in ids {
                kick(app.handle(), &id);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_meta,
            list_workspace,
            create_project,
            open_project,
            pick_video,
            import_video,
            export_video,
            cancel_job,
            pause_job,
            resume_job,
            retry_job,
            submit_tippy,
            create_short,
            undo_short_change,
            accept_short_changes,
            export_short,
            edit_timeline
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tippy Desktop");
}
