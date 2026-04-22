use super::DisplaySelectionState;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MeshCommandTargetEvent {
    StudyDomain,
    AdaptiveFollowup,
    Airbox,
    ObjectMesh { object_id: String },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatus {
    Bootstrapping,
    Materializing,
    MaterializingScript,
    WaitingForCompute,
    AwaitingCommand,
    Running,
    Paused,
    Breaking,
    Closing,
    Completed,
    Failed,
    Cancelled,
    Unknown,
}

impl RuntimeStatus {
    pub fn from_status_code(code: &str) -> Self {
        match code {
            "bootstrapping" => Self::Bootstrapping,
            "materializing" => Self::Materializing,
            "materializing_script" => Self::MaterializingScript,
            "waiting_for_compute" => Self::WaitingForCompute,
            "awaiting_command" | "interactive" | "ready" => Self::AwaitingCommand,
            "running" => Self::Running,
            "paused" => Self::Paused,
            "breaking" => Self::Breaking,
            "closing" | "closed" => Self::Closing,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Unknown,
        }
    }

    pub fn is_busy(self) -> bool {
        matches!(
            self,
            Self::Bootstrapping
                | Self::Materializing
                | Self::MaterializingScript
                | Self::Running
                | Self::Breaking
                | Self::Closing
        )
    }

    pub fn can_accept_commands(self) -> bool {
        matches!(
            self,
            Self::AwaitingCommand | Self::Running | Self::Paused | Self::WaitingForCompute
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandAckEvent {
    pub session_id: String,
    pub seq: u64,
    pub command_id: String,
    pub command_kind: String,
    pub issued_at_unix_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_target: Option<MeshCommandTargetEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_selection: Option<DisplaySelectionState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandRejectedEvent {
    pub session_id: String,
    pub command_id: String,
    pub command_kind: String,
    pub issued_at_unix_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_target: Option<MeshCommandTargetEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_reason: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandCompletedEvent {
    pub session_id: String,
    pub seq: u64,
    pub command_id: String,
    pub command_kind: String,
    pub completed_at_unix_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_target: Option<MeshCommandTargetEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_reason: Option<String>,
    pub completion_state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStatusChangedEvent {
    pub session_id: String,
    pub status: RuntimeStatus,
    pub status_code: String,
    pub is_busy: bool,
    pub can_accept_commands: bool,
    pub changed_at_unix_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_status: Option<RuntimeStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_status_code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepDeltaEvent {
    pub session_id: String,
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    pub wall_time_ns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuntimeEventEnvelope {
    CommandAck(CommandAckEvent),
    CommandRejected(CommandRejectedEvent),
    CommandCompleted(CommandCompletedEvent),
    RuntimeStatusChanged(RuntimeStatusChangedEvent),
    StepDelta(StepDeltaEvent),
}
