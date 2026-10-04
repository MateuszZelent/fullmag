//! Immutable execution profiles and sparse requested-execution patches.
//!
//! This module stores authored intent only. Resolving defaults, replaying
//! layers, and enforcing submit precedence belongs to `fullmag-application`.

use crate::{
    BackendTarget, ComputeParallelismIR, ComputePlacementIR, ComputeResourcesIR, ComputeTargetIR,
    CpuAffinityIR, CpuCorePolicyIR, ExecutionDevice, ExecutionMode, ExecutionPrecision,
    GpuResourcesIR, RequestedThreads,
};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[cfg(test)]
#[path = "execution_profile_tests.rs"]
mod tests;

pub const EXECUTION_PROFILE_SCHEMA: &str = "execution_profile.v1";
pub const EXECUTION_REQUEST_SCHEMA: &str = "execution_request.v1";

/// A direct typed patch value, or an omitted field.
///
/// `Value(None)` is intentionally distinct from `Absent` and serializes as
/// JSON `null`, allowing nullable settings to be explicitly reset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldPatch<T> {
    Absent,
    Value(T),
}

impl<T> Default for FieldPatch<T> {
    fn default() -> Self {
        Self::Absent
    }
}

impl<T> FieldPatch<T> {
    pub fn is_absent(&self) -> bool {
        matches!(self, Self::Absent)
    }

    pub fn as_ref(&self) -> FieldPatch<&T> {
        match self {
            Self::Absent => FieldPatch::Absent,
            Self::Value(value) => FieldPatch::Value(value),
        }
    }
}

impl<T: Serialize> Serialize for FieldPatch<T> {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Absent => Err(serde::ser::Error::custom(
                "FieldPatch::Absent must be omitted by its sparse struct field",
            )),
            Self::Value(value) => value.serialize(serializer),
        }
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for FieldPatch<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        T::deserialize(deserializer).map(Self::Value)
    }
}

trait SparsePatch {
    fn is_empty(&self) -> bool;
}

fn absent_or_empty<T: SparsePatch>(patch: &FieldPatch<T>) -> bool {
    match patch {
        FieldPatch::Absent => true,
        FieldPatch::Value(value) => value.is_empty(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct CpuResourcePatchIR {
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub threads: FieldPatch<RequestedThreads>,
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub core_policy: FieldPatch<Option<CpuCorePolicyIR>>,
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub affinity: FieldPatch<CpuAffinityIR>,
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub numa_node: FieldPatch<Option<u32>>,
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub native_threads: FieldPatch<RequestedThreads>,
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub blas_threads: FieldPatch<RequestedThreads>,
}

impl SparsePatch for CpuResourcePatchIR {
    fn is_empty(&self) -> bool {
        self.threads.is_absent()
            && self.core_policy.is_absent()
            && self.affinity.is_absent()
            && self.numa_node.is_absent()
            && self.native_threads.is_absent()
            && self.blas_threads.is_absent()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct MemoryResourcePatchIR {
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub reservation_bytes: FieldPatch<Option<u64>>,
}

impl SparsePatch for MemoryResourcePatchIR {
    fn is_empty(&self) -> bool {
        self.reservation_bytes.is_absent()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ComputeResourcePatchIR {
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub target: FieldPatch<ComputeTargetIR>,
    #[serde(skip_serializing_if = "absent_or_empty")]
    pub cpu: FieldPatch<CpuResourcePatchIR>,
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub gpu: FieldPatch<Option<GpuResourcesIR>>,
    #[serde(skip_serializing_if = "absent_or_empty")]
    pub ram: FieldPatch<MemoryResourcePatchIR>,
    #[serde(skip_serializing_if = "absent_or_empty")]
    pub scratch: FieldPatch<MemoryResourcePatchIR>,
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub parallelism: FieldPatch<ComputeParallelismIR>,
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub placement: FieldPatch<ComputePlacementIR>,
}

impl SparsePatch for ComputeResourcePatchIR {
    fn is_empty(&self) -> bool {
        self.target.is_absent()
            && absent_or_empty(&self.cpu)
            && self.gpu.is_absent()
            && absent_or_empty(&self.ram)
            && absent_or_empty(&self.scratch)
            && self.parallelism.is_absent()
            && self.placement.is_absent()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ExecutionRequestPatchIR {
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub backend: FieldPatch<BackendTarget>,
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub device: FieldPatch<ExecutionDevice>,
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub precision: FieldPatch<ExecutionPrecision>,
    #[serde(skip_serializing_if = "FieldPatch::is_absent")]
    pub mode: FieldPatch<ExecutionMode>,
    #[serde(skip_serializing_if = "absent_or_empty")]
    pub resources: FieldPatch<ComputeResourcePatchIR>,
}

impl SparsePatch for ExecutionRequestPatchIR {
    fn is_empty(&self) -> bool {
        self.backend.is_absent()
            && self.device.is_absent()
            && self.precision.is_absent()
            && self.mode.is_absent()
            && absent_or_empty(&self.resources)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionOriginKindIR {
    #[default]
    ProductDefault,
    Profile,
    Script,
    Study,
    Step,
    Submit,
    Cli,
    LegacyEnv,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionFieldOriginIR {
    pub kind: ExecutionOriginKindIR,
    pub location: String,
}

impl Default for ExecutionFieldOriginIR {
    fn default() -> Self {
        Self {
            kind: ExecutionOriginKindIR::ProductDefault,
            location: "product.default".to_string(),
        }
    }
}

impl ExecutionFieldOriginIR {
    pub fn validate(&self) -> Result<(), String> {
        if self.location.trim().is_empty()
            || self.location.len() > 4096
            || self.location.chars().any(char::is_control)
        {
            return Err(
                "execution origin location must be nonempty, at most 4096 UTF-8 bytes, and contain no control characters".to_string(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionRequestLayerIR {
    pub origin: ExecutionFieldOriginIR,
    #[serde(default)]
    pub request: ExecutionRequestPatchIR,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionRequestIR {
    pub backend: BackendTarget,
    pub device: ExecutionDevice,
    pub precision: ExecutionPrecision,
    pub mode: ExecutionMode,
    pub resources: ComputeResourcesIR,
}

impl Default for ExecutionRequestIR {
    fn default() -> Self {
        Self {
            backend: BackendTarget::Auto,
            device: ExecutionDevice::Auto,
            precision: ExecutionPrecision::Double,
            mode: ExecutionMode::Strict,
            resources: ComputeResourcesIR::default(),
        }
    }
}

impl ExecutionRequestIR {
    pub fn validate(&self) -> Result<(), String> {
        self.resources
            .validate()
            .map_err(|errors| errors.join("; "))?;
        if self.device == ExecutionDevice::Cpu && self.resources.gpu.is_some() {
            return Err(
                "execution_intent_conflict: GPU resources contradict device=cpu".to_string(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionProfileIR {
    pub schema_version: String,
    pub profile_id: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub defaults: ExecutionRequestPatchIR,
}

impl Default for ExecutionProfileIR {
    fn default() -> Self {
        Self {
            schema_version: EXECUTION_PROFILE_SCHEMA.to_string(),
            profile_id: "exec:default".to_string(),
            version: "1".to_string(),
            description: String::new(),
            defaults: ExecutionRequestPatchIR::default(),
        }
    }
}

impl ExecutionProfileIR {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != EXECUTION_PROFILE_SCHEMA {
            return Err(format!(
                "unsupported execution profile schema {}",
                self.schema_version
            ));
        }
        validate_profile_identity(&self.profile_id, "profile_id")?;
        validate_profile_identity(&self.version, "version")?;
        if self.version.eq_ignore_ascii_case("latest") {
            return Err("execution profile version 'latest' is not immutable".to_string());
        }
        if self.description.len() > 4096 {
            return Err("execution profile description exceeds 4096 UTF-8 bytes".to_string());
        }
        Ok(())
    }

    pub fn canonical_sha256(&self) -> Result<String, String> {
        let value = serde_json::to_value(self)
            .map_err(|error| format!("execution profile serialization failed: {error}"))?;
        let bytes = canonical_json_bytes(&value)
            .map_err(|error| format!("execution profile canonicalization failed: {error}"))?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
}

fn validate_profile_identity(value: &str, field: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 256
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(format!(
            "execution profile {field} must be nonempty, at most 256 UTF-8 bytes, and contain no whitespace or control characters"
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterializedExecutionRequestIR {
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<ExecutionProfileIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile_sha256: Option<String>,
    #[serde(default)]
    pub layers: Vec<ExecutionRequestLayerIR>,
    pub requested: ExecutionRequestIR,
    pub origins: BTreeMap<String, ExecutionFieldOriginIR>,
}

impl MaterializedExecutionRequestIR {
    pub fn validate_shape(&self) -> Result<(), String> {
        if self.schema_version != EXECUTION_REQUEST_SCHEMA {
            return Err(format!(
                "unsupported materialized execution schema {}",
                self.schema_version
            ));
        }
        self.requested.validate()?;
        for origin in self.origins.values() {
            origin.validate()?;
        }
        Ok(())
    }
}

fn canonical_json_bytes(value: &Value) -> Result<Vec<u8>, serde_json::Error> {
    let mut output = Vec::new();
    write_canonical_json(value, &mut output)?;
    Ok(output)
}

fn write_canonical_json(value: &Value, output: &mut Vec<u8>) -> Result<(), serde_json::Error> {
    match value {
        Value::Null => output.extend_from_slice(b"null"),
        Value::Bool(value) => output.extend_from_slice(if *value { b"true" } else { b"false" }),
        Value::Number(value) => output.extend_from_slice(serde_json::to_string(value)?.as_bytes()),
        Value::String(value) => output.extend_from_slice(serde_json::to_string(value)?.as_bytes()),
        Value::Array(values) => {
            output.push(b'[');
            for (index, item) in values.iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                write_canonical_json(item, output)?;
            }
            output.push(b']');
        }
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|left, right| left.0.cmp(right.0));
            output.push(b'{');
            for (index, (key, item)) in entries.into_iter().enumerate() {
                if index != 0 {
                    output.push(b',');
                }
                output.extend_from_slice(serde_json::to_string(key)?.as_bytes());
                output.push(b':');
                write_canonical_json(item, output)?;
            }
            output.push(b'}');
        }
    }
    Ok(())
}
