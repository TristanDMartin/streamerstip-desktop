use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::actions;
use crate::ai::PrivacyMode;
use crate::atomic::write_json;
use crate::error::{DesktopError, DesktopResult};
use crate::jobs::{dependencies_failed, dependencies_satisfied, Job, JobState};
use crate::project::{new_id, now_iso, Project, VersionEntry};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextSnapshot {
    pub project_id: String,
    pub owner_id: String,
    pub privacy_mode: PrivacyMode,
    pub media_ids: Vec<String>,
    pub moment_count: usize,
}

pub fn capture_context(project: &Project) -> ContextSnapshot {
    ContextSnapshot {
        project_id: project.project_id.clone(),
        owner_id: project.owner_id.clone(),
        privacy_mode: project.tippy_context.privacy_mode,
        media_ids: project
            .media
            .iter()
            .map(|media| media.media_id.clone())
            .collect(),
        moment_count: project.moments.len(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskNode {
    pub key: String,
    pub action_id: String,
    pub agent: String,
    pub depends_on: Vec<String>,
    pub subject_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanError {
    NotConnected,
}

pub fn plan_import() -> Vec<TaskNode> {
    vec![
        node("probe", "probe_media", "media_analyst", vec![]),
        node("proxy", "create_proxy", "media_analyst", vec!["probe"]),
        node("audio", "extract_audio", "media_analyst", vec!["probe"]),
        node("thumb", "create_thumbnail", "media_analyst", vec!["probe"]),
        node("silence", "detect_silence", "media_analyst", vec!["audio"]),
        node("scenes", "detect_scenes", "media_analyst", vec!["probe"]),
        node(
            "transcript",
            "transcribe_media",
            "transcript_agent",
            vec!["audio"],
        ),
        node(
            "moments",
            "scout_moments",
            "moment_scout",
            vec!["transcript", "scenes", "silence"],
        ),
    ]
}

pub fn plan_export() -> Vec<TaskNode> {
    vec![node("export", "create_export", "media_analyst", vec![])]
}

pub fn plan_shorts(moment_ids: &[String]) -> Vec<TaskNode> {
    let mut nodes: Vec<TaskNode> = moment_ids
        .iter()
        .enumerate()
        .map(|(index, moment_id)| TaskNode {
            key: format!("short-{index}"),
            action_id: "create_short".into(),
            agent: "clip_editor".into(),
            depends_on: Vec::new(),
            subject_id: moment_id.clone(),
        })
        .collect();
    if nodes.is_empty() {
        return nodes;
    }
    let short_keys: Vec<String> = nodes.iter().map(|node| node.key.clone()).collect();
    nodes.push(TaskNode {
        key: "package".into(),
        action_id: "package_content".into(),
        agent: "packaging_agent".into(),
        depends_on: short_keys,
        subject_id: String::new(),
    });
    nodes.push(TaskNode {
        key: "qa".into(),
        action_id: "qa_content".into(),
        agent: "qa_agent".into(),
        depends_on: vec!["package".into()],
        subject_id: String::new(),
    });
    nodes
}

pub fn plan_short_followup(action_id: &str, sequence_id: &str) -> Vec<TaskNode> {
    vec![TaskNode {
        key: action_id.into(),
        action_id: action_id.into(),
        agent: "clip_editor".into(),
        depends_on: Vec::new(),
        subject_id: sequence_id.into(),
    }]
}

pub fn parallel_limit() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(1)
        .clamp(1, 4)
}

pub fn runnable_batch(jobs: &[Job], limit: usize) -> Vec<usize> {
    let runnable: Vec<usize> = jobs
        .iter()
        .enumerate()
        .filter(|(_, job)| job.state.is_runnable() && dependencies_satisfied(jobs, job))
        .map(|(index, _)| index)
        .collect();
    let Some(first) = runnable.first().copied() else {
        return Vec::new();
    };
    if jobs[first].job_type != "create_short" {
        return vec![first];
    }
    let cap = limit.max(1);
    runnable
        .into_iter()
        .filter(|index| jobs[*index].job_type == "create_short")
        .take(cap)
        .collect()
}

pub fn plan_goal(_goal: &str) -> Result<Vec<TaskNode>, PlanError> {
    Err(PlanError::NotConnected)
}

fn node(key: &str, action_id: &str, agent: &str, depends_on: Vec<&str>) -> TaskNode {
    TaskNode {
        key: key.into(),
        action_id: action_id.into(),
        agent: agent.into(),
        depends_on: depends_on.into_iter().map(str::to_string).collect(),
        subject_id: String::new(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    Allowed,
    NeedsApproval,
    Denied,
}

pub fn authorize(action_id: &str, privacy: PrivacyMode) -> (PermissionDecision, String) {
    let Some(action) = actions::find(action_id) else {
        return (
            PermissionDecision::Denied,
            format!("unknown action {action_id}"),
        );
    };
    if privacy == PrivacyMode::LocalFirst && !action.local_capable {
        return (
            PermissionDecision::Denied,
            "Local-only privacy mode refused a cloud action.".into(),
        );
    }
    if action.requires_approval {
        return (
            PermissionDecision::NeedsApproval,
            "This action waits for creator approval.".into(),
        );
    }
    (PermissionDecision::Allowed, String::new())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDefinition {
    pub id: &'static str,
    pub role: &'static str,
    pub responsibility: &'static str,
}

pub const WORKERS: &[WorkerDefinition] = &[
    WorkerDefinition {
        id: "media_analyst",
        role: "Media Analyst",
        responsibility: "Metadata, proxies, audio levels, thumbnails",
    },
    WorkerDefinition {
        id: "transcript_agent",
        role: "Transcript Agent",
        responsibility: "Local speech-to-text, timestamps, and transcript search",
    },
    WorkerDefinition {
        id: "moment_scout",
        role: "Moment Scout",
        responsibility: "Local moment shortlist from the transcript, scenes, and silence",
    },
    WorkerDefinition {
        id: "clip_editor",
        role: "Clip Editor",
        responsibility: "Builds draft Shorts on this machine",
    },
    WorkerDefinition {
        id: "packaging_agent",
        role: "Packaging Agent",
        responsibility: "Writes a title and hook on this machine. Nothing is published.",
    },
    WorkerDefinition {
        id: "qa_agent",
        role: "QA Agent",
        responsibility: "Checks that a Short is vertical, captioned, and ready to review.",
    },
];

#[derive(Debug, Clone, Copy)]
pub struct ToolDefinition {
    pub id: &'static str,
    pub engine_method: &'static str,
    pub agent: &'static str,
}

pub fn tools() -> &'static [ToolDefinition] {
    &[
        ToolDefinition {
            id: "probe_media",
            engine_method: "probe",
            agent: "media_analyst",
        },
        ToolDefinition {
            id: "create_proxy",
            engine_method: "create_proxy",
            agent: "media_analyst",
        },
        ToolDefinition {
            id: "extract_audio",
            engine_method: "extract_audio",
            agent: "media_analyst",
        },
        ToolDefinition {
            id: "trim_clip",
            engine_method: "trim",
            agent: "clip_editor",
        },
        ToolDefinition {
            id: "render_sequence",
            engine_method: "render_sequence",
            agent: "clip_editor",
        },
        ToolDefinition {
            id: "create_thumbnail",
            engine_method: "create_thumbnail",
            agent: "media_analyst",
        },
        ToolDefinition {
            id: "create_export",
            engine_method: "export_video",
            agent: "media_analyst",
        },
        ToolDefinition {
            id: "detect_silence",
            engine_method: "detect_silence",
            agent: "media_analyst",
        },
        ToolDefinition {
            id: "detect_scenes",
            engine_method: "detect_scenes",
            agent: "media_analyst",
        },
        ToolDefinition {
            id: "transcribe_media",
            engine_method: "transcribe",
            agent: "transcript_agent",
        },
        ToolDefinition {
            id: "scout_moments",
            engine_method: "scout_moments",
            agent: "moment_scout",
        },
        ToolDefinition {
            id: "create_short",
            engine_method: "render_short",
            agent: "clip_editor",
        },
        ToolDefinition {
            id: "export_short",
            engine_method: "render_short",
            agent: "clip_editor",
        },
        ToolDefinition {
            id: "package_content",
            engine_method: "package_content",
            agent: "packaging_agent",
        },
        ToolDefinition {
            id: "qa_content",
            engine_method: "qa_content",
            agent: "qa_agent",
        },
    ]
}

pub fn record_version(project: &mut Project, label: &str) {
    project.tippy_context.versions.push(VersionEntry {
        version_id: new_id("ver"),
        label: label.into(),
        created_at: now_iso(),
    });
}

pub fn settle_interrupted(project: &mut Project) -> bool {
    let mut changed = false;
    for job in &mut project.jobs {
        if job.state == JobState::Running {
            job.state = JobState::Retrying;
            job.error = None;
            job.message = "Interrupted. Retrying.".into();
            changed = true;
        }
    }
    changed
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CostEntry {
    pub project_id: String,
    pub kind: String,
    pub amount: f64,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CostLedger {
    pub entries: Vec<CostEntry>,
}

pub struct CostMeter {
    path: std::path::PathBuf,
}

impl CostMeter {
    pub fn open(path: std::path::PathBuf) -> DesktopResult<Self> {
        if !path.exists() {
            write_json(&path, &CostLedger::default())?;
        }
        Ok(Self { path })
    }

    pub fn record(&self, entry: CostEntry) -> DesktopResult<()> {
        let mut ledger = self.load()?;
        ledger.entries.push(entry);
        write_json(&self.path, &ledger)?;
        Ok(())
    }

    pub fn total(&self, kind: &str) -> DesktopResult<f64> {
        let ledger = self.load()?;
        Ok(ledger
            .entries
            .iter()
            .filter(|entry| entry.kind == kind)
            .map(|entry| entry.amount)
            .sum())
    }

    fn load(&self) -> DesktopResult<CostLedger> {
        if !self.path.exists() {
            return Ok(CostLedger::default());
        }
        let bytes = fs::read(&self.path)?;
        serde_json::from_slice(&bytes)
            .map_err(|err| DesktopError::Message(format!("cost meter is invalid: {err}")))
    }
}

pub struct Orchestrator;

impl Orchestrator {
    pub fn enqueue(
        &self,
        project: &mut Project,
        media_id: &str,
        nodes: &[TaskNode],
    ) -> Vec<String> {
        let context = capture_context(project);
        let mut key_to_id: HashMap<String, String> = HashMap::new();
        for node in nodes {
            key_to_id.insert(node.key.clone(), new_id("job"));
        }
        let mut created = Vec::new();
        for node in nodes {
            let job_id = key_to_id[&node.key].clone();
            let dependencies: Vec<String> = node
                .depends_on
                .iter()
                .filter_map(|key| key_to_id.get(key).cloned())
                .collect();
            let (decision, reason) = authorize(&node.action_id, context.privacy_mode);
            let (state, error, message) = match decision {
                PermissionDecision::Allowed => {
                    let state = if dependencies.is_empty() {
                        JobState::Queued
                    } else {
                        JobState::WaitingForDependency
                    };
                    (state, None, String::new())
                }
                PermissionDecision::NeedsApproval => (JobState::WaitingForUser, None, reason),
                PermissionDecision::Denied => (JobState::Failed, Some(reason.clone()), reason),
            };
            project.jobs.push(Job {
                job_id: job_id.clone(),
                project_id: project.project_id.clone(),
                job_type: node.action_id.clone(),
                agent: node.agent.clone(),
                state,
                progress: 0.0,
                dependencies,
                created_at: now_iso(),
                started_at: None,
                completed_at: None,
                error,
                media_id: media_id.to_string(),
                message,
                subject_id: node.subject_id.clone(),
                explanation: crate::team::explanation_for(&node.action_id).into(),
            });
            created.push(job_id);
        }
        project.touch();
        let _ = context.owner_id;
        created
    }
}

pub fn refresh_dependency_states(jobs: &mut [Job]) -> bool {
    let snapshot = jobs.to_vec();
    let mut changed = false;
    for job in jobs.iter_mut() {
        if job.state != JobState::WaitingForDependency && !job.state.is_runnable() {
            continue;
        }
        if dependencies_failed(&snapshot, job) && !job.state.is_terminal() {
            job.state = JobState::Failed;
            job.error = Some("A required step failed.".into());
            job.completed_at = Some(now_iso());
            changed = true;
            continue;
        }
        if job.state == JobState::WaitingForDependency && dependencies_satisfied(&snapshot, job) {
            job.state = JobState::Ready;
            changed = true;
        }
    }
    changed
}

pub fn next_runnable(jobs: &[Job]) -> Option<usize> {
    jobs.iter()
        .position(|job| job.state.is_runnable() && dependencies_satisfied(jobs, job))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BusEvent {
    pub kind: String,
    pub project_id: String,
    pub job_id: Option<String>,
    pub state: Option<String>,
    pub progress: Option<f64>,
    pub message: String,
}

impl BusEvent {
    pub fn job(project_id: &str, job: &Job) -> Self {
        Self {
            kind: "job_updated".into(),
            project_id: project_id.into(),
            job_id: Some(job.job_id.clone()),
            state: Some(job.state.as_str().into()),
            progress: Some(job.progress),
            message: job.message.clone(),
        }
    }
}

pub fn event_is_small(event: &BusEvent) -> bool {
    serde_json::to_vec(event)
        .map(|bytes| bytes.len() < 800)
        .unwrap_or(false)
}

pub fn record_action(project: &mut Project, action: &str, payload: Value) {
    project.actions.push(crate::project::ActionRecord {
        action_id: new_id("act"),
        action: action.into(),
        project_id: project.project_id.clone(),
        created_at: now_iso(),
        payload,
        requires_approval: false,
    });
}

pub fn derived_dir(root: &Path, project_id: &str, media_id: &str) -> std::path::PathBuf {
    root.join("projects")
        .join(project_id)
        .join("derived")
        .join(media_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::PrivacyMode;
    use crate::project::Project;

    #[test]
    fn import_plan_runs_probe_before_derivatives() {
        let plan = plan_import();
        assert_eq!(plan[0].action_id, "probe_media");
        assert!(plan[1].depends_on.contains(&"probe".into()));
        let scout = plan
            .iter()
            .find(|node| node.action_id == "scout_moments")
            .unwrap();
        assert!(scout.depends_on.contains(&"transcript".into()));
        assert!(scout.depends_on.contains(&"scenes".into()));
        assert!(scout.depends_on.contains(&"silence".into()));
        assert!(plan_goal("make shorts").is_err());
        let (scouted, _) = authorize("scout_moments", PrivacyMode::LocalFirst);
        assert_eq!(scouted, PermissionDecision::Allowed);
    }

    #[test]
    fn local_only_refuses_a_cloud_action() {
        let project = Project::create("Local", "owner_1");
        let (decision, _) = authorize("reframe_subject", project.tippy_context.privacy_mode);
        assert_eq!(decision, PermissionDecision::Denied);
        let (allowed, _) = authorize("create_proxy", PrivacyMode::LocalFirst);
        assert_eq!(allowed, PermissionDecision::Allowed);
        let (short, _) = authorize("create_short", PrivacyMode::LocalFirst);
        assert_eq!(short, PermissionDecision::Allowed);
    }

    #[test]
    fn short_jobs_batch_up_to_the_machine_cap() {
        fn queued(id: &str, job_type: &str) -> Job {
            Job {
                job_id: id.into(),
                project_id: "proj_1".into(),
                job_type: job_type.into(),
                agent: "clip_editor".into(),
                state: JobState::Queued,
                progress: 0.0,
                dependencies: Vec::new(),
                created_at: now_iso(),
                started_at: None,
                completed_at: None,
                error: None,
                media_id: "media_1".into(),
                message: String::new(),
                subject_id: id.into(),
                explanation: String::new(),
            }
        }
        let shorts: Vec<_> = (0..6)
            .map(|index| queued(&format!("s{index}"), "create_short"))
            .collect();
        assert_eq!(runnable_batch(&shorts, 4).len(), 4);
        assert_eq!(runnable_batch(&shorts, 2).len(), 2);
        let mut mixed = vec![queued("probe", "probe_media")];
        mixed.extend(shorts);
        assert_eq!(runnable_batch(&mixed, 4), vec![0]);
        assert!(parallel_limit() >= 1 && parallel_limit() <= 4);
        let plan = plan_shorts(&["moment_a".into(), "moment_b".into()]);
        assert_eq!(plan.len(), 4);
        assert!(plan[..2].iter().all(|node| node.depends_on.is_empty()));
        assert_eq!(plan[1].subject_id, "moment_b");
        assert_eq!(plan[2].action_id, "package_content");
        assert_eq!(plan[2].agent, "packaging_agent");
        assert_eq!(
            plan[2].depends_on,
            vec!["short-0".to_string(), "short-1".to_string()]
        );
        assert_eq!(plan[3].action_id, "qa_content");
        assert_eq!(plan[3].depends_on, vec!["package".to_string()]);
    }

    #[test]
    fn workers_are_data_records() {
        assert_eq!(WORKERS.len(), 6);
        assert!(tools()
            .iter()
            .any(|tool| tool.engine_method == "export_video"));
        let encoded = serde_json::to_string(&WORKERS[0]).unwrap();
        assert!(!encoded.contains("pid"));
    }

    #[test]
    fn checkpoint_only_moves_running_jobs() {
        let mut project = Project::create("Crash", "owner_1");
        let queued = Job {
            job_id: "job_q".into(),
            project_id: project.project_id.clone(),
            job_type: "probe_media".into(),
            agent: "media_analyst".into(),
            state: JobState::Queued,
            progress: 0.0,
            dependencies: Vec::new(),
            created_at: now_iso(),
            started_at: None,
            completed_at: None,
            error: None,
            media_id: "media_1".into(),
            message: String::new(),
            subject_id: String::new(),
            explanation: String::new(),
        };
        let mut running = queued.clone();
        running.job_id = "job_r".into();
        running.state = JobState::Running;
        project.jobs = vec![queued, running];
        assert!(settle_interrupted(&mut project));
        assert_eq!(project.jobs[0].state, JobState::Queued);
        assert_eq!(project.jobs[1].state, JobState::Retrying);
    }

    #[test]
    fn events_stay_small() {
        let project = Project::create("Events", "owner_1");
        let job = Job {
            job_id: "job_1".into(),
            project_id: project.project_id.clone(),
            job_type: "create_proxy".into(),
            agent: "media_analyst".into(),
            state: JobState::Running,
            progress: 0.25,
            dependencies: Vec::new(),
            created_at: now_iso(),
            started_at: None,
            completed_at: None,
            error: None,
            media_id: "media_1".into(),
            message: "Writing proxy".into(),
            subject_id: String::new(),
            explanation: String::new(),
        };
        assert!(event_is_small(&BusEvent::job(&project.project_id, &job)));
    }

    #[test]
    fn cost_meter_records_local_work() {
        let dir =
            std::env::temp_dir().join(format!("tippy-cost-{}", uuid::Uuid::new_v4().simple()));
        fs::create_dir_all(&dir).unwrap();
        let meter = CostMeter::open(dir.join("cost-meter.json")).unwrap();
        meter
            .record(CostEntry {
                project_id: "proj_1".into(),
                kind: "local_process_ms".into(),
                amount: 12.0,
                at: now_iso(),
            })
            .unwrap();
        assert_eq!(meter.total("local_process_ms").unwrap(), 12.0);
        let _ = fs::remove_dir_all(dir);
    }
}
