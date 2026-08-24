#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PublicGpuTransportRoute {
    None,
    ChargeOnly,
    InvalidGpuSpinPlan,
    SpinOnNonCudaForbidden,
    SpinCoupled,
}

pub(crate) const FDM_CUDA_UNAVAILABLE_FALLBACK_REASON: &str = "fdm_cuda_unavailable";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FdmGpuAvailabilityRoute {
    CpuRequested,
    Cuda,
    CpuAutoFallback { reason: &'static str },
}

pub(crate) fn resolve_fdm_gpu_availability_route(
    requested_policy: &str,
    cuda_available: bool,
) -> Result<FdmGpuAvailabilityRoute, crate::types::RunError> {
    match (requested_policy, cuda_available) {
        ("cpu", _) => Ok(FdmGpuAvailabilityRoute::CpuRequested),
        ("cuda", true) | ("auto", true) => Ok(FdmGpuAvailabilityRoute::Cuda),
        ("cuda", false) => Err(crate::types::RunError {
            message: "FDM CUDA execution was requested, but the CUDA backend is not available"
                .to_string(),
        }),
        ("auto", false) => Ok(FdmGpuAvailabilityRoute::CpuAutoFallback {
            reason: FDM_CUDA_UNAVAILABLE_FALLBACK_REASON,
        }),
        (other, _) => Err(crate::types::RunError {
            message: format!("unsupported FDM execution policy '{other}'"),
        }),
    }
}

fn route_from_shape(
    charge_only: bool,
    spin_plan_count: usize,
    gpu_intent_count: usize,
    gpu_descriptor_count: usize,
    cuda_engine: bool,
) -> PublicGpuTransportRoute {
    if gpu_intent_count > 0 || gpu_descriptor_count > 0 {
        if spin_plan_count != 1 || gpu_intent_count != 1 || gpu_descriptor_count != 1 {
            PublicGpuTransportRoute::InvalidGpuSpinPlan
        } else if !cuda_engine {
            PublicGpuTransportRoute::SpinOnNonCudaForbidden
        } else {
            PublicGpuTransportRoute::SpinCoupled
        }
    } else if charge_only {
        PublicGpuTransportRoute::ChargeOnly
    } else {
        PublicGpuTransportRoute::None
    }
}

pub(crate) fn public_gpu_transport_route(
    plan: &fullmag_ir::FdmPlanIR,
    cuda_engine: bool,
) -> PublicGpuTransportRoute {
    let gpu_intent_count = plan
        .spin_transport_plans
        .iter()
        .filter(|transport| {
            transport.requested_execution.device == fullmag_ir::ExecutionDevice::Gpu
                || transport.resolved_device == fullmag_ir::ExecutionDevice::Gpu
                || transport.fdm_gpu_double.is_some()
        })
        .count();
    let gpu_descriptor_count = plan
        .spin_transport_plans
        .iter()
        .filter(|transport| transport.fdm_gpu_double.is_some())
        .count();
    route_from_shape(
        !plan.fdm_gpu_charge_transports.is_empty(),
        plan.spin_transport_plans.len(),
        gpu_intent_count,
        gpu_descriptor_count,
        cuda_engine,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forced_gpu_unavailable_fails_before_cpu_route_is_called() {
        let cpu_calls = std::cell::Cell::new(0_u64);
        let result = resolve_fdm_gpu_availability_route("cuda", false).and_then(|route| {
            if matches!(route, FdmGpuAvailabilityRoute::CpuAutoFallback { .. }) {
                cpu_calls.set(cpu_calls.get() + 1);
            }
            Ok(route)
        });

        let error = result.expect_err("forced CUDA must fail closed");
        assert!(error.message.contains("CUDA backend is not available"));
        assert_eq!(cpu_calls.get(), 0, "CPU route must not be called");
    }

    #[test]
    fn auto_gpu_unavailable_falls_back_only_with_reason() {
        let route = resolve_fdm_gpu_availability_route("auto", false)
            .expect("auto may select the CPU fallback");
        assert_eq!(
            route,
            FdmGpuAvailabilityRoute::CpuAutoFallback {
                reason: FDM_CUDA_UNAVAILABLE_FALLBACK_REASON,
            }
        );
        assert!(!FDM_CUDA_UNAVAILABLE_FALLBACK_REASON.is_empty());
    }

    #[test]
    fn available_gpu_never_routes_through_cpu() {
        assert_eq!(
            resolve_fdm_gpu_availability_route("cuda", true).expect("CUDA route"),
            FdmGpuAvailabilityRoute::Cuda,
        );
        assert_eq!(
            resolve_fdm_gpu_availability_route("auto", true).expect("CUDA route"),
            FdmGpuAvailabilityRoute::Cuda,
        );
    }

    #[test]
    fn spin_route_fails_closed_before_any_charge_only_return() {
        assert_eq!(
            route_from_shape(true, 1, 1, 1, true),
            PublicGpuTransportRoute::SpinCoupled
        );
    }

    #[test]
    fn spin_route_rejects_hidden_non_cuda_fallback_before_binding() {
        assert_eq!(
            route_from_shape(false, 1, 1, 1, false),
            PublicGpuTransportRoute::SpinOnNonCudaForbidden
        );
    }

    #[test]
    fn charge_only_route_remains_separate_when_spin_is_absent() {
        assert_eq!(
            route_from_shape(true, 0, 0, 0, false),
            PublicGpuTransportRoute::ChargeOnly
        );
    }

    #[test]
    fn requested_or_resolved_gpu_without_exactly_one_descriptor_is_invalid() {
        assert_eq!(
            route_from_shape(false, 1, 1, 0, true),
            PublicGpuTransportRoute::InvalidGpuSpinPlan
        );
        assert_eq!(
            route_from_shape(false, 2, 2, 2, true),
            PublicGpuTransportRoute::InvalidGpuSpinPlan
        );
    }

    #[test]
    fn cpu_spin_plan_does_not_activate_the_gpu_route() {
        assert_eq!(
            route_from_shape(false, 1, 0, 0, false),
            PublicGpuTransportRoute::None
        );
    }
}
