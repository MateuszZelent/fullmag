use crate::types::{FdmGpuExecutionReceipt, RunError};

#[cfg(feature = "cuda")]
use super::{ffi, NativeFdmBackend};
#[cfg(feature = "cuda")]
use crate::types::{FdmGpuOperatorResidency, FdmGpuTransferCounts};

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
    let receipt = receipt_result.as_ref().ok().cloned().unwrap_or_else(|| {
        FdmGpuExecutionReceipt::strict_unvalidated(&provenance.precision)
    });
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
    let unknown = (required | resolved_device | resolved_host | resolved_unknown |
        executed_device | executed_host | executed_unknown) & !KNOWN_OPERATOR_MASK;
    if unknown != 0 {
        return Err(preflight_error(format!("unknown_operator_mask={unknown:#x}")));
    }
    if required == 0 || resolved_device & required != required || resolved_host != 0 ||
        resolved_unknown != 0 || resolved_device & !required != 0 ||
        executed_device & !required != 0 || executed_host != 0 ||
        executed_unknown != (required & !executed_device) {
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
        finalize_receipt_result(receipt_result, provenance, artifacts, outcome)
    }
}

pub(super) fn validate_strict_preflight(
    receipt: &FdmGpuExecutionReceipt,
) -> Result<(), RunError> {
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
    if !receipt.accounting_valid || receipt.required_operator_mask == 0 ||
        receipt.resolved_device_operator_mask != receipt.required_operator_mask ||
        receipt.resolved_host_operator_mask != 0 ||
        receipt.resolved_unknown_operator_mask != 0 {
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
    if receipt.executed != "cuda_fdm" ||
        receipt.executed_device_operator_mask != receipt.required_operator_mask ||
        receipt.executed_host_operator_mask != 0 ||
        receipt.executed_unknown_operator_mask != 0 {
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
            message: "strict FDM GPU hot-loop full-vector transfer count must be zero"
                .to_string(),
        });
    }
    if counts.hot_loop_host_compute_count != 0 {
        return Err(RunError {
            message: "strict FDM GPU hot-loop host-compute count must be zero".to_string(),
        });
    }
    if counts.hot_loop_host_sync_count
        > counts.hot_loop_control_scalar_host_sync_count
    {
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
        value if value == ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_SINGLE as u32 => Ok("single"),
        value if value == ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE as u32 => Ok("double"),
        other => Err(preflight_error(format!("unknown precision discriminant={other}"))),
    }
}

#[cfg(feature = "cuda")]
fn integrator_realization(
    integrator: u32,
    precision: &str,
) -> Result<String, RunError> {
    let name = match integrator {
        value if value == ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN as u32 => "heun",
        value if value == ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK4 as u32 => "rk4",
        value if value == ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_RK23 as u32 => "rk23",
        value if value == ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_DP45 as u32 => "dp45",
        value if value == ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_ABM3 as u32 => "abm3",
        other => {
            return Err(preflight_error(format!(
                "unknown integrator discriminant={other}"
            )))
        }
    };
    let suffix = if precision == "single" { "fp32" } else { "fp64" };
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
pub(super) fn query_execution_receipt(
    backend: &NativeFdmBackend,
    requested_device: &str,
    requested_mode: fullmag_ir::ExecutionMode,
    device_name: &str,
) -> Result<FdmGpuExecutionReceipt, RunError> {
    let mut native = ffi::fullmag_fdm_execution_receipt_v2 {
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
    };
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
        format!("cuda_exchange_{}", if precision == "single" { "fp32" } else { "fp64" }),
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
        (ffi::FULLMAG_FDM_OPERATOR_EXTERNAL_FIELD, "external_field", "cuda_external_field"),
        (ffi::FULLMAG_FDM_OPERATOR_MASKS, "masks", "cuda_device_masks"),
        (ffi::FULLMAG_FDM_OPERATOR_MAGNETOELASTIC, "magnetoelastic", "cuda_magnetoelastic"),
        (ffi::FULLMAG_FDM_OPERATOR_THERMAL, "thermal", "cuda_counter_brown_noise"),
        (ffi::FULLMAG_FDM_OPERATOR_ZHANG_LI_STT, "zhang_li_stt", "cuda_zhang_li_stt"),
        (ffi::FULLMAG_FDM_OPERATOR_SLONCZEWSKI_STT, "slonczewski_stt", "cuda_slonczewski_stt"),
        (ffi::FULLMAG_FDM_OPERATOR_SOT, "sot", "cuda_sot"),
        (ffi::FULLMAG_FDM_OPERATOR_OERSTED, "oersted", "cuda_oersted"),
        (ffi::FULLMAG_FDM_OPERATOR_BOUNDARY_CORRECTION, "boundary_correction", "cuda_boundary_correction"),
        (ffi::FULLMAG_FDM_OPERATOR_MULTILAYER_TRANSFER, "multilayer_transfer", "cuda_multilayer_transfer"),
        (ffi::FULLMAG_FDM_OPERATOR_MULTILAYER_INTERACTIONS, "multilayer_interactions", "cuda_multilayer_interactions"),
        (ffi::FULLMAG_FDM_OPERATOR_MULTILAYER_DEMAG, "multilayer_demag", "cuda_multilayer_demag"),
        (ffi::FULLMAG_FDM_OPERATOR_GPU_TRANSPORT, "gpu_transport", "cuda_m1_transport"),
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
            hot_loop_control_scalar_host_sync_count:
                native.hot_loop_control_scalar_host_sync_count,
        },
        validation_state: "unvalidated".to_string(),
        accounting_valid: native.accounting_valid == 1,
    };
    let _ = requested_mode;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use crate::types::{
        FdmGpuExecutionReceipt, FdmGpuOperatorResidency, FdmGpuTransferCounts,
    };

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
        receipt.transfer_counts.hot_loop_control_scalar_host_sync_count = 1;
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
        assert!(super::validate_native_operator_masks(known | unknown, known, 0, 0, known, 0, 0).is_err());
        assert!(super::validate_native_operator_masks(known, known, unknown, 0, known, 0, 0).is_err());
        assert!(super::validate_native_operator_masks(known, known, 0, 0, known, 0, unknown).is_err());
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
        receipt.operator_residency = vec![FdmGpuOperatorResidency {
            operator: "llg_integrator".into(),
            realization: "cuda_dp45_fp64".into(),
            location: "device".into(),
        }];
        receipt
    }
}
