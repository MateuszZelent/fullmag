use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

// ── Existing catalog / meta types ────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldCatalog {
    pub revision: u64,
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub domain_generation_id: u64,
    pub quantities: Vec<FieldDescriptor>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldMaterializationState {
    Complete,
    StaleComplete,
    Pending,
    Superseded,
    Error,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldDescriptor {
    pub quantity_id: String,
    pub label: String,
    pub kind: String,
    pub components: u8,
    pub location: String,
    pub unit: String,
    pub field_revision: u64,
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub domain_generation_id: u64,
    pub available: bool,
    pub source_step: u64,
    pub source_revision: u64,
    pub materialized_at_unix_ms: u64,
    pub stale_by_steps: u64,
    pub materialization_wall_time_ns: u64,
    pub state: FieldMaterializationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialization_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldMeta {
    pub quantity_id: String,
    pub label: String,
    pub kind: String,
    pub components: u8,
    pub location: String,
    pub unit: String,
    pub field_revision: u64,
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub domain_generation_id: u64,
    pub stats: Option<FieldStats>,
    pub source_step: u64,
    pub source_revision: u64,
    pub materialized_at_unix_ms: u64,
    pub stale_by_steps: u64,
    pub materialization_wall_time_ns: u64,
    pub state: FieldMaterializationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialization_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldStats {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
}

// ── P1: 3D component query ────────────────────────────────────────────────────

/// Query parameters for the `/fields/{quantity_id}/vector` endpoint.
#[derive(Debug, Clone, Deserialize, utoipa::IntoParams, ToSchema)]
pub struct FieldVectorQuery {
    /// Component to return.
    ///
    /// Accepted values: `full` (default), `magnitude`, `x`, `y`, `z`, `c0`, `c1`, …, `cN-1`.
    ///
    /// - `full` → full interleaved vector (nComp unchanged)
    /// - `magnitude` → per-point L2 norm (nComp=1)
    /// - `x`/`y`/`z`/`cN` → single component by index (nComp=1)
    pub component: Option<String>,
    /// Optional FEM scope for large-domain samples.
    ///
    /// Accepted values: `full`, `object`, `part`, `airbox`, `selection`.
    /// `object` and `part` require `scope_id`; `airbox` may omit it and resolves
    /// to the first mesh part with role `air`; `selection` resolves from the
    /// current workspace selection.
    pub scope_kind: Option<String>,
    /// Scope identifier for `object` and `part` scopes.
    pub scope_id: Option<String>,
    /// Optional geometric subset for scoped vector samples.
    ///
    /// Accepted values: `full` (default) and `surface`. `surface` is currently
    /// supported for `airbox` scope and is resolved from the selected mesh
    /// part's canonical surface-node membership before `max_samples` is applied.
    pub geometry_scope: Option<String>,
    /// Optional hard cap for vector samples returned by the binary payload.
    ///
    /// FMVP v3 encodes sampled FEM responses with `sampled_node_indices`.
    /// Sampled responses are valid for vector glyph placement only; surface
    /// shader coloring requires either full-domain data or an explicit complete
    /// node-index mapping for the target surface.
    pub max_samples: Option<u32>,
    /// Optional persisted analysis snapshot id, for example a saved
    /// hysteresis-point magnetization state.
    pub snapshot_id: Option<String>,
    /// Optional hysteresis stage id that owns `snapshot_id`.
    ///
    /// When present, the data-plane reader validates that the requested
    /// snapshot appears in that stage's hysteresis point history before
    /// loading persisted magnetization data.
    pub stage_id: Option<String>,
    /// Optional complex analysis view for frequency-domain fields.
    ///
    /// Accepted values for analysis fields: `complex`, `full`, `real`, `imag`,
    /// `abs`, `amplitude`, `phase`, `phase_rotated_real`.
    pub view: Option<String>,
    /// Phase angle in radians for `view=phase_rotated_real`.
    pub phase_rad: Option<f64>,
}

// ── P2: 2D slice JSON types ───────────────────────────────────────────────────

/// JSON metadata response for `/fields/{quantity_id}/slice/meta`.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldSliceMeta {
    pub quantity_id: String,
    pub component: String,
    pub plane: String,
    /// How the cut position was specified: `"normalized"` or `"world"`.
    pub cut_kind: String,
    /// Resolved cut in normalised coordinates \[0, 1\].
    pub cut_norm: f64,
    /// Resolved cut in world coordinates (m), if domain bounds are known.
    pub cut_world: Option<f64>,
    pub field_revision: u64,
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub domain_generation_id: u64,
    /// Sampling path used to construct this slice.
    ///
    /// Examples: `fdm_nearest`, `fem_fallback_fdm_nearest`.
    pub sampling_method: String,
    /// Stable fingerprint covering all resolved parameters (ETag for the meta resource).
    pub etag: String,
    /// Stable fingerprint covering all resolved parameters.
    pub slice_revision: String,
    /// Pixel width of the slice grid.
    pub x_pixels: u32,
    /// Pixel height of the slice grid.
    pub y_pixels: u32,
    pub grid: FieldSliceGrid,
    pub bounds: Option<FieldSliceBounds>,
    pub scalar: FieldSliceBinaryDescriptor,
    pub arrows: FieldSliceBinaryDescriptor,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldSliceGrid {
    pub x_size: u32,
    pub y_size: u32,
    pub point_count: u32,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldSliceBounds {
    pub u_min: f64,
    pub u_max: f64,
    pub v_min: f64,
    pub v_max: f64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldMatrixResponse {
    pub schema: String,
    pub quantity_id: String,
    pub plane: String,
    pub mode: String,
    pub component: String,
    pub color_mode: String,
    pub x_size: u32,
    pub y_size: u32,
    pub u_axis: String,
    pub v_axis: String,
    pub normal_axis: String,
    pub cut_world: Option<f64>,
    pub bounds: FieldSliceBounds,
    pub values: Option<Vec<Vec<Option<f64>>>>,
    pub rgba: Option<Vec<Vec<[u8; 4]>>>,
    pub mask: Vec<Vec<u8>>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub sampling_method: String,
    pub aggregation: Option<String>,
    pub effective_thickness_world: Option<f64>,
    pub matrix_hash: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldSliceBinaryDescriptor {
    pub available: bool,
    pub n_comp: u8,
    pub point_count: u32,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub etag: Option<String>,
    pub href: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldProjectionMeta {
    pub quantity_id: String,
    pub component: String,
    pub plane: String,
    pub reduction: String,
    pub include_air_as_zero: bool,
    pub samples: u32,
    pub field_revision: u64,
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub domain_generation_id: u64,
    pub sampling_method: String,
    pub etag: String,
    pub projection_revision: String,
    pub x_pixels: u32,
    pub y_pixels: u32,
    pub grid: FieldSliceGrid,
    pub bounds: Option<FieldSliceBounds>,
    pub occupied_count: u32,
    pub occupied_measure: f64,
    pub empty_count: u32,
    pub error_estimate: Option<f64>,
    pub error_method: Option<String>,
    pub scalar: FieldSliceBinaryDescriptor,
    pub empty_mask: FieldProjectionMaskDescriptor,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldProjectionMaskDescriptor {
    pub available: bool,
    pub point_count: u32,
    pub etag: Option<String>,
    pub href: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldProjectionProfile {
    pub quantity_id: String,
    pub component: String,
    pub plane: String,
    pub field_revision: u64,
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub domain_generation_id: u64,
    pub sampling_method: String,
    pub pixel_x: u32,
    pub pixel_y: u32,
    pub x_pixels: u32,
    pub y_pixels: u32,
    pub u: f64,
    pub v: f64,
    pub bounds: Option<FieldSliceBounds>,
    pub sample_count: u32,
    pub truncated: bool,
    pub samples: Vec<FieldProjectionProfileSample>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldProjectionProfileSample {
    pub element_index: u32,
    pub marker: u32,
    pub normal_coord: f64,
    pub value: f64,
    pub measure: f64,
}
