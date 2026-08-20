use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::schemas::common::{AcceptedObservationFrameRef, FieldPublicationBundle};

// ── Existing catalog / meta types ────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldCatalog {
    pub revision: u64,
    pub domain_generation_id: String,
    pub quantities: Vec<FieldDescriptor>,
}

/// Target-scoped field availability. Unlike [`FieldCatalog`], this resource
/// proves readiness for one concrete target/scope carrier; it deliberately
/// does not include frontend renderer adoption state.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct FieldAvailabilityResource {
    pub quantity_id: String,
    pub target_id: String,
    pub scope_kind: String,
    #[serde(default)]
    pub scope_id: Option<String>,
    pub supported: bool,
    pub materialized: bool,
    pub pending: bool,
    pub state: TargetFieldAvailabilityState,
    #[serde(default)]
    pub carrier_id: Option<String>,
    pub generation: String,
    #[serde(default)]
    pub revision: Option<u64>,
    #[serde(default)]
    pub reason_code: Option<String>,
}

/// Backend availability states intentionally stop at `ready`; `adopted` is a
/// renderer/frontend fact and must not be inferred from an HTTP resource.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TargetFieldAvailabilityState {
    Supported,
    Materializing,
    Ready,
    Stale,
    Unavailable,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldMaterializationState {
    Unsupported,
    Unmaterialized,
    Complete,
    StaleComplete,
    Pending,
    Error,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldDescriptor {
    pub quantity_id: String,
    pub label: String,
    /// Whether this canonical quantity is intended for interactive UI selection.
    pub ui_exposed: bool,
    /// Whether this descriptor can be rendered as a spatial viewport field.
    pub spatial: bool,
    pub domain: String,
    pub kind: String,
    pub components: u8,
    pub location: String,
    pub unit: String,
    pub field_revision: u64,
    pub domain_generation_id: String,
    pub available: bool,
    pub source_step: u64,
    /// Solver time in seconds for the state that produced this field, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_time_seconds: Option<f64>,
    pub source_revision: u64,
    pub materialized_at_unix_ms: u64,
    pub stale_by_steps: u64,
    pub materialization_wall_time_ns: u64,
    pub state: FieldMaterializationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialization_reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialization_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldMeta {
    pub observation_frame: AcceptedObservationFrameRef,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publication_bundle: Option<FieldPublicationBundle>,
    pub quantity_id: String,
    pub label: String,
    pub kind: String,
    pub components: u8,
    pub location: String,
    pub unit: String,
    pub field_revision: u64,
    pub domain_generation_id: String,
    pub stats: Option<FieldStats>,
    pub source_step: u64,
    /// Solver time in seconds for the state that produced this field, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_time_seconds: Option<f64>,
    pub source_revision: u64,
    pub materialized_at_unix_ms: u64,
    pub stale_by_steps: u64,
    pub materialization_wall_time_ns: u64,
    pub state: FieldMaterializationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub materialization_reason_code: Option<String>,
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
    /// Optional FEM or FDM scope for large-domain samples.
    ///
    /// Accepted values: `full`, `object`, `region`, `part`, `layer`, `airbox`,
    /// `selection`. Single-grid FDM supports `object`, `region`, and `airbox`
    /// from current FMRM membership. Multilayer FDM supports native `layer`
    /// and `object` scopes without projecting payloads onto the common grid.
    /// `object` and `part` require `scope_id`; `airbox` may omit it and resolves
    /// to the aggregate of all FEM mesh parts with role `air`, while an explicit
    /// Airbox mesh-part `scope_id` selects exactly that part; `selection` resolves
    /// from the current workspace selection.
    pub scope_kind: Option<String>,
    /// Scope identifier for `object`, `region`, and `part` scopes. For `airbox`,
    /// omit it or use `airbox` for the aggregate, or pass an explicit air-part id.
    pub scope_id: Option<String>,
    /// Optional canonical owner of a `region` scope.
    ///
    /// Required when the current single-grid FDM membership has the same
    /// `region_id` under more than one magnetic object. It is ignored by
    /// globally unique region IDs to preserve existing unqualified requests.
    pub owner_object_id: Option<String>,
    /// Optional geometric subset for scoped vector samples.
    ///
    /// Accepted values: `full` (default) and `surface`. `surface` is currently
    /// Accepted values: `full` (default) and `surface`. `surface` is currently
    /// supported for `airbox` scope and is resolved from the union of the
    /// selected air-part surface-node memberships before `max_samples` is applied.
    pub geometry_scope: Option<String>,
    /// Optional positive hard cap for vector samples returned by the binary payload.
    ///
    /// When `max_samples=K` is supplied, the response contains at most `K`
    /// deterministic samples. FMVP v3 carries `sampled_node_indices` (FEM) or
    /// explicit cell ordinals/native-grid provenance (FDM), so sampled vectors
    /// remain placeable on their source carrier. This applies to full-domain
    /// regular-grid FDM as well as scoped FDM and multilayer native-grid
    /// requests. Without a cap, a full-domain FDM response remains the complete
    /// cell-centred field and may use the legacy FMVP v2 representation.
    ///
    /// A value of zero is invalid and returns HTTP 400. Raw FEM nodal coloring
    /// still requires complete field coverage even when vector glyph transport
    /// is sampled.
    #[param(minimum = 1)]
    #[schema(minimum = 1)]
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
    /// Optional optimistic-concurrency precondition for the domain generation.
    pub expected_generation_id: Option<String>,
    /// Optional optimistic-concurrency precondition for the resolved field carrier.
    pub expected_carrier_revision: Option<String>,
}

/// JSON response returned while a requested field vector is being materialized.
///
/// The stable `reason_code` and `retry_after_ms` fields let clients retry a
/// pending resource without parsing an error message. The `generation_id`
/// identifies the domain generation for which materialization is pending.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FieldVectorPendingResponse {
    /// Current materialization state, normally `pending`.
    pub state: String,
    /// Stable reason code suitable for client-side diagnostics.
    pub reason_code: String,
    /// Recommended delay before retrying the same resource request.
    pub retry_after_ms: u64,
    /// Active compute-fields command, when one owns the materialization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    pub quantity_id: String,
    pub scope_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope_id: Option<String>,
    pub generation_id: String,
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
    pub domain_generation_id: String,
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
    pub domain_generation_id: String,
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
    pub domain_generation_id: String,
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
