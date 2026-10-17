//! Canonical migration of legacy live execution intent into v2 layers.
//!
//! The migration is deliberately pure.  It does not publish a profile, read
//! host state, select a GPU, or turn a legacy ordinal into a UUID.  The API
//! boundary owns profile publication and host admission after it has carried
//! this result into the canonical StudyPlan/RunIntent path.

use crate::RequestedExecution;
use fullmag_ir::{
    BackendTarget, ComputeResourcePatchIR, ComputeResourcesIR, CpuResourcePatchIR, ExecutionDevice,
    ExecutionFieldOriginIR, ExecutionMode, ExecutionOriginKindIR, ExecutionPrecision,
    ExecutionProfileIR, ExecutionRequestLayerIR, ExecutionRequestPatchIR, FieldPatch,
    MaterializedExecutionRequestIR, MemoryResourcePatchIR, ProblemIR,
};

pub const LEGACY_LIVE_EXECUTION_PROFILE_ID: &str = "exec:default";
pub const LEGACY_LIVE_EXECUTION_PROFILE_VERSION: &str = "1";

/// The pure v2 representation of a legacy live request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyLiveExecutionMigration {
    /// The immutable profile that the API boundary must publish or reuse.
    pub profile: ExecutionProfileIR,
    /// The authored request layer carrying the legacy values and origin.
    pub layer: ExecutionRequestLayerIR,
    /// The replayable request used to construct the canonical StudyPlan.
    pub materialized: MaterializedExecutionRequestIR,
}

/// Return the canonical empty profile used when migrating a legacy live scene.
///
/// The profile intentionally carries no CPU/GPU choice.  All authored legacy
/// values are represented by the explicit layer returned by
/// [`migrate_legacy_live_execution`].
pub fn legacy_live_execution_profile() -> ExecutionProfileIR {
    let profile = ExecutionProfileIR::default();
    debug_assert_eq!(profile.profile_id, LEGACY_LIVE_EXECUTION_PROFILE_ID);
    debug_assert_eq!(profile.version, LEGACY_LIVE_EXECUTION_PROFILE_VERSION);
    profile
}

/// Convert a legacy live request into the canonical profile-plus-layer form.
///
/// `problem` is used only to preserve and validate already-authored typed
/// compute resources and legacy ordinal metadata.  The function never resolves
/// resources or performs host admission.  Only `Study` and `Script` origins
/// are accepted because this adapter represents authored legacy intent rather
/// than a submit/CLI override.
pub fn migrate_legacy_live_execution(
    problem: &ProblemIR,
    requested: &RequestedExecution,
    origin_kind: ExecutionOriginKindIR,
    location: impl Into<String>,
) -> Result<LegacyLiveExecutionMigration, String> {
    requested
        .validate()
        .map_err(|error| format!("legacy live execution request is invalid: {error}"))?;
    if !matches!(
        origin_kind,
        ExecutionOriginKindIR::Study | ExecutionOriginKindIR::Script
    ) {
        return Err("legacy live execution migration requires a study or script origin".into());
    }

    validate_legacy_ordinal_constraints(problem)?;
    let resources = ComputeResourcesIR::from_problem(problem)?;
    if let Some(resources) = resources.as_ref() {
        resources.validate().map_err(|errors| errors.join("; "))?;
        resources
            .validate_legacy_selection(problem)
            .map_err(|errors| errors.join("; "))?;
        if requested.device == "cpu" && resources.gpu.is_some() {
            return Err(
                "execution_intent_conflict: compute_resources.gpu contradicts requested_execution.device=cpu"
                    .into(),
            );
        }
    }

    let origin = ExecutionFieldOriginIR {
        kind: origin_kind,
        location: location.into(),
    };
    origin.validate()?;
    let layer = ExecutionRequestLayerIR {
        origin,
        request: ExecutionRequestPatchIR {
            backend: FieldPatch::Value(parse_backend(&requested.backend)?),
            device: FieldPatch::Value(parse_device(&requested.device)?),
            precision: FieldPatch::Value(parse_precision(&requested.precision)?),
            mode: FieldPatch::Value(parse_mode(&requested.mode)?),
            resources: resources
                .as_ref()
                .map(resources_patch)
                .map(FieldPatch::Value)
                .unwrap_or(FieldPatch::Absent),
        },
    };
    let profile = legacy_live_execution_profile();
    profile.validate()?;
    let materialized =
        fullmag_ir::materialize_execution_request(Some(profile.clone()), vec![layer.clone()])?;

    Ok(LegacyLiveExecutionMigration {
        profile,
        layer,
        materialized,
    })
}

fn parse_backend(value: &str) -> Result<BackendTarget, String> {
    match value {
        "auto" => Ok(BackendTarget::Auto),
        "fdm" => Ok(BackendTarget::Fdm),
        "fem" => Ok(BackendTarget::Fem),
        "hybrid" => Ok(BackendTarget::Hybrid),
        _ => Err(format!("unsupported legacy execution backend `{value}`")),
    }
}

fn parse_device(value: &str) -> Result<ExecutionDevice, String> {
    match value {
        "auto" => Ok(ExecutionDevice::Auto),
        "cpu" => Ok(ExecutionDevice::Cpu),
        "gpu" => Ok(ExecutionDevice::Gpu),
        _ => Err(format!("unsupported legacy execution device `{value}`")),
    }
}

fn parse_precision(value: &str) -> Result<ExecutionPrecision, String> {
    match value {
        "single" => Ok(ExecutionPrecision::Single),
        "double" => Ok(ExecutionPrecision::Double),
        _ => Err(format!("unsupported legacy execution precision `{value}`")),
    }
}

fn parse_mode(value: &str) -> Result<ExecutionMode, String> {
    match value {
        "strict" => Ok(ExecutionMode::Strict),
        "extended" => Ok(ExecutionMode::Extended),
        "hybrid" => Ok(ExecutionMode::Hybrid),
        _ => Err(format!("unsupported legacy execution mode `{value}`")),
    }
}

fn resources_patch(resources: &ComputeResourcesIR) -> ComputeResourcePatchIR {
    ComputeResourcePatchIR {
        target: FieldPatch::Value(resources.target.clone()),
        cpu: FieldPatch::Value(CpuResourcePatchIR {
            threads: FieldPatch::Value(resources.cpu.threads),
            core_policy: FieldPatch::Value(resources.cpu.core_policy),
            affinity: FieldPatch::Value(resources.cpu.affinity),
            numa_node: FieldPatch::Value(resources.cpu.numa_node),
            native_threads: FieldPatch::Value(resources.cpu.native_threads),
            blas_threads: FieldPatch::Value(resources.cpu.blas_threads),
        }),
        gpu: FieldPatch::Value(resources.gpu.clone()),
        ram: FieldPatch::Value(MemoryResourcePatchIR {
            reservation_bytes: FieldPatch::Value(resources.ram.reservation_bytes),
        }),
        scratch: FieldPatch::Value(MemoryResourcePatchIR {
            reservation_bytes: FieldPatch::Value(resources.scratch.reservation_bytes),
        }),
        parallelism: FieldPatch::Value(resources.parallelism.clone()),
        placement: FieldPatch::Value(resources.placement),
    }
}

fn validate_legacy_ordinal_constraints(problem: &ProblemIR) -> Result<(), String> {
    let Some(selection) = problem
        .problem_meta
        .runtime_metadata
        .get("runtime_selection")
    else {
        return Ok(());
    };
    let Some(selection) = selection.as_object() else {
        return Err("runtime_selection must be an object before legacy execution migration".into());
    };
    if let Some(value) = selection.get("gpu_count").filter(|value| !value.is_null()) {
        let count = value
            .as_u64()
            .ok_or("runtime_selection.gpu_count must be a non-negative integer")?;
        if count > 1 {
            return Err(
                "legacy live execution cannot preserve a multi-GPU ordinal selection".into(),
            );
        }
    }
    if let Some(value) = selection
        .get("device_index")
        .filter(|value| !value.is_null())
    {
        let index = value
            .as_u64()
            .ok_or("runtime_selection.device_index must be a non-negative integer")?;
        if index != 0 {
            return Err(format!(
                "legacy live execution cannot preserve GPU ordinal device_index={index}; only device_index=0 is portable in the single-GPU Docker lane"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use fullmag_ir::{
        ComputeParallelismIR, ComputePlacementIR, ComputeTargetIR, CpuAffinityIR, CpuCorePolicyIR,
        GpuResourcesIR, GpuSelectorIR, RequestedThreads,
    };
    use serde_json::json;

    fn requested(device: &str) -> RequestedExecution {
        RequestedExecution {
            backend: "fdm".into(),
            device: device.into(),
            precision: "double".into(),
            mode: "strict".into(),
            minimum_resources: None,
        }
    }

    #[test]
    fn migration_uses_empty_immutable_default_and_explicit_auto_layer() {
        let migration = migrate_legacy_live_execution(
            &ProblemIR::bootstrap_example(),
            &requested("auto"),
            ExecutionOriginKindIR::Study,
            "live.scene.study.legacy_execution",
        )
        .unwrap();

        assert_eq!(migration.profile, ExecutionProfileIR::default());
        assert_eq!(migration.profile.profile_id, "exec:default");
        assert_eq!(migration.profile.version, "1");
        assert!(migration.profile.defaults.backend.is_absent());
        assert!(migration.profile.defaults.device.is_absent());
        assert!(migration.profile.defaults.precision.is_absent());
        assert!(migration.profile.defaults.mode.is_absent());
        assert!(migration.profile.defaults.resources.is_absent());
        assert_eq!(migration.layer.origin.kind, ExecutionOriginKindIR::Study);
        assert_eq!(
            migration.layer.request.device,
            FieldPatch::Value(ExecutionDevice::Auto)
        );
        assert_eq!(
            migration.materialized.requested.device,
            ExecutionDevice::Auto
        );
        assert_eq!(
            migration.materialized.origins["device"].location,
            "live.scene.study.legacy_execution"
        );
        fullmag_ir::validate_execution_materialization(&migration.materialized).unwrap();
    }

    #[test]
    fn migration_preserves_gpu_intent_and_all_typed_resources() {
        let resources = ComputeResourcesIR {
            schema_version: fullmag_ir::COMPUTE_RESOURCES_SCHEMA.into(),
            target: ComputeTargetIR::Node {
                id: "node-a".into(),
            },
            cpu: fullmag_ir::CpuResourcesIR {
                threads: RequestedThreads::Count(4),
                core_policy: Some(CpuCorePolicyIR::PhysicalFirst),
                affinity: CpuAffinityIR::Compact,
                numa_node: None,
                native_threads: RequestedThreads::Count(2),
                blas_threads: RequestedThreads::Count(2),
            },
            gpu: Some(GpuResourcesIR {
                selector: GpuSelectorIR::AnyCompatible,
                device_uuids: Vec::new(),
                devices_per_task: 1,
                vram_per_device_bytes: Some(8 * 1024 * 1024 * 1024),
            }),
            ram: fullmag_ir::MemoryReservationIR {
                reservation_bytes: Some(2 * 1024 * 1024 * 1024),
            },
            scratch: fullmag_ir::MemoryReservationIR {
                reservation_bytes: Some(4 * 1024 * 1024 * 1024),
            },
            parallelism: ComputeParallelismIR::SingleProcess,
            placement: ComputePlacementIR::Pinned,
        };
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "compute_resources".into(),
            serde_json::to_value(&resources).unwrap(),
        );
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".into(),
            json!({"device":"cuda", "gpu_count":1, "device_index":0}),
        );

        let migration = migrate_legacy_live_execution(
            &problem,
            &requested("gpu"),
            ExecutionOriginKindIR::Script,
            "script:legacy.device",
        )
        .unwrap();

        assert_eq!(
            migration.materialized.requested.device,
            ExecutionDevice::Gpu
        );
        assert_eq!(migration.materialized.requested.resources, resources);
        assert_eq!(
            migration.materialized.origins["resources.gpu"].kind,
            ExecutionOriginKindIR::Script
        );
        let bound = crate::bind_materialized_execution(&problem, &migration.materialized).unwrap();
        assert_eq!(
            bound.problem_meta.runtime_metadata["compute_resources"],
            serde_json::to_value(resources).unwrap()
        );
    }

    #[test]
    fn migration_maps_cpu_precision_mode_and_backend_without_fallback() {
        let mut request = requested("cpu");
        request.backend = "fem".into();
        request.precision = "single".into();
        request.mode = "hybrid".into();
        let migration = migrate_legacy_live_execution(
            &ProblemIR::bootstrap_example(),
            &request,
            ExecutionOriginKindIR::Script,
            "script:legacy.execution",
        )
        .unwrap();

        assert_eq!(migration.materialized.requested.backend, BackendTarget::Fem);
        assert_eq!(
            migration.materialized.requested.device,
            ExecutionDevice::Cpu
        );
        assert_eq!(
            migration.materialized.requested.precision,
            ExecutionPrecision::Single
        );
        assert_eq!(migration.materialized.requested.mode, ExecutionMode::Hybrid);
        assert_eq!(
            migration.materialized.origins["device"].kind,
            ExecutionOriginKindIR::Script
        );
    }

    #[test]
    fn nonzero_gpu_ordinal_is_rejected_without_fabricating_a_uuid() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".into(),
            json!({"device":"cuda", "gpu_count":1, "device_index":1}),
        );
        let error = migrate_legacy_live_execution(
            &problem,
            &requested("gpu"),
            ExecutionOriginKindIR::Study,
            "live.scene.study.legacy_execution",
        )
        .unwrap_err();
        assert!(error.contains("device_index=1"));
    }

    #[test]
    fn unsupported_origin_and_multi_gpu_are_rejected() {
        let origin_error = migrate_legacy_live_execution(
            &ProblemIR::bootstrap_example(),
            &requested("cpu"),
            ExecutionOriginKindIR::Cli,
            "cli.device",
        )
        .unwrap_err();
        assert!(origin_error.contains("study or script origin"));

        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "runtime_selection".into(),
            json!({"device":"gpu", "gpu_count":2}),
        );
        let gpu_error = migrate_legacy_live_execution(
            &problem,
            &requested("gpu"),
            ExecutionOriginKindIR::Study,
            "live.scene.study.legacy_execution",
        )
        .unwrap_err();
        assert!(gpu_error.contains("multi-GPU ordinal"));
    }

    #[test]
    fn gpu_resources_cannot_be_migrated_as_cpu_intent() {
        let mut problem = ProblemIR::bootstrap_example();
        problem.problem_meta.runtime_metadata.insert(
            "compute_resources".into(),
            json!({
                "schema_version":"compute_resources.v1",
                "gpu":{"selector":"any_compatible","device_uuids":[],"devices_per_task":1,"vram_per_device_bytes":null}
            }),
        );
        let error = migrate_legacy_live_execution(
            &problem,
            &requested("cpu"),
            ExecutionOriginKindIR::Study,
            "live.scene.study.legacy_execution",
        )
        .unwrap_err();
        assert!(error.contains("compute_resources.gpu"));
    }
}
