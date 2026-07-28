use fullmag_authoring::SceneDocument;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum NullableU32PatchValue {
    Value(u32),
    Null,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum NullableF64PatchValue {
    Value(f64),
    Null,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(untagged)]
pub enum NullableStringPatchValue {
    Value(String),
    Null,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct StudyRuntimeResource {
    pub backend: Option<String>,
    pub requested_backend: String,
    pub requested_device: String,
    pub requested_precision: String,
    pub requested_mode: String,
    pub requested_cpu_threads: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct StudyRuntimePatchRequest {
    pub requested_backend: Option<String>,
    pub requested_device: Option<String>,
    pub requested_precision: Option<String>,
    pub requested_mode: Option<String>,
    #[serde(default, deserialize_with = "deserialize_nullable_u32_patch_field")]
    pub requested_cpu_threads: Option<NullableU32PatchValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SamplingPeriodPolicyResource {
    AutoSincCutoff { nyquist_guard_factor: f64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AutomaticOutputSamplingResource {
    FieldAuto {
        name: String,
        sample_period_policy: SamplingPeriodPolicyResource,
    },
    ScalarAuto {
        name: String,
        sample_period_policy: SamplingPeriodPolicyResource,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AutomaticTableAutosaveResource {
    pub table_id: String,
    pub quantities: Vec<String>,
    pub sample_period_policy: SamplingPeriodPolicyResource,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageAutosaveLayoutResource {
    Continuous,
    Separate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StageAutosaveFormatResource {
    Zarr,
    Hdf5,
    Txt,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StageTableAutosaveResource {
    #[serde(default = "default_table_autosave_resource_kind")]
    pub kind: String,
    #[serde(default = "default_table_autosave_resource_id")]
    pub table_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_period_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_steps: Option<u64>,
    pub quantities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FieldAutosaveResource {
    #[serde(default = "default_field_autosave_resource_kind")]
    pub kind: String,
    pub quantity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_steps: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StageAutosaveResource {
    #[serde(default = "default_stage_autosave_resource_kind")]
    pub kind: String,
    pub target: String,
    pub layout: StageAutosaveLayoutResource,
    pub format: StageAutosaveFormatResource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<StageTableAutosaveResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<FieldAutosaveResource>,
}

impl StageAutosaveResource {
    pub fn validate(&self) -> Result<(), String> {
        if self.kind != "stage_autosave" {
            return Err("stage autosave kind must be 'stage_autosave'".into());
        }
        if self.target.is_empty()
            || !self
                .target
                .chars()
                .next()
                .is_some_and(|character| character.is_ascii_alphanumeric())
            || !self.target.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
            })
        {
            return Err("stage autosave target is unsafe".into());
        }
        if self.table.is_none() && self.fields.is_empty() {
            return Err("stage autosave requires a table or field policy".into());
        }
        if self.format == StageAutosaveFormatResource::Txt && !self.fields.is_empty() {
            return Err("TXT stage autosave supports scalar tables only".into());
        }
        Ok(())
    }
}

fn default_stage_autosave_resource_kind() -> String {
    "stage_autosave".into()
}

fn default_field_autosave_resource_kind() -> String {
    "field_autosave".into()
}

fn default_table_autosave_resource_kind() -> String {
    "table_autosave".into()
}

fn default_table_autosave_resource_id() -> String {
    "default".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SceneMetadataResource {
    pub id: String,
    pub name: String,
    pub source_of_truth: String,
    pub authoring_schema: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SceneObjectResource {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(additional_properties, nullable)]
    pub geometry: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(additional_properties, nullable)]
    pub transform: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_ref: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[schema(additional_properties)]
    pub region_overrides: BTreeMap<String, BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub physics_stack: Vec<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(additional_properties, nullable)]
    pub object_mesh: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(additional_properties, nullable)]
    pub mesh_override: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub regions: Vec<fullmag_authoring::SceneObjectRegion>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allocated_region_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_parameter_fields: Vec<fullmag_authoring::SceneMaterialParameterAssignment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SceneMaterialResource {
    pub id: String,
    pub name: String,
    #[schema(additional_properties)]
    pub properties: BTreeMap<String, Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<MaterialReferenceResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SceneResource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene: Option<SceneMetadataResource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(additional_properties, nullable)]
    pub universe: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<SceneObjectResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub materials: Vec<SceneMaterialResource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub magnetization_assets: Vec<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub couplings: Vec<fullmag_authoring::SceneCoupling>,
    #[serde(default)]
    pub field_drives: FieldDriveListStateResource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(additional_properties, nullable)]
    pub current_modules: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(additional_properties, nullable)]
    pub study: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(additional_properties, nullable)]
    pub outputs: Option<BTreeMap<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(additional_properties, nullable)]
    pub editor: Option<BTreeMap<String, Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
#[serde(deny_unknown_fields)]
pub struct FieldDriveListStateResource {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub drives: Vec<RegionalFieldDriveResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FieldDriveKindResource {
    Regional,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FieldTargetResource {
    Global {},
    Object {
        object_id: String,
    },
    Region {
        object_id: String,
        region_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FieldEnvelopeResource {
    Uniform {},
    Sinc {
        axis: [f64; 3],
        period_m: f64,
        #[serde(default)]
        center_m: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width_m: Option<f64>,
        #[serde(default = "default_field_window_none")]
        window: String,
    },
}

fn default_field_window_none() -> String {
    "none".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FieldSpatialProfileResource {
    Uniform {},
    Sinc {
        axis: [f64; 3],
        period_m: f64,
        #[serde(default)]
        center_m: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        width_m: Option<f64>,
        #[serde(default = "default_field_window_none")]
        window: String,
    },
    GeometryMask {
        object_id: String,
        envelope: FieldEnvelopeResource,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TimeDependenceResource {
    Constant,
    Sinusoidal {
        frequency_hz: f64,
        #[serde(default)]
        phase_rad: f64,
        #[serde(default)]
        offset: f64,
    },
    Pulse {
        t_on: f64,
        t_off: f64,
    },
    PiecewiseLinear {
        points: Vec<[f64; 2]>,
    },
    SincPulse {
        cutoff_hz: f64,
        #[serde(default)]
        t0: f64,
        #[serde(default = "default_unit_amplitude")]
        amplitude: f64,
    },
}

fn default_unit_amplitude() -> f64 {
    1.0
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FieldTimeOriginResource {
    StageLocal,
    Absolute,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum DriveActivationResource {
    AllTimeEvolution {},
    StageIds { stage_ids: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct FieldDriveMigrationResource {
    pub migrated_from: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RegionalFieldDriveResource {
    pub id: String,
    pub name: String,
    pub kind: FieldDriveKindResource,
    #[serde(default = "default_field_drive_enabled")]
    pub enabled: bool,
    pub target: FieldTargetResource,
    #[serde(rename = "amplitude_B_T")]
    pub amplitude_b_t: f64,
    pub direction: [f64; 3],
    pub spatial_profile: FieldSpatialProfileResource,
    pub waveform: TimeDependenceResource,
    pub time_origin: FieldTimeOriginResource,
    pub activation: DriveActivationResource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub migration: Option<FieldDriveMigrationResource>,
}

fn default_field_drive_enabled() -> bool {
    true
}

impl RegionalFieldDriveResource {
    pub fn into_ir(self) -> Result<fullmag_ir::RegionalFieldDriveIR, serde_json::Error> {
        serde_json::from_value(serde_json::to_value(self)?)
    }

    pub fn from_ir(value: fullmag_ir::RegionalFieldDriveIR) -> Result<Self, serde_json::Error> {
        serde_json::from_value(serde_json::to_value(value)?)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FieldDriveListResource {
    pub scene_revision: u64,
    pub drives: Vec<RegionalFieldDriveResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FieldDriveCreateRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    pub drive: RegionalFieldDriveResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FieldDriveReplaceRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    pub drive: RegionalFieldDriveResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct FieldDriveDeleteRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
}

impl SceneResource {
    pub fn from_scene_document(scene: SceneDocument) -> Result<Self, serde_json::Error> {
        serde_json::from_value(serde_json::to_value(scene)?)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ObjectRegionCreateRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    pub region: fullmag_authoring::SceneObjectRegion,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SceneObjectRegionPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<fullmag_authoring::SceneRegionShape>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<fullmag_authoring::SceneRegionFrame>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_policy: Option<Option<fullmag_authoring::SceneRegionMeshPolicy>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_overrides: Option<Vec<fullmag_authoring::SceneRegionMaterialOverride>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_override: Option<Option<fullmag_authoring::SceneTextureOverride>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_transition: Option<Option<fullmag_authoring::SceneMaterialTransition>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization_policy: Option<Option<fullmag_authoring::SceneRegionRealizationPolicy>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_id: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_object: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ObjectRegionPatchRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    pub patch: SceneObjectRegionPatch,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct SceneCouplingPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<fullmag_authoring::SceneCouplingKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<fullmag_authoring::SceneCouplingEndpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<fullmag_authoring::SceneCouplingEndpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parameters: Option<fullmag_authoring::SceneCouplingParameters>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_policy: Option<fullmag_authoring::SceneCouplingCapabilityPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(ignore)]
    pub coupling_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CouplingCreateRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    pub coupling: fullmag_authoring::SceneCoupling,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CouplingPatchRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    pub patch: SceneCouplingPatch,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CouplingDeleteRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ObjectRegionDuplicateRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ObjectRegionReorderRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    pub region_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialPropertiesResource {
    #[serde(rename = "Ms")]
    pub ms: Option<f64>,
    #[serde(rename = "Aex")]
    pub aex: Option<f64>,
    pub alpha: f64,
    #[serde(rename = "Dind")]
    pub dind: Option<f64>,
    #[serde(rename = "Dbulk")]
    pub dbulk: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialReferenceResource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub citation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialResource {
    pub region_coefficients_revision: Option<u64>,
    pub id: String,
    pub name: String,
    pub properties: MaterialPropertiesResource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub references: Vec<MaterialReferenceResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MagnetizationAssetResource {
    pub scene_revision: u64,
    pub region_initial_state_revision: Option<u64>,
    #[schema(additional_properties)]
    pub asset: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MagnetizationAssetPatchRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[schema(additional_properties)]
    pub asset: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialPropertiesPatchRequest {
    #[serde(rename = "Ms")]
    #[serde(default, deserialize_with = "deserialize_nullable_f64_patch_field")]
    pub ms: Option<NullableF64PatchValue>,
    #[serde(rename = "Aex")]
    #[serde(default, deserialize_with = "deserialize_nullable_f64_patch_field")]
    pub aex: Option<NullableF64PatchValue>,
    pub alpha: Option<f64>,
    #[serde(rename = "Dind")]
    #[serde(default, deserialize_with = "deserialize_nullable_f64_patch_field")]
    pub dind: Option<NullableF64PatchValue>,
    #[serde(rename = "Dbulk")]
    #[serde(default, deserialize_with = "deserialize_nullable_f64_patch_field")]
    pub dbulk: Option<NullableF64PatchValue>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialPatchRequest {
    pub name: Option<String>,
    pub properties: Option<MaterialPropertiesPatchRequest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub references: Option<Vec<MaterialReferenceResource>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ObjectInteractionResource {
    pub object_id: String,
    pub interaction_kind: String,
    pub present: bool,
    pub enabled: bool,
    #[schema(value_type = Object)]
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ObjectInteractionPatchRequest {
    pub present: Option<bool>,
    pub enabled: Option<bool>,
    #[schema(value_type = Object)]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ObjectGeometryPatchRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[schema(value_type = Object)]
    pub geometry: Value,
    #[schema(value_type = Object, nullable)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ObjectCreateRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    pub object_id: String,
    pub name: String,
    #[schema(value_type = Object)]
    pub geometry: Value,
    #[schema(value_type = Object, nullable)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_ref: Option<String>,
    #[schema(value_type = Object, nullable)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_asset: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_asset: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub universe: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub study_universe_mesh: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ObjectPatchRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub material_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_ref: Option<String>,
    #[schema(value_type = Object, nullable)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub geometry: Option<Value>,
    #[schema(value_type = Object, nullable)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transform: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UniverseResource {
    pub scene_revision: u64,
    #[schema(value_type = Object, nullable)]
    pub universe: Option<Value>,
    #[schema(value_type = Object, nullable)]
    pub study_universe_mesh: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_bounds_min: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub object_bounds_max: Option<[f64; 3]>,
    pub mesh_dirty: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UniversePatchRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[schema(value_type = Object)]
    pub universe: Value,
    #[serde(default = "default_true")]
    pub sync_study_universe_mesh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct UniverseFitRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub padding: Option<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minimum_size: Option<[f64; 3]>,
    #[serde(default = "default_true")]
    pub sync_study_universe_mesh: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GeometryRealizationRequest {
    #[serde(default)]
    pub backend_target: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RegionResource {
    pub region_id: String,
    pub name: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_object_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_path: Option<String>,
    pub source_object_ids: Vec<String>,
    pub source_body_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape: Option<fullmag_authoring::SceneRegionShape>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_policy: Option<fullmag_authoring::SceneRegionMeshPolicy>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_overrides: Vec<fullmag_authoring::SceneRegionMaterialOverride>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub material_parameter_fields: Vec<fullmag_authoring::SceneMaterialParameterAssignment>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub texture_override: Option<fullmag_authoring::SceneTextureOverride>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization_status: Option<String>,
    pub material_ref: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_ref: Option<String>,
    pub interaction_refs: Vec<String>,
    pub mesh_part_ids: Vec<String>,
    pub enabled: bool,
    pub bounds_min: [f64; 3],
    pub bounds_max: [f64; 3],
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RegionListResource {
    pub scene_revision: u64,
    pub geometry_realization_revision: u64,
    pub region_topology_revision: Option<u64>,
    pub region_membership_revision: Option<u64>,
    pub region_coefficients_revision: Option<u64>,
    pub region_initial_state_revision: Option<u64>,
    pub regions: Vec<RegionResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RegionDiagnosticResource {
    pub diagnostic_id: String,
    pub severity: String,
    pub code: String,
    pub message: String,
    pub region_id: String,
    pub owner_object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_gate: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RegionDiagnosticsResource {
    pub scene_revision: u64,
    pub region_topology_revision: Option<u64>,
    pub region_membership_revision: Option<u64>,
    pub region_coefficients_revision: Option<u64>,
    pub region_initial_state_revision: Option<u64>,
    pub diagnostics: Vec<RegionDiagnosticResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialParameterFieldResource {
    pub assignment_id: String,
    pub owner_object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_path: Option<String>,
    pub parameter: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_region_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    pub field: fullmag_authoring::SceneMaterialParameterField,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mean: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialParameterFieldListResource {
    pub scene_revision: u64,
    pub region_coefficients_revision: Option<u64>,
    pub fields: Vec<MaterialParameterFieldResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialParameterFieldDataSummaryResource {
    pub field_id: String,
    pub assignment_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    pub owner_object_id: String,
    pub parameter: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_region_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    pub realization_status: String,
    pub sample_count: u64,
    pub href: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialParameterFieldDataListResource {
    pub scene_revision: u64,
    pub region_coefficients_revision: Option<u64>,
    pub fields: Vec<MaterialParameterFieldDataSummaryResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialParameterFieldDataResource {
    pub field_id: String,
    pub assignment_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
    pub scene_revision: u64,
    pub region_coefficients_revision: Option<u64>,
    pub owner_object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_path: Option<String>,
    pub parameter: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_region_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_generation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithm: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timing_ms: Option<f64>,
    pub realization_status: String,
    pub sample_count: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mean: Option<f64>,
    pub values: Vec<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CouplingEndpointResolutionResource {
    pub status: String,
    pub object_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tolerance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_face_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_face_indices: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_marker_ids: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub area: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CouplingResource {
    pub coupling_id: String,
    pub coupling_kind: String,
    pub enabled: bool,
    pub source: fullmag_authoring::SceneCouplingEndpoint,
    pub target: fullmag_authoring::SceneCouplingEndpoint,
    pub source_resolution: CouplingEndpointResolutionResource,
    pub target_resolution: CouplingEndpointResolutionResource,
    pub params: fullmag_authoring::SceneCouplingParameters,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CouplingListResource {
    pub scene_revision: u64,
    pub couplings: Vec<CouplingResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RegionPatchRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, deserialize_with = "deserialize_nullable_string_patch_field")]
    pub magnetization_ref: Option<NullableStringPatchValue>,
}

fn deserialize_nullable_u32_patch_field<'de, D>(
    deserializer: D,
) -> Result<Option<NullableU32PatchValue>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Null => Ok(Some(NullableU32PatchValue::Null)),
        Value::Number(number) => number
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .map(NullableU32PatchValue::Value)
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("expected nullable u32 patch field")),
        _ => Err(serde::de::Error::custom(
            "expected nullable u32 patch field",
        )),
    }
}

fn deserialize_nullable_f64_patch_field<'de, D>(
    deserializer: D,
) -> Result<Option<NullableF64PatchValue>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Null => Ok(Some(NullableF64PatchValue::Null)),
        Value::Number(number) => number
            .as_f64()
            .map(NullableF64PatchValue::Value)
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("expected nullable f64 patch field")),
        _ => Err(serde::de::Error::custom(
            "expected nullable f64 patch field",
        )),
    }
}

fn deserialize_nullable_string_patch_field<'de, D>(
    deserializer: D,
) -> Result<Option<NullableStringPatchValue>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::Null => Ok(Some(NullableStringPatchValue::Null)),
        Value::String(value) => Ok(Some(NullableStringPatchValue::Value(value))),
        _ => Err(serde::de::Error::custom(
            "expected nullable string patch field",
        )),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ScenePatchRequest {
    #[schema(value_type = Object)]
    pub merge_patch: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuthoringTransactionRequest {
    ReplaceScene {
        #[schema(value_type = Object)]
        scene: Value,
    },
    MergePatch {
        #[schema(value_type = Object)]
        merge_patch: Value,
    },
    PatchObjectGeometry {
        object_id: String,
        #[serde(default)]
        base_revision: Option<u64>,
        #[schema(value_type = Object)]
        geometry: Value,
        #[schema(value_type = Object, nullable)]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transform: Option<Value>,
    },
    CreateObject {
        #[serde(default)]
        base_revision: Option<u64>,
        object_id: String,
        name: String,
        #[schema(value_type = Object)]
        geometry: Value,
        #[schema(value_type = Object, nullable)]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        transform: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        material_ref: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        region_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        magnetization_ref: Option<String>,
        #[schema(value_type = Object, nullable)]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        material_asset: Option<Value>,
        #[schema(value_type = Object, nullable)]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        magnetization_asset: Option<Value>,
        #[schema(value_type = Object, nullable)]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        universe: Option<Value>,
        #[schema(value_type = Object, nullable)]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        study_universe_mesh: Option<Value>,
    },
    CreateMaterial {
        #[serde(default)]
        base_revision: Option<u64>,
        material_id: String,
        name: String,
        properties: MaterialPropertiesResource,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        references: Vec<MaterialReferenceResource>,
    },
    PatchMaterial {
        #[serde(default)]
        base_revision: Option<u64>,
        material_id: String,
        patch: MaterialPatchRequest,
    },
    DeleteMaterial {
        #[serde(default)]
        base_revision: Option<u64>,
        material_id: String,
    },
    DeleteObject {
        #[serde(default)]
        base_revision: Option<u64>,
        object_id: String,
    },
    RenameObject {
        #[serde(default)]
        base_revision: Option<u64>,
        object_id: String,
        name: String,
    },
    CommitObjectTransform {
        #[serde(default)]
        base_revision: Option<u64>,
        object_id: String,
        #[schema(value_type = Object)]
        transform: Value,
    },
    PatchUniverse {
        #[serde(default)]
        base_revision: Option<u64>,
        #[schema(value_type = Object)]
        universe: Value,
        #[serde(default = "default_true")]
        sync_study_universe_mesh: bool,
    },
    CreateObjectRegion {
        #[serde(default)]
        base_revision: Option<u64>,
        object_id: String,
        region: fullmag_authoring::SceneObjectRegion,
    },
    PatchObjectRegion {
        #[serde(default)]
        base_revision: Option<u64>,
        object_id: String,
        region_id: String,
        patch: SceneObjectRegionPatch,
    },
    PatchObjectMaterialFields {
        #[serde(default)]
        base_revision: Option<u64>,
        object_id: String,
        fields: Vec<fullmag_authoring::SceneMaterialParameterAssignment>,
    },
    DeleteObjectRegion {
        #[serde(default)]
        base_revision: Option<u64>,
        object_id: String,
        region_id: String,
    },
    ReorderObjectRegions {
        #[serde(default)]
        base_revision: Option<u64>,
        object_id: String,
        region_ids: Vec<String>,
    },
    CreateCoupling {
        #[serde(default)]
        base_revision: Option<u64>,
        coupling: fullmag_authoring::SceneCoupling,
    },
    PatchCoupling {
        #[serde(default)]
        base_revision: Option<u64>,
        coupling_id: String,
        patch: SceneCouplingPatch,
    },
    DeleteCoupling {
        #[serde(default)]
        base_revision: Option<u64>,
        coupling_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AuthoringTransactionResponse {
    pub transaction_kind: String,
    pub scene_revision: u64,
    #[schema(value_type = Object)]
    pub committed_scene: Value,
}

#[cfg(test)]
mod stage_autosave_tests {
    use super::*;

    #[test]
    fn stage_autosave_resource_round_trips_all_storage_choices() {
        for format in ["zarr", "hdf5", "txt"] {
            let resource: StageAutosaveResource = serde_json::from_value(serde_json::json!({
                "kind": "stage_autosave",
                "target": "main",
                "layout": "continuous",
                "format": format,
                "table": {
                    "kind": "table_autosave",
                    "table_id": "default",
                    "sample_period_s": 1e-12,
                    "quantities": ["step", "t", "mx"]
                },
                "fields": []
            }))
            .unwrap();
            resource.validate().unwrap();
            assert_eq!(
                serde_json::to_value(&resource).unwrap()["format"],
                serde_json::json!(format)
            );
        }
    }

    #[test]
    fn txt_stage_autosave_resource_rejects_field_requests() {
        let resource: StageAutosaveResource = serde_json::from_value(serde_json::json!({
            "target": "main",
            "layout": "separate",
            "format": "txt",
            "fields": [{"quantity": "m", "every_seconds": 1e-12}]
        }))
        .unwrap();
        assert!(resource
            .validate()
            .unwrap_err()
            .contains("scalar tables only"));
    }
}
