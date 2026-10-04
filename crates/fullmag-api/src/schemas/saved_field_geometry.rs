//! Resource and binary-envelope contracts for an immutable saved FEM field geometry.
//!
//! The JSON resource is a control-plane projection.  Mesh topology is served
//! through the existing FMMT v2 data plane and the field support mask through
//! the separate FMSP v1 data plane.  Neither resource is sourced from the
//! active session.

use super::materialized_dataset::MaterializedDatasetFieldDescriptorResource;
use super::solutions::{SolutionAcceptedStateIdResource, SolutionArtifactKindResource};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

pub const SAVED_FIELD_GEOMETRY_RESOURCE_SCHEMA: &str =
    "fullmag.persistence.saved_field_geometry.v1";
pub const SAVED_FIELD_GEOMETRY_BINARY_SCHEMA: &str = "fullmag.binary.saved_field_geometry.v1";
pub const SAVED_FIELD_SUPPORT_BINARY_SCHEMA: &str = "fullmag.binary.saved_field_support.v1";

/// Existing cold geometry reader bound.  This is a decode/output guard, not a
/// measurement of peak process memory.
pub const MAX_SAVED_FIELD_GEOMETRY_DECODE_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_SAVED_FIELD_GEOMETRY_METADATA_BYTES: usize = 1024 * 1024;
pub const MAX_SAVED_FIELD_SUPPORT_BINARY_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Default, Deserialize, IntoParams, ToSchema)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct SavedFieldGeometryBinaryQuery {
    /// Bare lowercase SHA-256 of the exact materialized dataset manifest.
    pub expected_dataset_manifest_object_ref: String,
    /// Bare lowercase SHA-256 of the exact saved geometry binding manifest.
    pub expected_geometry_manifest_object_ref: String,
    /// Bare lowercase SHA-256 of the exact saved geometry payload.
    pub expected_geometry_object_ref: String,
    /// Maximum complete binary body size, including its fixed header.
    pub max_response_bytes: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SavedFieldGeometryArtifactResource {
    pub artifact_id: String,
    pub kind: SolutionArtifactKindResource,
    pub accepted_state: Option<SolutionAcceptedStateIdResource>,
    pub schema_id: String,
    pub object_ref: String,
    /// Canonical decimal u64.
    pub byte_length: String,
}

/// CAS-only geometry payload identity.  The payload is referenced by the
/// saved geometry manifest but is not a separate SolutionSet artifact.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SavedFieldGeometryPayloadResource {
    pub schema_id: String,
    pub object_ref: String,
    /// Canonical decimal u64.
    pub byte_length: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SavedFieldGeometryPinnedSourceResource {
    pub run_id: String,
    pub solution_set_id: String,
    /// Canonical decimal u64.
    pub solution_revision: String,
    pub member_id: String,
    pub tensor_artifact_id: String,
    pub tensor_object_ref: String,
    pub run_spec_digest: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SavedFieldGeometryDatasetResource {
    pub dataset_id: String,
    /// Canonical decimal u64.
    pub revision: String,
    pub sample_id: String,
    pub item_id: String,
    pub field_id: String,
    pub group_id: String,
    pub descriptor: MaterializedDatasetFieldDescriptorResource,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SavedFieldGeometryResource {
    pub schema_version: String,
    pub project_id: String,
    pub run_id: String,
    pub solution_set_id: String,
    /// Revision selected by the containing route.
    pub containing_solution_revision: String,
    /// Exact historical revision that owns the pinned tensor and geometry.
    pub owner_solution_revision: String,
    pub member_id: String,
    pub source: SavedFieldGeometryPinnedSourceResource,
    pub dataset_manifest: SavedFieldGeometryArtifactResource,
    pub geometry_manifest: SavedFieldGeometryArtifactResource,
    pub geometry_payload: SavedFieldGeometryPayloadResource,
    pub tensor_artifact: SavedFieldGeometryArtifactResource,
    pub dataset: SavedFieldGeometryDatasetResource,
    pub geometry_schema_version: String,
    pub coordinate_unit: String,
    pub representation_evidence: SavedFieldGeometryRepresentationEvidenceResource,
    pub topology_fingerprint: String,
    pub support_fingerprint: String,
    pub layout_digest: String,
    pub producer_id: String,
    pub producer_version: String,
    /// Canonical decimal u64 counts.
    pub node_count: String,
    pub cell_count: String,
    pub facet_count: String,
    pub active_node_count: String,
    /// Existing cold reader limit.  Peak RAM is not certified by this value.
    pub geometry_decode_budget_bytes: String,
    pub topology_binary_schema: String,
    pub support_binary_schema: String,
    /// Complete FMMT v2 body length, when it fits the bounded transport.
    pub topology_binary_byte_length: Option<String>,
    /// SHA-256 of the complete FMMT v2 body, when it fits the bounded transport.
    pub topology_binary_sha256: Option<String>,
    /// Complete FMSP body length, including its 24-byte header.
    pub support_binary_byte_length: String,
    /// SHA-256 of the complete FMSP body.  Absent when the support body is
    /// over the bounded support transport budget.
    pub support_binary_sha256: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavedFieldGeometryRepresentationEvidenceResource {
    NotVerified,
}

#[derive(Debug, Clone, Copy, Serialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SavedFieldGeometryBinaryIntegrityResource {
    VerifiedReturnedBody,
}
