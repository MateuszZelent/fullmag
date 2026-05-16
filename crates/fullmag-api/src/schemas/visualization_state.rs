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
    /// Canonical 3-D trim controls for topology-aware viewports.
    pub trim: TrimVisualizationState,
    /// Session-wide viewport camera. All connected clients should converge to this view.
    pub camera: VisualizationCameraState,
    /// Compatibility projection of the legacy single clip plane.
    pub clip: ClipVisualizationState,
    /// Vector glyph style independent from vector visibility and sampling.
    pub vector_style: VectorStyleVisualizationState,
    /// Object/part overrides. Endpoint projections must patch this state, not create a second store.
    pub overrides: Vec<VisualizationOverrideState>,
    /// Complete effective target registry for the current scene and mesh.
    #[serde(default = "default_visualization_target_registry_state")]
    pub targets: VisualizationTargetRegistryState,
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

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisualizationClientAckStatus {
    Applied,
    Rendered,
    Failed,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone)]
pub struct VisualizationClientAckRequest {
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport_id: Option<String>,
    pub revision: u64,
    pub status: VisualizationClientAckStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_render_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone)]
pub struct VisualizationClientAckEntry {
    pub client_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport_id: Option<String>,
    pub revision: u64,
    pub status: VisualizationClientAckStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_render_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub received_at_unix_ms: u64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone)]
pub struct VisualizationClientAckResource {
    pub revision: u64,
    pub entries: Vec<VisualizationClientAckEntry>,
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
    pub trim: Option<TrimVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera: Option<VisualizationCameraPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clip: Option<ClipVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_style: Option<VectorStyleVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub overrides: Option<Vec<VisualizationOverrideState>>,
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
    #[serde(default = "default_basic_layer_state")]
    pub bounds: BasicLayerState,
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
    pub bounds: Option<BasicLayerPatch>,
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

fn default_basic_layer_state() -> BasicLayerState {
    BasicLayerState {
        visible: false,
        opacity: 1.0,
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
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

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
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
    #[serde(default = "default_basic_layer_state")]
    pub bounds: BasicLayerState,
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
    pub bounds: Option<BasicLayerPatch>,
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
    pub projection_reduction: String,
    pub projection_include_air_as_zero: bool,
    pub projection_samples: u32,
    pub projection_resolution: u32,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection_reduction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection_include_air_as_zero: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection_samples: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection_resolution: Option<u32>,
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
pub struct TrimVisualizationState {
    pub enabled: bool,
    pub axes: TrimAxisVisualizationAxes,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TrimVisualizationPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub axes: Option<TrimAxisVisualizationAxesPatch>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct TrimAxisVisualizationAxes {
    pub x: TrimAxisVisualizationState,
    pub y: TrimAxisVisualizationState,
    pub z: TrimAxisVisualizationState,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TrimAxisVisualizationAxesPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<TrimAxisVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<TrimAxisVisualizationPatch>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z: Option<TrimAxisVisualizationPatch>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct TrimAxisVisualizationState {
    pub enabled: bool,
    pub min_percent: f64,
    pub max_percent: f64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct TrimAxisVisualizationPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_percent: Option<f64>,
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

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisualizationCameraProjection {
    Perspective,
    Orthographic,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationCameraState {
    pub projection: VisualizationCameraProjection,
    pub position: [f64; 3],
    pub target: [f64; 3],
    pub up: [f64; 3],
    pub fov_degrees: f64,
    pub orthographic_scale: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationCameraPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection: Option<VisualizationCameraProjection>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub up: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fov_degrees: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orthographic_scale: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationOverrideState {
    pub scope: VisualizationScopeKind,
    pub scope_id: String,
    /// Compatibility target visibility override. Prefer `display.visible` for new clients.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display: Option<VisualizationTargetDisplayOverride>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<VisualizationTargetStyleOverride>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationTargetRegistryState {
    pub airbox: VisualizationTargetRegistryEntry,
    pub objects: Vec<VisualizationTargetRegistryEntry>,
    pub parts: Vec<VisualizationTargetRegistryEntry>,
}

fn default_visualization_target_registry_state() -> VisualizationTargetRegistryState {
    VisualizationTargetRegistryState {
        airbox: VisualizationTargetRegistryEntry {
            scope: VisualizationScopeKind::Airbox,
            scope_id: "airbox".to_string(),
            label: "Airbox".to_string(),
            source: VisualizationTargetSource::Airbox,
            settings: VisualizationResolvedTargetSettings {
                visible: false,
                bounds_visible: false,
                geometry_scope: VisualizationTargetGeometryScope::Full,
                opacity: 0.18,
                points_visible: false,
                render_mode: VisualizationTargetRenderMode::Wireframe,
                surface_color_source: SurfaceColorSource::Solid,
                surface_mono_color: "var(--fm-airbox-fill)".to_string(),
                surface_visible: false,
                vector_alpha: 1.0,
                vector_color_mode: VectorColorMode::Orientation,
                vector_mono_color: "var(--fm-accent)".to_string(),
                vector_thickness: 1.0,
                vectors_visible: false,
                wireframe_color: "var(--fm-airbox-wire)".to_string(),
                wireframe_opacity: 1.0,
                wireframe_visible: false,
            },
            override_state: None,
        },
        objects: Vec::new(),
        parts: Vec::new(),
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationTargetRegistryEntry {
    pub scope: VisualizationScopeKind,
    pub scope_id: String,
    pub label: String,
    pub source: VisualizationTargetSource,
    pub settings: VisualizationResolvedTargetSettings,
    #[serde(rename = "override", skip_serializing_if = "Option::is_none")]
    pub override_state: Option<VisualizationOverrideState>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisualizationTargetSource {
    Airbox,
    SceneObject,
    MeshPart,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationResolvedTargetSettings {
    pub visible: bool,
    pub bounds_visible: bool,
    pub geometry_scope: VisualizationTargetGeometryScope,
    pub opacity: f64,
    pub points_visible: bool,
    pub render_mode: VisualizationTargetRenderMode,
    pub surface_color_source: SurfaceColorSource,
    pub surface_mono_color: String,
    pub surface_visible: bool,
    pub vector_alpha: f64,
    pub vector_color_mode: VectorColorMode,
    pub vector_mono_color: String,
    pub vector_thickness: f64,
    pub vectors_visible: bool,
    pub wireframe_color: String,
    pub wireframe_opacity: f64,
    pub wireframe_visible: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisualizationTargetRenderMode {
    Points,
    Surface,
    #[serde(rename = "surface+edges")]
    SurfaceEdges,
    Wireframe,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationTargetDisplayOverride {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<BasicLayerPatch>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_scope: Option<VisualizationTargetGeometryScope>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationTargetStyleOverride {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_color_source: Option<SurfaceColorSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_mono_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_color_mode: Option<VectorColorMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_mono_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_alpha: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_thickness: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wireframe_color: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisualizationTargetGeometryScope {
    Surface,
    Full,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceColorSource {
    Solid,
    Orientation,
    ComponentX,
    ComponentY,
    ComponentZ,
    Magnitude,
    Colormap,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationDiagnostics {
    pub warnings: Vec<String>,
    pub degraded_reasons: Vec<String>,
}
