use crate::{
    SceneCurrentTransport, SceneOerstedField, SceneSpinTorque, SceneSpinTransport,
    ScriptBuilderCurrentModuleState, ScriptBuilderExcitationAnalysisState,
    ScriptBuilderAdaptiveTimestepState, ScriptBuilderFdmDemagState, ScriptBuilderFdmGridState,
    ScriptBuilderInitialState,
    ScriptBuilderMagneticInteractionEntry, ScriptBuilderMaterialState, ScriptBuilderMeshState,
    ScriptBuilderPerGeometryMeshState, ScriptBuilderSolverState,
    ScriptBuilderUniverseState, StudyPipelineDocument,
};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(deny_unknown_fields)]
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
    pub monitors: SceneMonitorState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selections: Vec<fullmag_ir::SelectionDefinitionIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub magnetization_constraints: Vec<fullmag_ir::MagnetizationConstraintIR>,
    #[serde(default)]
    pub current_modules: SceneCurrentModulesState,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub current_transports: Vec<SceneCurrentTransport>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spin_transports: Vec<SceneSpinTransport>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spin_torques: Vec<SceneSpinTorque>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub oersted_fields: Vec<SceneOerstedField>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub antenna_port_modes: Vec<fullmag_ir::AntennaPortModeIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub antenna_field_solve_stages: Vec<fullmag_ir::AntennaFieldSolveStageIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub antenna_target_projections: Vec<fullmag_ir::AntennaTargetProjectionRefIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub solved_antenna_drives: Vec<fullmag_ir::SolvedAntennaDriveIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub antenna_spectrum_requests: Vec<fullmag_ir::AntennaSpectrumRequestIR>,
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

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(deny_unknown_fields)]
pub struct SceneMonitorState {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub planar: Vec<fullmag_ir::PlanarMonitorIR>,
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
    pub absorbing_boundary: Option<fullmag_ir::AbsorbingBoundaryLayerIR>,
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
#[serde(deny_unknown_fields)]
pub struct SceneCurrentModulesState {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modules: Vec<ScriptBuilderCurrentModuleState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub excitation_analysis: Option<ScriptBuilderExcitationAnalysisState>,
}

/// A stage scalar that is numeric in the canonical scene representation.
///
/// `LegacyText` is retained only to read older script-builder archives. Valid
/// legacy numeric text is normalized to `Number`; invalid text stays visible
/// so validation can reject it without silently discarding the authored draft.
#[derive(Debug, Clone, PartialEq)]
pub enum SceneStageF64 {
    Number(f64),
    LegacyText(String),
}

impl Default for SceneStageF64 {
    fn default() -> Self {
        Self::LegacyText(String::new())
    }
}

impl SceneStageF64 {
    fn is_unset(&self) -> bool {
        matches!(self, Self::LegacyText(value) if value.is_empty())
    }

    fn from_builder_text(value: &str) -> Self {
        value
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .map(Self::Number)
            .unwrap_or_else(|| Self::LegacyText(value.to_string()))
    }

    fn to_builder_text(&self) -> String {
        match self {
            Self::Number(value) => value.to_string(),
            Self::LegacyText(value) => value.clone(),
        }
    }
}

impl Serialize for SceneStageF64 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Number(value) => serializer.serialize_f64(*value),
            Self::LegacyText(value) => serializer.serialize_str(value),
        }
    }
}

impl<'de> Deserialize<'de> for SceneStageF64 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match Value::deserialize(deserializer)? {
            Value::Number(number) => number
                .as_f64()
                .filter(|value| value.is_finite())
                .map(Self::Number)
                .ok_or_else(|| serde::de::Error::custom("expected a finite number")),
            Value::String(text) => match text.trim().parse::<f64>() {
                Ok(value) if value.is_finite() => Ok(Self::Number(value)),
                _ => Ok(Self::LegacyText(text)),
            },
            _ => Err(serde::de::Error::custom(
                "expected a number or legacy builder text",
            )),
        }
    }
}

/// Unsigned integer counterpart to [`SceneStageF64`]. Fractional, negative,
/// and overflowing JSON numbers remain invalid; legacy string drafts are kept.
#[derive(Debug, Clone, PartialEq)]
pub enum SceneStageU64 {
    Number(u64),
    LegacyText(String),
}

impl Default for SceneStageU64 {
    fn default() -> Self {
        Self::LegacyText(String::new())
    }
}

impl SceneStageU64 {
    fn is_unset(&self) -> bool {
        matches!(self, Self::LegacyText(value) if value.is_empty())
    }

    fn from_builder_text(value: &str) -> Self {
        value
            .trim()
            .parse::<u64>()
            .map(Self::Number)
            .unwrap_or_else(|_| Self::LegacyText(value.to_string()))
    }

    fn to_builder_text(&self) -> String {
        match self {
            Self::Number(value) => value.to_string(),
            Self::LegacyText(value) => value.clone(),
        }
    }
}

impl Serialize for SceneStageU64 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Number(value) => serializer.serialize_u64(*value),
            Self::LegacyText(value) => serializer.serialize_str(value),
        }
    }
}

impl<'de> Deserialize<'de> for SceneStageU64 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match Value::deserialize(deserializer)? {
            Value::Number(number) if number.is_u64() => number
                .as_u64()
                .map(Self::Number)
                .ok_or_else(|| serde::de::Error::custom("expected an unsigned integer")),
            Value::Number(_) => Err(serde::de::Error::custom(
                "expected an unsigned integer",
            )),
            Value::String(text) => match text.trim().parse::<u64>() {
                Ok(value) => Ok(Self::Number(value)),
                Err(_) => Ok(Self::LegacyText(text)),
            },
            _ => Err(serde::de::Error::custom(
                "expected an unsigned integer or legacy builder text",
            )),
        }
    }
}

/// A numeric eigenmode wave vector with a string-only archive compatibility
/// path. Invalid legacy text is retained for editing but cannot be exported.
#[derive(Debug, Clone, PartialEq)]
pub enum SceneStageVec3 {
    Vector([f64; 3]),
    LegacyText(String),
}

impl Default for SceneStageVec3 {
    fn default() -> Self {
        Self::LegacyText(String::new())
    }
}

impl SceneStageVec3 {
    fn is_unset(&self) -> bool {
        matches!(self, Self::LegacyText(value) if value.is_empty())
    }

    fn from_builder_text(value: &str) -> Self {
        parse_scene_stage_vec3_text(value)
            .map(Self::Vector)
            .unwrap_or_else(|| Self::LegacyText(value.to_string()))
    }

    fn to_builder_text(&self) -> String {
        match self {
            Self::Vector([x, y, z]) => format!("{},{},{}", x, y, z),
            Self::LegacyText(value) => value.clone(),
        }
    }

    pub(crate) fn is_valid_or_empty(&self) -> bool {
        match self {
            Self::Vector(value) => value.iter().all(|component| component.is_finite()),
            Self::LegacyText(text) if text.trim().is_empty() => true,
            Self::LegacyText(text) => parse_scene_stage_vec3_text(text).is_some(),
        }
    }
}

fn parse_scene_stage_vec3_text(value: &str) -> Option<[f64; 3]> {
    let trimmed = value.trim();
    let components = trimmed
        .strip_prefix('(')
        .and_then(|value| value.strip_suffix(')'))
        .unwrap_or(trimmed)
        .split(',')
        .map(str::trim)
        .collect::<Vec<_>>();
    if components.len() != 3 {
        return None;
    }
    let parsed = [
        components[0].parse::<f64>().ok()?,
        components[1].parse::<f64>().ok()?,
        components[2].parse::<f64>().ok()?,
    ];
    parsed.iter().all(|value| value.is_finite()).then_some(parsed)
}

impl Serialize for SceneStageVec3 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Vector(value) => value.serialize(serializer),
            Self::LegacyText(value) => serializer.serialize_str(value),
        }
    }
}

impl<'de> Deserialize<'de> for SceneStageVec3 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match Value::deserialize(deserializer)? {
            Value::Array(values) if values.len() == 3 => {
                let mut components = [0.0; 3];
                for (index, value) in values.into_iter().enumerate() {
                    components[index] = value
                        .as_f64()
                        .filter(|component| component.is_finite())
                        .ok_or_else(|| {
                            serde::de::Error::custom("expected three finite vector components")
                        })?;
                }
                Ok(Self::Vector(components))
            }
            Value::Array(_) => Err(serde::de::Error::custom(
                "expected a vector with exactly three components",
            )),
            Value::String(text) => Ok(parse_scene_stage_vec3_text(&text)
                .map(Self::Vector)
                .unwrap_or_else(|| Self::LegacyText(text))),
            _ => Err(serde::de::Error::custom(
                "expected a numeric vector or legacy builder text",
            )),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
pub struct SceneStageAdaptiveTimestepState {
    #[serde(default = "default_scene_stage_adaptive_tolerance_mode")]
    pub tolerance_mode: String,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub atol: SceneStageF64,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub rtol: SceneStageF64,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub dt_initial: SceneStageF64,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub dt_min: SceneStageF64,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub dt_max: SceneStageF64,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub safety: SceneStageF64,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub growth_limit: SceneStageF64,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub shrink_limit: SceneStageF64,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub max_spin_rotation: SceneStageF64,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub norm_tolerance: SceneStageF64,
}

impl Default for SceneStageAdaptiveTimestepState {
    fn default() -> Self {
        Self {
            tolerance_mode: default_scene_stage_adaptive_tolerance_mode(),
            atol: SceneStageF64::default(),
            rtol: SceneStageF64::default(),
            dt_initial: SceneStageF64::default(),
            dt_min: SceneStageF64::default(),
            dt_max: SceneStageF64::default(),
            safety: SceneStageF64::default(),
            growth_limit: SceneStageF64::default(),
            shrink_limit: SceneStageF64::default(),
            max_spin_rotation: SceneStageF64::default(),
            norm_tolerance: SceneStageF64::default(),
        }
    }
}

fn default_scene_stage_adaptive_tolerance_mode() -> String {
    "advanced".to_string()
}

impl SceneStageAdaptiveTimestepState {
    fn from_script_builder(value: &ScriptBuilderAdaptiveTimestepState) -> Self {
        Self {
            tolerance_mode: value.tolerance_mode.clone(),
            atol: SceneStageF64::from_builder_text(&value.atol),
            rtol: SceneStageF64::from_builder_text(&value.rtol),
            dt_initial: SceneStageF64::from_builder_text(&value.dt_initial),
            dt_min: SceneStageF64::from_builder_text(&value.dt_min),
            dt_max: SceneStageF64::from_builder_text(&value.dt_max),
            safety: SceneStageF64::from_builder_text(&value.safety),
            growth_limit: SceneStageF64::from_builder_text(&value.growth_limit),
            shrink_limit: SceneStageF64::from_builder_text(&value.shrink_limit),
            max_spin_rotation: SceneStageF64::from_builder_text(&value.max_spin_rotation),
            norm_tolerance: SceneStageF64::from_builder_text(&value.norm_tolerance),
        }
    }

    fn to_script_builder(&self) -> ScriptBuilderAdaptiveTimestepState {
        ScriptBuilderAdaptiveTimestepState {
            tolerance_mode: self.tolerance_mode.clone(),
            atol: self.atol.to_builder_text(),
            rtol: self.rtol.to_builder_text(),
            dt_initial: self.dt_initial.to_builder_text(),
            dt_min: self.dt_min.to_builder_text(),
            dt_max: self.dt_max.to_builder_text(),
            safety: self.safety.to_builder_text(),
            growth_limit: self.growth_limit.to_builder_text(),
            shrink_limit: self.shrink_limit.to_builder_text(),
            max_spin_rotation: self.max_spin_rotation.to_builder_text(),
            norm_tolerance: self.norm_tolerance.to_builder_text(),
        }
    }
}

/// Canonical scene stage state. Numeric solver scalars and the eigenmode
/// wave-vector are typed here; their legacy textual forms are accepted only by
/// the compatibility readers above.
#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct SceneStudyStageState {
    pub kind: String,
    pub entrypoint_kind: String,
    #[serde(default)]
    pub integrator: String,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub fixed_timestep: SceneStageF64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_timestep: Option<SceneStageAdaptiveTimestepState>,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub until_seconds: SceneStageF64,
    #[serde(default, rename = "algorithm", alias = "relax_algorithm")]
    pub relax_algorithm: String,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub torque_tolerance: SceneStageF64,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub energy_tolerance: SceneStageF64,
    #[serde(default, skip_serializing_if = "SceneStageU64::is_unset")]
    pub max_steps: SceneStageU64,
    #[serde(default, skip_serializing_if = "SceneStageU64::is_unset")]
    pub eigen_count: SceneStageU64,
    #[serde(default)]
    pub eigen_target: String,
    #[serde(default)]
    pub eigen_include_demag: bool,
    #[serde(default)]
    pub eigen_equilibrium_source: String,
    #[serde(default)]
    pub eigen_normalization: String,
    #[serde(default, skip_serializing_if = "SceneStageF64::is_unset")]
    pub eigen_target_frequency: SceneStageF64,
    #[serde(default)]
    pub eigen_damping_policy: String,
    #[serde(default, skip_serializing_if = "SceneStageVec3::is_unset")]
    pub eigen_k_vector: SceneStageVec3,
    #[serde(default)]
    pub eigen_spin_wave_bc: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub eigen_spin_wave_bc_config: Option<Value>,
    #[serde(default, flatten, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra: BTreeMap<String, Value>,
}

impl SceneStudyStageState {
    pub(crate) fn from_script_builder(stage: &crate::ScriptBuilderStageState) -> Self {
        Self {
            kind: stage.kind.clone(),
            entrypoint_kind: stage.entrypoint_kind.clone(),
            integrator: stage.integrator.clone(),
            fixed_timestep: SceneStageF64::from_builder_text(&stage.fixed_timestep),
            adaptive_timestep: stage
                .adaptive_timestep
                .as_ref()
                .map(SceneStageAdaptiveTimestepState::from_script_builder),
            until_seconds: SceneStageF64::from_builder_text(&stage.until_seconds),
            relax_algorithm: stage.relax_algorithm.clone(),
            torque_tolerance: SceneStageF64::from_builder_text(&stage.torque_tolerance),
            energy_tolerance: SceneStageF64::from_builder_text(&stage.energy_tolerance),
            max_steps: SceneStageU64::from_builder_text(&stage.max_steps),
            eigen_count: SceneStageU64::from_builder_text(&stage.eigen_count),
            eigen_target: stage.eigen_target.clone(),
            eigen_include_demag: stage.eigen_include_demag,
            eigen_equilibrium_source: stage.eigen_equilibrium_source.clone(),
            eigen_normalization: stage.eigen_normalization.clone(),
            eigen_target_frequency: SceneStageF64::from_builder_text(&stage.eigen_target_frequency),
            eigen_damping_policy: stage.eigen_damping_policy.clone(),
            eigen_k_vector: SceneStageVec3::from_builder_text(&stage.eigen_k_vector),
            eigen_spin_wave_bc: stage.eigen_spin_wave_bc.clone(),
            eigen_spin_wave_bc_config: stage.eigen_spin_wave_bc_config.clone(),
            extra: stage.extra.clone(),
        }
    }

    pub(crate) fn to_script_builder(&self) -> crate::ScriptBuilderStageState {
        crate::ScriptBuilderStageState {
            kind: self.kind.clone(),
            entrypoint_kind: self.entrypoint_kind.clone(),
            integrator: self.integrator.clone(),
            fixed_timestep: self.fixed_timestep.to_builder_text(),
            adaptive_timestep: self
                .adaptive_timestep
                .as_ref()
                .map(SceneStageAdaptiveTimestepState::to_script_builder),
            until_seconds: self.until_seconds.to_builder_text(),
            relax_algorithm: self.relax_algorithm.clone(),
            torque_tolerance: self.torque_tolerance.to_builder_text(),
            energy_tolerance: self.energy_tolerance.to_builder_text(),
            max_steps: self.max_steps.to_builder_text(),
            eigen_count: self.eigen_count.to_builder_text(),
            eigen_target: self.eigen_target.clone(),
            eigen_include_demag: self.eigen_include_demag,
            eigen_equilibrium_source: self.eigen_equilibrium_source.clone(),
            eigen_normalization: self.eigen_normalization.clone(),
            eigen_target_frequency: self.eigen_target_frequency.to_builder_text(),
            eigen_damping_policy: self.eigen_damping_policy.clone(),
            eigen_k_vector: self.eigen_k_vector.to_builder_text(),
            eigen_spin_wave_bc: self.eigen_spin_wave_bc.clone(),
            eigen_spin_wave_bc_config: self.eigen_spin_wave_bc_config.clone(),
            extra: self.extra.clone(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(deny_unknown_fields)]
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
    pub fdm: Option<SceneFdmDiscretizationState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_field: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotated_interfacial_dmi: Option<f64>,
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
    pub stages: Vec<SceneStudyStageState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_pipeline: Option<StudyPipelineDocument>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_autosave: Option<fullmag_ir::TableAutosaveIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_storage: Option<fullmag_ir::OutputStorageIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_profile: Option<fullmag_ir::ExecutionProfileIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub execution_layers: Vec<fullmag_ir::ExecutionRequestLayerIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_state: Option<ScriptBuilderInitialState>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
pub struct SceneFdmDiscretizationState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_cell: Option<[f64; 3]>,
    #[serde(
        default,
        alias = "per_magnet",
        skip_serializing_if = "BTreeMap::is_empty",
        deserialize_with = "deserialize_null_default"
    )]
    pub per_object_grid: BTreeMap<String, ScriptBuilderFdmGridState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag: Option<ScriptBuilderFdmDemagState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_correction: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_phi_floor: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_delta_min: Option<f64>,
}

fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
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

fn default_preset_version() -> u32 {
    1
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
        gamma: String::new(),
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
        compute_quality: true,
        per_element_quality: true,
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
        #[serde(default = "default_preset_version")]
        preset_version: u32,
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

#[cfg(test)]
mod spin_authoring_tests {
    use super::*;

    #[test]
    fn scene_document_accepts_null_python_fdm_per_magnet() {
        let value = serde_json::json!({
            "version": "scene.v2",
            "study": {
                "fdm": {
                    "default_cell": [6.25e-9, 10.15625e-9, 3.0e-9],
                    "per_magnet": null
                }
            }
        });

        let scene: SceneDocument =
            serde_json::from_value(value).expect("Python FDM scene must accept null per_magnet");
        let fdm = scene.study.fdm.expect("FDM state");
        assert!(fdm.per_object_grid.is_empty());
    }

    #[test]
    fn scene_document_round_trips_study_table_autosave() {
        let value = serde_json::json!({
            "version": "scene.v2",
            "study": {
                "table_autosave": {
                    "kind": "table_autosave",
                    "table_id": "scene-table",
                    "every_steps": 3,
                    "quantities": ["step", "mx"],
                    "expressions": ["custom_quantity"]
                }
            }
        });

        let scene: SceneDocument =
            serde_json::from_value(value.clone()).expect("typed table autosave scene");
        let serialized = serde_json::to_value(scene).expect("serialize typed scene");

        assert_eq!(
            serialized["study"]["table_autosave"],
            value["study"]["table_autosave"]
        );
    }

    #[test]
    fn scene_document_rejects_unrecognized_versioned_fields() {
        for value in [
            serde_json::json!({"version": "scene.v2", "future_physics": {"D": 1.0}}),
            serde_json::json!({"version": "scene.v2", "study": {"future_solver_policy": "new-policy"}}),
            serde_json::json!({"version": "scene.v2", "current_modules": {"future_policy": "new-policy"}}),
            serde_json::json!({
                "version": "scene.v2",
                "current_modules": {
                    "modules": [{
                        "kind": "antenna",
                        "name": "drive",
                        "solver": "fdm",
                        "air_box_factor": 1.0,
                        "antenna_kind": "wire",
                        "drive": {"current_a": 0.0},
                        "future_policy": "new-policy"
                    }]
                }
            }),
            serde_json::json!({
                "version": "scene.v2",
                "current_modules": {
                    "modules": [{
                        "kind": "antenna",
                        "name": "drive",
                        "solver": "fdm",
                        "air_box_factor": 1.0,
                        "antenna_kind": "wire",
                        "drive": {"current_a": 0.0, "future_policy": "new-policy"}
                    }]
                }
            }),
            serde_json::json!({
                "version": "scene.v2",
                "current_modules": {
                    "excitation_analysis": {
                        "source": "drive",
                        "method": "dispersion",
                        "propagation_axis": [1.0, 0.0, 0.0],
                        "samples": 8,
                        "future_policy": "new-policy"
                    }
                }
            }),
        ] {
            assert!(
                serde_json::from_value::<SceneDocument>(value).is_err(),
                "unrecognized scene.v2 fields must not be silently discarded"
            );
        }
    }

    #[test]
    fn scene_document_rejects_malformed_current_module_states() {
        for value in [
            serde_json::json!({"version": "scene.v2", "current_modules": null}),
            serde_json::json!({"version": "scene.v2", "current_modules": {"modules": null}}),
            serde_json::json!({"version": "scene.v2", "current_modules": {"modules": [null]}}),
            serde_json::json!({"version": "scene.v2", "current_modules": {"excitation_analysis": []}}),
        ] {
            assert!(
                serde_json::from_value::<SceneDocument>(value).is_err(),
                "malformed current-module state must not be normalized into an empty default"
            );
        }
    }

    #[test]
    fn scene_document_round_trips_typed_spin_authoring_collections() {
        let value = serde_json::json!({
            "version": "scene.v2",
            "current_transports": [{
                "kind": "current_transport",
                "name": "transport",
                "model": "prescribed_density",
                "coupling": "one_way",
                "current_density": [1.25e11, -2.5e10, 3.75e9],
                "solve_region": "layer"
            }],
            "spin_transports": [{
                "schema_version": "spin_transport.v1",
                "id": "spin:0",
                "current_source_id": "transport",
                "mode": "steady",
                "domain": [{"object_id": "layer"}],
                "materials": [{
                    "region": {"object_id": "layer"},
                    "material": {
                        "sigma_s_Spm": 5.0e6,
                        "polarization_p": 0.4,
                        "theta_sh": 0.12,
                        "lambda_sf_m": 2.0e-9,
                        "lambda_j_m": "disabled",
                        "lambda_phi_m": 1.0e-9
                    }
                }],
                "solver": {
                    "engine": "gmres",
                    "linear": {"relative_tolerance": 1.0e-10, "absolute_tolerance": 0.0, "max_iterations": 500},
                    "physical_residual_version": "spin_balance.fullmag.v1",
                    "operator_version": "fv_spin_upwind_v1",
                    "default_external_boundary": "spin_insulating"
                },
                "requested_execution": {"discretization": "fdm", "device": "cpu", "precision": "double", "execution_mode": "strict"},
                "constitutive_version": "transport_constitutive.one_way.fullmag.v1"
            }],
            "spin_torques": [{
                "id": "zl:0",
                "kind": "zhang_li",
                "current_source": "transport",
                "degree": 0.45,
                "beta": 0.03
            }],
            "oersted_fields": [{
                "id": "oe:0",
                "kind": "oersted_cylinder",
                "current": -0.003,
                "radius": 2.2e-8,
                "center": [1.0e-9, -2.0e-9, 3.0e-9],
                "axis": [1.0, 2.0, 3.0],
                "time_dependence": {
                    "kind": "piecewise_linear",
                    "points": [[0.0, 0.0], [2.0e-12, 1.0]]
                }
            }]
        });
        let scene: SceneDocument = serde_json::from_value(value.clone()).expect("typed scene");
        assert_eq!(scene.current_transports.len(), 1);
        assert_eq!(scene.spin_transports.len(), 1);
        assert_eq!(scene.spin_torques.len(), 1);
        assert_eq!(scene.oersted_fields.len(), 1);
        let serialized = serde_json::to_value(scene).expect("serialize typed scene");
        assert_eq!(
            serialized["current_transports"],
            value["current_transports"]
        );
        assert_eq!(serialized["spin_transports"], value["spin_transports"]);
        assert_eq!(serialized["spin_torques"], value["spin_torques"]);
        assert_eq!(serialized["oersted_fields"], value["oersted_fields"]);
    }

    #[test]
    fn scene_document_round_trips_complete_ohmic_charge_contract() {
        let value = serde_json::json!({
            "version": "scene.v2",
            "current_transports": [{
                "kind": "current_transport",
                "name": "charge:0",
                "model": "ohmic_poisson",
                "coupling": "bidirectional",
                "domain": [{"object_id": "layer"}],
                "materials": [{
                    "region": {"object_id": "layer"},
                    "material": {"sigma_Spm": 5.0e6}
                }],
                "boundaries": [
                    {
                        "kind": "voltage_electrode",
                        "id": "left",
                        "surfaces": [{"object_id": "layer", "surface_id": "left", "orientation": [-1.0, 0.0, 0.0]}],
                        "potential_V": 0.1
                    },
                    {
                        "kind": "normal_current_electrode",
                        "id": "right",
                        "surfaces": [{"object_id": "layer", "surface_id": "right", "orientation": [1.0, 0.0, 0.0]}],
                        "outward_current_density_Apm2": 2.0e10
                    }
                ],
                "gauge": "dirichlet_reference",
                "solver": {
                    "engine": "cg",
                    "linear": {"relative_tolerance": 1.0e-10, "absolute_tolerance": 0.0, "max_iterations": 10000},
                    "physical_residual_version": "charge_balance_integrated_l2.v1",
                    "operator_version": "fv_charge_harmonic_v1"
                }
            }]
        });
        let scene: SceneDocument = serde_json::from_value(value.clone()).expect("typed scene");
        assert_eq!(
            serde_json::to_value(scene).unwrap()["current_transports"],
            value["current_transports"]
        );
    }

    #[test]
    fn unsupported_spin_authoring_round_trips_exactly_and_remains_non_executable() {
        let value = serde_json::json!({
            "version": "scene.v2",
            "current_transports": [{"kind": "future_transport", "name": "future-current", "nested": {"x": [1, true, null]}}],
            "spin_transports": [{"id": "future-spin", "schema_version": "vendor.v9", "nested": {"tensor": [[1, 2], [3, 4]]}}],
            "spin_torques": [{"id": "future-torque", "kind": "future_torque", "vendor": {"alpha": 0.125}}],
            "oersted_fields": [{"id": "future-field", "kind": "future_oersted", "coefficients": [1, 2, 3]}]
        });
        let scene: SceneDocument =
            serde_json::from_value(value.clone()).expect("opaque records must load");
        let serialized = serde_json::to_value(&scene).expect("opaque records must serialize");
        assert_eq!(
            serialized["current_transports"],
            value["current_transports"]
        );
        assert_eq!(serialized["spin_transports"], value["spin_transports"]);
        assert_eq!(serialized["spin_torques"], value["spin_torques"]);
        assert_eq!(serialized["oersted_fields"], value["oersted_fields"]);
        let error = crate::validate_scene_document(&scene)
            .expect_err("opaque records must remain non-executable");
        assert!(
            error.to_string().contains("unsupported read-only variant"),
            "{error}"
        );
    }
}
