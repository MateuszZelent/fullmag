//! Source-surface authoring resources; these do not describe an FEM mesh.
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct ImportedSourceSurfaceResource {
    pub purpose: String,
    pub object_id: String,
    pub scene_revision: u64,
    pub surface_id: String,
    pub source_sha256: String,
    pub coordinate_frame: String,
    pub coordinate_unit: String,
    pub scale_to_metres: [f64; 3],
    pub node_count: usize,
    pub triangle_count: usize,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
    /// This surface is source geometry, not a generated or validated volume mesh.
    pub solver_eligible: bool,
    pub topology_format: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub(crate) struct ImportedSourceSurfaceQuery {
    pub scene_revision: u64,
    pub source_sha256: String,
}
