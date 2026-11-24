//! Immutable, read-only reconstruction of an owned sample vector on its Tet4 carrier.
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use super::saved_field_geometry::SavedFieldGeometryResource;

#[derive(Debug, Clone, Deserialize, Serialize, IntoParams, ToSchema)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct SavedPlanarQuery {
    pub expected_dataset_manifest_object_ref: String,
    pub expected_geometry_manifest_object_ref: String,
    pub expected_geometry_object_ref: String,
    /// xy, xz or yz. Coordinates and bounds are in metres.
    pub plane: String,
    pub position_m: f64,
    pub u_min_m: f64,
    pub u_max_m: f64,
    pub v_min_m: f64,
    pub v_max_m: f64,
    /// Positive raster dimensions, at most 1048576 points in total.
    pub width: u32,
    pub height: u32,
    /// magnitude, x, y, z, u, v or normal; derived after interpolation.
    pub component: String,
    /// Canonical positive decimal byte budget, including the binary header.
    pub max_response_bytes: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SavedPlanarResource {
    pub schema_version: String,
    pub request_identity: String,
    pub source: SavedFieldGeometryResource,
    pub reconstruction: String,
    pub qualification: String,
    pub operator: String,
    pub sampler_version: String,
    pub sampling_method: String,
    pub component: String,
    pub frame_origin_m: [f64; 3],
    pub frame_u_axis: [f64; 3],
    pub frame_v_axis: [f64; 3],
    pub frame_normal: [f64; 3],
    pub bounds_uv_m: [f64; 4],
    pub resolution: [u32; 2],
    pub occupied_count: u32,
    pub empty_count: u32,
    pub scalar_min: Option<f64>,
    pub scalar_max: Option<f64>,
    /// World xyz vectors; scalar and vector binaries use FMVP v2.
    pub vector_components: [String; 3],
    /// 0 occupied, 1 empty, 2 partial, 3 undefined orientation, 4 ambiguous.
    pub occupancy_encoding: String,
}

#[derive(Debug, Clone, Deserialize, IntoParams, ToSchema)]
#[serde(deny_unknown_fields)]
#[into_params(parameter_in = Query)]
pub struct SavedPlanarProbeQuery {
    pub expected_dataset_manifest_object_ref: String,
    pub expected_geometry_manifest_object_ref: String,
    pub expected_geometry_object_ref: String,
    /// xy, xz or yz. Coordinates and bounds are in metres.
    pub plane: String,
    pub position_m: f64,
    pub u_min_m: f64,
    pub u_max_m: f64,
    pub v_min_m: f64,
    pub v_max_m: f64,
    /// Positive raster dimensions, at most 1048576 points in total.
    pub width: u32,
    pub height: u32,
    /// magnitude, x, y, z, u, v or normal; derived after interpolation.
    pub component: String,
    /// Canonical positive decimal byte budget, including the binary header.
    pub max_response_bytes: String,
    /// Exact raster column and row, not a nearest-node probe.
    pub pixel_x: u32,
    pub pixel_y: u32,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct SavedPlanarProbeResource {
    pub request_identity: String,
    pub pixel: [u32; 2],
    pub point_m: [f64; 3],
    pub occupancy: u8,
    pub scalar: Option<f64>,
    pub vector: Option<[f64; 3]>,
    /// Saved mesh cell ordinal containing the raster centre.
    pub source_entity_ordinal: Option<u32>,
}

impl SavedPlanarProbeQuery {
    pub(crate) fn into_plane(self) -> SavedPlanarQuery {
        SavedPlanarQuery {
            expected_dataset_manifest_object_ref: self.expected_dataset_manifest_object_ref,
            expected_geometry_manifest_object_ref: self.expected_geometry_manifest_object_ref,
            expected_geometry_object_ref: self.expected_geometry_object_ref,
            plane: self.plane,
            position_m: self.position_m,
            u_min_m: self.u_min_m,
            u_max_m: self.u_max_m,
            v_min_m: self.v_min_m,
            v_max_m: self.v_max_m,
            width: self.width,
            height: self.height,
            component: self.component,
            max_response_bytes: self.max_response_bytes,
        }
    }
}
