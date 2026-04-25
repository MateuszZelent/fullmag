use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

// ── Existing catalog / meta types ────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FieldCatalog {
    pub revision: u64,
    pub domain_generation_id: u64,
    pub quantities: Vec<FieldDescriptor>,
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
    pub domain_generation_id: u64,
    pub available: bool,
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
    pub domain_generation_id: u64,
    pub stats: Option<FieldStats>,
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
pub struct FieldSliceBinaryDescriptor {
    pub available: bool,
    pub n_comp: u8,
    pub point_count: u32,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub etag: Option<String>,
    pub href: Option<String>,
}
