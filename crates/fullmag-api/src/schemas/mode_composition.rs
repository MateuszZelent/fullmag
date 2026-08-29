use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct ModeCompositionResource {
    pub schema_version: String,
    pub revision: u64,
    pub composition_id: String,
    /// Runtime identity that owns this ephemeral visualization resource. It is
    /// intentionally distinct from the immutable mode-artifact identity.
    pub lifecycle: ModeCompositionLifecycle,
    pub run_id: String,
    pub stage_id: String,
    pub artifact_revision: String,
    pub phase_clock: ModeCompositionPhaseClock,
    pub layers: Vec<ModeCompositionLayer>,
}

impl Default for ModeCompositionResource {
    fn default() -> Self {
        Self {
            schema_version: "mode-composition.v1".to_string(),
            revision: 0,
            composition_id: "active".to_string(),
            lifecycle: ModeCompositionLifecycle::default(),
            run_id: String::new(),
            stage_id: String::new(),
            artifact_revision: String::new(),
            phase_clock: ModeCompositionPhaseClock::default(),
            layers: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ToSchema, Default)]
pub struct ModeCompositionLifecycle {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub artifact_revision: u64,
    pub mesh_revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct ModeCompositionPhaseClock {
    pub synchronized: bool,
    pub master_rate_hz: f64,
}

impl Default for ModeCompositionPhaseClock {
    fn default() -> Self {
        Self {
            synchronized: true,
            master_rate_hz: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct EigenModeResourceRef {
    pub run_id: String,
    pub stage_id: String,
    pub artifact_revision: String,
    pub sample_id: String,
    pub mode_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_mode_index: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct ModeCompositionLayer {
    pub layer_id: String,
    pub target_id: String,
    pub object_id: String,
    pub enabled: bool,
    pub mode: EigenModeResourceRef,
    pub field_id: String,
    pub representation: ModeFieldRepresentation,
    pub component: ModeFieldComponent,
    pub phase_rad: f64,
    pub amplitude_scale: f64,
    pub normalization: ModeFieldNormalization,
    pub animation: ModeLayerAnimation,
    pub appearance: ModeLayerAppearance,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModeFieldRepresentation {
    PhaseRotatedReal,
    Real,
    Imag,
    Abs,
    Phase,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModeFieldComponent {
    Vector,
    Magnitude,
    X,
    Y,
    Z,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModeFieldNormalization {
    ModeGlobalMax,
    ObjectMax,
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct ModeLayerAnimation {
    pub enabled: bool,
    pub rate_hz: f64,
    pub phase_offset_rad: f64,
    pub synchronized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct ModeLayerAppearance {
    pub colormap: String,
    pub auto_range: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_max: Option<f64>,
    pub symmetric_zero: bool,
    pub opacity: f64,
    pub colorbar_visible: bool,
    pub vectors_visible: bool,
    pub vector_budget: u32,
    pub vector_length_scale: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct ModeCompositionPatch {
    pub base_revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dataset: Option<ModeCompositionDatasetPatch>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase_clock: Option<ModeCompositionPhaseClock>,
    #[serde(default)]
    pub operations: Vec<ModeCompositionOperation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
pub struct ModeCompositionDatasetPatch {
    pub run_id: String,
    pub stage_id: String,
    pub artifact_revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ModeCompositionOperation {
    UpsertLayer { layer: ModeCompositionLayer },
    RemoveLayer { layer_id: String },
    ClearLayers,
}
