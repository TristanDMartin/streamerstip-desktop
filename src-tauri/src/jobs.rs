use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Planning,
    Ready,
    Running,
    WaitingForDependency,
    WaitingForTool,
    WaitingForUser,
    Paused,
    Retrying,
    Failed,
    Completed,
    Cancelled,
}

impl JobState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Planning => "planning",
            Self::Ready => "ready",
            Self::Running => "running",
            Self::WaitingForDependency => "waiting_for_dependency",
            Self::WaitingForTool => "waiting_for_tool",
            Self::WaitingForUser => "waiting_for_user",
            Self::Paused => "paused",
            Self::Retrying => "retrying",
            Self::Failed => "failed",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn is_runnable(self) -> bool {
        matches!(self, Self::Queued | Self::Ready | Self::Retrying)
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Failed | Self::Completed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub job_id: String,
    pub project_id: String,
    #[serde(rename = "type")]
    pub job_type: String,
    pub agent: String,
    pub state: JobState,
    pub progress: f64,
    pub dependencies: Vec<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub error: Option<String>,
    pub media_id: String,
    pub message: String,
}

pub fn dependencies_satisfied(jobs: &[Job], job: &Job) -> bool {
    job.dependencies.iter().all(|dependency_id| {
        jobs.iter()
            .find(|candidate| candidate.job_id == *dependency_id)
            .map(|dependency| dependency.state == JobState::Completed)
            .unwrap_or(false)
    })
}

pub fn dependencies_failed(jobs: &[Job], job: &Job) -> bool {
    job.dependencies.iter().any(|dependency_id| {
        jobs.iter()
            .find(|candidate| candidate.job_id == *dependency_id)
            .map(|dependency| matches!(dependency.state, JobState::Failed | JobState::Cancelled))
            .unwrap_or(true)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, state: JobState, dependencies: &[&str]) -> Job {
        Job {
            job_id: id.into(),
            project_id: "proj_1".into(),
            job_type: "probe_media".into(),
            agent: "media_analyst".into(),
            state,
            progress: 0.0,
            dependencies: dependencies
                .iter()
                .map(|item| (*item).to_string())
                .collect(),
            created_at: "2026-10-13T00:00:00Z".into(),
            started_at: None,
            completed_at: None,
            error: None,
            media_id: "media_1".into(),
            message: String::new(),
        }
    }

    #[test]
    fn every_specified_state_round_trips() {
        let states = [
            JobState::Queued,
            JobState::Planning,
            JobState::Ready,
            JobState::Running,
            JobState::WaitingForDependency,
            JobState::WaitingForTool,
            JobState::WaitingForUser,
            JobState::Paused,
            JobState::Retrying,
            JobState::Failed,
            JobState::Completed,
            JobState::Cancelled,
        ];
        for state in states {
            let json = serde_json::to_string(&state).unwrap();
            let parsed: JobState = serde_json::from_str(&json).unwrap();
            assert_eq!(parsed, state);
            assert_eq!(json, format!("\"{}\"", state.as_str()));
        }
    }

    #[test]
    fn dependency_waits_until_the_parent_completes() {
        let jobs = vec![
            job("probe", JobState::Running, &[]),
            job("proxy", JobState::WaitingForDependency, &["probe"]),
        ];
        assert!(!dependencies_satisfied(&jobs, &jobs[1]));
        assert!(!dependencies_failed(&jobs, &jobs[1]));
    }
}
