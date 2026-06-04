use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const FULLMAG_LIVE_SUBPROTOCOL: &str = "fullmag.live.v1";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RealtimeResourceRevisionMap {
    pub topology_revision: u64,
    pub field_catalog_revision: u64,
    pub field_revision: u64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub field_quantity_revisions: BTreeMap<String, u64>,
    pub slice_revision: u64,
    pub artifact_revision: u64,
    pub command_completion_revision: u64,
    pub fields_revision: u64,
    pub scalars_revision: u64,
    pub domain_generation_id: u64,
    pub artifacts_revision: u64,
    pub engine_log_revision: u64,
    pub solver_profile_revision: u64,
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
    Diagnostics,
    Mesh,
    MeshBuilds,
    Commands,
    Stages,
    SceneDocument,
    VisualizationState,
    VisualizationClientAcks,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RealtimeResourceChange {
    pub resource: RealtimeResourceName,
    pub revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub quantity_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub broad: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain_generation_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended_fetch: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RealtimeCommunicationPolicy {
    pub ws_replay_capacity: u32,
    pub ws_heartbeat_ms: u32,
    pub ws_reconnect_ms: u32,
    pub lifecycle_coalesce_ms: u32,
    pub table_rows_min_refetch_ms: u32,
    pub field_sample_publish_ms: u32,
    pub scalar_telemetry_publish_ms: u32,
    pub diagnostics_summary_ms: u32,
    pub status_refresh_ms: u32,
    pub error_retry_ms: u32,
}

impl Default for RealtimeCommunicationPolicy {
    fn default() -> Self {
        Self {
            ws_replay_capacity: 512,
            ws_heartbeat_ms: 15_000,
            ws_reconnect_ms: 5_000,
            lifecycle_coalesce_ms: 250,
            table_rows_min_refetch_ms: 1_000,
            field_sample_publish_ms: 2_000,
            scalar_telemetry_publish_ms: 200,
            diagnostics_summary_ms: 5_000,
            status_refresh_ms: 5_000,
            error_retry_ms: 1_000,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HelloPayload {
    pub server_time: String,
    pub replay_available_after_seq: u64,
    pub current_seq: u64,
    pub resource_revisions: RealtimeResourceRevisionMap,
    #[serde(default)]
    pub communication_policy: RealtimeCommunicationPolicy,
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
pub struct ScalarSamplePayload {
    pub revision: u64,
    pub row: Value,
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
    #[serde(rename = "scalar.sample")]
    ScalarSample {
        seq: u64,
        ts: String,
        session_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
        contract_version: String,
        payload: ScalarSamplePayload,
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
            | Self::ScalarSample { seq, .. }
            | Self::ResyncRequired { seq, .. } => *seq,
        }
    }
}
