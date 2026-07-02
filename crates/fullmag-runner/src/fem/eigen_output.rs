use fullmag_engine::Vector3;
use fullmag_ir::{
    EigenDampingPolicyIR, EigenNormalizationIR, EquilibriumSourceIR, FemEigenPlanIR, KSamplingIR,
    OutputIR, SpinWaveBoundaryConditionIR, SpinWaveBoundaryKindIR,
};

use crate::types::{AuxiliaryArtifact, RunError};
use crate::ExecutionProvenance;

pub(crate) fn frequency_from_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> f64 {
    angular_frequency_from_eigenvalue(gyromagnetic_ratio, eigenvalue) / (2.0 * std::f64::consts::PI)
}

pub(crate) fn angular_frequency_from_eigenvalue(gyromagnetic_ratio: f64, eigenvalue: f64) -> f64 {
    // gyromagnetic_ratio is mu0*gamma (about 2.211e5 m/(A*s)), eigenvalue is H_eff in A/m.
    gyromagnetic_ratio * eigenvalue.max(0.0)
}

pub(crate) fn angular_frequency_from_raw_eigenvalue(
    gyromagnetic_ratio: f64,
    eigenvalue: f64,
) -> f64 {
    gyromagnetic_ratio * eigenvalue
}

pub(crate) fn requested_mode_indices(outputs: &[OutputIR]) -> std::collections::BTreeSet<u32> {
    outputs
        .iter()
        .filter_map(|output| {
            if let OutputIR::EigenMode { indices, .. } = output {
                Some(indices.iter().copied())
            } else {
                None
            }
        })
        .flatten()
        .collect()
}

pub(crate) fn json_artifact(
    path: impl Into<String>,
    value: &serde_json::Value,
) -> Result<AuxiliaryArtifact, RunError> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| RunError {
        message: format!("failed to serialize eigen artifact: {}", error),
    })?;
    Ok(AuxiliaryArtifact {
        relative_path: path.into(),
        bytes,
    })
}

pub(crate) fn normalization_label(normalization: EigenNormalizationIR) -> &'static str {
    match normalization {
        EigenNormalizationIR::UnitL2 => "unit_l2",
        EigenNormalizationIR::UnitMaxAmplitude => "unit_max_amplitude",
    }
}

pub(crate) fn damping_policy_label(policy: EigenDampingPolicyIR) -> &'static str {
    match policy {
        EigenDampingPolicyIR::Ignore => "ignore",
        EigenDampingPolicyIR::Include => "include",
    }
}

pub(crate) fn damping_imaginary_factor(damping: f64, policy: EigenDampingPolicyIR) -> f64 {
    match policy {
        EigenDampingPolicyIR::Ignore => 0.0,
        EigenDampingPolicyIR::Include => -(damping.abs() / (1.0 + damping * damping)),
    }
}

pub(crate) fn spin_wave_bc_label(bc: SpinWaveBoundaryConditionIR) -> &'static str {
    match bc.kind() {
        SpinWaveBoundaryKindIR::Free => "free",
        SpinWaveBoundaryKindIR::Pinned => "pinned",
        SpinWaveBoundaryKindIR::Periodic => "periodic",
        SpinWaveBoundaryKindIR::Floquet => "floquet",
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => "surface_anisotropy",
    }
}

pub(crate) fn spin_wave_bc_json(bc: &SpinWaveBoundaryConditionIR) -> serde_json::Value {
    serde_json::json!({
        "kind": spin_wave_bc_label(bc.clone()),
        "boundary_pair_id": bc.boundary_pair_id(),
        "pair_ids": bc.boundary_pair_ids(),
        "phase_convention": bc.phase_convention(),
        "surface_anisotropy_ks": bc.surface_anisotropy_ks(),
        "surface_anisotropy_axis": bc.surface_anisotropy_axis(),
    })
}

pub(crate) fn solver_kind_label(plan: &FemEigenPlanIR) -> &'static str {
    if matches!(plan.spin_wave_bc.kind(), SpinWaveBoundaryKindIR::Floquet) {
        "cpu_phase_reduced_floquet"
    } else {
        match (plan.operator.kind, plan.damping_policy) {
            (fullmag_ir::EigenOperatorIR::Full2x2, EigenDampingPolicyIR::Ignore) => {
                "cpu_full_2x2_symmetric"
            }
            (fullmag_ir::EigenOperatorIR::Full2x2, EigenDampingPolicyIR::Include) => {
                "cpu_full_2x2_damped"
            }
            (_, EigenDampingPolicyIR::Ignore) => "cpu_reference_symmetric",
            (_, EigenDampingPolicyIR::Include) => "cpu_generalized_eigen",
        }
    }
}

pub(crate) fn solver_notes(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> &'static str {
    if complex_reduction {
        "phase-aware periodic reduction on a real doubled Hermitian block"
    } else if use_sparse && matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "sparse LOBPCG on full 2×2 Herring-Kittel block operator (2N DOF)"
    } else if use_sparse {
        "sparse LOBPCG iterative eigensolver for large DOF systems"
    } else if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        "full 2×2 Herring-Kittel block operator in tangent plane (2N DOF)"
    } else if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        "damping artifacts use first-order alpha linewidth correction over the CPU reference eigenbasis"
    } else {
        "cpu reference symmetric eigen solve"
    }
}

pub(crate) fn solver_capabilities(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> Vec<&'static str> {
    let mut capabilities = vec!["cpu_reference_eigen", "artifact_backed_analyze"];
    if use_sparse {
        capabilities.push("sparse_lobpcg");
    }
    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        capabilities.push("full_2x2_herring_kittel");
    }
    match plan.spin_wave_bc.kind() {
        SpinWaveBoundaryKindIR::Free => capabilities.push("free_bc"),
        SpinWaveBoundaryKindIR::Pinned => capabilities.push("pinned_bc"),
        SpinWaveBoundaryKindIR::Periodic => capabilities.push("periodic_zero_phase"),
        SpinWaveBoundaryKindIR::Floquet => capabilities.push("floquet_phase_reduction"),
        SpinWaveBoundaryKindIR::SurfaceAnisotropy => {
            capabilities.push("surface_anisotropy_boundary_term")
        }
    }
    if plan.enable_exchange {
        capabilities.push("exchange");
    }
    if plan.enable_demag {
        match resolved_demag_realization(plan)
            .unwrap_or(fullmag_ir::ResolvedFemDemagIR::PoissonRobin)
        {
            fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet => {
                capabilities.push("demag_poisson_dirichlet")
            }
            fullmag_ir::ResolvedFemDemagIR::PoissonRobin => {
                capabilities.push("demag_poisson_robin")
            }
            fullmag_ir::ResolvedFemDemagIR::Bem => capabilities.push("demag_bem"),
            fullmag_ir::ResolvedFemDemagIR::FredkinKoehler => {
                capabilities.push("demag_fredkin_koehler")
            }
            fullmag_ir::ResolvedFemDemagIR::Fmm => capabilities.push("demag_fmm"),
        }
    }
    if plan.external_field.is_some() {
        capabilities.push("zeeman");
    }
    if plan.interfacial_dmi.is_some() {
        capabilities.push("interfacial_dmi");
    }
    if plan.bulk_dmi.is_some() {
        capabilities.push("bulk_dmi");
    }
    if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        capabilities.push("damping_linewidth_metadata");
    }
    if complex_reduction {
        capabilities.push("complex_mode_projection");
    }
    capabilities
}

pub(crate) fn solver_limitations(
    plan: &FemEigenPlanIR,
    complex_reduction: bool,
    use_sparse: bool,
) -> Vec<&'static str> {
    let mut limitations = Vec::new();
    if use_sparse {
        limitations.push("sparse_lobpcg_may_miss_modes_near_degeneracy");
    }
    if !matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        limitations.push("scalar_projection_only_accurate_for_uniform_equilibrium");
    }
    if matches!(plan.damping_policy, EigenDampingPolicyIR::Include) {
        limitations.push("no_generalized_qz_backend");
        limitations.push("damping_is_first_order_linewidth_correction");
    }
    if complex_reduction {
        limitations.push("floquet_uses_phase_reduced_hermitian_block");
    }
    if plan.interfacial_dmi.is_some() || plan.bulk_dmi.is_some() {
        limitations.push("dmi_operator_is_cpu_first_reference_approximation");
    }
    if matches!(
        plan.spin_wave_bc.kind(),
        SpinWaveBoundaryKindIR::SurfaceAnisotropy
    ) {
        limitations.push("surface_anisotropy_requires_exposed_boundary_faces");
    }
    limitations
}

pub(crate) fn resolved_demag_realization(
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

fn demag_realization_label(realization: fullmag_ir::ResolvedFemDemagIR) -> &'static str {
    realization.provenance_name()
}

pub(crate) fn execution_provenance(plan: &FemEigenPlanIR, used_gpu: bool) -> ExecutionProvenance {
    let engine = if used_gpu {
        format!("gpu_cusolver_fem_eigen/{}", solver_kind_label(plan))
    } else {
        format!("cpu_baseline_fem_eigen/{}", solver_kind_label(plan))
    };
    let resolved_demag = resolved_demag_realization(plan);
    ExecutionProvenance {
        execution_engine: engine,
        precision: "double".to_string(),
        demag_operator_kind: resolved_demag.map(|r| r.provenance_name().to_string()),
        requested_demag_realization: if plan.enable_demag {
            plan.demag_realization
                .map(|requested| demag_realization_label(requested).to_string())
        } else {
            None
        },
        resolved_demag_realization: resolved_demag
            .map(|resolved| demag_realization_label(resolved).to_string()),
        fft_backend: None,
        device_name: None,
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
        ..Default::default()
    }
}

pub(crate) fn equilibrium_source_json(equilibrium: &EquilibriumSourceIR) -> serde_json::Value {
    match equilibrium {
        EquilibriumSourceIR::Provided => serde_json::json!({ "kind": "provided" }),
        EquilibriumSourceIR::RelaxedInitialState => {
            serde_json::json!({ "kind": "relaxed_initial_state" })
        }
        EquilibriumSourceIR::Artifact { path } => {
            serde_json::json!({ "kind": "artifact", "path": path })
        }
    }
}

pub(crate) fn k_vector_json(k_sampling: Option<&KSamplingIR>) -> serde_json::Value {
    match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => serde_json::json!(k_vector),
        Some(KSamplingIR::Path { .. }) => serde_json::json!([0.0, 0.0, 0.0]),
        None => serde_json::Value::Null,
    }
}

pub(crate) fn dispersion_csv(
    k_sampling: Option<&KSamplingIR>,
    modes: &serde_json::Value,
) -> String {
    let k_vector = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let mut csv = String::from("mode_index,kx,ky,kz,frequency_hz,angular_frequency_rad_per_s\n");
    if let Some(entries) = modes.as_array() {
        for entry in entries {
            csv.push_str(&format!(
                "{},{:.15e},{:.15e},{:.15e},{:.15e},{:.15e}\n",
                entry["index"].as_u64().unwrap_or(0),
                k_vector[0],
                k_vector[1],
                k_vector[2],
                entry["frequency_hz"].as_f64().unwrap_or(0.0),
                entry["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
            ));
        }
    }
    csv
}

pub(crate) fn dispersion_v2_csv(
    k_sampling: Option<&KSamplingIR>,
    modes: &serde_json::Value,
) -> String {
    let k_vector = match k_sampling {
        Some(KSamplingIR::Single { k_vector }) => *k_vector,
        Some(KSamplingIR::Path { .. }) => [0.0, 0.0, 0.0],
        None => [0.0, 0.0, 0.0],
    };
    let label = if k_vector.iter().all(|value| *value == 0.0) {
        "Γ"
    } else {
        ""
    };
    let mut csv = String::from(
        "sample_index,path_s_rad_per_m,kx_rad_per_m,ky_rad_per_m,kz_rad_per_m,label,raw_mode_index,branch_id,frequency_hz,omega_rad_s,line_width_hz,residual_norm,overlap_score\n",
    );
    if let Some(entries) = modes.as_array() {
        for entry in entries {
            let residual_norm = entry["residual_norm"]
                .as_f64()
                .map(|value| format!("{value:.16e}"))
                .unwrap_or_default();
            csv.push_str(&format!(
                "0,{:.16e},{:.16e},{:.16e},{:.16e},{},{},{},{:.16e},{:.16e},{},{},{}\n",
                0.0,
                k_vector[0],
                k_vector[1],
                k_vector[2],
                label,
                entry["index"].as_u64().unwrap_or(0),
                "",
                entry["frequency_hz"].as_f64().unwrap_or(0.0),
                entry["angular_frequency_rad_per_s"].as_f64().unwrap_or(0.0),
                "",
                residual_norm,
                "",
            ));
        }
    }
    csv
}

pub(crate) fn dot(a: Vector3, b: Vector3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn cross(a: Vector3, b: Vector3) -> Vector3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

pub(crate) fn norm(a: Vector3) -> f64 {
    dot(a, a).sqrt()
}

pub(crate) fn normalize_vector(a: Vector3) -> Vector3 {
    let magnitude = norm(a);
    if magnitude <= 1e-30 {
        [1.0, 0.0, 0.0]
    } else {
        scale_vector(a, 1.0 / magnitude)
    }
}

pub(crate) fn scale_vector(a: Vector3, factor: f64) -> Vector3 {
    [a[0] * factor, a[1] * factor, a[2] * factor]
}

pub(crate) fn add_vector(a: Vector3, b: Vector3) -> Vector3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub(crate) fn classify_polarization(
    amplitude: &[f64],
    active_nodes: &[usize],
    equilibrium: &[Vector3],
    max_amplitude: f64,
) -> &'static str {
    if active_nodes.is_empty() || max_amplitude < 1e-30 {
        return "mixed";
    }

    let n = active_nodes.len() as f64;
    let mean_amplitude: f64 = active_nodes.iter().map(|&i| amplitude[i]).sum::<f64>() / n;
    if mean_amplitude / max_amplitude > 0.6 {
        return "uniform";
    }

    let mean_mz_abs: f64 = if equilibrium.len() > *active_nodes.iter().max().unwrap_or(&0) {
        active_nodes
            .iter()
            .map(|&i| equilibrium[i][2].abs())
            .sum::<f64>()
            / n
    } else {
        0.0
    };

    if mean_mz_abs > 0.7 {
        "op"
    } else {
        "ip"
    }
}
