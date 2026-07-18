use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};

#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PlanarFieldQuery {
    pub component: Option<String>,
    pub scope_kind: Option<String>,
    pub scope_id: Option<String>,
    pub stage_id: Option<String>,
    pub snapshot_id: Option<String>,
    pub resolution_x: Option<u32>,
    pub resolution_y: Option<u32>,
    pub quality: Option<String>,
    pub vector_budget: Option<u32>,
    pub include_mesh: Option<bool>,
    pub expected_monitor_revision: Option<u64>,
    pub expected_mesh_revision: Option<u64>,
    pub expected_field_revision: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct PlanarFieldProbeQuery {
    pub u_m: f64,
    pub v_m: f64,
    pub component: Option<String>,
    pub resolution_x: Option<u32>,
    pub resolution_y: Option<u32>,
    pub scope_kind: Option<String>,
    pub scope_id: Option<String>,
    pub stage_id: Option<String>,
    pub snapshot_id: Option<String>,
    pub expected_monitor_revision: Option<u64>,
    pub expected_mesh_revision: Option<u64>,
    pub expected_field_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarFieldFrameResource {
    pub origin_m: [f64; 3],
    pub u_axis: [f64; 3],
    pub v_axis: [f64; 3],
    pub normal: [f64; 3],
    pub bounds_uv_m: [f64; 4],
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarFieldOccupancyResource {
    pub occupied: u32,
    pub partial: u32,
    pub empty: u32,
    pub occupied_measure: f64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarFieldLinksResource {
    pub scalar: String,
    pub vectors: String,
    pub empty_mask: String,
    pub mesh_overlay: String,
    pub probe: String,
    pub render_png: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarFieldMetaResource {
    pub schema_version: String,
    pub monitor_id: String,
    pub monitor_revision: u64,
    pub monitor_hash: String,
    pub quantity_id: String,
    pub canonical_unit: String,
    pub component: String,
    pub field_revision: u64,
    pub mesh_revision: u64,
    pub generation_id: String,
    pub field_source: String,
    pub scope_kind: String,
    pub scope_id: Option<String>,
    pub frame: PlanarFieldFrameResource,
    pub resolution: [u32; 2],
    pub pixel_size_m: [f64; 2],
    pub sample_support: String,
    pub sampling_execution: String,
    pub sampling_method: String,
    pub sampler_version: String,
    pub basis_order: u8,
    pub integration_order: u8,
    pub occupancy: PlanarFieldOccupancyResource,
    pub overlap_count: u32,
    pub fold_count: u32,
    pub non_injective: bool,
    pub scalar_min: Option<f64>,
    pub scalar_max: Option<f64>,
    pub etag: String,
    pub links: PlanarFieldLinksResource,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlanarFieldProbeResource {
    pub monitor_id: String,
    pub quantity_id: String,
    pub u_m: f64,
    pub v_m: f64,
    pub world_m: [f64; 3],
    pub scalar: Option<f64>,
    pub vector: Option<[f64; 3]>,
    pub cell_id: Option<u32>,
    pub element_id: Option<u32>,
    pub occupancy: String,
    pub sampling_method: String,
}
