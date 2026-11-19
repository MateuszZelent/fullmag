//! Presence of external clients (e.g. Python live scripts) in the current session.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Kind of external client driving the session (ADR 0068).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SessionClientKind {
    /// `fm.connect()` / `FULLMAG_URL` live mode of the Python DSL.
    PythonLive,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SessionClientHeartbeatRequest {
    pub kind: SessionClientKind,
    /// Short human label, e.g. the script file name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionClientEntry {
    pub client_id: String,
    pub kind: SessionClientKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub connected_at_unix_ms: u64,
    pub last_seen_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SessionClientsResource {
    pub revision: u64,
    /// A client without a heartbeat for this long is no longer listed.
    pub ttl_ms: u64,
    pub clients: Vec<SessionClientEntry>,
}
