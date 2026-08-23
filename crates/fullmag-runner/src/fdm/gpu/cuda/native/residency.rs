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
    device: u64,
    host: u64,
) -> Result<(), RunError> {
    let unknown = (required | device | host) & !KNOWN_OPERATOR_MASK;
    if unknown != 0 {
        return Err(preflight_error(format!("unknown_operator_mask={unknown:#x}")));
    }
    if required == 0 || device & required != required || host != 0 ||
        device & !required != 0 {
        return Err(preflight_error(format!(
            "required_operator_mask={required:#x} device_operator_mask={device:#x} host_operator_mask={host:#x}"
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

    pub(crate) fn finish(
        &self,
        backend: &NativeFdmBackend,
    ) -> Result<FdmGpuExecutionReceipt, RunError> {
        let mut receipt =
            backend.execution_receipt(&self.requested_device, self.execution_mode)?;
        if self.execution_mode == fullmag_ir::ExecutionMode::Strict {
            validate_strict_final_receipt(&receipt)?;
            receipt.validation_state = "validated".to_string();
        }
        Ok(receipt)
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
    if receipt.executed != "cuda_fdm" {
        return Err(preflight_error(format!(
            "executed={} expected=cuda_fdm",
            receipt.executed
        )));
    }
    if receipt.fallback_count != 0 {
        return Err(preflight_error(format!(
            "fallback_count={} expected=0",
            receipt.fallback_count
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
fn execution_class_name(value: ffi::fullmag_fdm_execution_class_v1) -> &'static str {
    match value {
        ffi::FULLMAG_FDM_EXECUTION_DEVICE_RESIDENT => "device_resident",
        ffi::FULLMAG_FDM_EXECUTION_GPU_OPERATOR_HOST_CONTROL => "gpu_operator_host_control",
        ffi::FULLMAG_FDM_EXECUTION_HYBRID => "hybrid",
        ffi::FULLMAG_FDM_EXECUTION_CPU => "cpu",
        _ => "unknown",
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
    let mut native = ffi::fullmag_fdm_execution_receipt_v1 {
        abi_version: ffi::FULLMAG_FDM_EXECUTION_RECEIPT_ABI_V1,
        struct_size: std::mem::size_of::<ffi::fullmag_fdm_execution_receipt_v1>() as u32,
        execution_class: ffi::FULLMAG_FDM_EXECUTION_UNKNOWN,
        executed_backend: ffi::FULLMAG_FDM_EXECUTED_UNKNOWN,
        device_ordinal: -1,
        precision: ffi::fullmag_fdm_precision::FULLMAG_FDM_PRECISION_DOUBLE as u32,
        integrator: ffi::fullmag_fdm_integrator::FULLMAG_FDM_INTEGRATOR_HEUN as u32,
        reserved0: 0,
        required_operator_mask: 0,
        device_operator_mask: 0,
        host_operator_mask: 0,
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
        ffi::fullmag_fdm_backend_execution_receipt_v1(backend.handle as *mut _, &mut native)
    };
    if status != ffi::FULLMAG_FDM_OK {
        return Err(backend.last_error_or("FDM CUDA execution receipt query failed"));
    }

    if native.accounting_valid != 1 {
        return Err(preflight_error(format!(
            "accounting_valid={} expected=1",
            native.accounting_valid
        )));
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
    )?;
    if native.reduction_location != ffi::FULLMAG_FDM_LOCATION_DEVICE ||
        native.control_location != ffi::FULLMAG_FDM_LOCATION_HOST_SCALAR {
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
        location: match native.control_location {
            ffi::FULLMAG_FDM_LOCATION_HOST_SCALAR => "host_scalar",
            ffi::FULLMAG_FDM_LOCATION_DEVICE => "device",
            ffi::FULLMAG_FDM_LOCATION_HOST => "host",
            ffi::FULLMAG_FDM_LOCATION_MIXED => "mixed",
            _ => "unknown",
        }
        .to_string(),
    });

    let receipt = FdmGpuExecutionReceipt {
        requested: requested_device_name(requested_device)?.to_string(),
        resolved: execution_class_name(native.execution_class).to_string(),
        executed: match native.executed_backend {
            ffi::FULLMAG_FDM_EXECUTED_CUDA_FDM => "cuda_fdm",
            _ => "unknown",
        }
        .to_string(),
        device: format!("cuda:{}:{device_name}", native.device_ordinal),
        precision,
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
    };
    if requested_mode == fullmag_ir::ExecutionMode::Strict {
        validate_strict_preflight(&receipt)?;
    }
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
        let mut receipt = FdmGpuExecutionReceipt::strict_unvalidated("double");
        receipt.resolved = "device_resident".into();
        receipt.executed = "cuda_fdm".into();
        receipt.operator_residency = vec![FdmGpuOperatorResidency {
            operator: "llg_integrator".into(),
            realization: "cuda_heun_fp64".into(),
            location: "device".into(),
        }];
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
        assert!(super::validate_native_operator_masks(known, known, 0).is_ok());
        assert!(super::validate_native_operator_masks(known | unknown, known, 0).is_err());
        assert!(super::validate_native_operator_masks(known, known, unknown).is_err());
    }

    fn strict_device_receipt() -> FdmGpuExecutionReceipt {
        let mut receipt = FdmGpuExecutionReceipt::strict_unvalidated("double");
        receipt.resolved = "device_resident".into();
        receipt.executed = "cuda_fdm".into();
        receipt.operator_residency = vec![FdmGpuOperatorResidency {
            operator: "llg_integrator".into(),
            realization: "cuda_dp45_fp64".into(),
            location: "device".into(),
        }];
        receipt
    }
}
