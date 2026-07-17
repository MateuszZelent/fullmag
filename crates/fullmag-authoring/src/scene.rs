use crate::{
    ScriptBuilderCurrentModuleState, ScriptBuilderExcitationAnalysisState,
    ScriptBuilderInitialState, ScriptBuilderMagneticInteractionEntry, ScriptBuilderMaterialState,
    ScriptBuilderMeshState, ScriptBuilderPerGeometryMeshState, ScriptBuilderSolverState,
    ScriptBuilderStageState, ScriptBuilderUniverseState, StudyPipelineDocument,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct SceneDocument {
    #[serde(default = "default_scene_version")]
    pub version: String,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub scene: SceneMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub universe: Option<ScriptBuilderUniverseState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<SceneObject>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub couplings: Vec<SceneCoupling>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials: Vec<SceneMaterialAsset>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub magnetization_assets: Vec<MagnetizationAsset>,
    #[serde(default)]
    pub field_drives: SceneFieldDrivesState,
    #[serde(default)]
    pub current_modules: SceneCurrentModulesState,
    #[serde(default)]
    pub study: SceneStudyState,
    #[serde(default)]
    pub outputs: SceneOutputsState,
    #[serde(default)]
    pub editor: SceneEditorState,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct SceneFieldDrivesState {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drives: Vec<fullmag_ir::RegionalFieldDriveIR>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SceneMetadata {
    #[serde(default)]
    pub id: String,
    #[serde(default = "default_scene_name")]
    pub name: String,
    #[serde(default = "default_source_of_truth")]
    pub source_of_truth: String,
    #[serde(default = "default_authoring_schema")]
    pub authoring_schema: String,
}

impl Default for SceneMetadata {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: default_scene_name(),
            source_of_truth: default_source_of_truth(),
            authoring_schema: default_authoring_schema(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct SceneObject {
    pub id: String,
    pub name: String,
    #[serde(default = "default_scene_object_role")]
    pub role: String,
    pub geometry: SceneGeometry,
    #[serde(default)]
    pub transform: Transform3D,
    pub material_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_ref: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub region_overrides: BTreeMap<String, SceneRegionOverride>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub physics_stack: Vec<ScriptBuilderMagneticInteractionEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_mesh: Option<ScriptBuilderPerGeometryMeshState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_override: Option<ScriptBuilderPerGeometryMeshState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub regions: Vec<SceneObjectRegion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allocated_region_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_parameter_fields: Vec<SceneMaterialParameterAssignment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default)]
    pub locked: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

fn default_scene_object_role() -> String {
    "magnet".to_string()
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct SceneRegionOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_ref: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct SceneMeshInterface {
    pub interface_id: String,
    pub owner_a: String,
    pub owner_b: String,
    #[serde(default)]
    pub config: ScriptBuilderPerGeometryMeshState,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct SceneGeometry {
    pub geometry_kind: String,
    #[serde(default)]
    pub geometry_params: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds_min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds_max: Option<[f64; 3]>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct Transform3D {
    #[serde(default = "zero_vec3")]
    pub translation: [f64; 3],
    #[serde(default = "identity_quat")]
    pub rotation_quat: [f64; 4],
    #[serde(default = "one_vec3")]
    pub scale: [f64; 3],
    #[serde(default = "zero_vec3")]
    pub pivot: [f64; 3],
}

impl Default for Transform3D {
    fn default() -> Self {
        Self {
            translation: [0.0, 0.0, 0.0],
            rotation_quat: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
            pivot: [0.0, 0.0, 0.0],
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct SceneMaterialAsset {
    pub id: String,
    pub name: String,
    pub properties: ScriptBuilderMaterialState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<SceneMaterialReference>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct SceneMaterialReference {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citation: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct MagnetizationAsset {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_index: Option<i64>,
    #[serde(default)]
    pub mapping: MagnetizationMapping,
    #[serde(default)]
    pub texture_transform: TextureTransform3D,
    // preset_texture fields
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_params: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct MagnetizationMapping {
    #[serde(default = "default_mapping_space")]
    pub space: String,
    #[serde(default = "default_mapping_projection")]
    pub projection: String,
    #[serde(default = "default_mapping_clamp_mode")]
    pub clamp_mode: String,
}

impl Default for MagnetizationMapping {
    fn default() -> Self {
        Self {
            space: default_mapping_space(),
            projection: default_mapping_projection(),
            clamp_mode: default_mapping_clamp_mode(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct TextureTransform3D {
    #[serde(default = "zero_vec3")]
    pub translation: [f64; 3],
    #[serde(default = "identity_quat")]
    pub rotation_quat: [f64; 4],
    #[serde(default = "one_vec3")]
    pub scale: [f64; 3],
    #[serde(default = "zero_vec3")]
    pub pivot: [f64; 3],
}

impl Default for TextureTransform3D {
    fn default() -> Self {
        Self {
            translation: [0.0, 0.0, 0.0],
            rotation_quat: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
            pivot: [0.0, 0.0, 0.0],
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct SceneCurrentModulesState {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modules: Vec<ScriptBuilderCurrentModuleState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excitation_analysis: Option<ScriptBuilderExcitationAnalysisState>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct SceneStudyState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(default = "default_auto")]
    pub requested_backend: String,
    #[serde(default = "default_auto")]
    pub requested_device: String,
    #[serde(default = "default_double")]
    pub requested_precision: String,
    #[serde(default = "default_strict")]
    pub requested_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_cpu_threads: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_demag_solver_policy: Option<fullmag_ir::FemLinearSolverPolicy>,
    #[serde(default = "default_true")]
    pub exchange_enabled: bool,
    #[serde(default = "default_true")]
    pub demag_enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_realization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_field: Option<[f64; 3]>,
    #[serde(default = "default_solver")]
    pub solver: ScriptBuilderSolverState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub universe_mesh: Option<ScriptBuilderUniverseState>,
    #[serde(default = "default_mesh")]
    pub shared_domain_mesh: ScriptBuilderMeshState,
    #[serde(default = "default_mesh")]
    pub mesh_defaults: ScriptBuilderMeshState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh_interfaces: Vec<SceneMeshInterface>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<ScriptBuilderStageState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_pipeline: Option<StudyPipelineDocument>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_state: Option<ScriptBuilderInitialState>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct SceneOutputsState {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct SceneMeshEntityViewState {
    #[serde(default = "default_true")]
    pub visible: bool,
    #[serde(default = "default_scene_mesh_render_mode")]
    pub render_mode: String,
    #[serde(default = "default_scene_mesh_opacity")]
    pub opacity: f64,
    #[serde(default = "default_scene_mesh_color_field")]
    pub color_field: String,
}

impl Default for SceneMeshEntityViewState {
    fn default() -> Self {
        Self {
            visible: default_true(),
            render_mode: default_scene_mesh_render_mode(),
            opacity: default_scene_mesh_opacity(),
            color_field: default_scene_mesh_color_field(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
pub struct VisualizationPresetRef {
    pub source: String,
    pub preset_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct VisualizationCameraState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projection: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub navigation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
}

impl Default for VisualizationCameraState {
    fn default() -> Self {
        Self {
            projection: None,
            navigation: None,
            preset: None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct VisualizationPresetFemState {
    #[serde(default = "default_scene_mesh_render_mode")]
    pub render_mode: String,
    #[serde(default = "default_scene_mesh_opacity")]
    pub opacity: f64,
    #[serde(default)]
    pub clip_enabled: bool,
    #[serde(default = "default_clip_axis")]
    pub clip_axis: String,
    #[serde(default = "default_clip_pos")]
    pub clip_pos: f64,
    #[serde(default = "default_true")]
    pub show_arrows: bool,
    #[serde(default = "default_preview_max_points")]
    pub max_points: i64,
    #[serde(default = "default_arrow_color_mode")]
    pub arrow_color_mode: String,
    #[serde(default = "default_arrow_mono_color")]
    pub arrow_mono_color: String,
    #[serde(default = "default_arrow_alpha")]
    pub arrow_alpha: f64,
    #[serde(default = "default_arrow_length_scale")]
    pub arrow_length_scale: f64,
    #[serde(default = "default_arrow_thickness")]
    pub arrow_thickness: f64,
    #[serde(default = "default_context")]
    pub object_view_mode: String,
    #[serde(default)]
    pub air_mesh_visible: bool,
    #[serde(default = "default_air_mesh_opacity")]
    pub air_mesh_opacity: f64,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mesh_entity_view_state: BTreeMap<String, SceneMeshEntityViewState>,
}

impl Default for VisualizationPresetFemState {
    fn default() -> Self {
        Self {
            render_mode: default_scene_mesh_render_mode(),
            opacity: default_scene_mesh_opacity(),
            clip_enabled: false,
            clip_axis: default_clip_axis(),
            clip_pos: default_clip_pos(),
            show_arrows: true,
            max_points: default_preview_max_points(),
            arrow_color_mode: default_arrow_color_mode(),
            arrow_mono_color: default_arrow_mono_color(),
            arrow_alpha: default_arrow_alpha(),
            arrow_length_scale: default_arrow_length_scale(),
            arrow_thickness: default_arrow_thickness(),
            object_view_mode: default_context(),
            air_mesh_visible: false,
            air_mesh_opacity: default_air_mesh_opacity(),
            mesh_entity_view_state: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct VisualizationPresetFdmState {
    #[serde(default = "default_quality_high")]
    pub quality: String,
    #[serde(default = "default_render_mode_glyph")]
    pub render_mode: String,
    #[serde(default = "default_orientation")]
    pub voxel_color_mode: String,
    #[serde(default = "default_sampling")]
    pub sampling: u32,
    #[serde(default = "default_fdm_brightness")]
    pub brightness: f64,
    #[serde(default = "default_fdm_voxel_opacity")]
    pub voxel_opacity: f64,
    #[serde(default = "default_fdm_voxel_gap")]
    pub voxel_gap: f64,
    #[serde(default = "default_fdm_voxel_threshold")]
    pub voxel_threshold: f64,
    #[serde(default)]
    pub topo_enabled: bool,
    #[serde(default = "default_topo_component")]
    pub topo_component: String,
    #[serde(default = "default_topo_multiplier")]
    pub topo_multiplier: f64,
}

impl Default for VisualizationPresetFdmState {
    fn default() -> Self {
        Self {
            quality: default_quality_high(),
            render_mode: default_render_mode_glyph(),
            voxel_color_mode: default_orientation(),
            sampling: default_sampling(),
            brightness: default_fdm_brightness(),
            voxel_opacity: default_fdm_voxel_opacity(),
            voxel_gap: default_fdm_voxel_gap(),
            voxel_threshold: default_fdm_voxel_threshold(),
            topo_enabled: false,
            topo_component: default_topo_component(),
            topo_multiplier: default_topo_multiplier(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct VisualizationPreset2DState {
    #[serde(default = "default_magnitude")]
    pub component: String,
    #[serde(default = "default_xy")]
    pub plane: String,
    #[serde(default)]
    pub slice_index: i64,
}

impl Default for VisualizationPreset2DState {
    fn default() -> Self {
        Self {
            component: default_magnitude(),
            plane: default_xy(),
            slice_index: 0,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct VisualizationPreset {
    pub id: String,
    pub name: String,
    #[serde(default = "default_view_mode_3d")]
    pub mode: String,
    #[serde(default = "default_domain_fem")]
    pub domain: String,
    #[serde(default = "default_quantity_m")]
    pub quantity: String,
    #[serde(default)]
    pub fem: VisualizationPresetFemState,
    #[serde(default)]
    pub fdm: VisualizationPresetFdmState,
    #[serde(default)]
    pub two_d: VisualizationPreset2DState,
    #[serde(default)]
    pub camera: VisualizationCameraState,
    #[serde(default)]
    pub created_at_unix_ms: i64,
    #[serde(default)]
    pub updated_at_unix_ms: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct SceneEditorState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_object_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gizmo_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform_space: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected_entity_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused_entity_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_view_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_mesh_visible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub air_mesh_opacity: Option<f64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mesh_entity_view_state: BTreeMap<String, SceneMeshEntityViewState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub visualization_presets: Vec<VisualizationPreset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_visualization_preset_ref: Option<VisualizationPresetRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_transform_scope: Option<String>,
}

impl Default for SceneEditorState {
    fn default() -> Self {
        Self {
            selected_object_id: None,
            gizmo_mode: None,
            transform_space: None,
            selected_entity_id: None,
            focused_entity_id: None,
            object_view_mode: Some("context".to_string()),
            air_mesh_visible: Some(true),
            air_mesh_opacity: Some(28.0),
            mesh_entity_view_state: BTreeMap::new(),
            visualization_presets: Vec::new(),
            active_visualization_preset_ref: None,
            active_transform_scope: None,
        }
    }
}

fn default_scene_version() -> String {
    "scene.v2".to_string()
}

fn default_scene_name() -> String {
    "Scene".to_string()
}

fn default_source_of_truth() -> String {
    "repo_head".to_string()
}

fn default_authoring_schema() -> String {
    "mesh-first-fem.v1".to_string()
}

const fn zero_vec3() -> [f64; 3] {
    [0.0, 0.0, 0.0]
}

const fn one_vec3() -> [f64; 3] {
    [1.0, 1.0, 1.0]
}

const fn identity_quat() -> [f64; 4] {
    [0.0, 0.0, 0.0, 1.0]
}

const fn default_true() -> bool {
    true
}

fn default_mapping_space() -> String {
    "object".to_string()
}

fn default_mapping_projection() -> String {
    "object_local".to_string()
}

fn default_mapping_clamp_mode() -> String {
    "none".to_string()
}

fn default_scene_mesh_render_mode() -> String {
    "surface".to_string()
}

const fn default_scene_mesh_opacity() -> f64 {
    100.0
}

fn default_scene_mesh_color_field() -> String {
    "orientation".to_string()
}

fn default_clip_axis() -> String {
    "x".to_string()
}

const fn default_clip_pos() -> f64 {
    50.0
}

const fn default_preview_max_points() -> i64 {
    16_384
}

fn default_arrow_color_mode() -> String {
    "orientation".to_string()
}

fn default_arrow_mono_color() -> String {
    "#00c2ff".to_string()
}

const fn default_arrow_alpha() -> f64 {
    1.0
}

const fn default_arrow_length_scale() -> f64 {
    1.0
}

const fn default_arrow_thickness() -> f64 {
    1.0
}

fn default_context() -> String {
    "context".to_string()
}

const fn default_air_mesh_opacity() -> f64 {
    28.0
}

fn default_quality_high() -> String {
    "high".to_string()
}

fn default_render_mode_glyph() -> String {
    "glyph".to_string()
}

fn default_orientation() -> String {
    "orientation".to_string()
}

const fn default_sampling() -> u32 {
    1
}

const fn default_fdm_brightness() -> f64 {
    1.5
}

const fn default_fdm_voxel_opacity() -> f64 {
    0.5
}

const fn default_fdm_voxel_gap() -> f64 {
    0.14
}

const fn default_fdm_voxel_threshold() -> f64 {
    0.08
}

fn default_topo_component() -> String {
    "z".to_string()
}

const fn default_topo_multiplier() -> f64 {
    5.0
}

fn default_magnitude() -> String {
    "magnitude".to_string()
}

fn default_xy() -> String {
    "xy".to_string()
}

fn default_view_mode_3d() -> String {
    "3D".to_string()
}

fn default_domain_fem() -> String {
    "fem".to_string()
}

fn default_quantity_m() -> String {
    "m".to_string()
}

fn default_auto() -> String {
    "auto".to_string()
}

fn default_double() -> String {
    "double".to_string()
}

fn default_strict() -> String {
    "strict".to_string()
}

fn default_solver() -> ScriptBuilderSolverState {
    ScriptBuilderSolverState {
        integrator: String::new(),
        fixed_timestep: String::new(),
        dt_initial: String::new(),
        dt_min: String::new(),
        dt_max: String::new(),
        max_err: String::new(),
        adaptive_timestep: None,
        demag_interval_s: String::new(),
        relax_algorithm: String::new(),
        torque_tolerance: String::new(),
        energy_tolerance: String::new(),
        max_relax_steps: String::new(),
    }
}

fn default_mesh() -> ScriptBuilderMeshState {
    ScriptBuilderMeshState {
        algorithm_2d: 6,
        algorithm_3d: 1,
        size_mode: Some("predefined".to_string()),
        hmax: String::new(),
        hmin: String::new(),
        maximum_element_size: Some(String::new()),
        minimum_element_size: Some(String::new()),
        calibrate_for: Some("general_physics".to_string()),
        size_preset: Some("normal".to_string()),
        size_factor: 1.0,
        size_from_curvature: 0,
        curvature_factor: Some(String::new()),
        growth_rate: String::new(),
        maximum_element_growth_rate: Some(String::new()),
        narrow_regions: 0,
        narrow_region_resolution: Some(String::new()),
        resolved_size_from_curvature: None,
        resolved_narrow_regions: None,
        resolved_growth_rate: None,
        smoothing_steps: 1,
        optimize: String::new(),
        optimize_iterations: 1,
        compute_quality: false,
        per_element_quality: false,
        interface_hmax: None,
        interface_thickness: None,
        transition_distance: None,
        transition_growth: None,
        adaptive_enabled: false,
        adaptive_policy: "manual".to_string(),
        adaptive_indicator: Some("geometric_only".to_string()),
        adaptive_target_quantity: Some("auto".to_string()),
        adaptive_convergence_metric: Some("energy_delta".to_string()),
        adaptive_theta: 0.3,
        adaptive_h_min: String::new(),
        adaptive_h_max: String::new(),
        adaptive_max_passes: 5,
        adaptive_error_tolerance: String::new(),
    }
}

// Strongly typed Scene Document region structures

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, utoipa::ToSchema)]
pub struct SceneObjectRegion {
    #[serde(default)]
    pub region_id: String,
    #[serde(default)]
    pub owner_object: String,
    pub name: String,
    pub shape: SceneRegionShape,
    #[serde(default)]
    pub frame: SceneRegionFrame,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub priority: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_policy: Option<SceneRegionMeshPolicy>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_overrides: Vec<SceneRegionMaterialOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_override: Option<SceneTextureOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_transition: Option<SceneMaterialTransition>,
    #[serde(default)]
    pub realization_policy: SceneRegionRealizationPolicy,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneRegionShape {
    Box {
        size: [f64; 3],
        center: [f64; 3],
    },
    Cylinder {
        radius: f64,
        height: f64,
        center: [f64; 3],
        axis: [f64; 3],
    },
    Sphere {
        radius: f64,
        center: [f64; 3],
    },
    Csg {
        #[schema(value_type = Object)]
        expression: Box<fullmag_ir::GeometryEntryIR>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneRegionFrame {
    #[default]
    Object,
    World,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneRegionRealizationPolicy {
    #[default]
    Inherit,
    Conformal,
    Project,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
pub struct SceneRegionMeshPolicy {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_element_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_element_size: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneMaterialTransition {
    MeshRelative {
        cells: u32,
        #[serde(default)]
        scope: SceneMaterialTransitionScope,
    },
    Metric {
        width: f64,
        #[serde(default)]
        scope: SceneMaterialTransitionScope,
    },
    Sharp,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneMaterialTransitionScope {
    #[default]
    Boundary,
    Inside,
    Outside,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
pub struct SceneRegionMaterialOverride {
    pub parameter: SceneMaterialParameterName,
    pub value: SceneMaterialParameterField,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub conflict_policy: SceneRegionConflictPolicy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneMaterialParameterName {
    #[serde(alias = "Ms", alias = "ms")]
    Ms,
    #[serde(alias = "Aex", alias = "aex")]
    Aex,
    #[serde(alias = "Alpha", alias = "alpha")]
    Alpha,
    #[serde(alias = "Ku1", alias = "ku1")]
    Ku1,
    #[serde(alias = "Ku2", alias = "ku2")]
    Ku2,
    #[serde(
        alias = "AnisotropyAxis",
        alias = "anisotropyAxis",
        alias = "anisotropy_axis"
    )]
    AnisotropyAxis,
    #[serde(alias = "Kc1", alias = "kc1")]
    Kc1,
    #[serde(alias = "Kc2", alias = "kc2")]
    Kc2,
    #[serde(alias = "Kc3", alias = "kc3")]
    Kc3,
    #[serde(alias = "Dind", alias = "dind")]
    Dind,
    #[serde(alias = "Dbulk", alias = "dbulk")]
    Dbulk,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
#[serde(untagged)]
pub enum SceneMaterialParameterValue {
    Scalar(f64),
    Vector([f64; 3]),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneMaterialParameterField {
    Constant {
        value: SceneMaterialParameterValue,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    Linear {
        base: f64,
        gradient: [f64; 3],
        #[serde(default)]
        frame: SceneRegionFrame,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    Radial {
        center: [f64; 3],
        radius: f64,
        inside: f64,
        outside: f64,
        #[serde(default)]
        frame: SceneRegionFrame,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        unit: Option<String>,
    },
    Sampled {
        asset_id: String,
        component_count: u32,
        location: SceneMaterialFieldLocation,
        unit: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneMaterialFieldLocation {
    Cell,
    Node,
    Element,
    Quadrature,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneRegionConflictPolicy {
    #[default]
    Error,
    #[serde(rename = "higher_priority_wins")]
    HigherPriorityWins,
    #[serde(rename = "min_mesh_size_wins")]
    MinMeshSizeWins,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
pub struct SceneTextureOverride {
    pub initial_magnetization: SceneInitialMagnetization,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneInitialMagnetization {
    Uniform {
        value: [f64; 3],
    },
    #[serde(alias = "random")]
    RandomSeeded {
        seed: u64,
    },
    SampledField {
        values: Vec<[f64; 3]>,
    },
    PresetTexture {
        preset_kind: String,
        #[serde(default, alias = "params")]
        preset_params: BTreeMap<String, serde_json::Value>,
        #[serde(default)]
        mapping: SceneTextureMapping,
        #[serde(default)]
        texture_transform: SceneTextureTransform3D,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
pub struct SceneTextureMapping {
    #[serde(default = "default_mapping_space")]
    pub space: String,
    #[serde(default = "default_mapping_projection")]
    pub projection: String,
    #[serde(default = "default_mapping_clamp_mode")]
    pub clamp_mode: String,
}

impl Default for SceneTextureMapping {
    fn default() -> Self {
        Self {
            space: default_mapping_space(),
            projection: default_mapping_projection(),
            clamp_mode: default_mapping_clamp_mode(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
pub struct SceneTextureTransform3D {
    #[serde(default = "zero_vec3")]
    pub translation: [f64; 3],
    #[serde(default = "identity_quat")]
    pub rotation_quat: [f64; 4],
    #[serde(default = "one_vec3")]
    pub scale: [f64; 3],
    #[serde(default = "zero_vec3")]
    pub pivot: [f64; 3],
}

impl Default for SceneTextureTransform3D {
    fn default() -> Self {
        Self {
            translation: [0.0, 0.0, 0.0],
            rotation_quat: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0, 1.0, 1.0],
            pivot: [0.0, 0.0, 0.0],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
pub struct SceneMaterialParameterAssignment {
    pub assignment_id: String,
    pub owner_object: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_id: Option<String>,
    pub parameter: SceneMaterialParameterName,
    pub value: SceneMaterialParameterField,
    #[serde(default)]
    pub priority: i32,
    #[serde(default)]
    pub conflict_policy: SceneRegionConflictPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
pub struct SceneCoupling {
    pub coupling_id: String,
    pub kind: SceneCouplingKind,
    pub source: SceneCouplingEndpoint,
    pub target: SceneCouplingEndpoint,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub parameters: SceneCouplingParameters,
    #[serde(default)]
    pub capability_policy: SceneCouplingCapabilityPolicy,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneCouplingKind {
    Exchange,
    Rkky,
    InterlayerExchange,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneCouplingEndpoint {
    Object { object: String },
    Region { object: String, region_id: String },
    Surface { object: String, selector: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, utoipa::ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SceneCouplingParameters {
    Exchange {
        mode: SceneExchangeCouplingMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        scale: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        inter_exchange: Option<f64>,
    },
    Rkky {
        #[serde(alias = "J1")]
        j1: f64,
    },
    InterlayerExchange {
        #[serde(alias = "J1")]
        j1: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        j2: Option<f64>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneExchangeCouplingMode {
    HarmonicMean,
    Explicit,
    Disabled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default, utoipa::ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum SceneCouplingCapabilityPolicy {
    #[default]
    RequireRuntime,
    AuthoredOnly,
}
