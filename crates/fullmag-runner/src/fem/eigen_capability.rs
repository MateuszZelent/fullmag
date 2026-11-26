use super::eigen_constants::GAMMA_K_TOLERANCE_RAD_PER_M;
use super::eigen_constants::SHARED_DOMAIN_K0_RUNTIME_UNAVAILABLE_REASON;
use super::eigen_policy::{
    k_sampling_is_single_k0, native_cpu_modal_window_has_bloch_floquet_payload_path,
    native_cpu_modal_window_has_periodic_k0_runner_operator_path, native_modal_target_frequency_hz,
    open_airbox_k0_modal_requested, shared_domain_k0_modal_requested,
};
use super::eigen_reduction::{is_gamma_k_sampling, k_sampling_contains_nonzero};
use super::eigen_shared_domain::native_shared_domain_magnetic_assembly_available;
use super::eigen_shared_domain_geometry::{pa_e4b_airbox_size_m, periodic_domain_pair_stats};
use fullmag_ir::{EigenDampingPolicyIR, FemEigenPlanIR, SpinWaveBoundaryKindIR};
use std::collections::BTreeSet;

pub(super) fn modal_solver_policy_has_controls(plan: &FemEigenPlanIR) -> bool {
    plan.solver_policy.as_ref().is_some_and(|policy| {
        policy.residual_tolerance.is_some()
            || policy.max_outer_iterations.is_some()
            || policy.max_linear_iterations.is_some()
    })
}

/// Return whether the requested lane structurally selects a native PETSc/SLEPc
/// family that consumes modal solver controls. The GPU dense K0 Kittel route is
/// intentionally excluded because it does not use PETSc/SLEPc policy.
pub(super) fn modal_solver_policy_native_path_supported(
    plan: &FemEigenPlanIR,
    requested_gpu: bool,
) -> bool {
    if requested_gpu {
        native_gpu_shared_domain_modal_supported(plan)
    } else {
        native_cpu_modal_window_enabled(plan)
    }
}

pub(super) fn native_gpu_shared_domain_modal_supported(plan: &FemEigenPlanIR) -> bool {
    let periodic_k0 = matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Periodic)
        && is_gamma_k_sampling(plan.k_sampling.as_ref());
    let open_k0 = open_airbox_k0_modal_requested(plan);
    plan.precision == fullmag_ir::ExecutionPrecision::Double
        && plan.enable_demag
        && plan.operator.include_demag
        && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        && matches!(plan.damping_policy, EigenDampingPolicyIR::Ignore)
        && (periodic_k0 || open_k0)
        && plan.air_box_config.is_some()
        && native_shared_domain_mesh_metadata_valid(plan)
        && native_shared_domain_magnetic_assembly_available(plan)
        && plan.count > 0
        && plan.count <= 32
        && native_modal_target_frequency_hz(&plan.target).is_finite()
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
    if native_cpu_modal_window_has_periodic_k0_runner_operator_path(plan) {
        return true;
    }
    if native_cpu_modal_window_has_floquet_dynamic_demag_path(plan) {
        return true;
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

/// The bounded CPU nonzero-k demag lane is selected only for a fully explicit
/// Poisson-airbox plan. The provider and certificate checks remain at the
/// native boundary; this predicate only selects that production entrypoint.
pub(crate) fn native_cpu_modal_window_has_floquet_dynamic_demag_path(
    plan: &FemEigenPlanIR,
) -> bool {
    if !plan.enable_demag
        || !plan.operator.include_demag
        || !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        || !matches!(
            plan.damping_policy,
            fullmag_ir::EigenDampingPolicyIR::Ignore
        )
        || !native_cpu_modal_floquet_target_supported(&plan.target)
        || !matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet)
        || plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
        || plan.air_box_config.is_none()
        || !plan
            .demag_realization
            .is_some_and(|realization| realization.is_poisson())
        || !native_shared_domain_mesh_metadata_valid(plan)
        || !native_floquet_pair_sets_match(plan, false)
    {
        return false;
    }

    match plan.k_sampling.as_ref() {
        Some(fullmag_ir::KSamplingIR::Single { k_vector }) => {
            k_vector.iter().all(|value| value.is_finite())
                && k_vector
                    .iter()
                    .any(|value| value.abs() > GAMMA_K_TOLERANCE_RAD_PER_M)
        }
        Some(fullmag_ir::KSamplingIR::Path { points, .. }) => {
            !points.is_empty()
                && points
                    .iter()
                    .all(|point| point.k_vector.iter().all(|value| value.is_finite()))
                && points.iter().any(|point| {
                    point
                        .k_vector
                        .iter()
                        .any(|value| value.abs() > GAMMA_K_TOLERANCE_RAD_PER_M)
                })
        }
        None => false,
    }
}

/// Explicit-GPU Floquet admission for the first cuDSS modal slice. Unlike the
/// CPU provider this accepts only one signed nonzero k point and nearest-
/// frequency selection; path expansion and window search remain unsupported.
pub(crate) fn native_gpu_modal_window_has_floquet_dynamic_demag_path(
    plan: &FemEigenPlanIR,
) -> bool {
    let Some(fullmag_ir::KSamplingIR::Single { k_vector }) = plan.k_sampling.as_ref() else {
        return false;
    };
    if !plan.enable_demag
        || !plan.operator.include_demag
        || !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
        || !matches!(plan.damping_policy, EigenDampingPolicyIR::Ignore)
        || plan.precision != fullmag_ir::ExecutionPrecision::Double
        || !matches!(plan.target, fullmag_ir::EigenTargetIR::Nearest { frequency_hz }
            if frequency_hz.is_finite() && frequency_hz > 0.0)
        || !matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet)
        || plan.magnetostatic_bc
            != fullmag_ir::MagnetostaticBoundaryConditionIR::FloquetAirbox
        || plan.domain_mesh_mode != fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir
        || plan.fe_order != 1
        || plan.air_box_config.is_none()
        || !plan.demag_realization.is_some_and(|realization| realization.is_poisson())
        || !native_shared_domain_mesh_metadata_valid(plan)
        || !native_floquet_pair_sets_match(plan, true)
        || !k_vector.iter().all(|value| value.is_finite())
        || !k_vector
            .iter()
            .any(|value| value.abs() > GAMMA_K_TOLERANCE_RAD_PER_M)
        || !native_gpu_floquet_material_is_reciprocal(plan)
        || !native_gpu_floquet_has_nontrivial_phase(plan, *k_vector)
    {
        return false;
    }
    true
}

fn native_gpu_floquet_material_is_reciprocal(plan: &FemEigenPlanIR) -> bool {
    let material = &plan.material;
    material.damping.is_finite()
        && material.damping == 0.0
        && material.alpha_field.as_ref().is_none_or(|values| {
            !values.is_empty() && values.iter().all(|value| value.is_finite() && *value == 0.0)
        })
        && [
            material.uniaxial_anisotropy,
            material.uniaxial_anisotropy_k2,
            material.cubic_anisotropy_kc1,
            material.cubic_anisotropy_kc2,
            material.cubic_anisotropy_kc3,
        ]
        .into_iter()
        .flatten()
        .all(|value| value.is_finite() && value == 0.0)
        && [
            &material.ku_field,
            &material.ku2_field,
            &material.kc1_field,
            &material.kc2_field,
            &material.kc3_field,
        ]
        .into_iter()
        .flatten()
        .all(|values| values.iter().all(|value| value.is_finite() && *value == 0.0))
        && material.a_field.is_none()
        && material.dind_field.is_none()
        && material.dbulk_field.is_none()
        && plan
            .interfacial_dmi
            .is_none_or(|coefficient| coefficient.is_finite() && coefficient == 0.0)
        && plan
            .bulk_dmi
            .is_none_or(|coefficient| coefficient.is_finite() && coefficient == 0.0)
        && plan.spin_wave_bc.surface_anisotropy_ks().is_none()
}

fn native_gpu_floquet_has_nontrivial_phase(
    plan: &FemEigenPlanIR,
    k_vector: [f64; 3],
) -> bool {
    let requested = plan.spin_wave_bc.boundary_pair_ids();
    plan.mesh.periodic_boundary_pairs.iter().any(|pair| {
        (requested.is_empty() || requested.contains(&pair.pair_id.as_str()))
            && pair.translation.is_some_and(|translation| {
                if !translation.iter().all(|value| value.is_finite()) {
                    return false;
                }
                let angle = -k_vector
                    .iter()
                    .zip(translation)
                    .map(|(k, distance)| k * distance)
                    .sum::<f64>();
                let wrapped = (angle + std::f64::consts::PI)
                    .rem_euclid(std::f64::consts::TAU)
                    - std::f64::consts::PI;
                wrapped.abs() > 1.0e-12
            })
    })
}

fn native_floquet_pair_sets_match(plan: &FemEigenPlanIR, allow_implicit_all: bool) -> bool {
    let requested = plan.spin_wave_bc.boundary_pair_ids();
    let requested_set = requested.iter().copied().collect::<BTreeSet<_>>();
    let node_set = plan.mesh.periodic_node_pairs.iter()
        .map(|pair| pair.pair_id.as_str()).collect::<BTreeSet<_>>();
    let boundary_set = plan.mesh.periodic_boundary_pairs.iter()
        .map(|pair| pair.pair_id.as_str()).collect::<BTreeSet<_>>();
    !node_set.is_empty()
        && node_set == boundary_set
        && requested_set.len() == requested.len()
        && ((allow_implicit_all && requested_set.is_empty()) || requested_set == node_set)
}

/// The native Floquet Schur operator supports two spectral selection modes:
/// a bounded frequency window and a diagnostic nearest-frequency request.
/// `Nearest` deliberately remains selected-only; it does not imply a complete
/// window or a complete spectrum certificate.
fn native_cpu_modal_floquet_target_supported(target: &fullmag_ir::EigenTargetIR) -> bool {
    match target {
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. } => true,
        // Keep this boundary fail-closed even when a plan was assembled
        // directly instead of passing through the public IR validator.  The
        // public contract requires a finite positive nearest target; NaN and
        // infinity must never reach the native target-distance calculation.
        fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => {
            frequency_hz.is_finite() && *frequency_hz > 0.0
        }
        fullmag_ir::EigenTargetIR::Lowest => false,
    }
}

pub(super) fn native_shared_domain_cpu_modal_supported(plan: &FemEigenPlanIR) -> bool {
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
    if super::eigen_policy::open_airbox_k0_modal_requested(plan) {
        return pa_e4b_airbox_size_m(plan).is_ok();
    }
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
    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
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
        if !native_cpu_modal_floquet_target_supported(&plan.target) {
            return Some("production_cpu_modal_unsupported_floquet_target");
        }
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
