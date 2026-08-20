use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ApiErrorResponse {
    pub code: String,
    pub error: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_context: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct HealthResponse {
    pub status: String,
    pub uptime_seconds: u64,
    pub api_contract_version: String,
    pub active_session: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct HostEngineEntry {
    pub backend: String,
    pub device: String,
    pub precision: String,
    pub mode: String,
    pub runtime_family: String,
    pub runtime_version: String,
    pub worker: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<String>,
    pub public: bool,
    pub stability: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct RuntimeCapabilityMatrix {
    pub profile_version: String,
    pub engines: Vec<HostEngineEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct AcceptedObservationFrameRef {
    pub observation_frame_id: String,
    pub session_epoch: String,
    pub domain_generation_id: String,
    pub topology_revision: String,
    pub source_step: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_time_seconds: Option<f64>,
}

impl AcceptedObservationFrameRef {
    pub fn for_snapshot(
        session_id: &str,
        started_at_unix_ms: u128,
        domain_generation_id: impl Into<String>,
        topology_revision: u64,
        source_step: u64,
        source_time_seconds: Option<f64>,
    ) -> Self {
        let session_epoch = format!("{session_id}@{started_at_unix_ms}");
        let domain_generation_id = domain_generation_id.into();
        let time_bits = source_time_seconds
            .filter(|time| time.is_finite() && *time >= 0.0)
            .map(f64::to_bits)
            .unwrap_or(0);
        let observation_frame_id = format!(
            "obs:{session_epoch}:{domain_generation_id}:{topology_revision}:{source_step}:{time_bits:016x}"
        );
        Self {
            observation_frame_id,
            session_epoch,
            domain_generation_id,
            topology_revision: topology_revision.to_string(),
            source_step,
            source_time_seconds,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AcceptedObservationFrameRef;

    #[test]
    fn fields_and_scalars_share_observation_identity_for_the_same_solver_frame() {
        let field = AcceptedObservationFrameRef::for_snapshot(
            "session-1",
            1700000000000,
            "generation-7",
            11,
            42,
            Some(2.5e-12),
        );
        let scalar = AcceptedObservationFrameRef::for_snapshot(
            "session-1",
            1700000000000,
            "generation-7",
            11,
            42,
            Some(2.5e-12),
        );

        assert_eq!(field, scalar);
        assert!(field.observation_frame_id.starts_with("obs:session-1@"));
    }
}
