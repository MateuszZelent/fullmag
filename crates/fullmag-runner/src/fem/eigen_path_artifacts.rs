//! Private FEM eigen-path artifacts helpers.

use super::*;

pub(super) fn eigen_path_mode_artifacts_from_result(
    path_result: &crate::eigen::PathSolveResult,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    let temp_dir = std::env::temp_dir().join(format!(
        "fullmag-eigen-path-mode-artifacts-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&temp_dir).map_err(|error| RunError {
        message: format!("failed to create temporary eigen mode artifact directory: {error}"),
    })?;
    let write_result = crate::eigen::artifacts::write_mode_bundle(&temp_dir, path_result);
    let collect_result = write_result
        .map_err(|error| RunError {
            message: format!("failed to write analytic eigen mode bundle: {error}"),
        })
        .and_then(|_| collect_auxiliary_artifacts_from_dir(&temp_dir, &temp_dir));
    let _ = std::fs::remove_dir_all(&temp_dir);
    collect_result
}

fn collect_auxiliary_artifacts_from_dir(
    root: &std::path::Path,
    dir: &std::path::Path,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    let mut artifacts = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|error| RunError {
        message: format!("failed to read temporary eigen mode artifact directory: {error}"),
    })? {
        let entry = entry.map_err(|error| RunError {
            message: format!("failed to read temporary eigen mode artifact entry: {error}"),
        })?;
        let path = entry.path();
        if path.is_dir() {
            artifacts.extend(collect_auxiliary_artifacts_from_dir(root, &path)?);
            continue;
        }
        let relative_path = path
            .strip_prefix(root)
            .map_err(|error| RunError {
                message: format!("failed to relativize temporary eigen mode artifact: {error}"),
            })?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = std::fs::read(&path).map_err(|error| RunError {
            message: format!(
                "failed to read temporary eigen mode artifact {relative_path}: {error}"
            ),
        })?;
        artifacts.push(AuxiliaryArtifact {
            relative_path,
            bytes,
        });
    }
    Ok(artifacts)
}

pub(super) fn eigen_path_mode_for_branch_point<'a>(
    path_result: &'a crate::eigen::PathSolveResult,
    point: &crate::eigen::TrackedBranchPoint,
) -> Option<&'a crate::eigen::SingleKModeResult> {
    path_result
        .samples
        .iter()
        .find(|sample| sample.sample.sample_index == point.sample_index)
        .and_then(|sample| {
            sample
                .modes
                .iter()
                .find(|mode| mode.raw_mode_index == point.raw_mode_index)
        })
}

pub(super) fn median_f64(values: &[f64]) -> Option<f64> {
    let mut finite = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .collect::<Vec<_>>();
    if finite.is_empty() {
        return None;
    }
    finite.sort_by(|lhs, rhs| lhs.total_cmp(rhs));
    let mid = finite.len() / 2;
    if finite.len() % 2 == 0 {
        Some((finite[mid - 1] + finite[mid]) / 2.0)
    } else {
        Some(finite[mid])
    }
}

pub(super) fn eigen_path_requested_mode_indices(outputs: &[OutputIR]) -> BTreeSet<u32> {
    outputs
        .iter()
        .filter_map(|output| match output {
            OutputIR::EigenMode { indices, .. } => Some(indices),
            _ => None,
        })
        .flat_map(|indices| indices.iter().copied())
        .collect()
}

pub(super) fn eigen_path_wants_dispersion(outputs: &[OutputIR]) -> bool {
    outputs
        .iter()
        .any(|output| matches!(output, OutputIR::DispersionCurve { .. }))
}

pub(super) fn eigen_path_public_mode_indices(
    outputs: &[OutputIR],
    mode_count: u32,
) -> BTreeSet<u32> {
    let requested_modes = eigen_path_requested_mode_indices(outputs);
    let wants_spectrum = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }));
    if wants_spectrum || eigen_path_wants_dispersion(outputs) {
        return (0..mode_count).collect();
    }
    requested_modes
}

pub(super) fn eigen_path_mode_artifact_indices(outputs: &[OutputIR]) -> BTreeSet<u32> {
    eigen_path_requested_mode_indices(outputs)
}

pub(super) fn eigen_path_single_k_solver_model(
    plan: &FemEigenPlanIR,
    artifacts: &[crate::types::AuxiliaryArtifact],
) -> crate::eigen::EigenSolverModel {
    for artifact in artifacts {
        if artifact.relative_path != "eigen/metadata/eigen_summary.json" {
            continue;
        }
        let Ok(summary) = serde_json::from_slice::<serde_json::Value>(&artifact.bytes) else {
            continue;
        };
        let diagnostics = summary.get("solver_diagnostics");
        let production_solver_available = diagnostics
            .and_then(|value| value.get("production_solver_available"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let execution_lane = diagnostics
            .and_then(|value| value.get("execution_lane"))
            .and_then(|value| value.as_str());
        let solver_model = diagnostics
            .and_then(|value| value.get("solver_model"))
            .or_else(|| summary.get("solver_kind"))
            .and_then(|value| value.as_str());
        let solver_adapter = diagnostics
            .and_then(|value| value.get("solver_adapter"))
            .and_then(|value| value.as_str());
        let spectral_transform = diagnostics
            .and_then(|value| value.get("spectral_transform"))
            .and_then(|value| value.as_str());
        if production_solver_available
            && execution_lane == Some("production_cpu")
            && (solver_model == Some("slepc_multi_shift_invert_production_cpu_dense")
                || solver_adapter == Some("k0_poisson_airbox_cpu_full_coupled_slepc")
                || solver_adapter == Some("k0_poisson_airbox_cpu_schur_slepc"))
            && spectral_transform == Some("shift_invert")
        {
            if matches!(
                plan.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Floquet
            ) && !eigen_path_single_k_has_bloch_floquet_contract(diagnostics)
            {
                return crate::eigen::EigenSolverModel::ReferenceFull2x2Tangent;
            }
            return crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
        }
        if production_solver_available
            && execution_lane == Some("production_gpu")
            && solver_model == Some("gpu_dense_k0_macrospin_modal_eigen")
        {
            return crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin;
        }
        if production_solver_available
            && execution_lane == Some("production_gpu")
            && (solver_model == Some("k0_poisson_airbox_gpu_petsc_slepc")
                || solver_model == Some("k0_poisson_airbox_gpu_modal_device_krylov")
                || solver_adapter == Some("k0_poisson_airbox_gpu_petsc_slepc")
                || solver_adapter == Some("k0_poisson_airbox_gpu_modal_device_krylov"))
            && diagnostics.is_some_and(eigen_path_gpu_modal_device_contract)
        {
            return crate::eigen::EigenSolverModel::ProductionGpuModalDeviceKrylov;
        }
    }

    if matches!(plan.operator.kind, fullmag_ir::EigenOperatorIR::Full2x2) {
        crate::eigen::EigenSolverModel::ReferenceFull2x2Tangent
    } else {
        crate::eigen::EigenSolverModel::ReferenceScalarTangent
    }
}

pub(super) fn eigen_path_gpu_modal_device_contract(diagnostics: &serde_json::Value) -> bool {
    let has_contract = |sample: &serde_json::Value| {
        sample.get("gpu_device_resident_modal_eigensolver") == Some(&serde_json::json!(true))
            && sample.get("persistent_solver_context") == Some(&serde_json::json!(true))
            && sample.get("scalable_selected_spectrum") == Some(&serde_json::json!(true))
            // A bounded validation adapter may still use CUDA vectors and a
            // matrix-free action, but it is not a production capability.
            // Keep the explicit provenance flags fail-closed at this final
            // promotion boundary.
            && sample.get("validation_only") != Some(&serde_json::json!(true))
            && sample.get("production_implication") != Some(&serde_json::json!(false))
            // A host-projected Hessenberg/Ritz state is a valid bounded
            // diagnostic lane, but it is not the production device-resident
            // modal contract.  Reject it even when the older three boolean
            // markers are present for compatibility.
            && sample
                .get("host_ritz_extraction")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
    };
    if has_contract(diagnostics) {
        return true;
    }
    diagnostics
        .get("sample_solver_diagnostics")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|samples| {
            !samples.is_empty()
                && samples
                    .iter()
                    .all(|sample| sample.get("diagnostics").is_some_and(has_contract))
        })
}

pub(super) fn eigen_path_single_k_has_bloch_floquet_contract(
    diagnostics: Option<&serde_json::Value>,
) -> bool {
    diagnostics
        .and_then(|value| value.get("operator_diagnostics"))
        .and_then(|value| value.get("payload_kind"))
        .and_then(|value| value.as_str())
        == Some("bloch_floquet_tangent_operator")
        && diagnostics
            .and_then(|value| value.get("modal_periodic_pair_contract_available"))
            .and_then(|value| value.as_bool())
            == Some(true)
        && diagnostics
            .and_then(|value| value.get("floquet_periodic_pair_count"))
            .and_then(|value| value.as_u64())
            .is_some_and(|count| count > 0)
        && diagnostics
            .and_then(|value| value.get("operator_diagnostics"))
            .and_then(|value| value.get("demag_payload_kind"))
            .is_none()
        && !eigen_path_operator_diagnostics_has_gated_terms(diagnostics)
}

pub(super) fn eigen_path_operator_diagnostics_has_gated_terms(
    diagnostics: Option<&serde_json::Value>,
) -> bool {
    diagnostics
        .and_then(|value| value.get("operator_diagnostics"))
        .and_then(|value| value.get("operator_terms_included"))
        .and_then(|value| value.as_array())
        .is_some_and(|terms| {
            terms.iter().any(|term| {
                matches!(
                    term.as_str(),
                    Some(
                        "demag"
                            | "dynamic_demag"
                            | "periodic_poisson"
                            | "floquet_airbox"
                            | "dmi"
                            | "interfacial_dmi"
                            | "bulk_dmi"
                            | "magnetoelastic"
                    )
                )
            })
        })
}

pub(super) fn eigen_path_tracking_outputs(outputs: &[OutputIR], mode_count: u32) -> Vec<OutputIR> {
    let mut tracking_outputs = outputs.to_vec();
    if !tracking_outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }))
    {
        tracking_outputs.push(OutputIR::EigenSpectrum {
            quantity: "eigenfrequency".to_string(),
        });
    }

    let requested_modes = eigen_path_requested_mode_indices(outputs);
    let missing_tracking_modes = (0..mode_count)
        .filter(|index| !requested_modes.contains(index))
        .collect::<Vec<_>>();
    if !missing_tracking_modes.is_empty() {
        tracking_outputs.push(OutputIR::EigenMode {
            field: "mode".to_string(),
            indices: missing_tracking_modes,
        });
    }
    tracking_outputs
}

pub(super) fn eigen_path_mode_tracking_vector(
    artifacts: &[crate::types::AuxiliaryArtifact],
    raw_mode_index: usize,
) -> Option<Vec<num_complex::Complex64>> {
    let legacy_path = format!("eigen/modes/mode_{raw_mode_index:04}.json");
    let mode = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == legacy_path)
        .and_then(|artifact| serde_json::from_slice::<serde_json::Value>(&artifact.bytes).ok())?;
    let real = eigen_path_mode_vector_entries(&mode, "real");
    let imag = eigen_path_mode_vector_entries(&mode, "imag");
    let sample_count = real.len().max(imag.len());
    if sample_count == 0 {
        return None;
    }

    let mut vector = Vec::with_capacity(sample_count * 3);
    for index in 0..sample_count {
        let real_sample = real.get(index).copied().unwrap_or([0.0, 0.0, 0.0]);
        let imag_sample = imag.get(index).copied().unwrap_or([0.0, 0.0, 0.0]);
        for component in 0..3 {
            vector.push(num_complex::Complex64::new(
                real_sample[component],
                imag_sample[component],
            ));
        }
    }
    Some(vector)
}

pub(super) fn eigen_path_mode_vector_entries(
    value: &serde_json::Value,
    field: &str,
) -> Vec<[f64; 3]> {
    value
        .get(field)
        .and_then(|field_value| field_value.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let components = entry.as_array()?;
                    Some([
                        components
                            .first()
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        components
                            .get(1)
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                        components
                            .get(2)
                            .and_then(|value| value.as_f64())
                            .unwrap_or(0.0),
                    ])
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn eigen_path_branch_point_for_mode<'a>(
    path_result: &'a crate::eigen::PathSolveResult,
    sample_index: usize,
    raw_mode_index: usize,
) -> Option<(
    &'a crate::eigen::TrackedBranch,
    usize,
    &'a crate::eigen::TrackedBranchPoint,
)> {
    path_result.branches.iter().find_map(|branch| {
        branch
            .points
            .iter()
            .enumerate()
            .find(|(_, point)| {
                point.sample_index == sample_index && point.raw_mode_index == raw_mode_index
            })
            .map(|(point_index, point)| (branch, point_index, point))
    })
}

pub(super) fn eigen_path_branch_point_modal_overlap_available(
    path_result: &crate::eigen::PathSolveResult,
    branch: &crate::eigen::TrackedBranch,
    point_index: usize,
) -> bool {
    if point_index == 0 {
        return false;
    }
    let Some(previous_point) = branch.points.get(point_index - 1) else {
        return false;
    };
    let Some(current_point) = branch.points.get(point_index) else {
        return false;
    };
    let previous_vector = eigen_path_mode_for_branch_point(path_result, previous_point)
        .and_then(|mode| mode.reduced_vector.as_ref());
    let current_vector = eigen_path_mode_for_branch_point(path_result, current_point)
        .and_then(|mode| mode.reduced_vector.as_ref());
    match (previous_vector, current_vector) {
        (Some(previous), Some(current)) => !previous.is_empty() && previous.len() == current.len(),
        _ => false,
    }
}

pub(super) fn eigen_path_branch_point_tracking_score_source(
    path_result: &crate::eigen::PathSolveResult,
    branch: &crate::eigen::TrackedBranch,
    point_index: usize,
) -> &'static str {
    let Some(point) = branch.points.get(point_index) else {
        return "unknown";
    };
    if point.overlap_prev.is_none() {
        return "seed";
    }
    if eigen_path_branch_point_modal_overlap_available(path_result, branch, point_index) {
        "modal_overlap_weighted_score"
    } else {
        "frequency_score_fallback"
    }
}

pub(super) fn eigen_path_tracking_score_summary(
    path_result: &crate::eigen::PathSolveResult,
) -> (&'static str, bool) {
    let mut saw_modal_overlap = false;
    let mut saw_frequency_fallback = false;
    for branch in &path_result.branches {
        for point_index in 0..branch.points.len() {
            match eigen_path_branch_point_tracking_score_source(path_result, branch, point_index) {
                "modal_overlap_weighted_score" => saw_modal_overlap = true,
                "frequency_score_fallback" => saw_frequency_fallback = true,
                _ => {}
            }
        }
    }
    let source = match (saw_modal_overlap, saw_frequency_fallback) {
        (true, true) => "mixed_modal_overlap_and_frequency_fallback",
        (true, false) => "modal_overlap_weighted_score",
        (false, true) => "frequency_score_fallback",
        (false, false) => "seed_only",
    };
    (source, saw_modal_overlap)
}

pub(super) fn eigen_path_mode_field_id(sample_index: usize, raw_mode_index: usize) -> String {
    format!("analysis:eigen:sample-{sample_index:04}:mode-{raw_mode_index:04}")
}

pub(super) fn eigen_path_mode_field_resource_key(
    sample_index: usize,
    raw_mode_index: usize,
) -> String {
    format!(
        "/v2/sessions/current/data/fields/{}/samples/vector?view=phase_rotated_real&phase_rad=0",
        eigen_path_mode_field_id(sample_index, raw_mode_index)
    )
}

pub(super) fn eigen_path_line_width_hz(frequency_imag_hz: f64) -> Option<String> {
    if !frequency_imag_hz.is_finite() || frequency_imag_hz <= 0.0 {
        return None;
    }
    Some(format!("{:.16e}", 2.0 * frequency_imag_hz))
}

pub(super) struct EigenPathDeBvAnalyticCsvColumns {
    pub(super) analytic_frequency_hz: String,
    pub(super) relative_error: String,
    pub(super) geometry: String,
}

pub(super) fn eigen_path_de_bv_analytic_csv_columns(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
    mode: &crate::eigen::SingleKModeResult,
) -> EigenPathDeBvAnalyticCsvColumns {
    let Some(validation) = plan.dispersion_validation.as_ref() else {
        return EigenPathDeBvAnalyticCsvColumns {
            analytic_frequency_hz: String::new(),
            relative_error: String::new(),
            geometry: String::new(),
        };
    };
    if validation.kind != "thin_film_de_bv_low_k"
        || validation.analytic_model != "kalinikos_slab_n0"
    {
        return EigenPathDeBvAnalyticCsvColumns {
            analytic_frequency_hz: String::new(),
            relative_error: String::new(),
            geometry: String::new(),
        };
    }

    let geometry = de_bv_validation_geometry_for_sample(validation, sample.sample_index)
        .or_else(|| de_bv_geometry_for_k(sample.k_vector, validation).ok())
        .unwrap_or(mode.dominant_polarization.as_str());
    let analytic_frequency_hz = kalinikos_slab_n0_frequency_hz(
        vector_norm(sample.k_vector),
        geometry,
        vector_norm(plan.external_field.unwrap_or([0.0, 0.0, 0.0])),
        validation.film_thickness_m,
        plan.material.exchange_stiffness,
        plan.material.saturation_magnetisation,
        plan.gyromagnetic_ratio,
    )
    .ok();
    let relative_error = analytic_frequency_hz
        .map(|analytic| (mode.frequency_real_hz - analytic).abs() / analytic.abs().max(1.0));
    EigenPathDeBvAnalyticCsvColumns {
        analytic_frequency_hz: analytic_frequency_hz
            .map(|value| format!("{value:.16e}"))
            .unwrap_or_default(),
        relative_error: relative_error
            .map(|value| format!("{value:.16e}"))
            .unwrap_or_default(),
        geometry: geometry.to_string(),
    }
}

pub(super) fn de_bv_validation_geometry_for_sample(
    validation: &fullmag_ir::FemEigenDispersionValidationIR,
    sample_index: usize,
) -> Option<&str> {
    let sample_index = u32::try_from(sample_index).ok()?;
    validation.scenarios.iter().find_map(|scenario| {
        if !scenario.sample_indices.contains(&sample_index) {
            return None;
        }
        match scenario.geometry.as_str() {
            "de" | "damon_eshbach" | "damon-eshbach" => Some("damon_eshbach"),
            "bv" | "backward_volume" | "backward-volume" => Some("backward_volume"),
            _ => None,
        }
    })
}

pub(super) fn eigen_path_mode_json(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
    mode: &crate::eigen::SingleKModeResult,
    solver_model: crate::eigen::EigenSolverModel,
    solver_diagnostics: Option<&serde_json::Value>,
) -> serde_json::Value {
    let residual_absolute_l2 = finite_or_default(mode.residual_norm, 0.0);
    let residual_linf = finite_or_default(mode.residual_linf, residual_absolute_l2);
    let tangent_leakage_mean_abs = finite_or_default(mode.tangent_leakage_mean_abs, 0.0);
    let tangent_leakage_max_abs =
        finite_or_default(mode.tangent_leakage_max_abs, tangent_leakage_mean_abs)
            .max(tangent_leakage_mean_abs);
    let tangent_leakage_weighted_relative_l2 =
        finite_or_default(mode.tangent_leakage_weighted_relative_l2, 0.0);
    let gamma0_rad_s_per_a_m = plan.gyromagnetic_ratio;
    let gamma_rad_s_t = gamma0_rad_s_per_a_m / crate::MU0;
    let mass_norm = finite_or_default(
        mode.mass_norm,
        if mode.norm.is_finite() && mode.norm > 0.0 {
            mode.norm
        } else {
            1.0
        },
    );
    let production_shift_invert =
        solver_model == crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
    let production_periodic_airbox_k0 = periodic_airbox_k0_runtime_supported(plan);
    let production_gyrotropic = production_shift_invert
        || production_periodic_airbox_k0
        || solver_model == crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin;
    let provenance_value = |key: &str| {
        solver_diagnostics
            .and_then(|diagnostics| diagnostics.get(key))
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };

    let mut value = serde_json::json!({
        "index": mode.raw_mode_index,
        "raw_mode_index": mode.raw_mode_index,
        "branch_id": mode.branch_id,
        "frequency_hz": mode.frequency_real_hz,
        "frequency_real_hz": mode.frequency_real_hz,
        "frequency_imag_hz": mode.frequency_imag_hz,
        "angular_frequency_rad_per_s": mode.angular_frequency_rad_per_s,
        "omega_rad_s": mode.angular_frequency_rad_per_s,
        "eigenvalue_real": mode.eigenvalue_real,
        "eigenvalue_imag": mode.eigenvalue_imag,
        "phasor_convention": if production_periodic_airbox_k0 { "exp_plus_i_omega_t" } else if production_gyrotropic { "exp_i_omega_t" } else { "not_applicable_real_reference" },
        "eigenvalue_mapping": if production_periodic_airbox_k0 { "lambda_imag_positive_frequency" } else if production_gyrotropic { "lambda_eq_i_omega" } else { "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m" },
        "norm": mode.norm,
        "max_amplitude": mode.max_amplitude,
        "residual_norm": residual_absolute_l2,
        "residual_absolute_l2": residual_absolute_l2,
        "residual_relative_l2": residual_absolute_l2,
        "residual_linf": residual_linf,
        "mass_norm": mass_norm,
        "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
        "tangent_leakage_max_abs": tangent_leakage_max_abs,
        "tangent_leakage_weighted_relative_l2": tangent_leakage_weighted_relative_l2,
        "gamma_rad_s_T": gamma_rad_s_t,
        "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
        "mu0_T_m_per_A": crate::MU0,
        "dominant_polarization": mode.dominant_polarization,
        "k_vector": sample.k_vector,
        "external_field_a_per_m": eigen_path_external_field(plan, sample.sample_index),
        "assembly_kind": provenance_value("assembly_kind"),
        "operator_input_signature_sha256": provenance_value("operator_input_signature_sha256"),
        "phase_constraint_sha256": provenance_value("phase_constraint_sha256"),
        "equilibrium_artifact_sha256": provenance_value("equilibrium_artifact_sha256"),
        "linearization_state_sha256": provenance_value("linearization_state_sha256"),
        "periodic_mesh_certificate_sha256": provenance_value("periodic_mesh_certificate_sha256"),
        "mode_field_id": eigen_path_mode_field_id(
            sample.sample_index,
            mode.raw_mode_index,
        ),
        "mode_field_resource_key": eigen_path_mode_field_resource_key(
            sample.sample_index,
            mode.raw_mode_index,
        ),
    });
    if let Some(weights) = mode.node_mass_weights.as_ref() {
        value["node_mass_weights"] = serde_json::json!(weights);
    }
    value
}

pub(super) fn eigen_path_mode_v3_json(
    plan: &FemEigenPlanIR,
    sample: &crate::eigen::KSampleDescriptor,
    mode: &crate::eigen::SingleKModeResult,
    solver_model: crate::eigen::EigenSolverModel,
    solver_diagnostics: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut value = eigen_path_mode_json(plan, sample, mode, solver_model, solver_diagnostics);
    value["mode_id"] = serde_json::json!(format!(
        "sample-{:04}/mode-{:04}",
        sample.sample_index, mode.raw_mode_index
    ));
    value["component_participation"] = serde_json::to_value(&mode.component_participation)
        .expect("validated modal participation observable must serialize");
    value
}

pub(super) fn eigen_path_external_field(
    plan: &FemEigenPlanIR,
    sample_index: usize,
) -> Option<[f64; 3]> {
    if bias_field_sweep_requested(plan) {
        return plan
            .bias_field_samples
            .iter()
            .find(|sample| sample.sample_index as usize == sample_index)
            .map(|sample| sample.field_a_per_m);
    }
    plan.external_field
}

pub(super) fn eigen_path_node_mass_weights_from_json(
    value: &serde_json::Value,
) -> Option<Vec<f64>> {
    let array = value.as_array()?;
    if array.is_empty() {
        return None;
    }
    let mut weights = Vec::with_capacity(array.len());
    for item in array {
        let weight = item.as_f64()?;
        if !(weight.is_finite() && weight > 0.0) {
            return None;
        }
        weights.push(weight);
    }
    Some(weights)
}

pub(super) fn eigen_path_component_participation_from_json(
    value: Option<&serde_json::Value>,
    solver_device: &str,
) -> Result<crate::eigen::ModalParticipationObservable, crate::types::RunError> {
    let Some(value) = value else {
        return Ok(
            crate::eigen::ModalParticipationObservable::unavailable_without_context(solver_device),
        );
    };
    let observable =
        serde_json::from_value::<crate::eigen::ModalParticipationObservable>(value.clone())
            .map_err(|error| crate::types::RunError {
                message: format!("invalid managed component participation payload: {error}"),
            })?;
    let valid_status_payload = match observable.status {
        crate::eigen::ModalParticipationAvailability::Ready => {
            observable.global.is_some()
                && !observable.objects.is_empty()
                && observable.unavailable.is_none()
        }
        crate::eigen::ModalParticipationAvailability::Unavailable => {
            observable.global.is_none()
                && observable.objects.is_empty()
                && observable.unavailable.is_some()
        }
    };
    if observable.schema_version != "modal_component_participation.v1"
        || observable.definition_id != crate::eigen::MODAL_PARTICIPATION_DEFINITION_ID
        || !valid_status_payload
    {
        return Err(crate::types::RunError {
            message: "invalid managed component participation contract".to_string(),
        });
    }
    Ok(observable)
}

pub(super) fn eigen_path_public_mode_count(
    result: &crate::eigen::PathSolveResult,
    published_mode_indices: &BTreeSet<u32>,
) -> usize {
    result
        .samples
        .iter()
        .map(|sample| {
            sample
                .modes
                .iter()
                .filter(|mode| published_mode_indices.contains(&(mode.raw_mode_index as u32)))
                .count()
        })
        .max()
        .unwrap_or(0)
}

pub(super) fn eigen_path_floquet_periodic_pair_count(plan: &FemEigenPlanIR) -> u64 {
    if !matches!(
        plan.spin_wave_bc.kind(),
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    ) {
        return 0;
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    if requested_pair_ids.is_empty() {
        return 0;
    }
    plan.mesh
        .periodic_boundary_pairs
        .iter()
        .filter(|boundary_pair| {
            requested_pair_ids
                .iter()
                .any(|requested| *requested == boundary_pair.pair_id)
                && boundary_pair.translation.is_some()
                && plan
                    .mesh
                    .periodic_node_pairs
                    .iter()
                    .any(|node_pair| node_pair.pair_id == boundary_pair.pair_id)
        })
        .count() as u64
}

pub(super) fn eigen_path_floquet_periodic_mesh_certificate(
    plan: &FemEigenPlanIR,
) -> Option<serde_json::Value> {
    if !matches!(
        plan.spin_wave_bc.kind(),
        fullmag_ir::SpinWaveBoundaryKindIR::Floquet
    ) {
        return None;
    }
    let requested_pair_ids = plan.spin_wave_bc.boundary_pair_ids();
    if requested_pair_ids.is_empty() {
        return None;
    }
    let mut node_pairs: Vec<_> = plan
        .mesh
        .periodic_node_pairs
        .iter()
        .filter(|node_pair| {
            requested_pair_ids
                .iter()
                .any(|requested| *requested == node_pair.pair_id)
        })
        .collect();
    if node_pairs.is_empty() {
        return None;
    }
    node_pairs.sort_by(|left, right| {
        left.pair_id
            .cmp(&right.pair_id)
            .then(left.node_a.cmp(&right.node_a))
            .then(left.node_b.cmp(&right.node_b))
    });

    let mut canonical_payload =
        String::from("periodic_mesh_certificate_pair_map.v1\nschema=periodic_mesh_certificate.v5\nrole=magnetic\n");
    for node_pair in &node_pairs {
        canonical_payload.push_str(&format!(
            "pair_id_len={};pair_id={};node_a={};node_b={}\n",
            node_pair.pair_id.len(),
            node_pair.pair_id,
            node_pair.node_a,
            node_pair.node_b
        ));
    }
    let digest = Sha256::digest(canonical_payload.as_bytes());
    Some(serde_json::json!({
        "schema_version": "periodic_mesh_certificate.v5",
        "certificate_status": "accepted",
        "magnetic_pair_count": node_pairs.len(),
        "magnetic_pair_map_sha256": format!("sha256:{digest:x}"),
        "pair_map_hash_canonicalization": "periodic_mesh_certificate_pair_map.v1_schema_role_pair_id_len_sorted_nodes",
    }))
}

pub(super) fn eigen_path_solver_diagnostics(
    engine: FemEngine,
    plan: &FemEigenPlanIR,
    result: &crate::eigen::PathSolveResult,
    published_mode_indices: &BTreeSet<u32>,
) -> serde_json::Value {
    let gamma0_rad_s_per_a_m = plan.gyromagnetic_ratio;
    let public_mode_count = eigen_path_public_mode_count(result, published_mode_indices);
    let requested_production_shift_invert =
        result.solver_model == crate::eigen::EigenSolverModel::ProductionCpuShiftInvert;
    let native_cpu_modal_window_rejection_reason =
        fem_eigen::native_cpu_modal_window_rejection_reason(plan);
    let production_shift_invert =
        requested_production_shift_invert && native_cpu_modal_window_rejection_reason.is_none();
    let production_gpu_k0_kittel =
        result.solver_model == crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin;
    let production_periodic_airbox_k0 = periodic_airbox_k0_runtime_supported(plan);
    let production_periodic_airbox_gpu =
        production_periodic_airbox_k0 && engine == FemEngine::NativeGpu;
    let production_modal_solver =
        production_shift_invert || production_gpu_k0_kittel || production_periodic_airbox_k0;
    let mut diagnostics = serde_json::json!({
        "schema_version": "frequency_domain_modal_solver_diagnostics.v1",
        "study_product": "modal_eigen",
        "status": "ready",
        "complete": true,
        "solver_model": if production_periodic_airbox_gpu { "k0_poisson_airbox_gpu_petsc_slepc" } else if production_periodic_airbox_k0 { "k0_poisson_airbox_cpu_schur_slepc" } else { result.solver_model.as_str() },
        "solver_family": if production_periodic_airbox_gpu { "gpu_petsc_slepc_cuda" } else if production_periodic_airbox_k0 { "k0_poisson_airbox_schur" } else { result.solver_model.as_str() },
        "resolved_solver_family": if production_periodic_airbox_gpu { "device_resident_arnoldi_shift_invert" } else if production_periodic_airbox_k0 { "k0_poisson_airbox_schur" } else if production_shift_invert { "shift_invert" } else if production_gpu_k0_kittel { "gpu_dense_k0_macrospin" } else { result.solver_model.as_str() },
        "spectral_transform": if production_periodic_airbox_gpu { "shift_invert" } else if production_periodic_airbox_k0 { "shift_invert" } else if production_shift_invert { "shift_invert" } else if production_gpu_k0_kittel { "dense_generalized" } else { "none" },
        "solver_adapter": if production_periodic_airbox_gpu { "k0_poisson_airbox_gpu_petsc_slepc" } else if production_periodic_airbox_k0 { "k0_poisson_airbox_cpu_schur_slepc" } else if production_shift_invert { "slepc_modal_eigen" } else if production_gpu_k0_kittel { "cusolverdn_dense_k0_macrospin_modal" } else { "multi_k_reference_modal_path" },
        "solver_notes": result.notes,
        "execution_lane": if production_periodic_airbox_gpu { "production_gpu" } else if production_periodic_airbox_k0 { "production_cpu" } else if production_shift_invert { "production_cpu" } else if production_gpu_k0_kittel { "production_gpu" } else { "reference_cpu" },
        "algebraic_form": if production_periodic_airbox_gpu { "schur_reduced_descriptor" } else if production_periodic_airbox_k0 { "schur_reduced_descriptor" } else if production_shift_invert { "gyrotropic_generalized" } else if production_gpu_k0_kittel { "k0_macrospin_field_generalized_to_gyrotropic_modal" } else { "reference_effective_field_generalized" },
        "matrix_equation": if production_periodic_airbox_gpu { "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q" } else if production_periodic_airbox_k0 { "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q" } else if production_shift_invert { "A q = lambda B q" } else if production_gpu_k0_kittel { "K u = lambda_field M u; lambda_modal = i gamma0 lambda_field" } else { "K u = lambda M u" },
        "phasor_convention": if production_periodic_airbox_k0 { "exp_plus_i_omega_t" } else if production_shift_invert || production_gpu_k0_kittel { "exp_i_omega_t" } else { "not_applicable_real_reference" },
        "eigenvalue_mapping": if production_periodic_airbox_k0 { "lambda_imag_positive_frequency" } else if production_shift_invert || production_gpu_k0_kittel { "lambda_eq_i_omega" } else { "omega_rad_s_eq_gamma0_rad_s_per_A_m_times_effective_field_lambda_A_per_m" },
        "frequency_mapping": if production_modal_solver { "frequency_hz = imag(lambda)/(2*pi)" } else { "frequency_hz = omega_rad_s / (2*pi)" },
        "production_gyrotropic_mapping": production_modal_solver,
        "production_solver_available": production_modal_solver,
        "dense_reference_oracle": false,
        "sample_count": result.samples.len(),
        "mode_count": public_mode_count,
        "requested_mode_count": plan.count,
        "normalization": format!("{:?}", plan.normalization).to_lowercase(),
        "residual_definition": "residual_absolute_l2 is the solver-reported modal residual norm; residual_relative_l2 currently follows the reference residual until the production modal backend emits a separate relative norm",
        "tangent_leakage_definition": "abs(m0 dot delta_m) over reconstructed real and imaginary mode vectors",
        "constants": {
            "gamma_rad_s_T": gamma0_rad_s_per_a_m / crate::MU0,
            "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
            "mu0_T_m_per_A": crate::MU0,
        },
    });
    let transport_diagnostics = fem_eigen::modal_tangent_transport_diagnostics(plan);
    if let (Some(object), Some(transport)) = (
        diagnostics.as_object_mut(),
        transport_diagnostics.as_object(),
    ) {
        for (key, value) in transport {
            object.insert(key.clone(), value.clone());
        }
    }
    if let Some(object) = diagnostics.as_object_mut() {
        if !production_modal_solver {
            if let Some(reason) = native_cpu_modal_window_rejection_reason {
                object.insert(
                    "production_cpu_rejection_reason".to_string(),
                    serde_json::json!(reason),
                );
                object.insert(
                    "production_cpu_rejection_scope".to_string(),
                    serde_json::json!(fem_eigen::native_cpu_modal_window_rejection_scope(reason)),
                );
                fem_eigen::insert_native_cpu_modal_window_rejection_contract(object, reason);
            }
        }
        let floquet_pair_count = eigen_path_floquet_periodic_pair_count(plan);
        if floquet_pair_count > 0
            && matches!(
                plan.spin_wave_bc.kind(),
                fullmag_ir::SpinWaveBoundaryKindIR::Floquet
            )
            && !plan.operator.include_demag
        {
            object.insert(
                "modal_periodic_pair_contract_available".to_string(),
                serde_json::json!(true),
            );
            object.insert(
                "floquet_periodic_pair_count".to_string(),
                serde_json::json!(floquet_pair_count),
            );
            if let Some(certificate) = eigen_path_floquet_periodic_mesh_certificate(plan) {
                object.insert("periodic_mesh_certificate".to_string(), certificate);
            }
            object.insert(
                "operator_diagnostics".to_string(),
                serde_json::json!({
                    "schema_version": "frequency_domain_operator_diagnostics.v1",
                    "payload_kind": "bloch_floquet_tangent_operator",
                }),
            );
        }
        if production_periodic_airbox_k0 {
            object.insert(
                "demag_kind".to_string(),
                serde_json::json!("periodic_airbox_k0"),
            );
            object.insert(
                "production_periodic_airbox_claim".to_string(),
                serde_json::json!(true),
            );
        }
    }
    if let (Some(object), Some(metrics)) = (
        diagnostics.as_object_mut(),
        result.k0_kittel_periodic_airbox_demag.as_ref(),
    ) {
        let gauge_policy = if metrics.augmented_phi_dof_count > metrics.phi_dof_count {
            "mean_zero_augmented"
        } else {
            "none"
        };
        object.insert("gauge_policy".to_string(), serde_json::json!(gauge_policy));
        object.insert(
            "phi_dof_count".to_string(),
            serde_json::json!(metrics.phi_dof_count),
        );
        object.insert(
            "augmented_phi_dof_count".to_string(),
            serde_json::json!(metrics.augmented_phi_dof_count),
        );
        object.insert(
            "poisson_constraint_relative_residual".to_string(),
            serde_json::json!(metrics.poisson_constraint_relative_residual),
        );
        object.insert(
            "relative_reference_frequency_error".to_string(),
            serde_json::json!(metrics.relative_kittel_frequency_error),
        );
        object.insert(
            "magnetic_pair_count".to_string(),
            serde_json::json!(metrics.magnetic_pair_count),
        );
        object.insert(
            "airbox_pair_count".to_string(),
            serde_json::json!(metrics.airbox_pair_count),
        );
    }
    let sample_solver_diagnostics = result
        .samples
        .iter()
        .filter_map(|sample| {
            sample
                .solver_diagnostics
                .as_ref()
                .map(|sample_diagnostics| {
                    serde_json::json!({
                        "sample_index": sample.sample.sample_index,
                        "label": sample.sample.label,
                        "k_vector": sample.sample.k_vector,
                        "diagnostics": sample_diagnostics,
                    })
                })
        })
        .collect::<Vec<_>>();
    let exact_sample_diagnostics_available = !sample_solver_diagnostics.is_empty();
    if exact_sample_diagnostics_available {
        let converged_eigenpair_count_total = sample_solver_diagnostics
            .iter()
            .filter_map(|sample| sample.get("diagnostics"))
            .map(|sample| eigen_path_solver_counter(sample, "converged_eigenpair_count"))
            .sum::<u64>();
        let accepted_mode_count_total = sample_solver_diagnostics
            .iter()
            .filter_map(|sample| sample.get("diagnostics"))
            .map(|sample| eigen_path_solver_counter(sample, "accepted_mode_count"))
            .sum::<u64>();
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "sample_solver_diagnostics".to_string(),
                serde_json::json!(sample_solver_diagnostics),
            );
            object.insert(
                "converged_eigenpair_count_total".to_string(),
                serde_json::json!(converged_eigenpair_count_total),
            );
            object.insert(
                "accepted_mode_count_total".to_string(),
                serde_json::json!(accepted_mode_count_total),
            );
        }
    }
    if let fullmag_ir::EigenTargetIR::FrequencyWindow {
        frequency_min_hz,
        frequency_max_hz,
    } = plan.target
    {
        let window_width = frequency_max_hz - frequency_min_hz;
        let relative_width = if frequency_min_hz > 0.0 {
            window_width / frequency_min_hz
        } else {
            0.0
        };
        let subwindow_count = (relative_width / 0.35).ceil().max(1.0).min(16.0) as usize;
        let guard_fraction = 0.25;
        let mut resolved_min_hz = frequency_min_hz;
        let mut resolved_max_hz = frequency_max_hz;
        let subwindows = if exact_sample_diagnostics_available {
            Vec::new()
        } else {
            (0..subwindow_count)
                .map(|index| {
                    let sub_min =
                        frequency_min_hz + index as f64 * window_width / subwindow_count as f64;
                    let sub_max = frequency_min_hz
                        + (index + 1) as f64 * window_width / subwindow_count as f64;
                    let sub_width = sub_max - sub_min;
                    let search_min = (sub_min - guard_fraction * sub_width).max(0.0);
                    let search_max = sub_max + guard_fraction * sub_width;
                    let shift_frequency_hz = 0.5 * (sub_min + sub_max);
                    resolved_min_hz = resolved_min_hz.min(search_min);
                    resolved_max_hz = resolved_max_hz.max(search_max);
                    serde_json::json!({
                        "index": index,
                        "requested_hz": [sub_min, sub_max],
                        "search_hz": [search_min, search_max],
                        "shift_hz": shift_frequency_hz,
                        "shift_frequency_hz": shift_frequency_hz,
                        "shift_omega_rad_s": std::f64::consts::TAU * shift_frequency_hz,
                        "outer_iterations": 0,
                        "linear_iterations_total": 0,
                        "candidate_modes": public_mode_count,
                        "accepted_modes": public_mode_count,
                        "residual_max": 0.0,
                        "stop_reason": "window_exhausted",
                        "provenance": "planned_reference_window_not_executed",
                    })
                })
                .collect::<Vec<_>>()
        };
        if let Some(object) = diagnostics.as_object_mut() {
            object.insert(
                "requested_window_hz".to_string(),
                serde_json::json!([frequency_min_hz, frequency_max_hz]),
            );
            object.insert(
                "resolved_search_window_hz".to_string(),
                serde_json::json!([resolved_min_hz, resolved_max_hz]),
            );
            object.insert(
                "window_completeness".to_string(),
                serde_json::json!({
                    "policy": "best_effort",
                    "status": "not_certified",
                    "certification_method": "none",
                    "estimated_modes_in_window": public_mode_count,
                    "certified_modes_in_window": 0,
                    "additional_modes_may_exist": true,
                }),
            );
            if !subwindows.is_empty() {
                object.insert("subwindows".to_string(), serde_json::json!(subwindows));
            }
            if !production_shift_invert {
                object.insert(
                    "frequency_window_solver_policy".to_string(),
                    serde_json::json!("reference_k_path_window_filter_not_shift_invert_or_feast"),
                );
            }
        }
    }
    diagnostics
}

pub(super) fn eigen_path_solver_counter(diagnostics: &serde_json::Value, key: &str) -> u64 {
    diagnostics
        .get(key)
        .or_else(|| diagnostics.get("slepc").and_then(|slepc| slepc.get(key)))
        .and_then(|value| value.as_u64())
        .unwrap_or(0)
}

pub(super) fn eigen_path_equilibrium_source_json(
    plan: &FemEigenPlanIR,
    _relaxation_steps: u64,
) -> serde_json::Value {
    match &plan.equilibrium {
        fullmag_ir::EquilibriumSourceIR::RelaxedInitialState => {
            serde_json::json!({ "kind": "relaxed_initial_state" })
        }
        fullmag_ir::EquilibriumSourceIR::Provided => serde_json::json!("provided"),
        fullmag_ir::EquilibriumSourceIR::Artifact { path } => {
            serde_json::json!({ "kind": "artifact", "path": path })
        }
    }
}

fn finite_or_default(value: Option<f64>, default: f64) -> f64 {
    value.filter(|value| value.is_finite()).unwrap_or(default)
}

pub(super) fn remap_single_k_mode_artifacts(
    artifacts: &[crate::types::AuxiliaryArtifact],
    sample_index: usize,
    published_mode_indices: &BTreeSet<u32>,
) -> Result<Vec<crate::types::AuxiliaryArtifact>, RunError> {
    let mut remapped = Vec::new();
    for artifact in artifacts {
        let Some(relative_path) = remap_single_k_mode_artifact_path(
            &artifact.relative_path,
            sample_index,
            published_mode_indices,
        ) else {
            continue;
        };
        let bytes = if single_k_mode_artifact_is_json(&relative_path) {
            remap_single_k_mode_json_bytes(&artifact.bytes, sample_index)?
        } else {
            artifact.bytes.clone()
        };
        remapped.push(crate::types::AuxiliaryArtifact {
            relative_path,
            bytes,
        });
    }
    Ok(remapped)
}

pub(super) fn remap_single_k_mode_artifact_path(
    relative_path: &str,
    sample_index: usize,
    published_mode_indices: &BTreeSet<u32>,
) -> Option<String> {
    if published_mode_indices.is_empty() {
        return None;
    }
    let sample_path = format!("sample_{sample_index:04}");
    if relative_path == "eigen/mode_fields.zarr/.zgroup"
        || relative_path == "eigen/mode_fields.zarr/.zattrs"
    {
        return Some(relative_path.to_string());
    }
    for state_name in [
        "equilibrium_artifact.v7.json",
        "linearization_state.v6.json",
    ] {
        if relative_path == format!("eigen/metadata/{state_name}") {
            return Some(format!("eigen/metadata/{sample_path}/{state_name}"));
        }
    }
    if relative_path.starts_with("eigen/modes/sample_0000/")
        || relative_path.starts_with("eigen/mode_fields/sample_0000/")
        || relative_path.starts_with("eigen/mode_fields.zarr/sample_0000/")
    {
        let raw_mode_index = single_k_mode_artifact_raw_mode_index(relative_path)?;
        if !published_mode_indices.contains(&(raw_mode_index as u32)) {
            return None;
        }
        return Some(relative_path.replace("sample_0000", &sample_path));
    }
    None
}

pub(super) fn single_k_mode_artifact_raw_mode_index(relative_path: &str) -> Option<usize> {
    let mode_marker = "/mode_";
    let start = relative_path.rfind(mode_marker)? + mode_marker.len();
    let suffix = &relative_path[start..];
    let digits = suffix
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    if digits.is_empty() {
        return None;
    }
    digits.parse().ok()
}

pub(super) fn single_k_mode_artifact_is_json(relative_path: &str) -> bool {
    relative_path.ends_with(".json")
        || relative_path.ends_with(".zgroup")
        || relative_path.ends_with(".zattrs")
        || relative_path.ends_with(".zarray")
}

pub(super) fn remap_single_k_mode_json_bytes(
    bytes: &[u8],
    sample_index: usize,
) -> Result<Vec<u8>, RunError> {
    let mut value: serde_json::Value = serde_json::from_slice(bytes).map_err(|error| RunError {
        message: format!("failed to parse single-k mode artifact for k-path remap: {error}"),
    })?;
    remap_single_k_mode_json_value(&mut value, sample_index);
    serde_json::to_vec_pretty(&value).map_err(|error| RunError {
        message: format!("failed to serialize k-path mode artifact: {error}"),
    })
}

pub(super) fn remap_single_k_mode_json_value(value: &mut serde_json::Value, sample_index: usize) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                if key == "sample_index" && child.as_u64() == Some(0) {
                    *child = serde_json::json!(sample_index);
                } else {
                    remap_single_k_mode_json_value(child, sample_index);
                }
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                remap_single_k_mode_json_value(item, sample_index);
            }
        }
        serde_json::Value::String(text) => {
            let sample_path = format!("sample_{sample_index:04}");
            let sample_id = format!("sample-{sample_index:04}");
            let sample_meta = format!("/eigen/mode-field/{sample_index}/");
            *text = text
                .replace("sample_0000", &sample_path)
                .replace("sample-0000", &sample_id)
                .replace("/eigen/mode-field/0/", &sample_meta);
        }
        _ => {}
    }
}

pub(super) fn deduplicate_auxiliary_artifacts_by_path(
    artifacts: &mut Vec<crate::types::AuxiliaryArtifact>,
) {
    let mut seen = HashSet::new();
    artifacts.retain(|artifact| seen.insert(artifact.relative_path.clone()));
}
