use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::schemas::status::{DisplayViewMode, FieldComponent};

/// Default vector budget for airbox visualization (glyph count, not stride).
pub(crate) const DEFAULT_AIRBOX_VECTOR_BUDGET: u32 = 1200;

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
    /// Independent canonical 2-D planar-monitor visualization profile.
    #[serde(default = "default_planar_visualization_state")]
    pub planar: PlanarVisualizationState,
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
    pub planar: Option<PlanarVisualizationPatch>,
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
#[serde(deny_unknown_fields)]
pub struct PlanarVisualizationState {
    pub source: PlanarSourceSelectionState,
    pub default_slice: DefaultPlanarSliceState,
    pub view_scope: PlanarViewScopeState,
    pub quantity_id: String,
    pub component: PlanarFieldComponent,
    pub colormap: String,
    #[serde(default = "default_planar_color_range_state")]
    pub range: PlanarColorRangeState,
    #[serde(default = "default_planar_raster_opacity")]
    pub raster_opacity: f64,
    pub display_unit: Option<String>,
    pub resolution: PlanarResolutionPolicy,
    pub quality: PlanarRenderQuality,
    pub layers: PlanarLayerState,
    pub vector_style: PlanarVectorStyleState,
    pub interaction: PlanarInteractionState,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct PlanarVisualizationPatch {
    pub source: Option<PlanarSourceSelectionState>,
    pub default_slice: Option<DefaultPlanarSliceState>,
    pub view_scope: Option<PlanarViewScopeState>,
    pub quantity_id: Option<String>,
    pub component: Option<PlanarFieldComponent>,
    pub colormap: Option<String>,
    pub range: Option<PlanarColorRangeState>,
    pub raster_opacity: Option<f64>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub display_unit: Option<Option<String>>,
    pub resolution: Option<PlanarResolutionPolicy>,
    pub quality: Option<PlanarRenderQuality>,
    pub layers: Option<PlanarLayerState>,
    pub vector_style: Option<PlanarVectorStyleState>,
    pub interaction: Option<PlanarInteractionState>,
}

/// The source selected by the session-scoped planar viewport state.
///
/// `Default` is a presentation source resolved from the current domain. It is
/// intentionally not a monitor identity and is never written into the scene
/// document or the canonical Python model.
#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanarSourceSelectionState {
    Default,
    Monitor { monitor_id: String },
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct DefaultPlanarSliceState {
    pub plane: PlanarAxisPlane,
    pub position_fraction: f64,
    pub operator: DefaultPlanarOperatorState,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanarAxisPlane {
    Xy,
    Xz,
    Yz,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DefaultPlanarOperatorState {
    PlaneSample,
    SlabAverage { thickness_m: f64 },
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanarColorRangeMode {
    Auto,
    Manual,
    Symmetric,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct PlanarColorRangeState {
    pub mode: PlanarColorRangeMode,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

pub(crate) fn default_planar_color_range_state() -> PlanarColorRangeState {
    PlanarColorRangeState {
        mode: PlanarColorRangeMode::Auto,
        min: None,
        max: None,
    }
}

fn default_planar_raster_opacity() -> f64 {
    1.0
}

fn deserialize_double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlanarViewScopeState {
    MonitorTarget,
    MeshPart { scope_id: String },
    Airbox,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanarFieldComponent {
    X,
    Y,
    Z,
    U,
    V,
    Normal,
    Magnitude,
    InPlaneMagnitude,
    Orientation,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq, Eq)]
pub struct PlanarResolutionPolicy {
    pub width: u32,
    pub height: u32,
    pub vector_budget: u32,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanarRenderQuality {
    Interactive,
    Export,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq, Eq)]
pub struct PlanarLayerState {
    pub bounds: bool,
    pub raster: bool,
    pub contours: bool,
    pub mesh: bool,
    pub boundaries: bool,
    pub points: bool,
    pub vectors: bool,
    pub probes: bool,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct PlanarVectorStyleState {
    pub length_mode: String,
    pub color_mode: String,
    pub scale: f64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct PlanarInteractionState {
    pub zoom: f64,
    pub pan_u_m: f64,
    pub pan_v_m: f64,
}

pub(crate) fn default_planar_visualization_state() -> PlanarVisualizationState {
    PlanarVisualizationState {
        source: PlanarSourceSelectionState::Default,
        default_slice: DefaultPlanarSliceState {
            plane: PlanarAxisPlane::Xy,
            position_fraction: 0.5,
            operator: DefaultPlanarOperatorState::PlaneSample,
        },
        view_scope: PlanarViewScopeState::MonitorTarget,
        quantity_id: "m".to_string(),
        component: PlanarFieldComponent::Magnitude,
        colormap: "viridis".to_string(),
        range: default_planar_color_range_state(),
        raster_opacity: default_planar_raster_opacity(),
        display_unit: None,
        resolution: PlanarResolutionPolicy {
            width: 512,
            height: 512,
            vector_budget: 2_000,
        },
        quality: PlanarRenderQuality::Interactive,
        layers: PlanarLayerState {
            bounds: false,
            raster: true,
            contours: false,
            mesh: true,
            boundaries: true,
            points: false,
            vectors: false,
            probes: true,
        },
        vector_style: PlanarVectorStyleState {
            length_mode: "uniform".to_string(),
            color_mode: "orientation".to_string(),
            scale: 1.0,
        },
        interaction: PlanarInteractionState {
            zoom: 1.0,
            pan_u_m: 0.0,
            pan_v_m: 0.0,
        },
    }
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
    Region,
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
    pub mesh_quality_metric: SliceMeshQualityMetric,
    pub mesh_color_scale: SliceMeshColorScale,
    pub mesh_filter_expression: String,
    pub mesh_shrink_factor: f64,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_quality_metric: Option<SliceMeshQualityMetric>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_color_scale: Option<SliceMeshColorScale>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_filter_expression: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_shrink_factor: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SliceMeshQualityMetric {
    Gamma,
    Sicn,
    Volume,
    Skewness,
    AspectRatio,
    MaxAngle,
    MinEdge,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SliceMeshColorScale {
    Jet,
    Viridis,
    Hot,
    Coolwarm,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantity: Option<VisualizationTargetQuantityOverride>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationTargetQuantityOverride {
    pub active_quantity_id: String,
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
                active_quantity_id: "H_demag".to_string(),
                visible: true,
                bounds_visible: false,
                bounds_opacity: 1.0,
                geometry_scope: VisualizationTargetGeometryScope::Full,
                opacity: 0.18,
                point_color: "var(--fm-info)".to_string(),
                point_opacity: 1.0,
                points_visible: false,
                render_mode: VisualizationTargetRenderMode::Off,
                scalar_color_palette: "viridis".to_string(),
                surface_color_source: SurfaceColorSource::Solid,
                surface_mono_color: "var(--fm-airbox-fill)".to_string(),
                surface_opacity: 0.18,
                surface_projection_mode: SurfaceFieldProjectionMode::RawNodal,
                surface_visible: false,
                viewport_colorbar_visible: false,
                vector_alpha: 1.0,
                vector_budget: DEFAULT_AIRBOX_VECTOR_BUDGET,
                vector_color_mode: VectorColorMode::Orientation,
                vector_length_scale: 1.0,
                vector_mono_color: "var(--fm-info)".to_string(),
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
    pub active_quantity_id: String,
    pub visible: bool,
    pub bounds_visible: bool,
    pub bounds_opacity: f64,
    pub geometry_scope: VisualizationTargetGeometryScope,
    /// Legacy compatibility projection of `surface_opacity`.
    pub opacity: f64,
    pub point_color: String,
    pub point_opacity: f64,
    pub points_visible: bool,
    pub render_mode: VisualizationTargetRenderMode,
    pub scalar_color_palette: String,
    pub surface_color_source: SurfaceColorSource,
    pub surface_mono_color: String,
    pub surface_opacity: f64,
    pub surface_projection_mode: SurfaceFieldProjectionMode,
    pub surface_visible: bool,
    pub viewport_colorbar_visible: bool,
    pub vector_alpha: f64,
    pub vector_budget: u32,
    pub vector_color_mode: VectorColorMode,
    pub vector_length_scale: f64,
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
    Off,
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
    pub scalar_color_palette: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_color_source: Option<SurfaceColorSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_projection_mode: Option<SurfaceFieldProjectionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_mono_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewport_colorbar_visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_color_mode: Option<VectorColorMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_mono_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_alpha: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_budget: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vector_length_scale: Option<f64>,
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

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SurfaceFieldProjectionMode {
    RawNodal,
    SurfaceFaces,
    ThicknessAverageZ,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, PartialEq)]
pub struct VisualizationDiagnostics {
    pub warnings: Vec<String>,
    pub degraded_reasons: Vec<String>,
}
