use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::scene::{MagnetizationMapping, TextureTransform3D};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderSolverState {
    #[serde(default = "default_solver_integrator")]
    pub integrator: String,
    #[serde(default = "default_solver_timestep")]
    pub fixed_timestep: String,
    #[serde(default = "default_solver_relax_algorithm")]
    pub relax_algorithm: String,
    #[serde(default = "default_solver_torque_tol")]
    pub torque_tolerance: String,
    #[serde(default = "default_solver_energy_tol")]
    pub energy_tolerance: String,
    #[serde(default = "default_solver_max_steps")]
    pub max_relax_steps: String,
}

impl Default for ScriptBuilderSolverState {
    fn default() -> Self {
        Self {
            integrator: default_solver_integrator(),
            fixed_timestep: default_solver_timestep(),
            relax_algorithm: default_solver_relax_algorithm(),
            torque_tolerance: default_solver_torque_tol(),
            energy_tolerance: default_solver_energy_tol(),
            max_relax_steps: default_solver_max_steps(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderMeshState {
    #[serde(default = "default_mesh_algo_2d")]
    pub algorithm_2d: i64,
    #[serde(default = "default_mesh_algo_3d")]
    pub algorithm_3d: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_mode: Option<String>,
    #[serde(default)]
    pub hmax: String,
    #[serde(default)]
    pub hmin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_element_size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_element_size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibrate_for: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_preset: Option<String>,
    #[serde(default = "default_mesh_size_factor")]
    pub size_factor: f64,
    #[serde(default)]
    pub size_from_curvature: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curvature_factor: Option<String>,
    #[serde(default)]
    pub growth_rate: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_element_growth_rate: Option<String>,
    #[serde(default)]
    pub narrow_regions: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrow_region_resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_size_from_curvature: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_narrow_regions: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_growth_rate: Option<String>,
    #[serde(default = "default_mesh_smoothing")]
    pub smoothing_steps: i64,
    #[serde(default)]
    pub optimize: String,
    #[serde(default = "default_mesh_opt_iters")]
    pub optimize_iterations: i64,
    #[serde(default)]
    pub compute_quality: bool,
    #[serde(default)]
    pub per_element_quality: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface_hmax: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface_thickness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_growth: Option<String>,
    #[serde(default)]
    pub adaptive_enabled: bool,
    #[serde(default = "default_adaptive_mesh_policy")]
    pub adaptive_policy: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_indicator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_target_quantity: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_convergence_metric: Option<String>,
    #[serde(default = "default_adaptive_mesh_theta")]
    pub adaptive_theta: f64,
    #[serde(default)]
    pub adaptive_h_min: String,
    #[serde(default)]
    pub adaptive_h_max: String,
    #[serde(default = "default_adaptive_mesh_max_passes")]
    pub adaptive_max_passes: u32,
    #[serde(default)]
    pub adaptive_error_tolerance: String,
}

impl Default for ScriptBuilderMeshState {
    fn default() -> Self {
        Self {
            algorithm_2d: default_mesh_algo_2d(),
            algorithm_3d: default_mesh_algo_3d(),
            size_mode: None,
            hmax: String::new(),
            hmin: String::new(),
            maximum_element_size: None,
            minimum_element_size: None,
            calibrate_for: None,
            size_preset: None,
            size_factor: default_mesh_size_factor(),
            size_from_curvature: 0,
            curvature_factor: None,
            growth_rate: String::new(),
            maximum_element_growth_rate: None,
            narrow_regions: 0,
            narrow_region_resolution: None,
            resolved_size_from_curvature: None,
            resolved_narrow_regions: None,
            resolved_growth_rate: None,
            smoothing_steps: default_mesh_smoothing(),
            optimize: String::new(),
            optimize_iterations: default_mesh_opt_iters(),
            compute_quality: false,
            per_element_quality: false,
            interface_hmax: None,
            interface_thickness: None,
            transition_distance: None,
            transition_growth: None,
            adaptive_enabled: false,
            adaptive_policy: default_adaptive_mesh_policy(),
            adaptive_indicator: None,
            adaptive_target_quantity: None,
            adaptive_convergence_metric: None,
            adaptive_theta: default_adaptive_mesh_theta(),
            adaptive_h_min: String::new(),
            adaptive_h_max: String::new(),
            adaptive_max_passes: default_adaptive_mesh_max_passes(),
            adaptive_error_tolerance: String::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderMeshSizeFieldState {
    pub kind: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderMeshOperationState {
    pub kind: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderUniverseState {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_hmax: Option<f64>,
    // --- Commit 3: first-class mesh semantics ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_hmin: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_growth_rate: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct DomainFrameDeclaredUniverseState {
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub center: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub airbox_hmax: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct DomainFrameState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub declared_universe: Option<DomainFrameDeclaredUniverseState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_bounds_min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_bounds_max: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_bounds_min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_bounds_max: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_extent: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_center: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_source: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderStageState {
    pub kind: String,
    pub entrypoint_kind: String,
    #[serde(default)]
    pub integrator: String,
    #[serde(default)]
    pub fixed_timestep: String,
    #[serde(default)]
    pub until_seconds: String,
    #[serde(default)]
    pub relax_algorithm: String,
    #[serde(default)]
    pub torque_tolerance: String,
    #[serde(default)]
    pub energy_tolerance: String,
    #[serde(default)]
    pub max_steps: String,
    /// Eigenmode fields — only meaningful when kind == "eigenmodes"
    #[serde(default)]
    pub eigen_count: String,
    #[serde(default)]
    pub eigen_target: String,
    #[serde(default)]
    pub eigen_include_demag: bool,
    #[serde(default)]
    pub eigen_equilibrium_source: String,
    #[serde(default)]
    pub eigen_normalization: String,
    #[serde(default)]
    pub eigen_target_frequency: String,
    #[serde(default)]
    pub eigen_damping_policy: String,
    #[serde(default)]
    pub eigen_k_vector: String,
    #[serde(default)]
    pub eigen_spin_wave_bc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eigen_spin_wave_bc_config: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StudyPrimitiveStageKind {
    Relax,
    Run,
    Eigenmodes,
    SetField,
    SetCurrent,
    SaveState,
    LoadState,
    Export,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StudyMacroStageKind {
    HysteresisLoop,
    FieldSweepRelax,
    FieldSweepRelaxSnapshot,
    RelaxRun,
    RelaxEigenmodes,
    ParameterSweep,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StudyPipelineNodeSource {
    UiAuthored,
    ScriptImported,
    MacroGenerated,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct PrimitiveStageNode {
    pub id: String,
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<StudyPipelineNodeSource>,
    pub stage_kind: StudyPrimitiveStageKind,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub payload: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct MacroStageNode {
    pub id: String,
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<StudyPipelineNodeSource>,
    pub macro_kind: StudyMacroStageKind,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub config: BTreeMap<String, Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct StageGroupNode {
    pub id: String,
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<StudyPipelineNodeSource>,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<StudyPipelineNode>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(tag = "node_kind", rename_all = "snake_case")]
pub enum StudyPipelineNode {
    Primitive(PrimitiveStageNode),
    Macro(MacroStageNode),
    Group(StageGroupNode),
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct StudyPipelineDocument {
    #[serde(default = "default_study_pipeline_version")]
    pub version: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nodes: Vec<StudyPipelineNode>,
}

impl Default for StudyPipelineDocument {
    fn default() -> Self {
        Self {
            version: default_study_pipeline_version(),
            nodes: Vec::new(),
        }
    }
}

pub type StudyDocumentV2 = StudyPipelineDocument;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderInitialState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnet_name: Option<String>,
    pub source_path: String,
    pub format: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_index: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderMaterialState {
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "Ms")]
    pub ms: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "Aex")]
    pub aex: Option<f64>,
    #[serde(default)]
    pub alpha: f64,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "Dind")]
    pub dind: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ScriptBuilderMagneticInteractionKind {
    Exchange,
    Demag,
    InterfacialDmi,
    UniaxialAnisotropy,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderMagneticInteractionEntry {
    pub kind: ScriptBuilderMagneticInteractionKind,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderMagnetizationState {
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mapping: Option<MagnetizationMapping>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_transform: Option<TextureTransform3D>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_params: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_label: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderPerGeometryMeshState {
    #[serde(default = "default_inherit_mesh_mode")]
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_mode: Option<String>,
    #[serde(default)]
    pub hmax: String,
    #[serde(default)]
    pub hmin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_element_size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_element_size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calibrate_for: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_preset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithm_2d: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithm_3d: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_factor: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_from_curvature: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub curvature_factor: Option<String>,
    #[serde(default)]
    pub growth_rate: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maximum_element_growth_rate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrow_regions: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub narrow_region_resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_size_from_curvature: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_narrow_regions: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_growth_rate: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smoothing_steps: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optimize: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub optimize_iterations: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compute_quality: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub per_element_quality: Option<bool>,
    // --- Commit 3: first-class mesh semantics ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bulk_hmax: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bulk_hmin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface_hmax: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface_thickness: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_distance: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_growth: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub size_fields: Vec<ScriptBuilderMeshSizeFieldState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operations: Vec<ScriptBuilderMeshOperationState>,
    #[serde(default)]
    pub build_requested: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderGeometryEntry {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_name: Option<String>,
    pub geometry_kind: String,
    #[serde(default)]
    pub geometry_params: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds_min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds_max: Option<[f64; 3]>,
    pub material: ScriptBuilderMaterialState,
    pub magnetization: ScriptBuilderMagnetizationState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub physics_stack: Vec<ScriptBuilderMagneticInteractionEntry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh: Option<ScriptBuilderPerGeometryMeshState>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderDriveState {
    pub current_a: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frequency_hz: Option<f64>,
    #[serde(default)]
    pub phase_rad: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waveform: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderCurrentModuleState {
    pub kind: String,
    pub name: String,
    pub solver: String,
    pub air_box_factor: f64,
    pub antenna_kind: String,
    #[serde(default)]
    pub antenna_params: Value,
    pub drive: ScriptBuilderDriveState,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderExcitationAnalysisState {
    pub source: String,
    pub method: String,
    pub propagation_axis: [f64; 3],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub k_max_rad_per_m: Option<f64>,
    pub samples: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct ScriptBuilderState {
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_realization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_field: Option<[f64; 3]>,
    pub solver: ScriptBuilderSolverState,
    pub mesh: ScriptBuilderMeshState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub universe: Option<ScriptBuilderUniverseState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_frame: Option<DomainFrameState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<ScriptBuilderStageState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_pipeline: Option<StudyPipelineDocument>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_state: Option<ScriptBuilderInitialState>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub geometries: Vec<ScriptBuilderGeometryEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub current_modules: Vec<ScriptBuilderCurrentModuleState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excitation_analysis: Option<ScriptBuilderExcitationAnalysisState>,
}

fn default_inherit_mesh_mode() -> String {
    "inherit".to_string()
}

const fn default_true() -> bool {
    true
}

fn default_study_pipeline_version() -> String {
    "study_pipeline.v1".to_string()
}

fn default_adaptive_mesh_policy() -> String {
    "manual".to_string()
}

const fn default_adaptive_mesh_theta() -> f64 {
    0.3
}

const fn default_adaptive_mesh_max_passes() -> u32 {
    5
}

// --- ScriptBuilderSolverState defaults ---

fn default_solver_integrator() -> String {
    "rkf45".to_string()
}

fn default_solver_timestep() -> String {
    "1e-13".to_string()
}

fn default_solver_relax_algorithm() -> String {
    "llg_overdamped".to_string()
}

fn default_solver_torque_tol() -> String {
    "1e-5".to_string()
}

fn default_solver_energy_tol() -> String {
    "1e-8".to_string()
}

fn default_solver_max_steps() -> String {
    "100000".to_string()
}

// --- ScriptBuilderMeshState defaults ---

const fn default_mesh_algo_2d() -> i64 {
    6 // Frontal-Delaunay
}

const fn default_mesh_algo_3d() -> i64 {
    1 // Delaunay
}

const fn default_mesh_size_factor() -> f64 {
    1.0
}

const fn default_mesh_smoothing() -> i64 {
    1
}

const fn default_mesh_opt_iters() -> i64 {
    1
}
