use super::eigen_reduction::is_gamma_k_sampling;
use crate::native_fem;
use crate::types::RunError;
use fullmag_engine::fem::MeshTopology;
use fullmag_ir::{
    EigenDampingPolicyIR, EquilibriumSourceIR, FemEigenPlanIR, KSamplingIR,
    SpinWaveBoundaryConditionIR, SpinWaveBoundaryKindIR,
};

pub(super) fn native_modal_equilibrium_source_kind(
    equilibrium: &EquilibriumSourceIR,
) -> &'static str {
    match equilibrium {
        EquilibriumSourceIR::Provided => "provided",
        EquilibriumSourceIR::RelaxedInitialState => "relax",
        EquilibriumSourceIR::Artifact { .. } => "artifact",
    }
}

pub(super) fn native_modal_spin_wave_bc_kind(
    spin_wave_bc: &SpinWaveBoundaryConditionIR,
) -> &'static str {
    match spin_wave_bc.kind() {
        SpinWaveBoundaryKindIR::Free => "free",
        SpinWaveBoundaryKindIR::Pinned => "pinned",
        SpinWaveBoundaryKindIR::Periodic => "periodic",
        SpinWaveBoundaryKindIR::Floquet => "floquet",
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => "surface_anisotropy",
    }
}

pub(super) fn native_modal_damping_policy(damping_policy: EigenDampingPolicyIR) -> &'static str {
    match damping_policy {
        EigenDampingPolicyIR::Ignore => "ignore",
        EigenDampingPolicyIR::Include => "include",
    }
}

pub(super) fn native_modal_target_kind(target: &fullmag_ir::EigenTargetIR) -> &'static str {
    match target {
        fullmag_ir::EigenTargetIR::Lowest => "lowest",
        fullmag_ir::EigenTargetIR::Nearest { .. } => "nearest_frequency",
        fullmag_ir::EigenTargetIR::FrequencyWindow { .. } => "frequency_window",
    }
}

pub(super) fn native_modal_target_frequency_hz(target: &fullmag_ir::EigenTargetIR) -> f64 {
    match target {
        fullmag_ir::EigenTargetIR::Lowest => 0.0,
        fullmag_ir::EigenTargetIR::Nearest { frequency_hz } => *frequency_hz,
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz,
            frequency_max_hz,
        } => frequency_min_hz + 0.5 * (frequency_max_hz - frequency_min_hz),
    }
}

pub(super) fn native_modal_frequency_min_hz(target: &fullmag_ir::EigenTargetIR) -> f64 {
    match target {
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_min_hz, ..
        } => *frequency_min_hz,
        _ => 0.0,
    }
}

pub(super) fn native_modal_frequency_max_hz(target: &fullmag_ir::EigenTargetIR) -> f64 {
    match target {
        fullmag_ir::EigenTargetIR::FrequencyWindow {
            frequency_max_hz, ..
        } => *frequency_max_hz,
        _ => 0.0,
    }
}

pub(super) fn native_modal_k_vector(k_sampling: Option<&KSamplingIR>) -> Option<&[f64]> {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => Some(&k_vector[..]),
        _ => None,
    }
}

pub(super) fn native_modal_floquet_periodic_pairs<'a>(
    plan: &'a FemEigenPlanIR,
    topology: &'a MeshTopology,
) -> Result<Vec<native_fem::NativeModalEigenFloquetPeriodicPair<'a>>, RunError> {
    if !matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        return Ok(Vec::new());
    }
    let Some(KSamplingIR::Single { k_vector }) = plan.k_sampling.as_ref() else {
        return Ok(Vec::new());
    };
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    let mut pairs = Vec::new();
    for (pair_id, node_a, node_b) in &topology.periodic_node_pairs {
        if !requested_pair_ids.is_empty()
            && !requested_pair_ids
                .iter()
                .any(|requested| requested == pair_id)
        {
            continue;
        }
        let translation_m = topology
            .periodic_boundary_pairs
            .iter()
            .find(|(boundary_pair_id, _)| boundary_pair_id == pair_id)
            .and_then(|(_, translation)| *translation)
            .ok_or_else(|| RunError {
                message: format!(
                    "Floquet modal periodic pair '{pair_id}' requires mesh.periodic_boundary_pairs translation metadata"
                ),
            })?;
        let phase_rad = match plan.spin_wave_bc.phase_convention() {
            fullmag_ir::PhaseConventionIR::ExpMinusIKDotDeltaR => {
                -(k_vector[0] * translation_m[0]
                    + k_vector[1] * translation_m[1]
                    + k_vector[2] * translation_m[2])
            }
        };
        pairs.push(native_fem::NativeModalEigenFloquetPeriodicPair {
            pair_id: Some(pair_id.as_str()),
            node_a: u64::from(*node_a),
            node_b: u64::from(*node_b),
            translation_m: Some(translation_m),
            phase_rad: Some(phase_rad),
        });
    }
    Ok(pairs)
}

pub(super) fn shared_domain_k0_modal_requested(plan: &FemEigenPlanIR) -> bool {
    plan.enable_demag
        && plan.operator.include_demag
        && (matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2)
            || k0_kittel_periodic_airbox_validation_requested(plan))
        && matches!(plan.damping_policy, EigenDampingPolicyIR::Ignore)
        && (matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Periodic)
            || k0_kittel_periodic_airbox_validation_requested(plan))
        && (is_gamma_k_sampling(plan.k_sampling.as_ref())
            || k0_kittel_periodic_airbox_validation_requested(plan))
        && (plan.air_box_config.is_some() || k0_kittel_periodic_airbox_validation_requested(plan))
}

pub(super) fn native_cpu_modal_window_has_bloch_floquet_payload_path(
    plan: &FemEigenPlanIR,
) -> bool {
    if plan.operator.include_demag
        || !matches!(
            plan.spin_wave_bc.kind(),
            fullmag_ir::SpinWaveBoundaryKindIR::Floquet
        )
        || !matches!(
            plan.k_sampling.as_ref(),
            Some(fullmag_ir::KSamplingIR::Single { .. })
                | Some(fullmag_ir::KSamplingIR::Path { .. })
        )
    {
        return false;
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    if requested_pair_ids.is_empty() {
        return false;
    }
    requested_pair_ids.iter().any(|pair_id| {
        let has_nodes = plan
            .mesh
            .periodic_node_pairs
            .iter()
            .any(|pair| pair.pair_id == *pair_id);
        let has_translation = plan
            .mesh
            .periodic_boundary_pairs
            .iter()
            .any(|pair| pair.pair_id == *pair_id && pair.translation.is_some());
        has_nodes && has_translation
    })
}

pub(super) fn k0_kittel_periodic_airbox_validation_requested(plan: &FemEigenPlanIR) -> bool {
    plan.k0_kittel_validation
        .as_ref()
        .is_some_and(|validation| {
            validation.kind == "k0_kittel_field_sweep"
                && validation.case_id.as_deref() == Some("K0-3")
                && validation.demag_kind.as_deref() == Some("periodic_airbox_k0")
        })
}

pub(super) fn k_sampling_is_single_k0(k_sampling: Option<&KSamplingIR>) -> bool {
    let Some(KSamplingIR::Single { k_vector }) = k_sampling else {
        return false;
    };
    k_vector
        .iter()
        .all(|component| component.is_finite() && component.abs() <= 1.0e-12)
}

pub(super) fn resolved_demag_realization(
    plan: &FemEigenPlanIR,
) -> Option<fullmag_ir::ResolvedFemDemagIR> {
    if !plan.enable_demag {
        return None;
    }
    Some(
        plan.demag_realization
            .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin),
    )
}
