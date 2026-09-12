use super::eigen_constants::SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON;
use super::eigen_policy::{
    k_sampling_is_single_k0, native_cpu_modal_window_has_bloch_floquet_payload_path,
    native_modal_target_frequency_hz, shared_domain_k0_modal_requested,
};
use super::eigen_reduction::{is_gamma_k_sampling, k_sampling_contains_nonzero};
use super::eigen_shared_domain::native_shared_domain_magnetic_assembly_available;
use super::eigen_shared_domain_geometry::{pa_e4b_airbox_size_m, periodic_domain_pair_stats};
use fullmag_ir::{EigenDampingPolicyIR, FemEigenPlanIR, SpinWaveBoundaryKindIR};

pub(super) fn native_gpu_shared_domain_modal_supported(plan: &FemEigenPlanIR) -> bool {
    plan.precision == fullmag_ir::ExecutionPrecision::Double
        && plan.enable_demag
        && plan.operator.include_demag
        && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        && matches!(plan.damping_policy, EigenDampingPolicyIR::Ignore)
        && matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Periodic)
        && is_gamma_k_sampling(plan.k_sampling.as_ref())
        && plan.air_box_config.is_some()
        && native_shared_domain_mesh_metadata_valid(plan)
        && native_shared_domain_magnetic_assembly_available(plan)
        && plan.count > 0
        && plan.count <= 32
        && native_modal_target_frequency_hz(&plan.target) > 0.0
}

pub(super) fn native_gpu_k0_kittel_modal_supported(plan: &FemEigenPlanIR) -> bool {
    plan.precision == fullmag_ir::ExecutionPrecision::Double
        && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        && !plan.operator.include_demag
        && !plan.enable_demag
        && matches!(plan.damping_policy, EigenDampingPolicyIR::Ignore)
        && k_sampling_is_single_k0(plan.k_sampling.as_ref())
}

pub(super) fn native_cpu_modal_window_enabled(plan: &FemEigenPlanIR) -> bool {
    if shared_domain_k0_modal_requested(plan) {
        return native_shared_domain_cpu_modal_supported(plan);
    }
    let base_window_supported =
        matches!(
            plan.target,
            fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
        ) && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
            && matches!(
                plan.damping_policy,
                fullmag_ir::EigenDampingPolicyIR::Ignore
            );
    base_window_supported
        && ((matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Free
        ) && is_gamma_k_sampling(plan.k_sampling.as_ref()))
            || native_cpu_modal_window_has_bloch_floquet_payload_path(plan))
}

fn native_shared_domain_cpu_modal_supported(plan: &FemEigenPlanIR) -> bool {
    if !shared_domain_k0_modal_requested(plan)
        || plan.count == 0
        || !native_shared_domain_mesh_metadata_valid(plan)
        || !native_shared_domain_magnetic_assembly_available(plan)
    {
        return false;
    }
    if !native_modal_target_frequency_hz(&plan.target).is_finite()
        || native_modal_target_frequency_hz(&plan.target) < 0.0
    {
        return false;
    }
    true
}

fn native_shared_domain_mesh_metadata_valid(plan: &FemEigenPlanIR) -> bool {
    if plan.mesh.periodic_node_pairs.is_empty() || plan.mesh.periodic_boundary_pairs.is_empty() {
        return false;
    }
    let Ok(pair_stats) = periodic_domain_pair_stats(&plan.mesh) else {
        return false;
    };
    pair_stats.magnetic_pair_count > 0
        && pair_stats.airbox_pair_count > 0
        && pa_e4b_airbox_size_m(plan).is_ok()
}

pub(crate) fn native_cpu_modal_window_rejection_reason(
    plan: &FemEigenPlanIR,
) -> Option<&'static str> {
    if native_cpu_modal_window_enabled(plan) {
        return None;
    }
    if shared_domain_k0_modal_requested(plan) {
        return Some("production_cpu_modal_periodic_airbox_k0_payload_missing");
    }
    if matches!(
        plan.target,
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. }
    ) && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        && matches!(
            plan.damping_policy,
            fullmag_ir::EigenDampingPolicyIR::Ignore
        )
        && matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        )
        && k_sampling_contains_nonzero(plan.k_sampling.as_ref())
    {
        if plan.operator.include_demag {
            return Some("production_cpu_modal_dynamic_demag_k_operator_missing");
        }
        return Some("production_cpu_modal_nonzero_k_floquet_operator_missing");
    }
    None
}

pub(crate) fn native_cpu_modal_window_rejection_scope(reason: &str) -> &'static str {
    if reason == "production_cpu_modal_dynamic_demag_k_operator_missing" {
        return "selected_spectrum_nonzero_k_floquet_modal_dynamic_demag";
    }
    "selected_spectrum_nonzero_k_floquet_modal"
}

pub(crate) fn insert_native_cpu_modal_window_rejection_contract(
    object: &mut serde_json::Map<String, serde_json::Value>,
    reason: &str,
) {
    let required_operator_contract =
        if reason == "production_cpu_modal_dynamic_demag_k_operator_missing" {
            "bloch_floquet_tangent_operator_with_dynamic_demag_k"
        } else {
            "bloch_floquet_tangent_operator_with_periodic_pairs"
        };
    object.insert(
        "required_operator_contract".to_string(),
        serde_json::json!(required_operator_contract),
    );
    object.insert(
        "required_operator_payload_kind".to_string(),
        serde_json::json!("bloch_floquet_tangent_operator"),
    );
    if reason == "production_cpu_modal_dynamic_demag_k_operator_missing" {
        object.insert(
            "required_demag_payload_kind".to_string(),
            serde_json::json!("dynamic_demag_k_operator"),
        );
        object.insert(
            "dynamic_demag_operator_source".to_string(),
            serde_json::json!("missing_numeric_fem_demag_k"),
        );
    }
    if reason == "production_cpu_modal_periodic_airbox_k0_payload_missing" {
        object.insert(
            "runtime_capability_status".to_string(),
            serde_json::json!("unsupported"),
        );
        object.insert(
            "runtime_capability_reason".to_string(),
            serde_json::json!(SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON),
        );
        object.insert(
            "native_shared_domain_magnetic_assembly_available".to_string(),
            serde_json::json!(false),
        );
        object.insert(
            "certificate_binding_v6_producer_available".to_string(),
            serde_json::json!(false),
        );
    }
    object.insert(
        "modal_periodic_pair_contract_available".to_string(),
        serde_json::json!(false),
    );
}
