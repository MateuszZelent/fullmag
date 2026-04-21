use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct EngineLogResource {
    pub revision: u64,
    pub total: usize,
    pub entries: Vec<crate::types::EngineLogEntry>,
}
