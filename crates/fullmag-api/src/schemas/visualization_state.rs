use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::schemas::status::{DisplayViewMode, FieldComponent};

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone)]
pub struct VisualizationStateResource {
    /// Monotonic revision of all visualization state.
    pub revision: u64,
    /// Schema semver for consumers to detect payload shape changes.
    pub schema_version: u32,
    /// Canonical quantity/color state. New clients should read this instead of the flat compatibility fields.
    pub quantity: QuantityVisualizationState,
    /// Independent renderer layers. This is the canonical View ribbon state model.
    pub layers: VisualizationLayerState,
    /// Domain/scope selection for renderer resources.
    pub domains: DomainVisualizationState,
    /// Sampling and memory budget policy for heavy renderer data.
    pub sampling: SamplingVisualizationState,
    /// FDM-specific view controls.
    pub fdm: FdmVisualizationState,
    /// FEM-specific view controls.
    pub fem: FemVisualizationState,
    /// 2-D slice toolbar and overlay controls.
    pub slice: SliceVisualizationState,
    /// Shared clip-plane controls for topology-aware viewports.
    pub clip: ClipVisualizationState,
    /// Vector glyph style independent from vector visibility and sampling.
    pub vector_style: VectorStyleVisualizationState,
    /// Object/part overrides. Endpoint projections must patch this state, not create a second store.
    pub overrides: Vec<VisualizationOverrideState>,
    /// Backend normalization warnings and degraded-state reasons for display controls.
    pub diagnostics: VisualizationDiagnostics,
    /// Compatibility projection for current display clients. Prefer `quantity.active_quantity_id`.
    pub active_quantity_id: String,
    /// Compatibility projection for current display clients.
    pub view_mode: DisplayViewMode,
    /// Compatibility projection for current display clients. Prefer `quantity.field_component`.
    pub field_component: FieldComponent,
    /// Compatibility projection for current display clients. Prefer `quantity.colormap`.
    pub colormap: String,
    /// Compatibility projection for current display clients. Prefer `quantity.auto_contrast`.
    pub auto_contrast: bool,
    /// Compatibility projection for current display clients. Prefer `quantity.contrast_min`.
    pub contrast_min: Option<f64>,
    /// Compatibility projection for current display clients. Prefer `quantity.contrast_max`.
    pub contrast_max: Option<f64>,
    /// Compatibility projection for current display clients. Prefer `layers.vectors.visible`.
    pub vector_glyphs: bool,
    /// Compatibility projection for current display clients. Prefer `layers.vectors.density`.
    pub vector_density: u32,
    pub slice_mode: String,
    pub slice_layer: i32,
    /// Compatibility projection for current display clients. Prefer `sampling.max_points`.
    pub max_points: u32,
    /// Compatibility projection for current display clients. Prefer `fdm.x_chosen_size`.
    pub x_chosen_size: u32,
    /// Compatibility projection for current display clients. Prefer `fdm.y_chosen_size`.
    pub y_chosen_size: u32,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct VisualizationStatePatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_quantity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_mode: Option<crate::schemas::status::DisplayViewMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_component: Option<crate::schemas::status::FieldComponent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colormap: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_contrast: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contrast_min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contrast_max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_glyphs: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_density: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slice_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slice_layer: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_points: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_chosen_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_chosen_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity: Option<QuantityVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layers: Option<VisualizationLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domains: Option<DomainVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sampling: Option<SamplingVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fdm: Option<FdmVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem: Option<FemVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slice: Option<SliceVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip: Option<ClipVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_style: Option<VectorStyleVisualizationPatch>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone)]
pub struct QuantityVisualizationState {
    pub active_quantity_id: String,
    pub field_component: FieldComponent,
    pub colormap: String,
    pub auto_contrast: bool,
    pub contrast_min: Option<f64>,
    pub contrast_max: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct QuantityVisualizationPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_quantity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field_component: Option<FieldComponent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colormap: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_contrast: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contrast_min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contrast_max: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationLayerState {
    pub surface: BasicLayerState,
    pub quantity_overlay: BasicLayerState,
    pub wireframe: BasicLayerState,
    pub volume_mesh: BasicLayerState,
    pub points: BasicLayerState,
    pub vectors: VectorLayerState,
    pub primitives: BasicLayerState,
    pub airbox: AirboxLayerState,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct VisualizationLayerPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface: Option<BasicLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity_overlay: Option<BasicLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wireframe: Option<BasicLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_mesh: Option<BasicLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<BasicLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vectors: Option<VectorLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub primitives: Option<BasicLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub airbox: Option<AirboxLayerPatch>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct BasicLayerState {
    pub visible: bool,
    pub opacity: f64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct BasicLayerPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VectorLayerState {
    pub visible: bool,
    pub density: u32,
    pub domain: VectorLayerDomain,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct VectorLayerPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub density: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<VectorLayerDomain>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VectorLayerDomain {
    Auto,
    MagneticOnly,
    FullDomain,
    AirboxOnly,
    Selection,
    Object,
    Part,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct AirboxLayerState {
    pub visible: bool,
    pub surface: BasicLayerState,
    pub wireframe: BasicLayerState,
    pub points: BasicLayerState,
    pub vectors: VectorLayerState,
    pub opacity: f64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct AirboxLayerPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface: Option<BasicLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wireframe: Option<BasicLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub points: Option<BasicLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vectors: Option<VectorLayerPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct DomainVisualizationState {
    pub active_scope: VisualizationScopeKind,
    pub object_id: Option<String>,
    pub part_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DomainVisualizationPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_scope: Option<VisualizationScopeKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisualizationScopeKind {
    Full,
    Magnetic,
    Airbox,
    Object,
    Part,
    Selection,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct SamplingVisualizationState {
    pub profile: SamplingProfile,
    pub max_points: u32,
    pub max_glyphs: u32,
    pub max_bytes: Option<u64>,
    pub progressive: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct SamplingVisualizationPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<SamplingProfile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_points: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_glyphs: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progressive: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SamplingProfile {
    Quality,
    Balanced,
    Interactive,
    MemorySaver,
    Custom,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct FdmVisualizationState {
    pub x_chosen_size: u32,
    pub y_chosen_size: u32,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FdmVisualizationPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_chosen_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_chosen_size: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct FemVisualizationState {
    pub topology_mode: FemTopologyMode,
    pub volume_edges_budget: u32,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FemVisualizationPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topology_mode: Option<FemTopologyMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_edges_budget: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct SliceVisualizationState {
    pub quantity_id: String,
    pub component: FieldComponent,
    pub axis: ClipAxis,
    pub mode: SliceVisualizationMode,
    pub layer_index: Option<i32>,
    pub position_percent: f64,
    pub thickness_percent: Option<f64>,
    pub colormap: String,
    pub auto_contrast: bool,
    pub show_primitives: bool,
    pub show_mesh: bool,
    pub show_magnetic_texture: bool,
    pub show_airbox: bool,
    pub airbox_render_mode: SliceAirboxRenderMode,
    pub show_airbox_vectors: bool,
    pub show_quantity: bool,
    pub show_vectors: bool,
    pub render_mode: SliceRenderMode,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct SliceVisualizationPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component: Option<FieldComponent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub axis: Option<ClipAxis>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<SliceVisualizationMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer_index: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thickness_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub colormap: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_contrast: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_primitives: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_mesh: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_magnetic_texture: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_airbox: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub airbox_render_mode: Option<SliceAirboxRenderMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_airbox_vectors: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_quantity: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_vectors: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render_mode: Option<SliceRenderMode>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SliceVisualizationMode {
    Single,
    Slab,
    AllLayers,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SliceRenderMode {
    Heatmap,
    Contour,
    #[serde(rename = "heatmap+contour")]
    HeatmapContour,
    Vectors,
    #[serde(rename = "mesh-overlay")]
    MeshOverlay,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SliceAirboxRenderMode {
    Surface,
    Wireframe,
    #[serde(rename = "surface+edges")]
    SurfaceEdges,
    Points,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct ClipVisualizationState {
    pub enabled: bool,
    pub axis: ClipAxis,
    pub position_percent: f64,
    pub flipped: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ClipVisualizationPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub axis: Option<ClipAxis>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flipped: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClipAxis {
    X,
    Y,
    Z,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FemTopologyMode {
    Surface,
    Boundary,
    Volume,
    Auto,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VectorStyleVisualizationState {
    pub color_mode: VectorColorMode,
    pub mono_color: String,
    pub alpha: f64,
    pub length_scale: f64,
    pub thickness: f64,
    pub ferromagnet_visibility: FerromagnetVisibilityMode,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct VectorStyleVisualizationPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_mode: Option<VectorColorMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mono_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thickness: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ferromagnet_visibility: Option<FerromagnetVisibilityMode>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VectorColorMode {
    Orientation,
    X,
    Y,
    Z,
    Magnitude,
    Monochrome,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FerromagnetVisibilityMode {
    Hide,
    Ghost,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationOverrideState {
    pub scope: VisualizationScopeKind,
    pub scope_id: String,
    pub visible: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationDiagnostics {
    pub warnings: Vec<String>,
    pub degraded_reasons: Vec<String>,
}
