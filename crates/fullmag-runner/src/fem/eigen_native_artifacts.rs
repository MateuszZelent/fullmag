use super::eigen_certificate::{modal_participation_for_mode, modal_participation_mesh_context};
use super::eigen_constants::{
    NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND, NATIVE_GPU_K0_KITTEL_SOLVER_KIND,
    NATIVE_GPU_MODAL_SHARED_DOMAIN_SOLVER_KIND,
};
use super::eigen_equilibrium_contract::AcceptedFemEigenEquilibriumHandoff;
use super::eigen_native_result::NativeModalEigenpair;
use super::eigen_output::{
    classify_polarization, damping_policy_label, demag_realization_label, dispersion_csv,
    dispersion_v2_csv, equilibrium_source_json, json_artifact, k_vector_json, normalization_label,
    requested_mode_indices, solver_kind_label, spin_wave_bc_json, spin_wave_bc_label,
    write_eigen_v2_bundle,
};
use super::eigen_policy::resolved_demag_realization;
use super::eigen_projection::project_complex_2x2_mode_to_tangent_basis;
use super::eigen_reduction::ReductionMap;
use super::eigen_solve::mode_tangent_leakage;
use super::eigen_types::SharedDomainLinearizationState;
use crate::native_fem;
use crate::types::AuxiliaryArtifact;
use crate::types::RunError;
use crate::ExecutionProvenance;
use fullmag_engine::Vector3;
use fullmag_engine::MU0;
use fullmag_ir::FemEigenPlanIR;
use fullmag_ir::OutputIR;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

pub(super) fn native_modal_artifacts(
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
    equilibrium: &[Vector3],
    reduction: &ReductionMap,
    bases: &[(Vector3, Vector3)],
    modes: &[NativeModalEigenpair],
    node_mass_weights: Option<&[f64]>,
    solver_diagnostics: serde_json::Value,
    relaxation_steps: u64,
    linearization_state: Option<&SharedDomainLinearizationState>,
    relax_to_eigen_handoff: Option<&AcceptedFemEigenEquilibriumHandoff>,
    sample_index: usize,
) -> Result<Vec<AuxiliaryArtifact>, RunError> {
    let requested_modes = requested_mode_indices(outputs);
    let wants_spectrum = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }));
    let wants_dispersion = outputs
        .iter()
        .any(|output| matches!(output, OutputIR::DispersionCurve { .. }));
    let gamma_rad_s_t = plan.gyromagnetic_ratio / MU0;
    let gamma0_rad_s_per_a_m = plan.gyromagnetic_ratio;
    let mu0_t_m_per_a = MU0;
    let mut auxiliary_artifacts = Vec::new();
    let mut solver_diagnostics = solver_diagnostics;
    if let Some(object) = solver_diagnostics.as_object_mut() {
        // The native diagnostics payload reports candidate/accepted counts,
        // while artifacts-v2 needs the exact number of modes that survived
        // native reconstruction and are about to be published.  This applies
        // to nearest-target solves as well as frequency-window solves.
        object.insert("mode_count".to_string(), serde_json::json!(modes.len()));
        object.insert(
            "requested_mode_count".to_string(),
            serde_json::json!(plan.count),
        );
    }
    if let Some(state) = linearization_state {
        if let Some(object) = solver_diagnostics.as_object_mut() {
            object.insert(
                "equilibrium_artifact_sha256".to_string(),
                serde_json::json!(state.equilibrium_artifact_digest),
            );
            object.insert(
                "linearization_state_sha256".to_string(),
                serde_json::json!(state.linearization_state_digest),
            );
            object.insert(
                "periodic_mesh_certificate_sha256".to_string(),
                serde_json::json!(state.periodic_mesh_certificate_digest),
            );
            object.insert(
                "linearization_handoff".to_string(),
                serde_json::json!({
                    "equilibrium_artifact_schema": "equilibrium_artifact.v7",
                    "linearization_state_schema": "LinearizationState.v6",
                    "accepted_for_frequency_operator": true,
                }),
            );
        }
    }
    if let Some(handoff) = relax_to_eigen_handoff {
        if let Some(object) = solver_diagnostics.as_object_mut() {
            object.insert(
                "relax_to_eigen_handoff_sha256".to_string(),
                serde_json::json!(handoff.content_sha256()),
            );
            object.insert(
                "source_mesh_topology_sha256".to_string(),
                serde_json::json!(handoff.source_mesh_topology_sha256()),
            );
            object.insert(
                "relax_to_eigen_handoff".to_string(),
                handoff.provenance_json(),
            );
        }
    }
    // A cached equilibrium is a valid source for the shared-domain modal
    // solve, but it intentionally has no in-memory relax-to-eigen handoff.
    // The publication contract still needs the topology identity that was
    // validated at the native boundary.  Derive it from the exact mesh being
    // published rather than leaving the field absent (or inventing a
    // placeholder), so cache-backed production runs remain fail-closed on any
    // later mesh drift.
    if let Some(object) = solver_diagnostics.as_object_mut() {
        let production_k0_adapter = matches!(
            object
                .get("solver_adapter")
                .and_then(serde_json::Value::as_str),
            Some("k0_poisson_airbox_cpu_full_coupled_slepc")
                | Some("k0_poisson_airbox_cpu_schur_slepc")
                | Some("k0_poisson_airbox_gpu_petsc_slepc")
                | Some("k0_poisson_airbox_gpu_modal_device_krylov")
        );
        if production_k0_adapter && !object.contains_key("source_mesh_topology_sha256") {
            object.insert(
                "source_mesh_topology_sha256".to_string(),
                serde_json::json!(plan.mesh.topology_fingerprint_v6()),
            );
        }
    }
    let sample_diagnostics = solver_diagnostics.clone();
    if let Some(object) = solver_diagnostics.as_object_mut() {
        if !object.contains_key("sample_solver_diagnostics") {
            object.insert(
                "sample_solver_diagnostics".to_string(),
                serde_json::json!([{
                    "sample_index": sample_index,
                    "diagnostics": sample_diagnostics,
                }]),
            );
        }
    }
    // The top-level diagnostics are also the source of the per-sample
    // provenance records consumed by artifacts-v2 validators.  Keep those
    // records synchronized with the exact v6 state files written for this
    // sample; otherwise a single-sample production run can expose the native
    // pre-handoff digest while its published sidecar carries the accepted
    // linearization digest.
    if let Some(state) = linearization_state {
        if let Some(samples) = solver_diagnostics
            .get_mut("sample_solver_diagnostics")
            .and_then(serde_json::Value::as_array_mut)
        {
            for sample in samples {
                let matches_sample = sample
                    .get("sample_index")
                    .and_then(serde_json::Value::as_u64)
                    .is_some_and(|index| index == sample_index as u64);
                if !matches_sample {
                    continue;
                }
                if let Some(nested) = sample
                    .get_mut("diagnostics")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    nested.insert(
                        "equilibrium_artifact_sha256".to_string(),
                        serde_json::json!(state.equilibrium_artifact_digest),
                    );
                    nested.insert(
                        "linearization_state_sha256".to_string(),
                        serde_json::json!(state.linearization_state_digest),
                    );
                    nested.insert(
                        "periodic_mesh_certificate_sha256".to_string(),
                        serde_json::json!(state.periodic_mesh_certificate_digest),
                    );
                }
            }
        }
    }
    if let Some(handoff) = relax_to_eigen_handoff {
        if let Some(samples) = solver_diagnostics
            .get_mut("sample_solver_diagnostics")
            .and_then(serde_json::Value::as_array_mut)
        {
            for sample in samples {
                let matches_sample = sample
                    .get("sample_index")
                    .and_then(serde_json::Value::as_u64)
                    .is_some_and(|index| index == sample_index as u64);
                if !matches_sample {
                    continue;
                }
                if let Some(nested) = sample
                    .get_mut("diagnostics")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    nested.insert(
                        "relax_to_eigen_handoff_sha256".to_string(),
                        serde_json::json!(handoff.content_sha256()),
                    );
                    nested.insert(
                        "source_mesh_topology_sha256".to_string(),
                        serde_json::json!(handoff.source_mesh_topology_sha256()),
                    );
                }
            }
        }
    }
    let mut modes_summary = Vec::with_capacity(modes.len());
    let solver_backend = solver_diagnostics
        .get("solver_backend")
        .and_then(|value| value.as_str())
        .unwrap_or("native_fem_modal_eigen");
    let solver_kind = solver_diagnostics
        .get("solver_model")
        .or_else(|| solver_diagnostics.get("solver_kind"))
        .and_then(|value| value.as_str())
        .unwrap_or("contour_interval_production_cpu_dense");
    let spectral_transform = solver_diagnostics
        .get("spectral_transform")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let execution_lane = solver_diagnostics
        .get("execution_lane")
        .and_then(|value| value.as_str())
        .unwrap_or("production_cpu");
    let participation_context = modal_participation_mesh_context(plan);
    let participation_solver_device = if execution_lane.contains("gpu") {
        "gpu"
    } else {
        "cpu"
    };
    let resolved_solver_family = solver_diagnostics
        .get("resolved_solver_family")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let solver_adapter_name = solver_diagnostics
        .get("solver_adapter")
        .and_then(|value| value.as_str());
    let pa_e2_cpu_periodic_airbox_k0 = matches!(
        solver_adapter_name,
        Some("k0_poisson_airbox_cpu_full_coupled_slepc")
            | Some("k0_poisson_airbox_cpu_schur_slepc")
    );
    let pa_e2_gpu_periodic_airbox_k0 = matches!(
        solver_adapter_name,
        Some("k0_poisson_airbox_gpu_petsc_slepc")
            | Some("k0_poisson_airbox_gpu_modal_device_krylov")
    );
    if pa_e2_cpu_periodic_airbox_k0 || pa_e2_gpu_periodic_airbox_k0 {
        let valid_fe_mass = node_mass_weights.is_some_and(|weights| {
            weights.len() == reduction.active_nodes.len()
                && weights
                    .iter()
                    .all(|weight| weight.is_finite() && *weight > 0.0)
        });
        if !valid_fe_mass {
            return Err(RunError {
                message: "production K0 mode artifacts require one positive FE mass weight per active magnetic node"
                    .to_string(),
            });
        }
    }
    let gpu_scalable_selected_spectrum = solver_diagnostics
        .get("scalable_selected_spectrum")
        .and_then(|value| value.as_bool())
        .unwrap_or(pa_e2_gpu_periodic_airbox_k0);
    let mode_phasor_convention = if pa_e2_cpu_periodic_airbox_k0 {
        "exp_plus_i_omega_t"
    } else {
        "exp_plus_i_omega_t"
    };
    let mode_eigenvalue_mapping = if pa_e2_cpu_periodic_airbox_k0 || pa_e2_gpu_periodic_airbox_k0 {
        "lambda_imag_positive_frequency"
    } else {
        "lambda_eq_i_omega"
    };
    let shift_invert_backend =
        spectral_transform == "shift_invert" || resolved_solver_family == "shift_invert";
    let gpu_k0_backend = pa_e2_gpu_periodic_airbox_k0
        || (execution_lane == "production_gpu" && solver_kind == NATIVE_GPU_K0_KITTEL_SOLVER_KIND);
    let gpu_shared_domain_backend = pa_e2_gpu_periodic_airbox_k0;
    let solver_notes = if gpu_k0_backend {
        if gpu_shared_domain_backend {
            if gpu_scalable_selected_spectrum {
                "native FEM production GPU K0 shared-domain demag modal eigensolver using device-resident Arnoldi/Ritz shift-invert"
            } else {
                "native FEM GPU K0 bounded dense device validation path; scalable selected-spectrum qualification is unavailable"
            }
        } else {
            "native FEM production GPU K0 macrospin modal eigensolver using cuSolverDN dense generalized solve"
        }
    } else if shift_invert_backend {
        "native FEM production CPU modal eigensolver using SLEPc shift-invert"
    } else {
        "native FEM production CPU modal eigensolver using dense contour interval search"
    };
    let solver_capabilities: Vec<&'static str> =
        if gpu_shared_domain_backend && gpu_scalable_selected_spectrum {
            vec![
                "native_modal_eigen",
                "production_gpu",
                "device_resident_krylov",
                "shared_domain_dynamic_demag",
                "k0_periodic_airbox",
            ]
        } else if gpu_shared_domain_backend {
            vec![
                "native_modal_eigen",
                "gpu_device_validation",
                "shared_domain_dynamic_demag",
                "k0_periodic_airbox",
            ]
        } else if gpu_k0_backend {
            vec![
                "native_modal_eigen",
                "production_gpu",
                "cusolverdn_dense",
                "k0_macrospin_validation",
            ]
        } else if shift_invert_backend {
            vec![
                "native_modal_eigen",
                "production_cpu",
                "shift_invert",
                "frequency_window_filter",
            ]
        } else {
            vec![
                "native_modal_eigen",
                "production_cpu",
                "contour_interval",
                "frequency_window_filter",
            ]
        };
    let solver_limitations: Vec<&'static str> =
        if gpu_shared_domain_backend && gpu_scalable_selected_spectrum {
            vec![
                "k0_only",
                "uniform_alpha_zero_scope",
                "anisotropy_and_dmi_tangent_terms_not_certified",
                "frequency_window_completeness_pending",
            ]
        } else if gpu_shared_domain_backend {
            vec![
                "k0_only",
                "uniform_alpha_zero_scope",
                "dense_device_validation_only",
                "scalable_selected_spectrum_unavailable",
            ]
        } else if gpu_k0_backend {
            vec![
                "k0_only",
                "no_demag",
                "macrospin_larmor_validation_slice",
                "nonzero_k_floquet_gpu_modal_not_implemented",
            ]
        } else if shift_invert_backend {
            vec![
                "dense_operator_payload",
                "window_count_certification_pending",
            ]
        } else {
            vec![
                "dense_operator_payload",
                "block_diagonal_2x2_contour_payload",
            ]
        };
    let mut cluster_sizes = BTreeMap::<u64, usize>::new();
    for mode in modes {
        *cluster_sizes.entry(mode.cluster_id).or_default() += 1;
    }

    // Keep the lane-independent operator and lane-specific v6 handoff
    // identities directly on every mode metadata record.  The manifest also
    // carries these values, but per-mode consumers (UI, parity and sidecar
    // validators) must not have to infer provenance through a global file.
    let mode_provenance_value = |key: &str| {
        solver_diagnostics
            .get(key)
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    };
    let mode_operator_input_signature = mode_provenance_value("operator_input_signature_sha256");
    let mode_phase_constraint = mode_provenance_value("phase_constraint_sha256");
    let mode_equilibrium_artifact = mode_provenance_value("equilibrium_artifact_sha256");
    let mode_linearization_state = mode_provenance_value("linearization_state_sha256");
    let mode_periodic_certificate = mode_provenance_value("periodic_mesh_certificate_sha256");
    let mode_relax_to_eigen_handoff = mode_provenance_value("relax_to_eigen_handoff_sha256");
    let mode_source_mesh_topology = mode_provenance_value("source_mesh_topology_sha256");
    let mode_assembly_kind = mode_provenance_value("assembly_kind");

    for (mode_index, mode) in modes.iter().enumerate() {
        let (real, imag, amplitude, phase, max_amplitude) =
            project_complex_2x2_mode_to_tangent_basis(
                equilibrium.len(),
                &reduction.active_nodes,
                &mode.vector,
                bases,
            );
        let norm = mode
            .vector
            .iter()
            .map(|value| value.norm_sqr())
            .sum::<f64>()
            .sqrt();
        let dominant_polarization = classify_polarization(
            &amplitude,
            &reduction.active_nodes,
            equilibrium,
            max_amplitude,
        );
        let (
            tangent_leakage_mean_abs,
            tangent_leakage_max_abs,
            tangent_leakage_weighted_relative_l2,
        ) = mode_tangent_leakage(
            equilibrium,
            &real,
            &imag,
            &reduction.active_nodes,
            node_mass_weights,
        );
        let component_participation = modal_participation_for_mode(
            &participation_context,
            plan,
            &real,
            &imag,
            participation_solver_device,
        );
        let q_real = mode
            .q_vector
            .iter()
            .map(|value| value.re)
            .collect::<Vec<_>>();
        let q_imag = mode
            .q_vector
            .iter()
            .map(|value| value.im)
            .collect::<Vec<_>>();
        let phi_real = mode
            .phi_vector
            .iter()
            .map(|value| value.re)
            .collect::<Vec<_>>();
        let phi_imag = mode
            .phi_vector
            .iter()
            .map(|value| value.im)
            .collect::<Vec<_>>();
        let has_native_q_phi_payload = !mode.q_vector.is_empty() || !mode.phi_vector.is_empty();
        let mode_summary = serde_json::json!({
            "index": mode_index,
            "sample_index": sample_index,
            "cluster_id": mode.cluster_id,
            "cluster_size": cluster_sizes.get(&mode.cluster_id).copied().unwrap_or(1),
            "multiplicity": cluster_sizes.get(&mode.cluster_id).copied().unwrap_or(1),
            "frequency_hz": mode.frequency_hz,
            "frequency_real_hz": mode.frequency_hz,
            "frequency_imag_hz": 0.0,
            "angular_frequency_rad_per_s": mode.omega_rad_s,
            "omega_rad_s": mode.omega_rad_s,
            "angular_frequency_imag_rad_per_s": 0.0,
            "eigenvalue_field_au_per_m": mode.omega_rad_s / plan.gyromagnetic_ratio,
            "eigenvalue_real": mode.eigenvalue_real,
            "eigenvalue_imag": mode.eigenvalue_imag,
            "phasor_convention": mode_phasor_convention,
            "eigenvalue_mapping": mode_eigenvalue_mapping,
            "norm": norm,
            "max_amplitude": max_amplitude,
            "residual_norm": mode.residual_absolute_l2,
            "residual_absolute_l2": mode.residual_absolute_l2,
            "residual_relative_l2": mode.residual_relative_l2,
            "residual_linf": mode.residual_linf,
            "block_residuals": {
                "eps_q": mode.block_residual_q,
                "eps_phi": mode.block_residual_phi,
                "eps_gauge": mode.block_residual_gauge,
                "eps_full": mode.residual_relative_l2,
                "backend_reported_residual": mode.backend_reported_residual,
                "certification_tolerance": 1.0e-8,
                "certified": mode.residual_relative_l2 <= 1.0e-8,
            },
            "mass_norm": mode.mass_norm,
            "q_dof_count": mode.q_vector.len(),
            "phi_dof_count": mode.phi_vector.len(),
            "native_q_phi_payload": has_native_q_phi_payload,
            "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
            "tangent_leakage_max_abs": tangent_leakage_max_abs,
            "tangent_leakage_weighted_relative_l2": tangent_leakage_weighted_relative_l2,
            "gamma_rad_s_T": gamma_rad_s_t,
            "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
            "mu0_T_m_per_A": mu0_t_m_per_a,
            "dominant_polarization": dominant_polarization,
            "k_vector": k_vector_json(plan.k_sampling.as_ref()),
            "external_field_a_per_m": plan.external_field,
            "assembly_kind": mode_assembly_kind.clone(),
            "operator_input_signature_sha256": mode_operator_input_signature.clone(),
            "phase_constraint_sha256": mode_phase_constraint.clone(),
            "equilibrium_artifact_sha256": mode_equilibrium_artifact.clone(),
            "linearization_state_sha256": mode_linearization_state.clone(),
            "periodic_mesh_certificate_sha256": mode_periodic_certificate.clone(),
            "relax_to_eigen_handoff_sha256": mode_relax_to_eigen_handoff.clone(),
            "source_mesh_topology_sha256": mode_source_mesh_topology.clone(),
            "component_participation": component_participation.clone(),
        });
        modes_summary.push(mode_summary.clone());

        if requested_modes.contains(&(mode_index as u32)) {
            let payload = serde_json::json!({
                "index": mode_index,
                "sample_index": sample_index,
                "frequency_hz": mode.frequency_hz,
                "frequency_real_hz": mode.frequency_hz,
                "frequency_imag_hz": 0.0,
                "angular_frequency_rad_per_s": mode.omega_rad_s,
                "omega_rad_s": mode.omega_rad_s,
                "angular_frequency_imag_rad_per_s": 0.0,
                "eigenvalue_real": mode.eigenvalue_real,
                "eigenvalue_imag": mode.eigenvalue_imag,
                "phasor_convention": mode_phasor_convention,
                "eigenvalue_mapping": mode_eigenvalue_mapping,
                "max_amplitude": max_amplitude,
                "residual_norm": mode.residual_absolute_l2,
                "residual_absolute_l2": mode.residual_absolute_l2,
                "residual_relative_l2": mode.residual_relative_l2,
                "residual_linf": mode.residual_linf,
                "cluster_id": mode.cluster_id,
                "cluster_size": cluster_sizes.get(&mode.cluster_id).copied().unwrap_or(1),
                "multiplicity": cluster_sizes.get(&mode.cluster_id).copied().unwrap_or(1),
                "block_residuals": {
                    "eps_q": mode.block_residual_q,
                    "eps_phi": mode.block_residual_phi,
                    "eps_gauge": mode.block_residual_gauge,
                    "eps_full": mode.residual_relative_l2,
                    "backend_reported_residual": mode.backend_reported_residual,
                    "certification_tolerance": 1.0e-8,
                    "certified": mode.residual_relative_l2 <= 1.0e-8,
                },
                "mass_norm": mode.mass_norm,
                "q_dof_count": mode.q_vector.len(),
                "phi_dof_count": mode.phi_vector.len(),
                "native_q_phi_payload": has_native_q_phi_payload,
                "q_real": q_real,
                "q_imag": q_imag,
                "phi_real": phi_real,
                "phi_imag": phi_imag,
                "tangent_leakage_mean_abs": tangent_leakage_mean_abs,
                "tangent_leakage_max_abs": tangent_leakage_max_abs,
                "tangent_leakage_weighted_relative_l2": tangent_leakage_weighted_relative_l2,
                "gamma_rad_s_T": gamma_rad_s_t,
                "gamma0_rad_s_per_A_m": gamma0_rad_s_per_a_m,
                "mu0_T_m_per_A": mu0_t_m_per_a,
                "normalization": normalization_label(plan.normalization),
                "damping_policy": damping_policy_label(plan.damping_policy),
                "solver_backend": solver_backend,
                "solver_kind": solver_kind,
                "solver_notes": solver_notes,
                "solver_capabilities": solver_capabilities,
                "solver_limitations": solver_limitations,
                "dominant_polarization": dominant_polarization,
                "k_vector": k_vector_json(plan.k_sampling.as_ref()),
                "external_field_a_per_m": plan.external_field,
                "assembly_kind": mode_assembly_kind,
                "operator_input_signature_sha256": mode_operator_input_signature,
                "phase_constraint_sha256": mode_phase_constraint,
                "equilibrium_artifact_sha256": mode_equilibrium_artifact,
                "linearization_state_sha256": mode_linearization_state,
                "periodic_mesh_certificate_sha256": mode_periodic_certificate,
                "relax_to_eigen_handoff_sha256": mode_relax_to_eigen_handoff,
                "source_mesh_topology_sha256": mode_source_mesh_topology,
                "node_mass_weights": node_mass_weights,
                "real": real,
                "imag": imag,
                "amplitude": amplitude,
                "phase": phase,
                "component_participation": component_participation,
            });
            auxiliary_artifacts.push(json_artifact(
                format!("eigen/modes/mode_{mode_index:04}.json"),
                &payload,
            )?);
        }
    }

    let summary_payload = serde_json::json!({
        "study_kind": "eigenmodes",
        "solver_backend": solver_backend,
        "solver_kind": solver_kind,
        "solver_notes": solver_notes,
        "solver_capabilities": solver_capabilities,
        "solver_limitations": solver_limitations,
        "mesh_name": plan.mesh_name,
        "sample_index": sample_index,
        "mode_count": modes_summary.len(),
        "normalization": normalization_label(plan.normalization),
        "damping_policy": damping_policy_label(plan.damping_policy),
        "spin_wave_bc": spin_wave_bc_label(plan.spin_wave_bc.clone()),
        "boundary_config": spin_wave_bc_json(&plan.spin_wave_bc),
        "equilibrium_source": equilibrium_source_json(&plan.equilibrium),
        "included_terms": {
            "exchange": plan.enable_exchange,
            "demag": plan.enable_demag,
            "zeeman": plan.external_field.is_some(),
            "interfacial_dmi": plan.interfacial_dmi.is_some(),
            "bulk_dmi": plan.bulk_dmi.is_some(),
            "surface_anisotropy": plan.spin_wave_bc.surface_anisotropy_ks().is_some(),
        },
        "operator": {
            "kind": format!("{:?}", plan.operator.kind).to_lowercase(),
            "include_demag": plan.operator.include_demag,
        },
        "solver_diagnostics": solver_diagnostics,
        "k_sampling": k_vector_json(plan.k_sampling.as_ref()),
        "node_mass_weights": node_mass_weights,
        "relaxation_steps": relaxation_steps,
        "modes": modes_summary,
    });

    if wants_spectrum {
        auxiliary_artifacts.push(json_artifact("eigen/spectrum.json", &summary_payload)?);
    }
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/eigen_summary.json",
        &summary_payload,
    )?);
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/normalization.json",
        &serde_json::json!({
            "normalization": normalization_label(plan.normalization),
            "mode_count": summary_payload["mode_count"],
        }),
    )?);
    auxiliary_artifacts.push(json_artifact(
        "eigen/metadata/equilibrium_source.json",
        &equilibrium_source_json(&plan.equilibrium),
    )?);
    if let Some(state) = linearization_state {
        auxiliary_artifacts.push(json_artifact(
            "eigen/metadata/equilibrium_artifact.v7.json",
            &state.equilibrium_artifact,
        )?);
        auxiliary_artifacts.push(json_artifact(
            "eigen/metadata/linearization_state.v6.json",
            &state.linearization_state,
        )?);
    }

    if wants_dispersion {
        let visualizable_mode_indices = requested_modes
            .iter()
            .copied()
            .map(u64::from)
            .collect::<BTreeSet<_>>();
        let k_vector = k_vector_json(plan.k_sampling.as_ref());
        auxiliary_artifacts.push(json_artifact(
            "eigen/dispersion/path.json",
            &serde_json::json!({
                "sampling": plan.k_sampling,
                "k_vector": k_vector,
            }),
        )?);
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion/branch_table.csv".to_string(),
            bytes: dispersion_csv(plan.k_sampling.as_ref(), &summary_payload["modes"]).into_bytes(),
        });
        auxiliary_artifacts.push(AuxiliaryArtifact {
            relative_path: "eigen/dispersion.csv".to_string(),
            bytes: dispersion_v2_csv(
                plan.k_sampling.as_ref(),
                &summary_payload["modes"],
                &visualizable_mode_indices,
            )
            .into_bytes(),
        });
    }
    write_eigen_v2_bundle(
        plan,
        &summary_payload,
        &requested_modes,
        &mut auxiliary_artifacts,
        sample_index,
    )?;
    auxiliary_artifacts
        .retain(|artifact| artifact.relative_path != "eigen/diagnostics/solver.v1.json");
    auxiliary_artifacts.push(json_artifact(
        "eigen/diagnostics/solver.v1.json",
        &summary_payload["solver_diagnostics"],
    )?);
    Ok(auxiliary_artifacts)
}

pub(super) fn execution_provenance(plan: &FemEigenPlanIR, used_gpu: bool) -> ExecutionProvenance {
    let engine = if used_gpu {
        format!("gpu_cusolver_fem_eigen/{}", solver_kind_label(plan))
    } else {
        format!("cpu_baseline_fem_eigen/{}", solver_kind_label(plan))
    };
    let resolved_demag = resolved_demag_realization(plan);
    ExecutionProvenance {
        execution_engine: engine,
        // FEM eigen baseline currently executes in double precision.
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

pub(super) fn native_modal_execution_provenance(plan: &FemEigenPlanIR) -> ExecutionProvenance {
    let resolved_demag = resolved_demag_realization(plan);
    ExecutionProvenance {
        execution_engine: format!("native_fem_modal_eigen/{NATIVE_CPU_MODAL_WINDOW_SOLVER_KIND}"),
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

pub(super) fn native_gpu_modal_shared_domain_execution_provenance(
    plan: &FemEigenPlanIR,
    attestation: Option<&native_fem::NativeModalGpuAttestation>,
) -> ExecutionProvenance {
    let resolved_demag = resolved_demag_realization(plan);
    ExecutionProvenance {
        execution_engine: format!(
            "native_fem_modal_eigen/{NATIVE_GPU_MODAL_SHARED_DOMAIN_SOLVER_KIND}"
        ),
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
        device_name: attestation.map(|value| value.device_name.clone()),
        compute_capability: attestation.map(|value| {
            format!(
                "{}.{}",
                value.compute_capability_major, value.compute_capability_minor
            )
        }),
        cuda_driver_version: attestation
            .and_then(|value| value.cuda_driver_version.try_into().ok()),
        cuda_runtime_version: attestation
            .and_then(|value| value.cuda_runtime_version.try_into().ok()),
        mfem_version: attestation.map(|value| value.mfem_version.clone()),
        hypre_version: attestation.map(|value| value.hypre_version.clone()),
        fem_execution_mode: attestation.map(|_| "full_gpu_modal_matrix_free".to_string()),
        fem_gpu_qualification_status: attestation.map(|_| "source_visible".to_string()),
        fem_data_residency: attestation.map(|_| "device_source_of_truth".to_string()),
        uses_cuda_kernels: attestation.map(|_| true),
        uses_gpu_poisson: attestation.map(|_| true),
        fem_demag_operator_mode: attestation.map(|_| "poisson_airbox_schur_cuda".to_string()),
        hypre_execution_policy: attestation.map(|_| "device".to_string()),
        demag_residency: attestation.map(|_| "device".to_string()),
        hot_loop_host_sync_count: attestation.map(|value| {
            value.hot_loop_computational_host_syncs + value.hot_loop_scalar_telemetry_syncs
        }),
        hot_loop_compute_h2d_bytes: attestation.map(|value| value.hot_loop_computational_h2d_bytes),
        hot_loop_compute_d2h_bytes: attestation.map(|value| value.hot_loop_computational_d2h_bytes),
        hot_loop_compute_host_sync_count: attestation
            .map(|value| value.hot_loop_computational_host_syncs),
        hot_loop_control_scalar_d2h_bytes: attestation
            .map(|value| value.hot_loop_scalar_telemetry_d2h_bytes),
        hot_loop_control_scalar_host_sync_count: attestation
            .map(|value| value.hot_loop_scalar_telemetry_syncs),
        ..Default::default()
    }
}

pub(super) fn native_gpu_k0_kittel_execution_provenance(
    plan: &FemEigenPlanIR,
) -> ExecutionProvenance {
    let resolved_demag = resolved_demag_realization(plan);
    ExecutionProvenance {
        execution_engine: format!("native_fem_modal_eigen/{NATIVE_GPU_K0_KITTEL_SOLVER_KIND}"),
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
        device_name: Some("cuda".to_string()),
        compute_capability: None,
        cuda_driver_version: None,
        cuda_runtime_version: None,
        ..Default::default()
    }
}
