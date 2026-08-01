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
