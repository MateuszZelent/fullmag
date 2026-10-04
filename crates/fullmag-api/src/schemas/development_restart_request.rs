use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

/// Independent UI owners; the canonical scene is acquired privately by the launcher.
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct DevelopmentRestartRequest {
    pub schema: String,
    pub request_id: String,
    #[serde(deserialize_with = "present_session_id")]
    #[schema(required = true)]
    pub session_id: Option<String>,
    pub session_epoch: u64,
    pub editor: Value,
    pub workspace: Value,
    pub project_document: Value,
}

fn present_session_id<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(deserializer)
}

#[derive(Serialize, ToSchema)]
pub struct DevelopmentRestartResource {
    pub schema: String,
    pub request_id: String,
    pub state: DevelopmentRestartState,
    pub new_api_instance_id: Option<String>,
    pub session_id: Option<String>,
    pub session_epoch: Option<u64>,
    pub editor: Option<Value>,
    pub workspace: Option<Value>,
    pub project_document: Option<Value>,
    pub public_reason: Option<String>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum DevelopmentRestartState {
    Pending,
    Ready,
    Failed,
    Unknown,
}

impl DevelopmentRestartResource {
    pub(crate) fn pending(request_id: String) -> Self {
        Self {
            schema: "fullmag.development-ui-restart-resource.v1".into(),
            request_id,
            state: DevelopmentRestartState::Pending,
            new_api_instance_id: None,
            session_id: None,
            session_epoch: None,
            editor: None,
            workspace: None,
            project_document: None,
            public_reason: None,
        }
    }
}
