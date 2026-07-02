use super::*;

pub(crate) fn normalize_plan_signature(plan: &FdmPlanIR) -> FdmPlanIR {
    let mut normalized = plan.clone();
    normalized.initial_magnetization.clear();
    normalized
}

pub(crate) fn normalize_fem_plan_signature(plan: &FemPlanIR) -> FemPlanIR {
    let mut normalized = plan.clone();
    normalized.initial_magnetization.clear();
    normalized
}

#[cfg(feature = "fem-gpu")]
pub(crate) fn fem_plan_for_cpu_native(plan: &FemPlanIR) -> FemPlanIR {
    let mut native = plan.clone();
    if native.mfem_device_string.is_none() {
        native.mfem_device_string = Some("cpu".to_string());
    }
    native
}
