use crate::types::{FdmGpuExecutionReceipt, RunError};

#[cfg(feature = "cuda")]
use super::{ffi, NativeFdmBackend};
#[cfg(feature = "cuda")]
use crate::types::{
    FdmGpuAdaptiveExecutionTelemetry, FdmGpuAdaptiveNumericsTelemetry,
    FdmGpuLocalPipelineTelemetry, FdmGpuOperatorResidency, FdmGpuPrecisionComponents,
    FdmGpuPrecisionPolicyReceipt, FdmGpuStepTransactionTelemetry, FdmGpuTransferCounts,
    FdmGpuWorkspaceTelemetry,
};

fn preflight_error(detail: impl AsRef<str>) -> RunError {
    RunError {
        message: format!("strict FDM GPU preflight mismatch: {}", detail.as_ref()),
    }
}

fn finalize_receipt_result<T>(
    receipt_result: Result<FdmGpuExecutionReceipt, RunError>,
    provenance: &mut crate::types::ExecutionProvenance,
    mut artifacts: Option<&mut crate::artifact_pipeline::ArtifactRecorder>,
    outcome: Result<T, RunError>,
) -> Result<T, RunError> {
    let receipt = receipt_result
        .as_ref()
        .ok()
        .cloned()
        .unwrap_or_else(|| FdmGpuExecutionReceipt::strict_unvalidated(&provenance.precision));
    provenance.fdm_gpu_execution_receipt = Some(receipt);
    if let Some(artifacts) = artifacts.as_deref_mut() {
        artifacts.update_provenance(provenance.clone());
    }
    match outcome {
        Ok(value) => {
            receipt_result?;
            Ok(value)
        }
        Err(primary) => {
            if let Some(artifacts) = artifacts.as_deref_mut() {
                let _ = artifacts.publish_failed_run_provenance(&primary);
            }
            Err(primary)
        }
    }
}

const KNOWN_OPERATOR_MASK: u64 = (1_u64 << 19) - 1;

#[cfg(test)]
pub(super) fn known_operator_mask() -> u64 {
    KNOWN_OPERATOR_MASK
}

pub(super) fn requested_device_name(requested: &str) -> Result<&'static str, RunError> {
    match requested {
        "gpu" | "cuda" => Ok("gpu"),
        "auto" => Ok("auto"),
        other => Err(preflight_error(format!(
            "requested_device={other} expected=gpu|cuda|auto"
        ))),
    }
}

pub(super) fn validate_native_operator_masks(
    required: u64,
    resolved_device: u64,
    resolved_host: u64,
    resolved_unknown: u64,
    executed_device: u64,
    executed_host: u64,
    executed_unknown: u64,
) -> Result<(), RunError> {
    let unknown = (required
        | resolved_device
        | resolved_host
        | resolved_unknown
        | executed_device
        | executed_host
        | executed_unknown)
        & !KNOWN_OPERATOR_MASK;
    if unknown != 0 {
        return Err(preflight_error(format!(
            "unknown_operator_mask={unknown:#x}"
        )));
    }
    if required == 0
        || resolved_device & required != required
        || resolved_host != 0
        || resolved_unknown != 0
        || resolved_device & !required != 0
        || executed_device & !required != 0
        || executed_host != 0
        || executed_unknown != (required & !executed_device)
    {
        return Err(preflight_error(format!(
            "required={required:#x} resolved_device={resolved_device:#x} resolved_host={resolved_host:#x} resolved_unknown={resolved_unknown:#x} executed_device={executed_device:#x} executed_host={executed_host:#x} executed_unknown={executed_unknown:#x}"
        )));
    }
    Ok(())
}

#[cfg(feature = "cuda")]
#[derive(Debug, Clone)]
pub(crate) struct FdmGpuReceiptLifecycle {
    requested_device: String,
    execution_mode: fullmag_ir::ExecutionMode,
}

#[cfg(feature = "cuda")]
impl FdmGpuReceiptLifecycle {
    pub(crate) fn begin(
        backend: &NativeFdmBackend,
        requested_device: &str,
        execution_mode: fullmag_ir::ExecutionMode,
    ) -> Result<(Self, FdmGpuExecutionReceipt), RunError> {
        let requested_device = requested_device_name(requested_device)?.to_string();
        let receipt = backend.execution_receipt(&requested_device, execution_mode)?;
        if execution_mode == fullmag_ir::ExecutionMode::Strict {
            validate_strict_preflight(&receipt)?;
        }
        Ok((
            Self {
                requested_device,
                execution_mode,
            },
            receipt,
        ))
    }

    pub(crate) fn finalize_after_outcome<T>(
        &self,
        backend: &NativeFdmBackend,
        provenance: &mut crate::types::ExecutionProvenance,
        artifacts: Option<&mut crate::artifact_pipeline::ArtifactRecorder>,
        outcome: Result<T, RunError>,
    ) -> Result<T, RunError> {
        let receipt_result = backend
            .execution_receipt(&self.requested_device, self.execution_mode)
            .and_then(|mut receipt| {
                if outcome.is_ok() && self.execution_mode == fullmag_ir::ExecutionMode::Strict {
                    validate_strict_final_receipt(&receipt)?;
                    receipt.validation_state = "validated".to_string();
                }
                Ok(receipt)
            });
        let telemetry_result = query_step_transaction_telemetry(backend);
        if let Ok(telemetry) = &telemetry_result {
            provenance.fdm_gpu_step_transaction_telemetry = Some(telemetry.clone());
        }
        let outcome = match outcome {
            Ok(value) => telemetry_result.map(|_| value),
            Err(primary) => Err(primary),
        };
        finalize_receipt_result(receipt_result, provenance, artifacts, outcome)
    }
}

pub(super) fn validate_strict_preflight(receipt: &FdmGpuExecutionReceipt) -> Result<(), RunError> {
    if receipt.requested != "gpu" && receipt.requested != "auto" {
        return Err(preflight_error(format!(
            "requested={} expected=gpu|auto",
            receipt.requested
        )));
    }
    if receipt.resolved != "device_resident" {
        return Err(preflight_error(format!(
            "resolved={} expected=device_resident",
            receipt.resolved
        )));
    }
    if receipt.fallback_count != 0 {
        return Err(preflight_error(format!(
            "fallback_count={} expected=0",
            receipt.fallback_count
        )));
    }
    if !receipt.accounting_valid
        || receipt.required_operator_mask == 0
        || receipt.resolved_device_operator_mask != receipt.required_operator_mask
        || receipt.resolved_host_operator_mask != 0
        || receipt.resolved_unknown_operator_mask != 0
    {
        return Err(preflight_error(format!(
            "required={:#x} resolved_device={:#x} resolved_host={:#x} resolved_unknown={:#x} accounting_valid={}",
            receipt.required_operator_mask,
            receipt.resolved_device_operator_mask,
            receipt.resolved_host_operator_mask,
            receipt.resolved_unknown_operator_mask,
            receipt.accounting_valid
        )));
    }
    if receipt.operator_residency.is_empty() {
        return Err(preflight_error("native receipt has no required operators"));
    }
    let precision_policy = receipt.precision_policy.as_ref().ok_or_else(|| {
        preflight_error("native receipt has no executed precision policy telemetry")
    })?;
    if !precision_policy.accounting_valid
        || precision_policy.requested != receipt.precision
        || precision_policy.resolved != precision_policy.executed
    {
        return Err(preflight_error(format!(
            "precision policy requested={} receipt_precision={} accounting_valid={} resolved={:?} executed={:?}",
            precision_policy.requested,
            receipt.precision,
            precision_policy.accounting_valid,
            precision_policy.resolved,
            precision_policy.executed
        )));
    }
    if let Some(operator) = receipt.operator_residency.iter().find(|operator| {
        operator.location != "device"
            && !(operator.operator == "control" && operator.location == "host_scalar")
    }) {
        return Err(preflight_error(format!(
            "operator={} realization={} location={} expected=device",
            operator.operator, operator.realization, operator.location
        )));
    }
    Ok(())
}

pub(crate) fn validate_strict_final_receipt(
    receipt: &FdmGpuExecutionReceipt,
) -> Result<(), RunError> {
    validate_strict_preflight(receipt)?;
    if receipt.executed != "cuda_fdm"
        || receipt.executed_device_operator_mask != receipt.required_operator_mask
        || receipt.executed_host_operator_mask != 0
        || receipt.executed_unknown_operator_mask != 0
    {
        return Err(RunError {
            message: "strict FDM GPU final execution is not fully device-proven".to_string(),
        });
    }
    let counts = &receipt.transfer_counts;
    if counts.hot_loop_full_vector_h2d_count != 0
        || counts.hot_loop_full_vector_h2d_bytes != 0
        || counts.hot_loop_full_vector_d2h_count != 0
        || counts.hot_loop_full_vector_d2h_bytes != 0
    {
        return Err(RunError {
            message: "strict FDM GPU hot-loop full-vector transfer count must be zero".to_string(),
        });
    }
    if counts.hot_loop_host_compute_count != 0 {
        return Err(RunError {
            message: "strict FDM GPU hot-loop host-compute count must be zero".to_string(),
        });
    }
    if counts.hot_loop_host_sync_count > counts.hot_loop_control_scalar_host_sync_count {
        return Err(RunError {
            message: "strict FDM GPU hot-loop contains an unclassified host synchronization"
                .to_string(),
        });
    }
    Ok(())
}

#[cfg(feature = "cuda")]
fn execution_class_name(
    value: ffi::fullmag_fdm_execution_class_v1,
) -> Result<&'static str, RunError> {
    match value {
        ffi::FULLMAG_FDM_EXECUTION_UNKNOWN => Ok("unknown"),
        ffi::FULLMAG_FDM_EXECUTION_DEVICE_RESIDENT => Ok("device_resident"),
        ffi::FULLMAG_FDM_EXECUTION_GPU_OPERATOR_HOST_CONTROL => Ok("gpu_operator_host_control"),
        ffi::FULLMAG_FDM_EXECUTION_HYBRID => Ok("hybrid"),
        ffi::FULLMAG_FDM_EXECUTION_CPU => Ok("cpu"),
        other => Err(preflight_error(format!(
            "unknown execution_class discriminant={other}"
        ))),
    }
}

#[cfg(feature = "cuda")]
fn executed_backend_name(
    value: ffi::fullmag_fdm_executed_backend_v1,
) -> Result<&'static str, RunError> {
    match value {
        ffi::FULLMAG_FDM_EXECUTED_UNKNOWN => Ok("unknown"),
        ffi::FULLMAG_FDM_EXECUTED_CUDA_FDM => Ok("cuda_fdm"),
        other => Err(preflight_error(format!(
            "unknown executed_backend discriminant={other}"
        ))),
    }
}

#[cfg(feature = "cuda")]
fn operator_location_name(
    value: ffi::fullmag_fdm_operator_location_v1,
) -> Result<&'static str, RunError> {
    match value {
        ffi::FULLMAG_FDM_LOCATION_UNKNOWN => Ok("unknown"),
        ffi::FULLMAG_FDM_LOCATION_DEVICE => Ok("device"),
        ffi::FULLMAG_FDM_LOCATION_HOST => Ok("host"),
        ffi::FULLMAG_FDM_LOCATION_MIXED => Ok("mixed"),
        ffi::FULLMAG_FDM_LOCATION_HOST_SCALAR => Ok("host_scalar"),
        other => Err(preflight_error(format!(
            "unknown operator_location discriminant={other}"
        ))),
    }
}

#[cfg(feature = "cuda")]
fn precision_name(value: u32) -> Result<&'static str, RunError> {
    match value {
        value if value == ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE as u32 => {
            Ok("single")
        }
        value if value == ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE as u32 => {
            Ok("double")
        }
        other => Err(preflight_error(format!(
            "unknown precision discriminant={other}"
        ))),
    }
}

#[cfg(feature = "cuda")]
fn precision_policy_telemetry_v1_request() -> ffi::fullmag_fdm_precision_policy_telemetry_v1 {
    ffi::fullmag_fdm_precision_policy_telemetry_v1 {
        abi_version: ffi::FULLMAG_FDM_PRECISION_POLICY_TELEMETRY_ABI_V1,
        struct_size: std::mem::size_of::<ffi::fullmag_fdm_precision_policy_telemetry_v1>() as u32,
        accounting_valid: 0,
        storage_precision: 0,
        compute_precision: 0,
        fft_precision: 0,
        reduction_precision: 0,
        realization: 0,
        metric_valid_mask: 0,
    }
}

#[cfg(feature = "cuda")]
fn precision_components_from_ir(
    policy: &fullmag_ir::FdmPrecisionPolicyIR,
) -> FdmGpuPrecisionComponents {
    let name = |precision| match precision {
        fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
        fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
    };
    FdmGpuPrecisionComponents {
        storage: name(policy.storage),
        compute: name(policy.compute),
        fft: name(policy.fft),
        reduction: name(policy.reduction),
        realization_id: policy.realization_id.clone(),
    }
}

#[cfg(feature = "cuda")]
fn precision_policy_from_native(
    native: ffi::fullmag_fdm_precision_policy_telemetry_v1,
    requested: fullmag_ir::ExecutionPrecision,
    resolved: &fullmag_ir::FdmPrecisionPolicyIR,
) -> Result<FdmGpuPrecisionPolicyReceipt, RunError> {
    if native.abi_version != ffi::FULLMAG_FDM_PRECISION_POLICY_TELEMETRY_ABI_V1
        || native.struct_size
            != std::mem::size_of::<ffi::fullmag_fdm_precision_policy_telemetry_v1>() as u32
    {
        return Err(preflight_error(format!(
            "precision policy ABI identity mismatch: version={} size={}",
            native.abi_version, native.struct_size
        )));
    }
    if native.accounting_valid != 1 {
        return Err(preflight_error(format!(
            "precision policy accounting_valid={} expected=1",
            native.accounting_valid
        )));
    }
    if native.metric_valid_mask != ffi::FULLMAG_FDM_PRECISION_POLICY_METRIC_IDENTITY {
        return Err(preflight_error(format!(
            "precision policy metric_valid_mask={:#x} expected={:#x}",
            native.metric_valid_mask,
            ffi::FULLMAG_FDM_PRECISION_POLICY_METRIC_IDENTITY
        )));
    }

    let realization_id = match native.realization {
        ffi::FULLMAG_FDM_PRECISION_POLICY_FULL_DOUBLE => {
            fullmag_ir::FdmPrecisionPolicyIR::FULL_DOUBLE_REALIZATION_ID
        }
        ffi::FULLMAG_FDM_PRECISION_POLICY_SINGLE_STORAGE_FP64_REDUCTION => {
            fullmag_ir::FdmPrecisionPolicyIR::SINGLE_STORAGE_FP64_REDUCTION_REALIZATION_ID
        }
        other => {
            return Err(preflight_error(format!(
                "unknown precision policy realization={other}"
            )))
        }
    };
    let executed = FdmGpuPrecisionComponents {
        storage: precision_name(native.storage_precision)?.to_string(),
        compute: precision_name(native.compute_precision)?.to_string(),
        fft: precision_name(native.fft_precision)?.to_string(),
        reduction: precision_name(native.reduction_precision)?.to_string(),
        realization_id: realization_id.to_string(),
    };
    let realization_precision = match native.realization {
        ffi::FULLMAG_FDM_PRECISION_POLICY_FULL_DOUBLE => fullmag_ir::ExecutionPrecision::Double,
        ffi::FULLMAG_FDM_PRECISION_POLICY_SINGLE_STORAGE_FP64_REDUCTION => {
            fullmag_ir::ExecutionPrecision::Single
        }
        _ => unreachable!("realization validated above"),
    };
    let realization_components = precision_components_from_ir(
        &fullmag_ir::FdmPrecisionPolicyIR::resolve(realization_precision),
    );
    if executed != realization_components {
        return Err(preflight_error(format!(
            "precision policy fields disagree with realization: executed={executed:?} expected={realization_components:?}"
        )));
    }
    resolved.validate_for(requested).map_err(preflight_error)?;
    let resolved_components = precision_components_from_ir(resolved);
    if executed != resolved_components {
        return Err(preflight_error(format!(
            "executed precision policy differs from plan: executed={executed:?} resolved={resolved_components:?}"
        )));
    }

    Ok(FdmGpuPrecisionPolicyReceipt {
        schema_version: "fullmag.fdm.cuda.precision-policy.v1".to_string(),
        requested: match requested {
            fullmag_ir::ExecutionPrecision::Single => "single".to_string(),
            fullmag_ir::ExecutionPrecision::Double => "double".to_string(),
        },
        resolved: resolved_components,
        executed,
        accounting_valid: true,
    })
}

#[cfg(feature = "cuda")]
fn query_precision_policy_telemetry(
    backend: &NativeFdmBackend,
) -> Result<FdmGpuPrecisionPolicyReceipt, RunError> {
    let mut native = precision_policy_telemetry_v1_request();
    let status = unsafe {
        ffi::fullmag_fdm_backend_get_precision_policy_telemetry_v1(
            backend.handle as *mut _,
            &mut native,
        )
    };
    if status != ffi::FULLMAG_FDM_OK {
        return Err(backend.last_error_or("FDM CUDA precision policy telemetry query failed"));
    }
    precision_policy_from_native(native, backend.precision, &backend.precision_policy)
}

#[cfg(feature = "cuda")]
fn integrator_realization(integrator: u32, precision: &str) -> Result<String, RunError> {
    let name = match integrator {
        value if value == ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN as u32 => "heun",
        value if value == ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK4 as u32 => "rk4",
        value if value == ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK23 as u32 => "rk23",
        value if value == ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_DP45 as u32 => "dp45",
        value if value == ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_ABM3 as u32 => "abm3",
        other => {
            return Err(preflight_error(format!(
                "unknown integrator discriminant={other}"
            )));
        }
    };
    let suffix = if precision == "single" {
        "fp32"
    } else {
        "fp64"
    };
    Ok(format!("cuda_{name}_{suffix}"))
}

#[cfg(feature = "cuda")]
fn push_operator(
    operators: &mut Vec<FdmGpuOperatorResidency>,
    mask: u64,
    bit: u64,
    operator: &str,
    realization: String,
) {
    if mask & bit != 0 {
        operators.push(FdmGpuOperatorResidency {
            operator: operator.to_string(),
            realization,
            location: "device".to_string(),
        });
    }
}

#[cfg(feature = "cuda")]
fn execution_receipt_v2_request() -> ffi::fullmag_fdm_execution_receipt_v2 {
    ffi::fullmag_fdm_execution_receipt_v2 {
        abi_version: ffi::FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V2,
        struct_size: std::mem::size_of::<ffi::fullmag_fdm_execution_receipt_v2>() as u32,
        execution_class: ffi::FULLMAG_FDM_EXECUTION_UNKNOWN,
        executed_backend: ffi::FULLMAG_FDM_EXECUTED_UNKNOWN,
        device_ordinal: -1,
        precision: ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE as u32,
        integrator: ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN as u32,
        reserved0: 0,
        required_operator_mask: 0,
        device_operator_mask: 0,
        host_operator_mask: 0,
        resolved_unknown_operator_mask: 0,
        executed_device_operator_mask: 0,
        executed_host_operator_mask: 0,
        executed_unknown_operator_mask: 0,
        reduction_location: ffi::FULLMAG_FDM_LOCATION_UNKNOWN,
        control_location: ffi::FULLMAG_FDM_LOCATION_UNKNOWN,
        fallback_count: 0,
        setup_full_vector_h2d_count: 0,
        setup_full_vector_h2d_bytes: 0,
        hot_loop_full_vector_h2d_count: 0,
        hot_loop_full_vector_h2d_bytes: 0,
        hot_loop_full_vector_d2h_count: 0,
        hot_loop_full_vector_d2h_bytes: 0,
        hot_loop_host_compute_count: 0,
        hot_loop_host_sync_count: 0,
        hot_loop_control_scalar_d2h_bytes: 0,
        hot_loop_control_scalar_host_sync_count: 0,
        setup_full_vector_d2h_count: 0,
        setup_full_vector_d2h_bytes: 0,
        observation_full_vector_h2d_count: 0,
        observation_full_vector_h2d_bytes: 0,
        observation_full_vector_d2h_count: 0,
        observation_full_vector_d2h_bytes: 0,
        accounting_valid: 0,
        reserved1: 0,
    }
}

#[cfg(feature = "cuda")]
fn step_transaction_telemetry_v1_request() -> ffi::fullmag_fdm_step_transaction_telemetry_v1 {
    ffi::fullmag_fdm_step_transaction_telemetry_v1 {
        abi_version: ffi::FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1,
        struct_size: std::mem::size_of::<ffi::fullmag_fdm_step_transaction_telemetry_v1>() as u32,
        accounting_valid: 0,
        reserved0: 0,
        capture_count: 0,
        rollback_count: 0,
        capture_d2d_bytes: 0,
        rollback_d2d_bytes: 0,
        rollback_latency_total_ns: 0,
        rollback_latency_max_ns: 0,
        accepted_step_index: 0,
        attempt_generation: 0,
        thermal_rng_draws: 0,
        stale_publication_count: 0,
    }
}

#[cfg(feature = "cuda")]
fn adaptive_execution_telemetry_v1_request() -> ffi::fullmag_fdm_adaptive_execution_telemetry_v1 {
    ffi::fullmag_fdm_adaptive_execution_telemetry_v1 {
        abi_version: ffi::FULLMAG_FDM_ADAPTIVE_EXECUTION_TELEMETRY_ABI_V1,
        struct_size: std::mem::size_of::<ffi::fullmag_fdm_adaptive_execution_telemetry_v1>() as u32,
        realization: ffi::FULLMAG_FDM_ADAPTIVE_CONTROL_NOT_APPLICABLE,
        accounting_valid: 0,
        graph_build_count: 0,
        graph_launch_count: 0,
        terminal_control_d2h_bytes: 0,
        terminal_control_host_sync_count: 0,
        step_completion_host_sync_count: 0,
        stats_none_host_sync_count: 0,
    }
}

#[cfg(feature = "cuda")]
fn adaptive_execution_telemetry_from_native(
    native: ffi::fullmag_fdm_adaptive_execution_telemetry_v1,
) -> Result<FdmGpuAdaptiveExecutionTelemetry, RunError> {
    let realization = match native.realization {
        ffi::FULLMAG_FDM_ADAPTIVE_CONTROL_NOT_APPLICABLE => "not_applicable",
        ffi::FULLMAG_FDM_ADAPTIVE_CONTROL_LEGACY_HOST_READBACK => "legacy_host_readback",
        ffi::FULLMAG_FDM_ADAPTIVE_CONTROL_CUDA_CONDITIONAL_GRAPH => "cuda_conditional_graph_v1",
        ffi::FULLMAG_FDM_ADAPTIVE_CONTROL_CUDA_CONDITIONAL_GRAPH_BATCHED => {
            "cuda_conditional_graph_batched_v1"
        }
        other => {
            return Err(preflight_error(format!(
                "unknown adaptive control realization={other}"
            )));
        }
    };
    Ok(FdmGpuAdaptiveExecutionTelemetry {
        realization: realization.to_string(),
        accounting_valid: native.accounting_valid == 1,
        graph_build_count: native.graph_build_count,
        graph_launch_count: native.graph_launch_count,
        terminal_control_d2h_bytes: native.terminal_control_d2h_bytes,
        terminal_control_host_sync_count: native.terminal_control_host_sync_count,
        step_completion_host_sync_count: native.step_completion_host_sync_count,
        stats_none_host_sync_count: native.stats_none_host_sync_count,
    })
}

#[cfg(feature = "cuda")]
fn query_adaptive_execution_telemetry(
    backend: &NativeFdmBackend,
) -> Result<FdmGpuAdaptiveExecutionTelemetry, RunError> {
    let mut native = adaptive_execution_telemetry_v1_request();
    let status = unsafe {
        ffi::fullmag_fdm_backend_get_adaptive_execution_telemetry_v1(
            backend.handle as *mut _,
            &mut native,
        )
    };
    if status != ffi::FULLMAG_FDM_OK {
        return Err(RunError {
            message: "fdm_gpu_adaptive_execution_telemetry_query_failed".to_string(),
        });
    }
    if native.abi_version != ffi::FULLMAG_FDM_ADAPTIVE_EXECUTION_TELEMETRY_ABI_V1
        || native.struct_size
            != std::mem::size_of::<ffi::fullmag_fdm_adaptive_execution_telemetry_v1>() as u32
    {
        return Err(RunError {
            message: "fdm_gpu_adaptive_execution_telemetry_abi_mismatch".to_string(),
        });
    }
    adaptive_execution_telemetry_from_native(native)
}

#[cfg(feature = "cuda")]
fn local_pipeline_telemetry_v1_request() -> ffi::fullmag_fdm_local_pipeline_telemetry_v1 {
    ffi::fullmag_fdm_local_pipeline_telemetry_v1 {
        abi_version: ffi::FULLMAG_FDM_LOCAL_PIPELINE_TELEMETRY_ABI_V1,
        struct_size: std::mem::size_of::<ffi::fullmag_fdm_local_pipeline_telemetry_v1>() as u32,
        requested_policy: ffi::FULLMAG_FDM_LOCAL_PIPELINE_POLICY_AUTO_SAFE,
        resolved_realization: ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_NONE,
        executed_realization: ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_NONE,
        accounting_valid: 0,
        precision: ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE,
        integrator: ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN,
        metric_valid_mask: 0,
        required_operator_mask: 0,
        active_feature_mask: 0,
        source_revision: 0,
        field_revision: 0,
        direct_fused_field_rhs_launch_count: 0,
        direct_unfused_effective_field_launch_count: 0,
        direct_unfused_rhs_launch_count: 0,
        captured_fused_field_rhs_node_count: 0,
        captured_unfused_effective_field_node_count: 0,
        captured_unfused_rhs_node_count: 0,
        graph_build_count: 0,
        graph_replay_count: 0,
        graph_recapture_count: 0,
        graph_attempt_execution_count: 0,
        graph_fused_field_rhs_execution_count: 0,
        graph_unfused_effective_field_execution_count: 0,
        graph_unfused_rhs_execution_count: 0,
        profiled_dram_read_bytes: 0,
        profiled_dram_write_bytes: 0,
        profiled_launch_time_ns: 0,
        profiled_achieved_occupancy_permyriad: 0,
    }
}

#[cfg(feature = "cuda")]
fn local_pipeline_realization_name(realization: u32) -> Result<&'static str, RunError> {
    match realization {
        ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_NONE => Ok("none"),
        ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_FUSED => Ok("direct_fused_v1"),
        ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_UNFUSED => Ok("direct_unfused_v1"),
        ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_CUDA_GRAPH_FUSED => Ok("cuda_graph_fused_v1"),
        ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_CUDA_GRAPH_UNFUSED => {
            Ok("cuda_graph_unfused_v1")
        }
        ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_MIXED => Ok("mixed_v1"),
        other => Err(preflight_error(format!(
            "unknown local pipeline realization={other}"
        ))),
    }
}

#[cfg(feature = "cuda")]
fn local_pipeline_telemetry_from_native(
    native: ffi::fullmag_fdm_local_pipeline_telemetry_v1,
) -> Result<FdmGpuLocalPipelineTelemetry, RunError> {
    if native.accounting_valid > 1 {
        return Err(preflight_error(format!(
            "invalid local pipeline accounting flag={}",
            native.accounting_valid
        )));
    }
    if native.requested_policy != ffi::FULLMAG_FDM_LOCAL_PIPELINE_POLICY_AUTO_SAFE {
        return Err(preflight_error(format!(
            "unknown local pipeline policy={}",
            native.requested_policy
        )));
    }
    let known_metric_mask = ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_IDENTITY
        | ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_DIRECT_SUBMISSIONS
        | ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_CAPTURED_NODES
        | ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_GRAPH_LIFECYCLE
        | ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_GRAPH_EXECUTIONS
        | ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_DRAM_BYTES
        | ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_LAUNCH_TIME
        | ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_OCCUPANCY;
    let required_runtime_metrics = ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_IDENTITY
        | ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_DIRECT_SUBMISSIONS
        | ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_CAPTURED_NODES
        | ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_GRAPH_LIFECYCLE
        | ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_GRAPH_EXECUTIONS;
    if native.metric_valid_mask & !known_metric_mask != 0
        || native.metric_valid_mask & required_runtime_metrics != required_runtime_metrics
    {
        return Err(preflight_error(format!(
            "invalid local pipeline metric mask={:#x}",
            native.metric_valid_mask
        )));
    }
    let dram_valid =
        native.metric_valid_mask & ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_DRAM_BYTES != 0;
    let launch_time_valid =
        native.metric_valid_mask & ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_LAUNCH_TIME != 0;
    let occupancy_valid =
        native.metric_valid_mask & ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_PROFILED_OCCUPANCY != 0;
    if (!dram_valid
        && (native.profiled_dram_read_bytes != 0 || native.profiled_dram_write_bytes != 0))
        || (!launch_time_valid && native.profiled_launch_time_ns != 0)
        || (!occupancy_valid && native.profiled_achieved_occupancy_permyriad != 0)
        || (occupancy_valid && native.profiled_achieved_occupancy_permyriad > 10_000)
    {
        return Err(preflight_error(
            "local pipeline profiler values disagree with metric validity",
        ));
    }
    let precision = match native.precision {
        ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE => "single",
        ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE => "double",
    };
    let integrator = match native.integrator {
        ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN => "heun",
        ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_DP45 => "dp45",
        ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_ABM3 => "abm3",
        ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK4 => "rk4",
        ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK23 => "rk23",
    };
    let resolved_realization =
        local_pipeline_realization_name(native.resolved_realization)?.to_string();
    let executed_realization =
        local_pipeline_realization_name(native.executed_realization)?.to_string();
    if native.executed_realization != ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_NONE
        && native.executed_realization != ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_MIXED
        && native.executed_realization != native.resolved_realization
    {
        return Err(preflight_error(format!(
            "local pipeline resolved/executed mismatch={}/{}",
            native.resolved_realization, native.executed_realization
        )));
    }
    let execution_categories = u32::from(native.direct_fused_field_rhs_launch_count != 0)
        + u32::from(
            native.direct_unfused_effective_field_launch_count != 0
                || native.direct_unfused_rhs_launch_count != 0,
        )
        + u32::from(native.graph_fused_field_rhs_execution_count != 0)
        + u32::from(
            native.graph_unfused_effective_field_execution_count != 0
                || native.graph_unfused_rhs_execution_count != 0,
        );
    if (native.executed_realization == ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_NONE
        && execution_categories != 0)
        || (native.executed_realization == ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_MIXED
            && execution_categories < 2)
        || (native.executed_realization != ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_NONE
            && native.executed_realization != ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_MIXED
            && execution_categories != 1)
    {
        return Err(preflight_error(format!(
            "local pipeline execution counters contradict realization={} categories={execution_categories}",
            native.executed_realization
        )));
    }
    Ok(FdmGpuLocalPipelineTelemetry {
        requested_policy: "auto_safe_v1".to_string(),
        resolved_realization,
        executed_realization,
        accounting_valid: native.accounting_valid == 1,
        precision: precision.to_string(),
        integrator: integrator.to_string(),
        metric_valid_mask: native.metric_valid_mask,
        required_operator_mask: native.required_operator_mask,
        active_feature_mask: native.active_feature_mask,
        source_revision: native.source_revision,
        field_revision: native.field_revision,
        direct_fused_field_rhs_launch_count: native.direct_fused_field_rhs_launch_count,
        direct_unfused_effective_field_launch_count: native
            .direct_unfused_effective_field_launch_count,
        direct_unfused_rhs_launch_count: native.direct_unfused_rhs_launch_count,
        captured_fused_field_rhs_node_count: native.captured_fused_field_rhs_node_count,
        captured_unfused_effective_field_node_count: native
            .captured_unfused_effective_field_node_count,
        captured_unfused_rhs_node_count: native.captured_unfused_rhs_node_count,
        graph_build_count: native.graph_build_count,
        graph_replay_count: native.graph_replay_count,
        graph_recapture_count: native.graph_recapture_count,
        graph_attempt_execution_count: native.graph_attempt_execution_count,
        graph_fused_field_rhs_execution_count: native.graph_fused_field_rhs_execution_count,
        graph_unfused_effective_field_execution_count: native
            .graph_unfused_effective_field_execution_count,
        graph_unfused_rhs_execution_count: native.graph_unfused_rhs_execution_count,
        profiled_dram_read_bytes: native.profiled_dram_read_bytes,
        profiled_dram_write_bytes: native.profiled_dram_write_bytes,
        profiled_launch_time_ns: native.profiled_launch_time_ns,
        profiled_achieved_occupancy_permyriad: native.profiled_achieved_occupancy_permyriad,
    })
}

#[cfg(feature = "cuda")]
fn query_local_pipeline_telemetry(
    backend: &NativeFdmBackend,
) -> Result<FdmGpuLocalPipelineTelemetry, RunError> {
    let mut native = local_pipeline_telemetry_v1_request();
    let status = unsafe {
        ffi::fullmag_fdm_backend_get_local_pipeline_telemetry_v1(
            backend.handle as *mut _,
            &mut native,
        )
    };
    if status != ffi::FULLMAG_FDM_OK {
        return Err(RunError {
            message: "fdm_gpu_local_pipeline_telemetry_query_failed".to_string(),
        });
    }
    if native.abi_version != ffi::FULLMAG_FDM_LOCAL_PIPELINE_TELEMETRY_ABI_V1
        || native.struct_size
            != std::mem::size_of::<ffi::fullmag_fdm_local_pipeline_telemetry_v1>() as u32
    {
        return Err(RunError {
            message: "fdm_gpu_local_pipeline_telemetry_abi_mismatch".to_string(),
        });
    }
    local_pipeline_telemetry_from_native(native)
}

#[cfg(feature = "cuda")]
fn gpu_workspace_telemetry_v1_request() -> ffi::fullmag_fdm_gpu_workspace_telemetry_v1 {
    ffi::fullmag_fdm_gpu_workspace_telemetry_v1 {
        abi_version: ffi::FULLMAG_FDM_GPU_WORKSPACE_TELEMETRY_ABI_V1,
        struct_size: std::mem::size_of::<ffi::fullmag_fdm_gpu_workspace_telemetry_v1>() as u32,
        accounting_valid: 0,
        setup_complete: 0,
        precision: ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE,
        integrator: ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN,
        metric_valid_mask: 0,
        workspace_revision: 0,
        source_revision: 0,
        field_revision: 0,
        setup_device_allocation_count: 0,
        setup_device_allocation_bytes: 0,
        total_device_allocation_count: 0,
        total_device_allocation_bytes: 0,
        step_device_allocation_count: 0,
        step_device_allocation_bytes: 0,
        setup_fft_plan_creation_count: 0,
        total_fft_plan_creation_count: 0,
        step_fft_plan_creation_count: 0,
        prepared_fft_workspace_count: 0,
        workspace_bytes: 0,
        peak_vram_bytes: 0,
        observed_step_count: 0,
    }
}

#[cfg(feature = "cuda")]
fn gpu_workspace_telemetry_from_native(
    native: ffi::fullmag_fdm_gpu_workspace_telemetry_v1,
) -> Result<FdmGpuWorkspaceTelemetry, RunError> {
    if native.accounting_valid > 1 || native.setup_complete > 1 {
        return Err(preflight_error(format!(
            "invalid GPU workspace flags accounting={} setup_complete={}",
            native.accounting_valid, native.setup_complete
        )));
    }
    if native.setup_complete != 1 {
        return Err(preflight_error("GPU workspace setup is incomplete"));
    }
    let known_metric_mask = ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_IDENTITY
        | ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_ALLOCATIONS
        | ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_FFT_PLANS
        | ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_FOOTPRINT
        | ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_REVISIONS;
    let identity_metrics = ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_IDENTITY
        | ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_REVISIONS;
    if native.metric_valid_mask & !known_metric_mask != 0
        || native.metric_valid_mask & identity_metrics != identity_metrics
    {
        return Err(preflight_error(format!(
            "invalid GPU workspace metric mask={:#x}",
            native.metric_valid_mask
        )));
    }
    if native.accounting_valid == 1 {
        if native.metric_valid_mask != known_metric_mask {
            return Err(preflight_error(format!(
                "complete GPU workspace accounting requires all metrics, got={:#x}",
                native.metric_valid_mask
            )));
        }
        if native.setup_device_allocation_count == 0
            || native.setup_device_allocation_bytes == 0
            || native.total_device_allocation_count != native.setup_device_allocation_count
            || native.total_device_allocation_bytes != native.setup_device_allocation_bytes
            || native.total_fft_plan_creation_count != native.setup_fft_plan_creation_count
            || native.step_device_allocation_count != 0
            || native.step_device_allocation_bytes != 0
            || native.step_fft_plan_creation_count != 0
            || native.workspace_bytes > native.peak_vram_bytes
            || native.prepared_fft_workspace_count > native.total_fft_plan_creation_count
        {
            return Err(preflight_error(
                "GPU workspace counters violate setup-only allocation/plan invariants",
            ));
        }
    }
    if native.workspace_revision == 0 || native.source_revision == 0 || native.field_revision == 0 {
        return Err(preflight_error(
            "GPU workspace/source/field revisions must be non-zero",
        ));
    }
    let precision = match native.precision {
        ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE => "single",
        ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE => "double",
    };
    let integrator = match native.integrator {
        ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN => "heun",
        ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_DP45 => "dp45",
        ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_ABM3 => "abm3",
        ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK4 => "rk4",
        ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK23 => "rk23",
    };
    Ok(FdmGpuWorkspaceTelemetry {
        accounting_valid: native.accounting_valid == 1,
        setup_complete: true,
        precision: precision.to_string(),
        integrator: integrator.to_string(),
        metric_valid_mask: native.metric_valid_mask,
        workspace_revision: native.workspace_revision,
        source_revision: native.source_revision,
        field_revision: native.field_revision,
        setup_device_allocation_count: native.setup_device_allocation_count,
        setup_device_allocation_bytes: native.setup_device_allocation_bytes,
        total_device_allocation_count: native.total_device_allocation_count,
        total_device_allocation_bytes: native.total_device_allocation_bytes,
        step_device_allocation_count: native.step_device_allocation_count,
        step_device_allocation_bytes: native.step_device_allocation_bytes,
        setup_fft_plan_creation_count: native.setup_fft_plan_creation_count,
        total_fft_plan_creation_count: native.total_fft_plan_creation_count,
        step_fft_plan_creation_count: native.step_fft_plan_creation_count,
        prepared_fft_workspace_count: native.prepared_fft_workspace_count,
        workspace_bytes: native.workspace_bytes,
        peak_vram_bytes: native.peak_vram_bytes,
        observed_step_count: native.observed_step_count,
    })
}

#[cfg(feature = "cuda")]
fn query_gpu_workspace_telemetry(
    backend: &NativeFdmBackend,
) -> Result<FdmGpuWorkspaceTelemetry, RunError> {
    let mut native = gpu_workspace_telemetry_v1_request();
    let status = unsafe {
        ffi::fullmag_fdm_backend_get_gpu_workspace_telemetry_v1(
            backend.handle as *mut _,
            &mut native,
        )
    };
    if status != ffi::FULLMAG_FDM_OK {
        return Err(RunError {
            message: "fdm_gpu_workspace_telemetry_query_failed".to_string(),
        });
    }
    if native.abi_version != ffi::FULLMAG_FDM_GPU_WORKSPACE_TELEMETRY_ABI_V1
        || native.struct_size
            != std::mem::size_of::<ffi::fullmag_fdm_gpu_workspace_telemetry_v1>() as u32
    {
        return Err(RunError {
            message: "fdm_gpu_workspace_telemetry_abi_mismatch".to_string(),
        });
    }
    gpu_workspace_telemetry_from_native(native)
}

#[cfg(feature = "cuda")]
fn adaptive_numerics_telemetry_v1_request() -> ffi::fullmag_fdm_adaptive_numerics_telemetry_v1 {
    ffi::fullmag_fdm_adaptive_numerics_telemetry_v1 {
        abi_version: ffi::FULLMAG_FDM_ADAPTIVE_NUMERICS_TELEMETRY_ABI_V1,
        struct_size: std::mem::size_of::<ffi::fullmag_fdm_adaptive_numerics_telemetry_v1>() as u32,
        embedded_error_semantics: 0,
        norm_defect_semantics: 0,
        spin_rotation_semantics: 0,
        accounting_valid: 0,
        terminal_observation_count: 0,
        decision_comparison_count: 0,
        decision_divergence_count: 0,
        last_terminal_normalized_error: 0.0,
        last_terminal_max_norm_defect: 0.0,
        last_terminal_max_spin_rotation_radians: 0.0,
        max_attempt_normalized_error: 0.0,
        max_attempt_norm_defect: 0.0,
        max_attempt_spin_rotation_radians: 0.0,
    }
}

#[cfg(feature = "cuda")]
fn adaptive_numerics_telemetry_from_native(
    native: ffi::fullmag_fdm_adaptive_numerics_telemetry_v1,
) -> Result<FdmGpuAdaptiveNumericsTelemetry, RunError> {
    let embedded_error_semantics = match native.embedded_error_semantics {
        ffi::FULLMAG_FDM_EMBEDDED_ERROR_PRE_PROJECTION_DIFFERENCE => {
            "pre_projection_embedded_difference_v1"
        }
        other => {
            return Err(preflight_error(format!(
                "unknown adaptive embedded-error semantics={other}"
            )));
        }
    };
    let norm_defect_semantics = match native.norm_defect_semantics {
        ffi::FULLMAG_FDM_NORM_DEFECT_POST_PROJECTION_ABS_UNIT => {
            "post_projection_abs_unit_norm_defect_v1"
        }
        other => {
            return Err(preflight_error(format!(
                "unknown adaptive norm-defect semantics={other}"
            )));
        }
    };
    let spin_rotation_semantics = match native.spin_rotation_semantics {
        ffi::FULLMAG_FDM_SPIN_ROTATION_ATTEMPT_GEODESIC_RADIANS => {
            "attempt_geodesic_rotation_radians_v1"
        }
        other => {
            return Err(preflight_error(format!(
                "unknown adaptive spin-rotation semantics={other}"
            )));
        }
    };
    for (name, value) in [
        (
            "last_terminal_normalized_error",
            native.last_terminal_normalized_error,
        ),
        (
            "last_terminal_max_norm_defect",
            native.last_terminal_max_norm_defect,
        ),
        (
            "last_terminal_max_spin_rotation_radians",
            native.last_terminal_max_spin_rotation_radians,
        ),
        (
            "max_attempt_normalized_error",
            native.max_attempt_normalized_error,
        ),
        ("max_attempt_norm_defect", native.max_attempt_norm_defect),
        (
            "max_attempt_spin_rotation_radians",
            native.max_attempt_spin_rotation_radians,
        ),
    ] {
        if !value.is_finite() || value < 0.0 {
            return Err(preflight_error(format!(
                "invalid adaptive numerics {name}={value}"
            )));
        }
    }
    Ok(FdmGpuAdaptiveNumericsTelemetry {
        embedded_error_semantics: embedded_error_semantics.to_string(),
        norm_defect_semantics: norm_defect_semantics.to_string(),
        spin_rotation_semantics: spin_rotation_semantics.to_string(),
        accounting_valid: native.accounting_valid == 1,
        terminal_observation_count: native.terminal_observation_count,
        decision_comparison_count: native.decision_comparison_count,
        decision_divergence_count: native.decision_divergence_count,
        last_terminal_normalized_error: native.last_terminal_normalized_error,
        last_terminal_max_norm_defect: native.last_terminal_max_norm_defect,
        last_terminal_max_spin_rotation_radians: native.last_terminal_max_spin_rotation_radians,
        max_attempt_normalized_error: native.max_attempt_normalized_error,
        max_attempt_norm_defect: native.max_attempt_norm_defect,
        max_attempt_spin_rotation_radians: native.max_attempt_spin_rotation_radians,
    })
}

#[cfg(feature = "cuda")]
fn query_adaptive_numerics_telemetry(
    backend: &NativeFdmBackend,
) -> Result<FdmGpuAdaptiveNumericsTelemetry, RunError> {
    let mut native = adaptive_numerics_telemetry_v1_request();
    let status = unsafe {
        ffi::fullmag_fdm_backend_get_adaptive_numerics_telemetry_v1(
            backend.handle as *mut _,
            &mut native,
        )
    };
    if status != ffi::FULLMAG_FDM_OK {
        return Err(RunError {
            message: "fdm_gpu_adaptive_numerics_telemetry_query_failed".to_string(),
        });
    }
    if native.abi_version != ffi::FULLMAG_FDM_ADAPTIVE_NUMERICS_TELEMETRY_ABI_V1
        || native.struct_size
            != std::mem::size_of::<ffi::fullmag_fdm_adaptive_numerics_telemetry_v1>() as u32
    {
        return Err(RunError {
            message: "fdm_gpu_adaptive_numerics_telemetry_abi_mismatch".to_string(),
        });
    }
    adaptive_numerics_telemetry_from_native(native)
}

#[cfg(feature = "cuda")]
fn step_transaction_telemetry_from_native(
    native: ffi::fullmag_fdm_step_transaction_telemetry_v1,
) -> FdmGpuStepTransactionTelemetry {
    FdmGpuStepTransactionTelemetry {
        accounting_valid: native.accounting_valid == 1,
        capture_count: native.capture_count,
        rollback_count: native.rollback_count,
        capture_d2d_bytes: native.capture_d2d_bytes,
        rollback_d2d_bytes: native.rollback_d2d_bytes,
        rollback_latency_total_ns: native.rollback_latency_total_ns,
        rollback_latency_max_ns: native.rollback_latency_max_ns,
        accepted_step_index: native.accepted_step_index,
        attempt_generation: native.attempt_generation,
        thermal_rng_draws: native.thermal_rng_draws,
        stale_publication_count: native.stale_publication_count,
    }
}

#[cfg(feature = "cuda")]
fn query_step_transaction_telemetry(
    backend: &NativeFdmBackend,
) -> Result<FdmGpuStepTransactionTelemetry, RunError> {
    let mut native = step_transaction_telemetry_v1_request();
    let status = unsafe {
        ffi::fullmag_fdm_backend_get_step_transaction_telemetry_v1(
            backend.handle as *mut _,
            &mut native,
        )
    };
    if status != ffi::FULLMAG_FDM_OK {
        return Err(RunError {
            message: "fdm_gpu_step_transaction_telemetry_query_failed".to_string(),
        });
    }
    if native.abi_version != ffi::FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1
        || native.struct_size
            != std::mem::size_of::<ffi::fullmag_fdm_step_transaction_telemetry_v1>() as u32
    {
        return Err(RunError {
            message: "fdm_gpu_step_transaction_telemetry_abi_mismatch".to_string(),
        });
    }
    Ok(step_transaction_telemetry_from_native(native))
}

#[cfg(feature = "cuda")]
pub(super) fn query_execution_device_ordinal(backend: &NativeFdmBackend) -> Result<i32, RunError> {
    let mut native = execution_receipt_v2_request();
    let status = unsafe {
        ffi::fullmag_fdm_backend_execution_receipt_v2(backend.handle as *mut _, &mut native)
    };
    if status != ffi::FULLMAG_FDM_OK {
        return Err(backend.last_error_or("FDM CUDA execution receipt query failed"));
    }

    if native.device_ordinal < 0 {
        return Err(preflight_error(format!(
            "device_ordinal={} expected non-negative CUDA ordinal",
            native.device_ordinal
        )));
    }
    Ok(native.device_ordinal)
}

#[cfg(feature = "cuda")]
pub(super) fn query_execution_receipt(
    backend: &NativeFdmBackend,
    requested_device: &str,
    requested_mode: fullmag_ir::ExecutionMode,
    device_name: &str,
) -> Result<FdmGpuExecutionReceipt, RunError> {
    let mut native = execution_receipt_v2_request();
    let status = unsafe {
        ffi::fullmag_fdm_backend_execution_receipt_v2(backend.handle as *mut _, &mut native)
    };
    if status != ffi::FULLMAG_FDM_OK {
        return Err(backend.last_error_or("FDM CUDA execution receipt query failed"));
    }
    if native.device_ordinal < 0 {
        return Err(preflight_error(format!(
            "device_ordinal={} expected non-negative CUDA ordinal",
            native.device_ordinal
        )));
    }
    let precision = precision_name(native.precision)?.to_string();
    let expected_precision = match backend.precision {
        fullmag_ir::ExecutionPrecision::Single => "single",
        fullmag_ir::ExecutionPrecision::Double => "double",
    };
    if precision != expected_precision {
        return Err(preflight_error(format!(
            "precision={precision} expected={expected_precision}"
        )));
    }
    validate_native_operator_masks(
        native.required_operator_mask,
        native.device_operator_mask,
        native.host_operator_mask,
        native.resolved_unknown_operator_mask,
        native.executed_device_operator_mask,
        native.executed_host_operator_mask,
        native.executed_unknown_operator_mask,
    )?;
    let reduction_location = operator_location_name(native.reduction_location)?;
    let control_location = operator_location_name(native.control_location)?;
    if reduction_location != "device" || control_location != "host_scalar" {
        return Err(preflight_error(format!(
            "reduction_location={} control_location={}",
            native.reduction_location, native.control_location
        )));
    }

    let mut operator_residency = Vec::new();
    push_operator(
        &mut operator_residency,
        native.required_operator_mask,
        ffi::FULLMAG_FDM_OPERATOR_LLG_INTEGRATOR,
        "llg_integrator",
        integrator_realization(native.integrator, &precision)?,
    );
    push_operator(
        &mut operator_residency,
        native.required_operator_mask,
        ffi::FULLMAG_FDM_OPERATOR_EXCHANGE,
        "exchange",
        format!(
            "cuda_exchange_{}",
            if precision == "single" {
                "fp32"
            } else {
                "fp64"
            }
        ),
    );
    push_operator(
        &mut operator_residency,
        native.required_operator_mask,
        ffi::FULLMAG_FDM_OPERATOR_DEMAG,
        "demag",
        "cuda_cufft_newell".to_string(),
    );
    push_operator(
        &mut operator_residency,
        native.required_operator_mask,
        ffi::FULLMAG_FDM_OPERATOR_DMI,
        "dmi",
        "cuda_dmi".to_string(),
    );
    push_operator(
        &mut operator_residency,
        native.required_operator_mask,
        ffi::FULLMAG_FDM_OPERATOR_ANISOTROPY,
        "anisotropy",
        "cuda_anisotropy".to_string(),
    );
    push_operator(
        &mut operator_residency,
        native.required_operator_mask,
        ffi::FULLMAG_FDM_OPERATOR_REDUCTION,
        "reduction",
        "cuda_reduction".to_string(),
    );
    for (bit, operator, realization) in [
        (
            ffi::FULLMAG_FDM_OPERATOR_EXTERNAL_FIELD,
            "external_field",
            "cuda_external_field",
        ),
        (
            ffi::FULLMAG_FDM_OPERATOR_MASKS,
            "masks",
            "cuda_device_masks",
        ),
        (
            ffi::FULLMAG_FDM_OPERATOR_MAGNETOELASTIC,
            "magnetoelastic",
            "cuda_magnetoelastic",
        ),
        (
            ffi::FULLMAG_FDM_OPERATOR_THERMAL,
            "thermal",
            "cuda_counter_brown_noise",
        ),
        (
            ffi::FULLMAG_FDM_OPERATOR_ZHANG_LI_STT,
            "zhang_li_stt",
            "cuda_zhang_li_stt",
        ),
        (
            ffi::FULLMAG_FDM_OPERATOR_SLONCZEWSKI_STT,
            "slonczewski_stt",
            "cuda_slonczewski_stt",
        ),
        (ffi::FULLMAG_FDM_OPERATOR_SOT, "sot", "cuda_sot"),
        (ffi::FULLMAG_FDM_OPERATOR_OERSTED, "oersted", "cuda_oersted"),
        (
            ffi::FULLMAG_FDM_OPERATOR_BOUNDARY_CORRECTION,
            "boundary_correction",
            "cuda_boundary_correction",
        ),
        (
            ffi::FULLMAG_FDM_OPERATOR_MULTILAYER_TRANSFER,
            "multilayer_transfer",
            "cuda_multilayer_transfer",
        ),
        (
            ffi::FULLMAG_FDM_OPERATOR_MULTILAYER_INTERACTIONS,
            "multilayer_interactions",
            "cuda_multilayer_interactions",
        ),
        (
            ffi::FULLMAG_FDM_OPERATOR_MULTILAYER_DEMAG,
            "multilayer_demag",
            "cuda_multilayer_demag",
        ),
        (
            ffi::FULLMAG_FDM_OPERATOR_GPU_TRANSPORT,
            "gpu_transport",
            "cuda_m1_transport",
        ),
    ] {
        push_operator(
            &mut operator_residency,
            native.required_operator_mask,
            bit,
            operator,
            realization.to_string(),
        );
    }
    operator_residency.push(FdmGpuOperatorResidency {
        operator: "control".to_string(),
        realization: "bounded_scalar_host_control".to_string(),
        location: control_location.to_string(),
    });

    let adaptive_execution = query_adaptive_execution_telemetry(backend)?;
    let adaptive_numerics = query_adaptive_numerics_telemetry(backend)?;
    let precision_policy = query_precision_policy_telemetry(backend)?;
    let local_pipeline = query_local_pipeline_telemetry(backend)?;
    let gpu_workspace = query_gpu_workspace_telemetry(backend)?;
    if local_pipeline.required_operator_mask != native.required_operator_mask
        || local_pipeline.precision != precision
    {
        return Err(preflight_error(format!(
            "local pipeline identity mismatch: operators={:#x}/{:#x} precision={}/{}",
            local_pipeline.required_operator_mask,
            native.required_operator_mask,
            local_pipeline.precision,
            precision
        )));
    }
    if gpu_workspace.precision != precision
        || gpu_workspace.source_revision != local_pipeline.source_revision
        || gpu_workspace.field_revision != local_pipeline.field_revision
    {
        return Err(preflight_error(format!(
            "GPU workspace identity mismatch: precision={}/{} source={}/{} field={}/{}",
            gpu_workspace.precision,
            precision,
            gpu_workspace.source_revision,
            local_pipeline.source_revision,
            gpu_workspace.field_revision,
            local_pipeline.field_revision
        )));
    }
    let accounting_valid = native.accounting_valid == 1
        && adaptive_execution.accounting_valid
        && adaptive_numerics.accounting_valid
        && precision_policy.accounting_valid
        && local_pipeline.accounting_valid
        && gpu_workspace.accounting_valid
        && adaptive_numerics.decision_divergence_count == 0;
    let receipt = FdmGpuExecutionReceipt {
        requested: requested_device_name(requested_device)?.to_string(),
        resolved: execution_class_name(native.execution_class)?.to_string(),
        executed: executed_backend_name(native.executed_backend)?.to_string(),
        device: format!("cuda:{}:{device_name}", native.device_ordinal),
        precision,
        required_operator_mask: native.required_operator_mask,
        resolved_device_operator_mask: native.device_operator_mask,
        resolved_host_operator_mask: native.host_operator_mask,
        resolved_unknown_operator_mask: native.resolved_unknown_operator_mask,
        executed_device_operator_mask: native.executed_device_operator_mask,
        executed_host_operator_mask: native.executed_host_operator_mask,
        executed_unknown_operator_mask: native.executed_unknown_operator_mask,
        operator_residency,
        fallback_count: native.fallback_count,
        transfer_counts: FdmGpuTransferCounts {
            setup_full_vector_h2d_count: native.setup_full_vector_h2d_count,
            setup_full_vector_h2d_bytes: native.setup_full_vector_h2d_bytes,
            setup_full_vector_d2h_count: native.setup_full_vector_d2h_count,
            setup_full_vector_d2h_bytes: native.setup_full_vector_d2h_bytes,
            observation_full_vector_h2d_count: native.observation_full_vector_h2d_count,
            observation_full_vector_h2d_bytes: native.observation_full_vector_h2d_bytes,
            observation_full_vector_d2h_count: native.observation_full_vector_d2h_count,
            observation_full_vector_d2h_bytes: native.observation_full_vector_d2h_bytes,
            hot_loop_full_vector_h2d_count: native.hot_loop_full_vector_h2d_count,
            hot_loop_full_vector_h2d_bytes: native.hot_loop_full_vector_h2d_bytes,
            hot_loop_full_vector_d2h_count: native.hot_loop_full_vector_d2h_count,
            hot_loop_full_vector_d2h_bytes: native.hot_loop_full_vector_d2h_bytes,
            hot_loop_host_compute_count: native.hot_loop_host_compute_count,
            hot_loop_host_sync_count: native.hot_loop_host_sync_count,
            hot_loop_control_scalar_d2h_bytes: native.hot_loop_control_scalar_d2h_bytes,
            hot_loop_control_scalar_host_sync_count: native.hot_loop_control_scalar_host_sync_count,
        },
        adaptive_execution: Some(adaptive_execution),
        adaptive_numerics: Some(adaptive_numerics),
        local_pipeline: Some(local_pipeline),
        gpu_workspace: Some(gpu_workspace),
        precision_policy: Some(precision_policy),
        validation_state: "unvalidated".to_string(),
        accounting_valid,
    };
    let _ = requested_mode;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use crate::types::{
        FdmGpuExecutionReceipt, FdmGpuOperatorResidency, FdmGpuPrecisionComponents,
        FdmGpuPrecisionPolicyReceipt, FdmGpuTransferCounts,
    };

    #[cfg(feature = "cuda")]
    fn native_precision_policy(
        realization: u32,
        storage: u32,
        compute: u32,
        fft: u32,
        reduction: u32,
    ) -> super::ffi::fullmag_fdm_precision_policy_telemetry_v1 {
        super::ffi::fullmag_fdm_precision_policy_telemetry_v1 {
            abi_version: super::ffi::FULLMAG_FDM_PRECISION_POLICY_TELEMETRY_ABI_V1,
            struct_size: std::mem::size_of::<super::ffi::fullmag_fdm_precision_policy_telemetry_v1>(
            ) as u32,
            accounting_valid: 1,
            storage_precision: storage,
            compute_precision: compute,
            fft_precision: fft,
            reduction_precision: reduction,
            realization,
            metric_valid_mask: super::ffi::FULLMAG_FDM_PRECISION_POLICY_METRIC_IDENTITY,
        }
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn native_precision_policy_maps_supported_fp32_and_fp64_realizations() {
        let single = super::ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE as u32;
        let double = super::ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE as u32;
        let fp32 = super::precision_policy_from_native(
            native_precision_policy(
                super::ffi::FULLMAG_FDM_PRECISION_POLICY_SINGLE_STORAGE_FP64_REDUCTION,
                single,
                single,
                single,
                double,
            ),
            fullmag_ir::ExecutionPrecision::Single,
            &fullmag_ir::FdmPrecisionPolicyIR::resolve(fullmag_ir::ExecutionPrecision::Single),
        )
        .expect("qualified FP32 policy");
        assert_eq!(fp32.executed.storage, "single");
        assert_eq!(fp32.executed.reduction, "double");

        let fp64 = super::precision_policy_from_native(
            native_precision_policy(
                super::ffi::FULLMAG_FDM_PRECISION_POLICY_FULL_DOUBLE,
                double,
                double,
                double,
                double,
            ),
            fullmag_ir::ExecutionPrecision::Double,
            &fullmag_ir::FdmPrecisionPolicyIR::default(),
        )
        .expect("qualified FP64 policy");
        assert_eq!(fp64.resolved, fp64.executed);
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn native_precision_policy_rejects_unknown_or_inconsistent_execution() {
        let single = super::ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE as u32;
        let double = super::ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE as u32;
        let expected =
            fullmag_ir::FdmPrecisionPolicyIR::resolve(fullmag_ir::ExecutionPrecision::Single);
        let inconsistent = native_precision_policy(
            super::ffi::FULLMAG_FDM_PRECISION_POLICY_SINGLE_STORAGE_FP64_REDUCTION,
            single,
            single,
            double,
            double,
        );
        assert!(super::precision_policy_from_native(
            inconsistent,
            fullmag_ir::ExecutionPrecision::Single,
            &expected,
        )
        .is_err());

        let unknown = native_precision_policy(u32::MAX, single, single, single, double);
        assert!(super::precision_policy_from_native(
            unknown,
            fullmag_ir::ExecutionPrecision::Single,
            &expected,
        )
        .is_err());
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn adaptive_execution_telemetry_maps_realization_and_all_counters() {
        let native = super::ffi::fullmag_fdm_adaptive_execution_telemetry_v1 {
            abi_version: super::ffi::FULLMAG_FDM_ADAPTIVE_EXECUTION_TELEMETRY_ABI_V1,
            struct_size: std::mem::size_of::<super::ffi::fullmag_fdm_adaptive_execution_telemetry_v1>(
            ) as u32,
            realization: super::ffi::FULLMAG_FDM_ADAPTIVE_CONTROL_CUDA_CONDITIONAL_GRAPH,
            accounting_valid: 1,
            graph_build_count: 1,
            graph_launch_count: 2,
            terminal_control_d2h_bytes: 128,
            terminal_control_host_sync_count: 2,
            step_completion_host_sync_count: 0,
            stats_none_host_sync_count: 2,
        };
        let telemetry = super::adaptive_execution_telemetry_from_native(native)
            .expect("known realization must map");
        assert_eq!(telemetry.realization, "cuda_conditional_graph_v1");
        assert!(telemetry.accounting_valid);
        assert_eq!(telemetry.graph_build_count, 1);
        assert_eq!(telemetry.graph_launch_count, 2);
        assert_eq!(telemetry.terminal_control_d2h_bytes, 128);
        assert_eq!(telemetry.terminal_control_host_sync_count, 2);
        assert_eq!(telemetry.step_completion_host_sync_count, 0);
        assert_eq!(telemetry.stats_none_host_sync_count, 2);

        let batched = super::adaptive_execution_telemetry_from_native(
            super::ffi::fullmag_fdm_adaptive_execution_telemetry_v1 {
                realization:
                    super::ffi::FULLMAG_FDM_ADAPTIVE_CONTROL_CUDA_CONDITIONAL_GRAPH_BATCHED,
                ..native
            },
        )
        .expect("batched realization must map");
        assert_eq!(batched.realization, "cuda_conditional_graph_batched_v1");
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn local_pipeline_telemetry_maps_all_runtime_evidence_and_fails_closed() {
        let mut native = super::local_pipeline_telemetry_v1_request();
        native.accounting_valid = 1;
        native.precision = super::ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE;
        native.integrator = super::ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK4;
        native.resolved_realization =
            super::ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_FUSED;
        native.executed_realization =
            super::ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_FUSED;
        native.metric_valid_mask = super::ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_IDENTITY
            | super::ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_DIRECT_SUBMISSIONS
            | super::ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_CAPTURED_NODES
            | super::ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_GRAPH_LIFECYCLE
            | super::ffi::FULLMAG_FDM_LOCAL_PIPELINE_METRIC_GRAPH_EXECUTIONS;
        native.required_operator_mask = 0x41;
        native.active_feature_mask = 0x2d;
        native.source_revision = 7;
        native.field_revision = 11;
        native.direct_fused_field_rhs_launch_count = 4;

        let telemetry = super::local_pipeline_telemetry_from_native(native)
            .expect("valid local pipeline telemetry must map");
        assert_eq!(telemetry.requested_policy, "auto_safe_v1");
        assert_eq!(telemetry.resolved_realization, "direct_fused_v1");
        assert_eq!(telemetry.executed_realization, "direct_fused_v1");
        assert_eq!(telemetry.precision, "double");
        assert_eq!(telemetry.integrator, "rk4");
        assert_eq!(telemetry.required_operator_mask, 0x41);
        assert_eq!(telemetry.active_feature_mask, 0x2d);
        assert_eq!(telemetry.direct_fused_field_rhs_launch_count, 4);

        let unknown_realization = super::local_pipeline_telemetry_from_native(
            super::ffi::fullmag_fdm_local_pipeline_telemetry_v1 {
                executed_realization: u32::MAX,
                ..native
            },
        );
        assert!(unknown_realization.is_err());

        let invalid_profile_metric = super::local_pipeline_telemetry_from_native(
            super::ffi::fullmag_fdm_local_pipeline_telemetry_v1 {
                profiled_launch_time_ns: 1,
                ..native
            },
        );
        assert!(invalid_profile_metric.is_err());

        let contradictory_execution = super::local_pipeline_telemetry_from_native(
            super::ffi::fullmag_fdm_local_pipeline_telemetry_v1 {
                executed_realization:
                    super::ffi::FULLMAG_FDM_LOCAL_PIPELINE_REALIZATION_DIRECT_UNFUSED,
                ..native
            },
        );
        assert!(contradictory_execution.is_err());
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn gpu_workspace_telemetry_maps_setup_evidence_and_rejects_hot_loop_allocation() {
        let mut native = super::gpu_workspace_telemetry_v1_request();
        native.accounting_valid = 1;
        native.setup_complete = 1;
        native.precision = super::ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE;
        native.integrator = super::ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK4;
        native.metric_valid_mask = super::ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_IDENTITY
            | super::ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_ALLOCATIONS
            | super::ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_FFT_PLANS
            | super::ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_FOOTPRINT
            | super::ffi::FULLMAG_FDM_GPU_WORKSPACE_METRIC_REVISIONS;
        native.workspace_revision = 3;
        native.source_revision = 4;
        native.field_revision = 5;
        native.setup_device_allocation_count = 10;
        native.setup_device_allocation_bytes = 1_000;
        native.total_device_allocation_count = 10;
        native.total_device_allocation_bytes = 1_000;
        native.setup_fft_plan_creation_count = 2;
        native.total_fft_plan_creation_count = 2;
        native.prepared_fft_workspace_count = 2;
        native.workspace_bytes = 800;
        native.peak_vram_bytes = 1_200;
        native.observed_step_count = 7;

        let telemetry = super::gpu_workspace_telemetry_from_native(native)
            .expect("consistent setup-only workspace telemetry must map");
        assert_eq!(telemetry.precision, "double");
        assert_eq!(telemetry.integrator, "rk4");
        assert_eq!(telemetry.prepared_fft_workspace_count, 2);
        assert_eq!(telemetry.observed_step_count, 7);

        let step_allocation = super::gpu_workspace_telemetry_from_native(
            super::ffi::fullmag_fdm_gpu_workspace_telemetry_v1 {
                step_device_allocation_count: 1,
                ..native
            },
        );
        assert!(step_allocation.is_err());

        let late_plan = super::gpu_workspace_telemetry_from_native(
            super::ffi::fullmag_fdm_gpu_workspace_telemetry_v1 {
                total_fft_plan_creation_count: 3,
                ..native
            },
        );
        assert!(late_plan.is_err());

        let incomplete_setup = super::gpu_workspace_telemetry_from_native(
            super::ffi::fullmag_fdm_gpu_workspace_telemetry_v1 {
                setup_complete: 0,
                ..native
            },
        );
        assert!(incomplete_setup.is_err());

        let unknown_metric = super::gpu_workspace_telemetry_from_native(
            super::ffi::fullmag_fdm_gpu_workspace_telemetry_v1 {
                metric_valid_mask: native.metric_valid_mask | (1_u64 << 63),
                ..native
            },
        );
        assert!(unknown_metric.is_err());
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn adaptive_numerics_telemetry_maps_semantics_and_counters() {
        let native = super::ffi::fullmag_fdm_adaptive_numerics_telemetry_v1 {
            abi_version: super::ffi::FULLMAG_FDM_ADAPTIVE_NUMERICS_TELEMETRY_ABI_V1,
            struct_size: std::mem::size_of::<super::ffi::fullmag_fdm_adaptive_numerics_telemetry_v1>(
            ) as u32,
            embedded_error_semantics:
                super::ffi::FULLMAG_FDM_EMBEDDED_ERROR_PRE_PROJECTION_DIFFERENCE,
            norm_defect_semantics: super::ffi::FULLMAG_FDM_NORM_DEFECT_POST_PROJECTION_ABS_UNIT,
            spin_rotation_semantics: super::ffi::FULLMAG_FDM_SPIN_ROTATION_ATTEMPT_GEODESIC_RADIANS,
            accounting_valid: 1,
            terminal_observation_count: 2,
            decision_comparison_count: 2,
            decision_divergence_count: 0,
            last_terminal_normalized_error: 0.25,
            last_terminal_max_norm_defect: 1.0e-15,
            last_terminal_max_spin_rotation_radians: 0.125,
            max_attempt_normalized_error: 1.5,
            max_attempt_norm_defect: 2.0e-15,
            max_attempt_spin_rotation_radians: 0.5,
        };
        let telemetry = super::adaptive_numerics_telemetry_from_native(native)
            .expect("known adaptive numerics semantics must map");
        assert_eq!(
            telemetry.embedded_error_semantics,
            "pre_projection_embedded_difference_v1"
        );
        assert_eq!(
            telemetry.norm_defect_semantics,
            "post_projection_abs_unit_norm_defect_v1"
        );
        assert_eq!(
            telemetry.spin_rotation_semantics,
            "attempt_geodesic_rotation_radians_v1"
        );
        assert!(telemetry.accounting_valid);
        assert_eq!(telemetry.terminal_observation_count, 2);
        assert_eq!(telemetry.decision_comparison_count, 2);
        assert_eq!(telemetry.decision_divergence_count, 0);
        assert_eq!(telemetry.max_attempt_normalized_error, 1.5);

        let unknown = super::adaptive_numerics_telemetry_from_native(
            super::ffi::fullmag_fdm_adaptive_numerics_telemetry_v1 {
                embedded_error_semantics: u32::MAX,
                ..native
            },
        );
        assert!(unknown.is_err());

        let invalid = super::adaptive_numerics_telemetry_from_native(
            super::ffi::fullmag_fdm_adaptive_numerics_telemetry_v1 {
                max_attempt_norm_defect: f64::INFINITY,
                ..native
            },
        );
        assert!(invalid.is_err());
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn fdm_gpu_step_transaction_telemetry_maps_all_fields() {
        let request = super::step_transaction_telemetry_v1_request();
        assert_eq!(
            request.abi_version,
            super::ffi::FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1
        );
        assert_eq!(
            request.struct_size as usize,
            std::mem::size_of::<super::ffi::fullmag_fdm_step_transaction_telemetry_v1>()
        );

        let native = super::ffi::fullmag_fdm_step_transaction_telemetry_v1 {
            abi_version: super::ffi::FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1,
            struct_size: std::mem::size_of::<super::ffi::fullmag_fdm_step_transaction_telemetry_v1>(
            ) as u32,
            accounting_valid: 1,
            reserved0: 0,
            capture_count: 11,
            rollback_count: 13,
            capture_d2d_bytes: 17,
            rollback_d2d_bytes: 19,
            rollback_latency_total_ns: 23,
            rollback_latency_max_ns: 29,
            accepted_step_index: 31,
            attempt_generation: 37,
            thermal_rng_draws: 41,
            stale_publication_count: 43,
        };

        assert_eq!(
            super::step_transaction_telemetry_from_native(native),
            crate::types::FdmGpuStepTransactionTelemetry {
                accounting_valid: true,
                capture_count: 11,
                rollback_count: 13,
                capture_d2d_bytes: 17,
                rollback_d2d_bytes: 19,
                rollback_latency_total_ns: 23,
                rollback_latency_max_ns: 29,
                accepted_step_index: 31,
                attempt_generation: 37,
                thermal_rng_draws: 41,
                stale_publication_count: 43,
            }
        );
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn fdm_gpu_step_transaction_telemetry_preserves_invalid_accounting() {
        let native = super::ffi::fullmag_fdm_step_transaction_telemetry_v1 {
            abi_version: super::ffi::FULLMAG_FDM_STEP_TRANSACTION_TELEMETRY_ABI_V1,
            struct_size: std::mem::size_of::<super::ffi::fullmag_fdm_step_transaction_telemetry_v1>(
            ) as u32,
            accounting_valid: 0,
            reserved0: 0,
            capture_count: 11,
            rollback_count: 13,
            capture_d2d_bytes: 17,
            rollback_d2d_bytes: 19,
            rollback_latency_total_ns: 23,
            rollback_latency_max_ns: 29,
            accepted_step_index: 31,
            attempt_generation: 37,
            thermal_rng_draws: 41,
            stale_publication_count: 43,
        };

        let telemetry = super::step_transaction_telemetry_from_native(native);
        assert!(!telemetry.accounting_valid);
        assert_eq!(telemetry.capture_count, 11);
        assert_eq!(telemetry.rollback_latency_max_ns, 29);
        assert_eq!(telemetry.stale_publication_count, 43);

        let mut provenance = crate::types::ExecutionProvenance::default();
        provenance.fdm_gpu_step_transaction_telemetry = Some(telemetry);
        let value = serde_json::to_value(provenance).expect("serialize provenance");
        assert_eq!(
            value["fdm_gpu_step_transaction_telemetry"]["accounting_valid"],
            false
        );
        assert_eq!(
            value["fdm_gpu_step_transaction_telemetry"]["capture_count"],
            11
        );
    }

    #[test]
    fn strict_preflight_rejects_non_device_operator_before_first_step() {
        let mut receipt = FdmGpuExecutionReceipt::strict_unvalidated("double");
        receipt.resolved = "hybrid".into();
        receipt.operator_residency = vec![FdmGpuOperatorResidency {
            operator: "exchange".into(),
            realization: "cuda_exchange_fp64".into(),
            location: "host".into(),
        }];

        let error = super::validate_strict_preflight(&receipt)
            .expect_err("strict preflight must reject a host operator");
        assert!(error.message.contains("strict FDM GPU preflight mismatch"));
    }

    #[test]
    fn strict_final_receipt_rejects_full_vector_hot_loop_movement() {
        let mut receipt = strict_device_receipt();
        receipt.transfer_counts = FdmGpuTransferCounts {
            setup_full_vector_h2d_count: 1,
            setup_full_vector_h2d_bytes: 24,
            hot_loop_full_vector_h2d_count: 1,
            hot_loop_full_vector_h2d_bytes: 24,
            ..Default::default()
        };

        let error = super::validate_strict_final_receipt(&receipt)
            .expect_err("strict final receipt must reject full-vector H2D");
        assert!(error.message.contains("hot-loop full-vector transfer"));
        assert_eq!(receipt.transfer_counts.setup_full_vector_h2d_count, 1);
    }

    #[test]
    fn strict_final_receipt_rejects_full_vector_d2h() {
        let mut receipt = strict_device_receipt();
        receipt.transfer_counts.hot_loop_full_vector_d2h_count = 1;
        receipt.transfer_counts.hot_loop_full_vector_d2h_bytes = 24;

        let error = super::validate_strict_final_receipt(&receipt)
            .expect_err("strict final receipt must reject full-vector D2H");
        assert!(error.message.contains("hot-loop full-vector transfer"));
    }

    #[test]
    fn strict_final_receipt_rejects_host_compute() {
        let mut receipt = strict_device_receipt();
        receipt.transfer_counts.hot_loop_host_compute_count = 1;

        let error = super::validate_strict_final_receipt(&receipt)
            .expect_err("strict final receipt must reject host compute");
        assert!(error.message.contains("hot-loop host-compute"));
    }

    #[test]
    fn scalar_control_readback_is_separate_from_forbidden_vector_transfers() {
        let mut receipt = strict_device_receipt();
        receipt.transfer_counts.hot_loop_control_scalar_d2h_bytes = 8;
        receipt
            .transfer_counts
            .hot_loop_control_scalar_host_sync_count = 1;
        receipt.transfer_counts.hot_loop_host_sync_count = 1;

        super::validate_strict_final_receipt(&receipt)
            .expect("bounded scalar control does not violate vector residency");
    }

    #[test]
    fn receipt_preserves_gpu_and_auto_request_intent() {
        assert_eq!(super::requested_device_name("gpu").unwrap(), "gpu");
        assert_eq!(super::requested_device_name("cuda").unwrap(), "gpu");
        assert_eq!(super::requested_device_name("auto").unwrap(), "auto");
        assert!(super::requested_device_name("cpu").is_err());
    }

    #[test]
    fn strict_native_masks_reject_unknown_and_host_realizations() {
        let known = super::known_operator_mask();
        let unknown = 1_u64 << 63;
        assert!(super::validate_native_operator_masks(known, known, 0, 0, known, 0, 0).is_ok());
        assert!(
            super::validate_native_operator_masks(known | unknown, known, 0, 0, known, 0, 0)
                .is_err()
        );
        assert!(
            super::validate_native_operator_masks(known, known, unknown, 0, known, 0, 0).is_err()
        );
        assert!(
            super::validate_native_operator_masks(known, known, 0, 0, known, 0, unknown).is_err()
        );
    }

    #[test]
    fn error_finalizer_preserves_primary_error_and_attaches_last_receipt() {
        let mut provenance = crate::types::ExecutionProvenance {
            precision: "double".into(),
            ..Default::default()
        };
        let mut receipt = strict_device_receipt();
        receipt.validation_state = "unvalidated".into();
        let error = super::finalize_receipt_result::<()>(
            Ok(receipt.clone()),
            &mut provenance,
            None,
            Err(crate::types::RunError {
                message: "primary solver failure".into(),
            }),
        )
        .expect_err("the primary solver error must be preserved");
        assert_eq!(error.message, "primary solver failure");
        assert_eq!(provenance.fdm_gpu_execution_receipt, Some(receipt));
    }

    #[test]
    fn error_finalizer_keeps_primary_error_when_receipt_query_fails() {
        let mut provenance = crate::types::ExecutionProvenance {
            precision: "double".into(),
            ..Default::default()
        };
        let error = super::finalize_receipt_result::<()>(
            Err(crate::types::RunError {
                message: "receipt query failure".into(),
            }),
            &mut provenance,
            None,
            Err(crate::types::RunError {
                message: "primary solver failure".into(),
            }),
        )
        .expect_err("the primary solver error must win over receipt query failure");
        assert_eq!(error.message, "primary solver failure");
        assert_eq!(
            provenance
                .fdm_gpu_execution_receipt
                .as_ref()
                .map(|receipt| receipt.validation_state.as_str()),
            Some("unvalidated")
        );
    }

    #[test]
    fn success_finalizer_propagates_receipt_failure() {
        let mut provenance = crate::types::ExecutionProvenance {
            precision: "double".into(),
            ..Default::default()
        };
        let error = super::finalize_receipt_result(
            Err(crate::types::RunError {
                message: "receipt validation failure".into(),
            }),
            &mut provenance,
            None,
            Ok(7_u32),
        )
        .expect_err("successful execution must not hide receipt validation failure");
        assert_eq!(error.message, "receipt validation failure");
    }

    #[cfg(feature = "cuda")]
    #[test]
    fn native_receipt_discriminants_fail_closed() {
        assert!(super::execution_class_name(u32::MAX).is_err());
        assert!(super::executed_backend_name(u32::MAX).is_err());
        assert!(super::operator_location_name(u32::MAX).is_err());
    }

    fn strict_device_receipt() -> FdmGpuExecutionReceipt {
        let mut receipt = FdmGpuExecutionReceipt::strict_unvalidated("double");
        receipt.resolved = "device_resident".into();
        receipt.executed = "cuda_fdm".into();
        receipt.required_operator_mask = 1;
        receipt.resolved_device_operator_mask = 1;
        receipt.executed_device_operator_mask = 1;
        receipt.executed_unknown_operator_mask = 0;
        receipt.accounting_valid = true;
        let components = FdmGpuPrecisionComponents {
            storage: "double".into(),
            compute: "double".into(),
            fft: "double".into(),
            reduction: "double".into(),
            realization_id: "fullmag.fdm.cuda.precision.full_double.v1".into(),
        };
        receipt.precision_policy = Some(FdmGpuPrecisionPolicyReceipt {
            schema_version: "fullmag.fdm.cuda.precision-policy.v1".into(),
            requested: "double".into(),
            resolved: components.clone(),
            executed: components,
            accounting_valid: true,
        });
        receipt.operator_residency = vec![FdmGpuOperatorResidency {
            operator: "llg_integrator".into(),
            realization: "cuda_dp45_fp64".into(),
            location: "device".into(),
        }];
        receipt
    }
}
