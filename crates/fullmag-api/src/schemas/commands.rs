use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CommandRequest {
    pub command: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CommandResponse {
    pub accepted: bool,
    pub command_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
