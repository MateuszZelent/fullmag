use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::{
    LlgTimestepCapabilityId, LlgTimestepQualificationId, TimestepBackend, TimestepDevice,
    TimestepValidationState,
};

const REGISTRY_SCHEMA: &str = "fullmag.llg_timestep_qualification_registry.v1";
pub const QUALIFICATION_REGISTRY_VERSION: &str = REGISTRY_SCHEMA;
const VALIDATOR_SCHEMA: &str = "fullmag.llg_timestep_qualification.validator.v1";
const REGISTRY_JSON: &str = include_str!(
    "../../../benchmarks/fem-llg/qualification-registry-v1.json"
);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimestepPolicyKind {
    Fixed,
    Adaptive,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TimestepExecutionIdentityKey {
    pub capability_id: LlgTimestepCapabilityId,
    pub qualification_id: LlgTimestepQualificationId,
    pub backend: TimestepBackend,
    pub device: TimestepDevice,
    pub precision: fullmag_ir::ExecutionPrecision,
    pub integrator: fullmag_ir::IntegratorChoice,
    pub timestep_policy: TimestepPolicyKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualification_artifact_sha256: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Registry {
    schema_version: String,
    entries: Vec<RegistryEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistryEntry {
    key: RegistryKey,
    validation_state: TimestepValidationState,
    artifact_path: Option<String>,
    artifact_sha256: Option<String>,
    runtime_source_inputs_sha256: Option<String>,
    runtime_dirty: Option<bool>,
    runtime_dirty_patch_sha256: Option<String>,
    validated_scope: Option<serde_json::Value>,
    validated_at: Option<String>,
    validator_schema: Option<String>,
    #[serde(default)]
    completed_gates: Vec<String>,
    reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct RegistryKey {
    capability_id: LlgTimestepCapabilityId,
    qualification_id: LlgTimestepQualificationId,
    backend: TimestepBackend,
    device: TimestepDevice,
    precision: fullmag_ir::ExecutionPrecision,
    integrator: fullmag_ir::IntegratorChoice,
    timestep_policy: TimestepPolicyKind,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct QualificationResolution {
    pub(crate) state: TimestepValidationState,
    pub(crate) artifact_sha256: Option<String>,
    pub(crate) runtime_source_inputs_sha256: Option<String>,
    pub(crate) validated_scope: Option<serde_json::Value>,
    pub(crate) validated_at: Option<String>,
    pub(crate) validator_schema: Option<String>,
}

impl Default for QualificationResolution {
    fn default() -> Self {
        Self {
            state: TimestepValidationState::Unvalidated,
            artifact_sha256: None,
            runtime_source_inputs_sha256: None,
            validated_scope: None,
            validated_at: None,
            validator_schema: None,
        }
    }
}

impl RegistryKey {
    fn matches(&self, identity: &TimestepExecutionIdentityKey) -> bool {
        self.capability_id == identity.capability_id
            && self.qualification_id == identity.qualification_id
            && self.backend == identity.backend
            && self.device == identity.device
            && self.precision == identity.precision
            && self.integrator == identity.integrator
            && self.timestep_policy == identity.timestep_policy
    }
}

fn expected_lane(
    qualification_id: LlgTimestepQualificationId,
) -> (TimestepBackend, TimestepDevice, fullmag_ir::ExecutionPrecision, TimestepPolicyKind) {
    use fullmag_ir::ExecutionPrecision::Double;
    use LlgTimestepQualificationId::*;
    use TimestepBackend::{Fdm, Fem};
    use TimestepDevice::{Cpu, Cuda, Gpu};

    match qualification_id {
        ExplicitFixedFdmCpuDouble => (Fdm, Cpu, Double, TimestepPolicyKind::Fixed),
        ExplicitFixedFdmCudaDouble => (Fdm, Cuda, Double, TimestepPolicyKind::Fixed),
        ExplicitFixedFdmCudaSingle => (
            Fdm,
            Cuda,
            fullmag_ir::ExecutionPrecision::Single,
            TimestepPolicyKind::Fixed,
        ),
        ExplicitFixedFemCpuDouble => (Fem, Cpu, Double, TimestepPolicyKind::Fixed),
        ExplicitFixedFemGpuDouble => (Fem, Gpu, Double, TimestepPolicyKind::Fixed),
        ExplicitAdaptiveFdmCpuDouble => (Fdm, Cpu, Double, TimestepPolicyKind::Adaptive),
        ExplicitAdaptiveFemCpuDouble => (Fem, Cpu, Double, TimestepPolicyKind::Adaptive),
        ExplicitAdaptiveFemGpuDouble => (Fem, Gpu, Double, TimestepPolicyKind::Adaptive),
    }
}

fn key_is_coherent(key: &RegistryKey) -> bool {
    if key.capability_id != LlgTimestepCapabilityId::LlgTdPolicyV1 {
        return false;
    }
    let (backend, device, precision, timestep_policy) = expected_lane(key.qualification_id);
    key.backend == backend
        && key.device == device
        && key.precision == precision
        && key.timestep_policy == timestep_policy
}

fn promoted_entry_is_complete(entry: &RegistryEntry) -> bool {
    entry.validation_state != TimestepValidationState::Unvalidated
        && entry.artifact_path.as_deref().is_some_and(|path| !path.is_empty())
        && entry.artifact_sha256.as_deref().is_some_and(is_sha256)
        && entry
            .runtime_source_inputs_sha256
            .as_deref()
            .is_some_and(is_sha256)
        && entry.runtime_dirty == Some(false)
        && entry.runtime_dirty_patch_sha256.is_none()
        && entry.validated_scope.is_some()
        && entry.validated_at.as_deref().is_some_and(|value| !value.is_empty())
        && entry.validator_schema.as_deref() == Some(VALIDATOR_SCHEMA)
        && has_required_gates(entry.validation_state, &entry.completed_gates)
}

fn parse_registry_document(document: &str) -> Option<Registry> {
    let parsed: Registry = serde_json::from_str(document).ok()?;
    if parsed.schema_version != REGISTRY_SCHEMA || parsed.entries.is_empty() {
        return None;
    }

    let mut seen = Vec::<RegistryKey>::with_capacity(parsed.entries.len());
    for entry in &parsed.entries {
        if !key_is_coherent(&entry.key) || seen.iter().any(|key| key == &entry.key) {
            return None;
        }
        seen.push(entry.key.clone());

        if entry.validation_state == TimestepValidationState::Unvalidated {
            if entry.artifact_path.is_some()
                || entry.artifact_sha256.is_some()
                || entry.runtime_source_inputs_sha256.is_some()
                || entry.runtime_dirty.is_some()
                || entry.runtime_dirty_patch_sha256.is_some()
                || entry.validated_scope.is_some()
                || entry.validated_at.is_some()
                || entry.validator_schema.is_some()
                || !entry.completed_gates.is_empty()
            {
                return None;
            }
        } else if !promoted_entry_is_complete(entry) {
            return None;
        }
    }
    Some(parsed)
}

fn parse_registry() -> Option<Registry> {
    parse_registry_document(REGISTRY_JSON)
}

fn registry() -> Option<&'static Registry> {
    static REGISTRY: OnceLock<Option<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(parse_registry).as_ref()
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn has_required_gates(state: TimestepValidationState, gates: &[String]) -> bool {
    let has = |gate: &str| gates.iter().any(|candidate| candidate == gate);
    match state {
        TimestepValidationState::Unvalidated => true,
        TimestepValidationState::AlgebraValidated => has("algebra"),
        TimestepValidationState::PhysicsValidated => has("algebra") && has("physics"),
        TimestepValidationState::ProductionQualified => {
            has("algebra") && has("physics") && has("production")
        }
    }
}

/// Resolve a qualification only from an exact registry, runtime-source and
/// artifact binding. Invalid, missing, dirty, stale, or partial evidence is
/// deliberately indistinguishable from an unvalidated lane.
pub(crate) fn qualification_resolution_for(
    identity: &TimestepExecutionIdentityKey,
    runtime_source_inputs_sha256: &str,
) -> QualificationResolution {
    if !is_sha256(runtime_source_inputs_sha256) {
        return QualificationResolution::default();
    }
    let Some(registry) = registry() else {
        return QualificationResolution::default();
    };
    let Some(entry) = registry
        .entries
        .iter()
        .find(|entry| entry.key.matches(identity))
    else {
        return QualificationResolution::default();
    };
    if entry.validation_state == TimestepValidationState::Unvalidated {
        return QualificationResolution::default();
    }
    if identity.backend == TimestepBackend::Fem
        && identity.precision == fullmag_ir::ExecutionPrecision::Single
    {
        return QualificationResolution::default();
    }
    let Some(artifact_sha256) = identity.qualification_artifact_sha256.as_deref() else {
        return QualificationResolution::default();
    };
    if !is_sha256(artifact_sha256)
        || entry.artifact_sha256.as_deref() != Some(artifact_sha256)
        || entry.runtime_source_inputs_sha256.as_deref()
            != Some(runtime_source_inputs_sha256)
        || entry.runtime_dirty != Some(false)
        || entry.runtime_dirty_patch_sha256.is_some()
        || entry.validated_scope.is_none()
        || entry.validated_at.as_deref().is_none_or(str::is_empty)
        || entry.validator_schema.as_deref() != Some(VALIDATOR_SCHEMA)
        || !has_required_gates(entry.validation_state, &entry.completed_gates)
    {
        return QualificationResolution::default();
    }
    QualificationResolution {
        state: entry.validation_state,
        artifact_sha256: entry.artifact_sha256.clone(),
        runtime_source_inputs_sha256: entry.runtime_source_inputs_sha256.clone(),
        validated_scope: entry.validated_scope.clone(),
        validated_at: entry.validated_at.clone(),
        validator_schema: entry.validator_schema.clone(),
    }
}

pub fn validation_state_for(
    identity: &TimestepExecutionIdentityKey,
    runtime_source_inputs_sha256: &str,
) -> TimestepValidationState {
    qualification_resolution_for(identity, runtime_source_inputs_sha256).state
}

#[cfg(test)]
mod tests {
    use super::{
        parse_registry_document, registry, validation_state_for,
        TimestepExecutionIdentityKey, TimestepPolicyKind,
    };
    use crate::{
        LlgTimestepCapabilityId, LlgTimestepQualificationId, TimestepBackend, TimestepDevice,
        TimestepValidationState,
    };

    fn fem_cpu_identity(artifact_sha256: Option<&str>) -> TimestepExecutionIdentityKey {
        TimestepExecutionIdentityKey {
            capability_id: LlgTimestepCapabilityId::LlgTdPolicyV1,
            qualification_id: LlgTimestepQualificationId::ExplicitFixedFemCpuDouble,
            backend: TimestepBackend::Fem,
            device: TimestepDevice::Cpu,
            precision: fullmag_ir::ExecutionPrecision::Double,
            integrator: fullmag_ir::IntegratorChoice::Rk45,
            timestep_policy: TimestepPolicyKind::Fixed,
            qualification_artifact_sha256: artifact_sha256.map(str::to_string),
        }
    }

    #[test]
    fn validation_state_vocabulary_roundtrips_exactly() {
        for (state, serialized) in [
            (TimestepValidationState::Unvalidated, "unvalidated"),
            (TimestepValidationState::AlgebraValidated, "algebra_validated"),
            (TimestepValidationState::PhysicsValidated, "physics_validated"),
            (
                TimestepValidationState::ProductionQualified,
                "production_qualified",
            ),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), serialized);
            assert_eq!(
                serde_json::from_value::<TimestepValidationState>(serialized.into()).unwrap(),
                state
            );
        }
    }

    #[test]
    fn missing_artifact_binding_fails_closed() {
        assert_eq!(
            validation_state_for(&fem_cpu_identity(None), &"a".repeat(64)),
            TimestepValidationState::Unvalidated
        );
    }

    #[test]
    fn stale_source_hash_fails_closed() {
        assert_eq!(
            validation_state_for(
                &fem_cpu_identity(Some(&"b".repeat(64))),
                &"c".repeat(64)
            ),
            TimestepValidationState::Unvalidated
        );
    }

    #[test]
    fn embedded_registry_covers_all_executable_lanes_without_duplicates() {
        let registry = registry().expect("embedded qualification registry must parse");
        let ids = registry
            .entries
            .iter()
            .map(|entry| entry.key.qualification_id)
            .collect::<Vec<_>>();
        assert_eq!(ids.len(), 8);
        for expected in [
            LlgTimestepQualificationId::ExplicitFixedFdmCpuDouble,
            LlgTimestepQualificationId::ExplicitFixedFdmCudaDouble,
            LlgTimestepQualificationId::ExplicitFixedFdmCudaSingle,
            LlgTimestepQualificationId::ExplicitFixedFemCpuDouble,
            LlgTimestepQualificationId::ExplicitFixedFemGpuDouble,
            LlgTimestepQualificationId::ExplicitAdaptiveFdmCpuDouble,
            LlgTimestepQualificationId::ExplicitAdaptiveFemCpuDouble,
            LlgTimestepQualificationId::ExplicitAdaptiveFemGpuDouble,
        ] {
            assert_eq!(ids.iter().filter(|id| **id == expected).count(), 1);
        }
    }

    #[test]
    fn registry_parser_rejects_duplicate_identity_keys() {
        let mut document: serde_json::Value = serde_json::from_str(super::REGISTRY_JSON).unwrap();
        let entries = document["entries"].as_array_mut().unwrap();
        let first = entries[0].clone();
        entries.push(first);
        let encoded = serde_json::to_string(&document).unwrap();
        assert!(parse_registry_document(&encoded).is_none());
    }

    #[test]
    fn registry_parser_rejects_unknown_fields_and_lane_mismatch() {
        let mut document: serde_json::Value = serde_json::from_str(super::REGISTRY_JSON).unwrap();
        document["entries"][0]["unexpected"] = serde_json::Value::Bool(true);
        assert!(parse_registry_document(&serde_json::to_string(&document).unwrap()).is_none());

        let mut document: serde_json::Value = serde_json::from_str(super::REGISTRY_JSON).unwrap();
        document["entries"][0]["key"]["backend"] = serde_json::Value::String("fdm".into());
        assert!(parse_registry_document(&serde_json::to_string(&document).unwrap()).is_none());
    }
}
