use std::fs;
use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ai::PrivacyMode;
use crate::atomic::write_json;
use crate::error::{DesktopError, DesktopResult};
use crate::jobs::Job;
use crate::media::ProbeInfo;

pub const APP_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub media_id: String,
    pub original_path: String,
    pub file_name: String,
    pub proxy_path: Option<String>,
    pub audio_path: Option<String>,
    pub thumbnail_path: Option<String>,
    pub waveform: Vec<f32>,
    pub probe: Option<ProbeInfo>,
    pub imported_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SequenceClip {
    pub media_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sequence {
    pub sequence_id: String,
    pub name: String,
    pub clips: Vec<SequenceClip>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionRecord {
    pub action_id: String,
    pub action: String,
    pub project_id: String,
    pub created_at: String,
    pub payload: Value,
    pub requires_approval: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportRecord {
    pub export_id: String,
    pub media_id: String,
    pub path: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
    pub version_id: String,
    pub label: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TippyContext {
    pub privacy_mode: PrivacyMode,
    #[serde(default)]
    pub versions: Vec<VersionEntry>,
}

impl Default for TippyContext {
    fn default() -> Self {
        Self {
            privacy_mode: PrivacyMode::LocalFirst,
            versions: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub project_id: String,
    pub name: String,
    pub owner_id: String,
    pub created_at: String,
    pub updated_at: String,
    pub media: Vec<MediaAsset>,
    pub sequences: Vec<Sequence>,
    pub transcript: Value,
    pub moments: Vec<Value>,
    pub jobs: Vec<Job>,
    pub actions: Vec<ActionRecord>,
    pub exports: Vec<ExportRecord>,
    pub brand_profile: Value,
    pub tippy_context: TippyContext,
}

impl Project {
    pub fn create(name: &str, owner_id: &str) -> Self {
        let now = now_iso();
        Self {
            schema_version: APP_SCHEMA_VERSION,
            project_id: new_id("proj"),
            name: name.trim().to_string(),
            owner_id: owner_id.to_string(),
            created_at: now.clone(),
            updated_at: now,
            media: Vec::new(),
            sequences: Vec::new(),
            transcript: serde_json::json!({}),
            moments: Vec::new(),
            jobs: Vec::new(),
            actions: Vec::new(),
            exports: Vec::new(),
            brand_profile: serde_json::json!({}),
            tippy_context: TippyContext::default(),
        }
    }

    pub fn touch(&mut self) {
        self.updated_at = now_iso();
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

pub fn migrate(document: Value) -> DesktopResult<Value> {
    let version = document
        .get("schemaVersion")
        .and_then(Value::as_u64)
        .ok_or_else(|| DesktopError::Message("project is missing schemaVersion".into()))?
        as u32;
    if version > APP_SCHEMA_VERSION {
        return Err(DesktopError::NewerThanApp {
            found: version,
            supported: APP_SCHEMA_VERSION,
        });
    }
    let mut current = version;
    let mut doc = document;
    while current < APP_SCHEMA_VERSION {
        doc = apply_migration_step(current, doc)?;
        current += 1;
        if let Some(object) = doc.as_object_mut() {
            object.insert("schemaVersion".into(), Value::from(current));
        }
    }
    Ok(doc)
}

fn apply_migration_step(from: u32, _document: Value) -> DesktopResult<Value> {
    Err(DesktopError::NoMigration { from })
}

pub fn parse_project_bytes(bytes: &[u8]) -> DesktopResult<Project> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| DesktopError::Corrupt)?;
    let migrated = migrate(value)?;
    serde_json::from_value(migrated)
        .map_err(|err| DesktopError::Message(format!("project does not match the schema: {err}")))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCard {
    pub project_id: String,
    pub name: String,
    pub updated_at: String,
    pub media_count: usize,
    pub error: Option<String>,
}

pub struct ProjectStore {
    root: PathBuf,
}

impl ProjectStore {
    pub fn new(root: PathBuf) -> DesktopResult<Self> {
        fs::create_dir_all(root.join("projects"))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn project_dir(&self, project_id: &str) -> DesktopResult<PathBuf> {
        if !is_safe_id(project_id) {
            return Err(DesktopError::Message("invalid project id".into()));
        }
        Ok(self.root.join("projects").join(project_id))
    }

    pub fn list_ids(&self) -> DesktopResult<Vec<String>> {
        let projects = self.root.join("projects");
        if !projects.exists() {
            return Ok(Vec::new());
        }
        let mut ids = Vec::new();
        for entry in fs::read_dir(projects)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if is_safe_id(&name) {
                ids.push(name);
            }
        }
        ids.sort();
        Ok(ids)
    }

    pub fn create_project(&self, name: &str, owner_id: &str) -> DesktopResult<Project> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(DesktopError::Message("project name is required".into()));
        }
        if trimmed.chars().count() > 80 {
            return Err(DesktopError::Message(
                "project name must be 80 characters or fewer".into(),
            ));
        }
        let project = Project::create(trimmed, owner_id);
        let dir = self.project_dir(&project.project_id)?;
        fs::create_dir_all(dir.join("snapshots"))?;
        fs::create_dir_all(dir.join("derived"))?;
        self.save_project(&project, true)?;
        Ok(project)
    }

    pub fn load_project(&self, project_id: &str) -> DesktopResult<Project> {
        self.read_best(project_id, false)
    }

    pub fn recover_on_launch(&self, project_id: &str) -> DesktopResult<Project> {
        let mut project = self.read_best(project_id, true)?;
        if crate::runtime::settle_interrupted(&mut project) {
            project.touch();
            self.save_project(&project, true)?;
        }
        Ok(project)
    }

    pub fn save_project(&self, project: &Project, snapshot: bool) -> DesktopResult<()> {
        if project.schema_version > APP_SCHEMA_VERSION {
            return Err(DesktopError::NewerThanApp {
                found: project.schema_version,
                supported: APP_SCHEMA_VERSION,
            });
        }
        let dir = self.project_dir(&project.project_id)?;
        fs::create_dir_all(dir.join("snapshots"))?;
        write_json(&dir.join("project.json"), project)?;
        if snapshot {
            self.write_snapshot(&dir, project)?;
        }
        Ok(())
    }

    fn read_best(&self, project_id: &str, restore_snapshot: bool) -> DesktopResult<Project> {
        let dir = self.project_dir(project_id)?;
        let main = dir.join("project.json");
        if main.exists() {
            let bytes = fs::read(&main)?;
            match parse_project_bytes(&bytes) {
                Ok(project) => return Ok(project),
                Err(DesktopError::NewerThanApp { found, supported }) => {
                    return Err(DesktopError::NewerThanApp { found, supported });
                }
                Err(_) => {}
            }
        }
        let project = self.latest_snapshot(&dir)?;
        if restore_snapshot || !main.exists() {
            if main.exists() {
                let quarantine = dir.join(format!("corrupt-{}.json", timestamp_ms()));
                let _ = fs::rename(&main, quarantine);
            }
            write_json(&main, &project)?;
        }
        Ok(project)
    }

    fn latest_snapshot(&self, dir: &Path) -> DesktopResult<Project> {
        let snapshots = dir.join("snapshots");
        if !snapshots.exists() {
            return Err(DesktopError::Unrecoverable);
        }
        let mut files: Vec<PathBuf> = fs::read_dir(&snapshots)?
            .filter_map(|entry| entry.ok().map(|item| item.path()))
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .collect();
        files.sort();
        for path in files.iter().rev() {
            let Ok(bytes) = fs::read(path) else {
                continue;
            };
            if let Ok(project) = parse_project_bytes(&bytes) {
                return Ok(project);
            }
        }
        Err(DesktopError::Unrecoverable)
    }

    fn write_snapshot(&self, dir: &Path, project: &Project) -> DesktopResult<()> {
        let snapshots = dir.join("snapshots");
        fs::create_dir_all(&snapshots)?;
        let mut name = format!("{}.json", timestamp_ms());
        let mut path = snapshots.join(&name);
        let mut salt = 0u32;
        while path.exists() {
            salt += 1;
            name = format!("{}-{salt}.json", timestamp_ms());
            path = snapshots.join(&name);
        }
        write_json(&path, project)?;
        let mut files: Vec<PathBuf> = fs::read_dir(&snapshots)?
            .filter_map(|entry| entry.ok().map(|item| item.path()))
            .filter(|item| item.extension().and_then(|ext| ext.to_str()) == Some("json"))
            .collect();
        files.sort();
        let overflow = files.len().saturating_sub(20);
        for stale in files.into_iter().take(overflow) {
            let _ = fs::remove_file(stale);
        }
        Ok(())
    }
}

pub trait StateStore {
    fn root(&self) -> &Path;
    fn load_project(&self, project_id: &str) -> DesktopResult<Project>;
    fn save_project(&self, project: &Project, snapshot: bool) -> DesktopResult<()>;
    fn list_ids(&self) -> DesktopResult<Vec<String>>;
}

impl StateStore for ProjectStore {
    fn root(&self) -> &Path {
        &self.root
    }

    fn load_project(&self, project_id: &str) -> DesktopResult<Project> {
        ProjectStore::load_project(self, project_id)
    }

    fn save_project(&self, project: &Project, snapshot: bool) -> DesktopResult<()> {
        ProjectStore::save_project(self, project, snapshot)
    }

    fn list_ids(&self) -> DesktopResult<Vec<String>> {
        ProjectStore::list_ids(self)
    }
}

fn is_safe_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_') && id.len() <= 80
}

fn timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::JobState;

    fn store() -> (PathBuf, ProjectStore) {
        let dir =
            std::env::temp_dir().join(format!("tippy-project-{}", uuid::Uuid::new_v4().simple()));
        let store = ProjectStore::new(dir.clone()).unwrap();
        (dir, store)
    }

    #[test]
    fn project_json_uses_the_section_23_keys() {
        let project = Project::create("Stream", "owner_1");
        let value = serde_json::to_value(&project).unwrap();
        let mut keys: Vec<_> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "actions",
                "brandProfile",
                "createdAt",
                "exports",
                "jobs",
                "media",
                "moments",
                "name",
                "ownerId",
                "projectId",
                "schemaVersion",
                "sequences",
                "tippyContext",
                "transcript",
                "updatedAt",
            ]
        );
        assert_eq!(value["schemaVersion"], 1);
        assert_eq!(value["transcript"], serde_json::json!({}));
        assert_eq!(value["brandProfile"], serde_json::json!({}));
    }

    #[test]
    fn newer_schema_fails_closed_without_rewriting() {
        let (dir, store) = store();
        let project = store.create_project("Keep", "owner_1").unwrap();
        let path = store
            .project_dir(&project.project_id)
            .unwrap()
            .join("project.json");
        let original = fs::read(&path).unwrap();
        let mut value: Value = serde_json::from_slice(&original).unwrap();
        value["schemaVersion"] = Value::from(2);
        fs::write(&path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        let err = store.load_project(&project.project_id).unwrap_err();
        assert!(matches!(
            err,
            DesktopError::NewerThanApp {
                found: 2,
                supported: 1
            }
        ));
        let err = migrate(value).unwrap_err();
        assert!(matches!(err, DesktopError::NewerThanApp { found: 2, .. }));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn current_schema_does_not_invent_a_migration() {
        let project = Project::create("Now", "owner_1");
        let value = serde_json::to_value(&project).unwrap();
        let migrated = migrate(value.clone()).unwrap();
        assert_eq!(migrated["schemaVersion"], 1);
        let err = apply_migration_step(1, value).unwrap_err();
        assert!(matches!(err, DesktopError::NoMigration { from: 1 }));
    }

    #[test]
    fn corrupt_project_file_recovers_the_last_snapshot() {
        let (dir, store) = store();
        let mut project = store.create_project("Recover me", "owner_1").unwrap();
        project.name = "Recover me".into();
        store.save_project(&project, true).unwrap();
        let main = store
            .project_dir(&project.project_id)
            .unwrap()
            .join("project.json");
        fs::write(&main, b"{\"schemaVersion\":1, \"torn\":").unwrap();
        let loaded = store.recover_on_launch(&project.project_id).unwrap();
        assert_eq!(loaded.name, "Recover me");
        assert_eq!(loaded.project_id, project.project_id);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn running_jobs_are_retried_on_launch() {
        let (dir, store) = store();
        let mut project = store.create_project("Jobs", "owner_1").unwrap();
        project.jobs.push(Job {
            job_id: "job_1".into(),
            project_id: project.project_id.clone(),
            job_type: "create_proxy".into(),
            agent: "media_analyst".into(),
            state: JobState::Running,
            progress: 0.4,
            dependencies: Vec::new(),
            created_at: now_iso(),
            started_at: Some(now_iso()),
            completed_at: None,
            error: None,
            media_id: "media_1".into(),
            message: "Writing proxy".into(),
        });
        store.save_project(&project, true).unwrap();
        let recovered = store.recover_on_launch(&project.project_id).unwrap();
        assert_eq!(recovered.jobs[0].state, JobState::Retrying);
        let again = store.load_project(&project.project_id).unwrap();
        assert_eq!(again.jobs[0].state, JobState::Retrying);
        let _ = fs::remove_dir_all(dir);
    }
}
