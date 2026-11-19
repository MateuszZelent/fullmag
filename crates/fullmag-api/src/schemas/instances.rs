//! Fullmag instances found on this host (ADR 0069).

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// One session of a discovered instance, as its `GET /v2/sessions` reported it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct InstanceSessionSummary {
    pub session_id: String,
    pub name: String,
    pub status: String,
    pub current: bool,
}

/// A Fullmag instance answering on one loopback port.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, ToSchema)]
pub struct DiscoveredInstance {
    /// Port of the instance's Control Room origin, which also serves its API.
    pub port: u16,
    /// Process identity of the instance's API (`x-fullmag-api-instance`).
    pub api_instance_id: String,
    /// The instance that answered this discovery request.
    pub is_self: bool,
    pub sessions: Vec<InstanceSessionSummary>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct InstanceDiscoveryResource {
    pub schema_version: String,
    /// Process identity of the API that answered this request.
    pub self_api_instance_id: String,
    /// First port of the probed window (inclusive).
    pub first_port: u16,
    /// Last port of the probed window (inclusive).
    pub last_port: u16,
    /// Instances that answered with a Fullmag session list, ordered by port.
    pub instances: Vec<DiscoveredInstance>,
}
