use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ApiErrorDiagnosticResponse {
    pub code: String,
    pub message: String,
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<Vec<ApiErrorDiagnosticResponse>>,
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

/// Atomic identity envelope for one field response. A consumer must accept or
/// reject the whole bundle; individual revision or carrier members are not a
/// valid publication on their own.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct FieldPublicationBundle {
    pub publication_id: String,
    pub observation_frame: AcceptedObservationFrameRef,
    pub responses: FieldPublicationResponseRevisions,
    pub domain_generation_id: String,
    pub topology_revision: String,
    pub topology_hash: String,
    pub field: FieldPublicationBinding,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub struct FieldPublicationResponseRevisions {
    pub fields_revision: u64,
    pub scalars_revision: u64,
    pub field_catalog_revision: u64,
    pub topology_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
pub struct FieldPublicationBinding {
    pub quantity_id: String,
    pub component: String,
    pub scope_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    pub carrier_id: String,
    pub carrier_fingerprint: String,
}

impl FieldPublicationBundle {
    #[allow(clippy::too_many_arguments)]
    pub fn for_response(
        observation_frame: AcceptedObservationFrameRef,
        fields_revision: u64,
        scalars_revision: u64,
        field_catalog_revision: u64,
        topology_revision: u64,
        topology_hash: impl Into<String>,
        quantity_id: impl Into<String>,
        component: impl Into<String>,
        scope_kind: impl Into<String>,
        scope_id: Option<impl Into<String>>,
        carrier_id: impl Into<String>,
        carrier_fingerprint: impl Into<String>,
    ) -> Self {
        let topology_hash = topology_hash.into();
        let field = FieldPublicationBinding {
            quantity_id: quantity_id.into(),
            component: component.into(),
            scope_kind: scope_kind.into(),
            scope_id: scope_id.map(Into::into),
            carrier_id: carrier_id.into(),
            carrier_fingerprint: carrier_fingerprint.into(),
        };
        let publication_id = format!(
            "publication:{}:{fields_revision}:{scalars_revision}:{field_catalog_revision}:{topology_revision}:{}:{}:{}",
            observation_frame.observation_frame_id,
            field.quantity_id,
            field.component,
            field.carrier_fingerprint
        );
        Self {
            publication_id,
            domain_generation_id: observation_frame.domain_generation_id.clone(),
            topology_revision: topology_revision.to_string(),
            observation_frame,
            responses: FieldPublicationResponseRevisions {
                fields_revision,
                scalars_revision,
                field_catalog_revision,
                topology_revision,
            },
            topology_hash,
            field,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{AcceptedObservationFrameRef, FieldPublicationBundle};

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

    #[test]
    fn field_publication_bundle_binds_frame_revisions_scope_and_carrier_atomically() {
        let frame = AcceptedObservationFrameRef::for_snapshot(
            "session-1",
            1700000000000,
            "generation-7",
            11,
            42,
            Some(2.5e-12),
        );
        let bundle = FieldPublicationBundle::for_response(
            frame.clone(),
            17,
            13,
            19,
            11,
            "sha256:topology",
            "H_eff",
            "magnitude",
            "object",
            Some("magnet-1"),
            "object:magnet-1",
            "sha256:carrier",
        );

        assert_eq!(bundle.observation_frame, frame);
        assert_eq!(bundle.responses.fields_revision, 17);
        assert_eq!(bundle.responses.scalars_revision, 13);
        assert_eq!(bundle.topology_revision, "11");
        assert_eq!(bundle.field.quantity_id, "H_eff");
        assert_eq!(bundle.field.carrier_fingerprint, "sha256:carrier");
        assert!(bundle
            .publication_id
            .contains(&bundle.observation_frame.observation_frame_id));
    }
}
