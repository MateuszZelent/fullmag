use serde::{Deserialize, Serialize};

pub const FULLMAG_LIVE_SUBPROTOCOL: &str = "fullmag.live.v1";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RealtimeResourceRevisionMap {
    pub topology_revision: u64,
    pub field_catalog_revision: u64,
    pub field_revision: u64,
    pub slice_revision: u64,
    pub artifact_revision: u64,
    pub command_completion_revision: u64,
    pub fields_revision: u64,
    pub scalars_revision: u64,
    pub domain_generation_id: u64,
    pub artifacts_revision: u64,
    pub engine_log_revision: u64,
    pub display_revision: u64,
    pub workspace_revision: u64,
    pub mesh_revision: u64,
    pub mesh_build_revision: u64,
    pub commands_revision: u64,
    pub stages_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
    pub visualization_state_revision: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "snake_case")]
pub enum RealtimeResourceName {
    Display,
    Workspace,
    Fields,
    Scalars,
    Domain,
    Artifacts,
    Logs,
    Mesh,
    MeshBuilds,
    Commands,
    Stages,
    SceneDocument,
    VisualizationState,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RealtimeResourceChange {
    pub resource: RealtimeResourceName,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_generation_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_fetch: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HelloPayload {
    pub server_time: String,
    pub replay_available_after_seq: u64,
    pub current_seq: u64,
    pub resource_revisions: RealtimeResourceRevisionMap,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HeartbeatPayload {
    pub current_seq: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ResourceBatchChangedPayload {
    pub changes: Vec<RealtimeResourceChange>,
    pub coalesced: bool,
    pub window_ms: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ResyncRequiredPayload {
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_after: Option<u64>,
    pub replay_available_after_seq: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type")]
pub enum LiveRealtimeServerEvent {
    #[serde(rename = "hello")]
    Hello {
        seq: u64,
        ts: String,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        contract_version: String,
        payload: HelloPayload,
    },
    #[serde(rename = "heartbeat")]
    Heartbeat {
        seq: u64,
        ts: String,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        contract_version: String,
        payload: HeartbeatPayload,
    },
    #[serde(rename = "resource.batch_changed")]
    ResourceBatchChanged {
        seq: u64,
        ts: String,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        contract_version: String,
        payload: ResourceBatchChangedPayload,
    },
    #[serde(rename = "resync.required")]
    ResyncRequired {
        seq: u64,
        ts: String,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        contract_version: String,
        payload: ResyncRequiredPayload,
    },
}

impl LiveRealtimeServerEvent {
    pub fn seq(&self) -> u64 {
        match self {
            Self::Hello { seq, .. }
            | Self::Heartbeat { seq, .. }
            | Self::ResourceBatchChanged { seq, .. }
            | Self::ResyncRequired { seq, .. } => *seq,
        }
    }
}
