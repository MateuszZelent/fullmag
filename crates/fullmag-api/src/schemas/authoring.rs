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
    #[schema(value_type = Vec<Object>)]
    pub regions: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allocated_region_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schema(value_type = Vec<Object>)]
    pub material_parameter_fields: Vec<Value>,
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
    #[schema(value_type = Vec<Object>)]
    pub couplings: Vec<Value>,
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

impl SceneResource {
    pub fn from_scene_document(scene: SceneDocument) -> Result<Self, serde_json::Error> {
        serde_json::from_value(serde_json::to_value(scene)?)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ObjectRegionCreateRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[schema(value_type = Object)]
    pub region: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct ObjectRegionPatchRequest {
    #[serde(default)]
    pub base_revision: Option<u64>,
    #[schema(value_type = Object)]
    pub patch: Value,
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
pub struct MaterialResource {
    pub id: String,
    pub name: String,
    pub properties: MaterialPropertiesResource,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MagnetizationAssetResource {
    pub scene_revision: u64,
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
    #[schema(value_type = Object, nullable)]
    pub shape: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Object, nullable)]
    pub mesh_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schema(value_type = Vec<Object>)]
    pub material_overrides: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[schema(value_type = Vec<Object>)]
    pub material_parameter_fields: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schema(value_type = Object, nullable)]
    pub texture_override: Option<Value>,
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
    #[schema(value_type = Object)]
    pub field: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct MaterialParameterFieldListResource {
    pub scene_revision: u64,
    pub fields: Vec<MaterialParameterFieldResource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CouplingResource {
    pub coupling_id: String,
    pub coupling_kind: String,
    pub enabled: bool,
    #[schema(value_type = Object)]
    pub source: Value,
    #[schema(value_type = Object)]
    pub target: Value,
    #[schema(value_type = Object)]
    pub params: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capability_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization_status: Option<String>,
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
        #[schema(value_type = Object)]
        region: Value,
    },
    PatchObjectRegion {
        #[serde(default)]
        base_revision: Option<u64>,
        object_id: String,
        region_id: String,
        #[schema(value_type = Object)]
        patch: Value,
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
        #[schema(value_type = Object)]
        coupling: Value,
    },
    PatchCoupling {
        #[serde(default)]
        base_revision: Option<u64>,
        coupling_id: String,
        #[schema(value_type = Object)]
        patch: Value,
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
