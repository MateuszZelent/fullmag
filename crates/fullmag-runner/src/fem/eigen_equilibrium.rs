use super::eigen_anisotropy::volume_anisotropy_field;
use super::eigen_digest::{is_sha256_digest, shared_domain_content_digest};
use super::eigen_equilibrium_contract::{
    validate_certified_equilibrium_fields, AcceptedFemRelaxStageHandoff,
    LoadedEquilibriumArtifactV7,
};
use super::eigen_math::{cross, vector_norm};
use super::eigen_policy::resolved_demag_realization;
use super::eigen_reduction::validate_tangent_frame_transport_support;
use super::eigen_shared_domain::max_vector_field_difference;
use super::eigen_shared_domain_geometry::shared_domain_robin_beta_m;
use super::eigen_types::AcceptedEquilibriumCriterion;
use crate::types::ExecutedRun;
use crate::types::RunError;
use fullmag_engine::fem::FemLlgProblem;
use fullmag_engine::fem::MeshTopology;
use fullmag_engine::EffectiveFieldObservables;
use fullmag_engine::EffectiveFieldTerms;
use fullmag_engine::LlgConfig;
use fullmag_engine::MaterialParameters;
use fullmag_engine::TimeIntegrator;
use fullmag_engine::Vector3;
use fullmag_ir::EquilibriumSourceIR;
use fullmag_ir::FemEigenPlanIR;

pub(super) fn prepare_single_k_stage_continuation(
    plan: &FemEigenPlanIR,
    handoff: &AcceptedFemRelaxStageHandoff,
) -> Result<FemEigenPlanIR, RunError> {
    handoff.validate_target_plan(plan)?;
    let mut prepared = plan.clone();
    prepared.equilibrium = EquilibriumSourceIR::Provided;
    prepared.equilibrium_magnetization = handoff.equilibrium_magnetization.clone();
    Ok(prepared)
}

pub(super) fn bind_stage_continuation_artifacts(
    run: &mut ExecutedRun,
    handoff: &AcceptedFemRelaxStageHandoff,
) -> Result<(), RunError> {
    if run.initial_magnetization != handoff.equilibrium_magnetization
        || run.result.final_magnetization != handoff.equilibrium_magnetization
    {
        return Err(RunError {
            message: "relax_stage_handoff_consumed_equilibrium_mismatch".to_string(),
        });
    }
    let equilibrium_source = serde_json::json!({
        "kind": "relaxed_initial_state",
        "handoff": "stage_continuation",
        "content_sha256": handoff.content_sha256,
        "equilibrium_content_sha256": handoff.equilibrium_content_sha256,
    });
    let mut bound_summary = false;
    for artifact in &mut run.auxiliary_artifacts {
        let is_summary = artifact.relative_path == "eigen/metadata/eigen_summary.json";
        let is_spectrum = artifact.relative_path == "eigen/spectrum.json";
        let is_spectrum_bundle = matches!(
            artifact.relative_path.as_str(),
            "eigen/spectrum.v2.json" | "eigen/spectrum.v3.json"
        );
        let is_solver_diagnostics = artifact.relative_path == "eigen/diagnostics/solver.v1.json";
        let is_source = artifact.relative_path == "eigen/metadata/equilibrium_source.json";
        let is_mode = artifact.relative_path.starts_with("eigen/modes/")
            && artifact.relative_path.ends_with(".json");
        if !(is_summary
            || is_spectrum
            || is_spectrum_bundle
            || is_solver_diagnostics
            || is_source
            || is_mode)
        {
            continue;
        }
        let mut value: serde_json::Value =
            serde_json::from_slice(&artifact.bytes).map_err(|error| RunError {
                message: format!(
                    "relax_stage_handoff_invalid_json_artifact '{}': {error}",
                    artifact.relative_path
                ),
            })?;
        let relaxation_steps = value
            .get("relaxation_steps")
            .and_then(serde_json::Value::as_u64);
        if is_source {
            value = equilibrium_source.clone();
        } else if let Some(object) = value.as_object_mut() {
            if is_summary || is_spectrum {
                if relaxation_steps != Some(0) {
                    return Err(RunError {
                        message: "relax_stage_handoff_second_relaxation_detected".to_string(),
                    });
                }
                object.insert("equilibrium_source".to_string(), equilibrium_source.clone());
                let diagnostics = object
                    .entry("solver_diagnostics")
                    .or_insert_with(|| serde_json::json!({}));
                let diagnostics = diagnostics.as_object_mut().ok_or_else(|| RunError {
                    message: "relax_stage_handoff_solver_diagnostics_not_object".to_string(),
                })?;
                diagnostics.insert(
                    "relax_to_eigen_handoff_sha256".to_string(),
                    serde_json::json!(handoff.content_sha256),
                );
                diagnostics.insert(
                    "source_mesh_topology_sha256".to_string(),
                    serde_json::json!(handoff.source_mesh_topology_sha256),
                );
                diagnostics.insert(
                    "relax_to_eigen_handoff".to_string(),
                    handoff.provenance_json(),
                );
                if let Some(modes) = object
                    .get_mut("modes")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    for mode in modes {
                        if let Some(mode) = mode.as_object_mut() {
                            mode.insert(
                                "relax_to_eigen_handoff_sha256".to_string(),
                                serde_json::json!(handoff.content_sha256),
                            );
                            mode.insert(
                                "source_mesh_topology_sha256".to_string(),
                                serde_json::json!(handoff.source_mesh_topology_sha256),
                            );
                        }
                    }
                }
                bound_summary |= is_summary;
            } else if is_mode {
                object.insert(
                    "relax_to_eigen_handoff_sha256".to_string(),
                    serde_json::json!(handoff.content_sha256),
                );
                object.insert(
                    "equilibrium_content_sha256".to_string(),
                    serde_json::json!(handoff.equilibrium_content_sha256),
                );
                object.insert(
                    "source_mesh_topology_sha256".to_string(),
                    serde_json::json!(handoff.source_mesh_topology_sha256),
                );
            } else if is_solver_diagnostics {
                object.insert(
                    "relax_to_eigen_handoff_sha256".to_string(),
                    serde_json::json!(handoff.content_sha256),
                );
                object.insert(
                    "source_mesh_topology_sha256".to_string(),
                    serde_json::json!(handoff.source_mesh_topology_sha256),
                );
                if let Some(samples) = object
                    .get_mut("sample_solver_diagnostics")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    for sample in samples {
                        if let Some(diagnostics) = sample
                            .get_mut("diagnostics")
                            .and_then(serde_json::Value::as_object_mut)
                        {
                            diagnostics.insert(
                                "relax_to_eigen_handoff_sha256".to_string(),
                                serde_json::json!(handoff.content_sha256),
                            );
                            diagnostics.insert(
                                "source_mesh_topology_sha256".to_string(),
                                serde_json::json!(handoff.source_mesh_topology_sha256),
                            );
                        }
                    }
                }
            } else if is_spectrum_bundle {
                if let Some(samples) = object
                    .get_mut("samples")
                    .and_then(serde_json::Value::as_array_mut)
                {
                    for sample in samples {
                        let Some(modes) = sample
                            .get_mut("modes")
                            .and_then(serde_json::Value::as_array_mut)
                        else {
                            continue;
                        };
                        for mode in modes {
                            if let Some(mode) = mode.as_object_mut() {
                                mode.insert(
                                    "relax_to_eigen_handoff_sha256".to_string(),
                                    serde_json::json!(handoff.content_sha256),
                                );
                                mode.insert(
                                    "source_mesh_topology_sha256".to_string(),
                                    serde_json::json!(handoff.source_mesh_topology_sha256),
                                );
                            }
                        }
                    }
                }
            }
        }
        artifact.bytes = serde_json::to_vec_pretty(&value).map_err(|error| RunError {
            message: format!(
                "relax_stage_handoff_artifact_serialization_failed '{}': {error}",
                artifact.relative_path
            ),
        })?;
    }
    if !bound_summary {
        return Err(RunError {
            message: "relax_stage_handoff_missing_eigen_summary".to_string(),
        });
    }
    Ok(())
}

pub(super) fn materialize_equilibrium(
    plan: &FemEigenPlanIR,
    initial_magnetization: &[Vector3],
    source_relax_handoff: Option<&AcceptedFemRelaxStageHandoff>,
) -> Result<
    (
        FemLlgProblem,
        Vec<Vector3>,
        u64,
        EffectiveFieldObservables,
        Option<LoadedEquilibriumArtifactV7>,
    ),
    RunError,
> {
    let source_artifact = if let EquilibriumSourceIR::Artifact { path } = &plan.equilibrium {
        Some(load_equilibrium_artifact_v7(path, plan.mesh.nodes.len())?)
    } else {
        None
    };
    let equilibrium_guess = source_artifact
        .as_ref()
        .map(|artifact| artifact.m0.clone())
        .unwrap_or_else(|| initial_magnetization.to_vec());

    let topology = MeshTopology::from_ir(&plan.mesh).map_err(|error| RunError {
        message: format!("MeshTopology: {}", error),
    })?;
    validate_tangent_frame_transport_support(plan, &topology, &equilibrium_guess)?;
    let material = MaterialParameters::new(
        plan.material.saturation_magnetisation,
        plan.material.exchange_stiffness,
        plan.material.damping,
    )
    .map_err(|error| RunError {
        message: format!("Material: {}", error),
    })?;
    let dynamics = LlgConfig::new(plan.gyromagnetic_ratio, TimeIntegrator::RK23)
        .map_err(|error| RunError {
            message: format!("LLG: {}", error),
        })?
        .with_precession_enabled(false);
    // Compute volume anisotropy field at equilibrium guess so that the
    // relaxation includes the anisotropy contribution.  Because the FEM
    // engine treats per_node_field as static, we recompute it once after
    // an initial relaxation pass (self-consistent field iteration).
    let aniso_per_node: Option<Vec<Vector3>> = {
        let has_uni = plan
            .material
            .uniaxial_anisotropy
            .map_or(false, |k| k.abs() > 0.0);
        let has_cub = plan
            .material
            .cubic_anisotropy_kc1
            .map_or(false, |k| k.abs() > 0.0);
        if has_uni || has_cub {
            Some(
                equilibrium_guess
                    .iter()
                    .map(|m| volume_anisotropy_field(*m, plan))
                    .collect(),
            )
        } else {
            None
        }
    };
    let terms = EffectiveFieldTerms {
        exchange: plan.enable_exchange,
        demag: plan.enable_demag,
        external_field: plan.external_field,
        per_node_field: aniso_per_node,
        magnetoelastic: None,
        uniaxial_anisotropy: None,
        cubic_anisotropy: None,
        interfacial_dmi: None,
        bulk_dmi: None,
        zhang_li_stt: None,
        slonczewski_stt: None,
        sot: None,
        oersted_cylinder: None,
    };
    let resolved_demag = resolved_demag_realization(plan);
    let robin_beta_factor = if matches!(
        resolved_demag,
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin)
    ) {
        shared_domain_robin_beta_m(plan)?.map(|beta| beta / topology.robin_beta)
    } else {
        None
    };
    let mut problem = match resolved_demag {
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonRobin) => {
            FemLlgProblem::with_terms_and_demag_airbox(
                topology,
                material,
                dynamics,
                terms,
                false,
                robin_beta_factor,
            )
        }
        Some(fullmag_ir::ResolvedFemDemagIR::PoissonDirichlet) => {
            FemLlgProblem::with_terms_and_demag_airbox(
                topology, material, dynamics, terms, true, None,
            )
        }
        Some(r) => {
            return Err(RunError {
                message: format!(
                    "FEM eigen runner: demag model '{}' is not yet implemented",
                    r.model_name(),
                ),
            });
        }
        None => FemLlgProblem::with_terms(topology, material, dynamics, terms),
    };
    if let Some(normal) = plan.dmi_interface_normal {
        problem.set_dmi_interface_normal(normal);
    }
    let state = problem
        .new_state(equilibrium_guess)
        .map_err(|error| RunError {
            message: format!("State: {}", error),
        })?;

    let steps_taken = 0;

    let mut observables = problem.observe(&state).map_err(|error| RunError {
        message: format!("FEM eigen observables: {}", error),
    })?;
    if let Some(handoff) = source_relax_handoff {
        validate_certified_equilibrium_fields(
            &handoff.certified_fields,
            state.magnetization().len(),
        )?;
        let require_recomputed_match =
            |label: &str, accepted: &[Vector3], recomputed: &[Vector3]| {
                let difference = max_vector_field_difference(accepted, recomputed).ok_or_else(|| {
                    RunError {
                        message: format!(
                            "relax_stage_handoff_{label}_recompute_mismatch: accepted and recomputed field shapes differ"
                        ),
                    }
                })?;
                if !difference.is_finite() || difference > 1.0e-8 {
                    return Err(RunError {
                        message: format!(
                            "relax_stage_handoff_{label}_recompute_mismatch: accepted/recomputed maximum difference {difference:.3e} exceeds 1.000e-8 A/m"
                        ),
                    });
                }
                Ok(())
            };
        require_recomputed_match(
            "h_ex0",
            &handoff.certified_fields.h_ex_a_per_m,
            &observables.exchange_field,
        )?;
        require_recomputed_match(
            "h_demag0",
            &handoff.certified_fields.h_demag_a_per_m,
            &observables.demag_field,
        )?;
        require_recomputed_match(
            "h_ext0",
            &handoff.certified_fields.h_ext_a_per_m,
            &observables.external_field,
        )?;
        require_recomputed_match(
            "h_eff0",
            &handoff.certified_fields.h_eff_a_per_m,
            &observables.effective_field,
        )?;
        observables.magnetization = state.magnetization().to_vec();
        observables.exchange_field = handoff.certified_fields.h_ex_a_per_m.clone();
        observables.demag_field = handoff.certified_fields.h_demag_a_per_m.clone();
        observables.external_field = handoff.certified_fields.h_ext_a_per_m.clone();
        observables.effective_field = handoff.certified_fields.h_eff_a_per_m.clone();
        observables.max_effective_field_amplitude = observables
            .effective_field
            .iter()
            .map(|field| vector_norm(*field))
            .fold(0.0_f64, f64::max);
        observables.max_demag_field_amplitude = observables
            .demag_field
            .iter()
            .map(|field| vector_norm(*field))
            .fold(0.0_f64, f64::max);
        observables.max_torque_Apm = observables
            .magnetization
            .iter()
            .zip(&observables.effective_field)
            .map(|(m, h)| vector_norm(cross(*m, *h)))
            .fold(0.0_f64, f64::max);
    }
    if std::env::var_os("FULLMAG_TRACE_CONTINUATION").is_some() {
        let max_exchange = observables
            .exchange_field
            .iter()
            .map(|field| vector_norm(*field))
            .fold(0.0_f64, f64::max);
        let max_demag = observables
            .demag_field
            .iter()
            .map(|field| vector_norm(*field))
            .fold(0.0_f64, f64::max);
        let max_external = observables
            .external_field
            .iter()
            .map(|field| vector_norm(*field))
            .fold(0.0_f64, f64::max);
        eprintln!(
            "[fullmag-trace] materialize-equilibrium: max_torque_apm={:.6e} max_h_eff_apm={:.6e} max_torque_relative={:.6e} max_exchange={:.6e} max_demag={:.6e} max_external={:.6e} steps={}",
            observables.max_torque_Apm,
            observables.max_effective_field_amplitude,
            observables.max_torque_Apm
                / observables.max_effective_field_amplitude.max(1.0),
            max_exchange,
            max_demag,
            max_external,
            steps_taken,
        );
    }
    let equilibrium = if source_relax_handoff.is_some() {
        let normalization_delta =
            max_vector_field_difference(state.magnetization(), initial_magnetization)
                .unwrap_or(f64::INFINITY);
        if !normalization_delta.is_finite() || normalization_delta > 1.0e-8 {
            return Err(RunError {
                message: format!(
                    "relax_stage_handoff_equilibrium_normalization_drift: state normalization changed the accepted m0 by {normalization_delta:.3e}"
                ),
            });
        }
        // FemLlgState normalizes each vector on construction.  The accepted
        // relaxation handoff is a stronger identity contract than that
        // internal representation: preserve its exact m0 for stage
        // continuation while using the normalized state for observations.
        initial_magnetization.to_vec()
    } else {
        state.magnetization().to_vec()
    };

    Ok((
        problem,
        equilibrium,
        steps_taken,
        observables,
        source_artifact,
    ))
}

pub(super) fn load_equilibrium_artifact_v7(
    path: &str,
    expected_len: usize,
) -> Result<LoadedEquilibriumArtifactV7, RunError> {
    let raw = std::fs::read_to_string(path).map_err(|error| RunError {
        message: format!("failed to read equilibrium artifact '{}': {}", path, error),
    })?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|error| RunError {
        message: format!("failed to parse equilibrium artifact '{}': {}", path, error),
    })?;
    let object = value.as_object().ok_or_else(|| RunError {
        message: format!(
            "equilibrium artifact '{}' must be a certified equilibrium_artifact.v7 object; raw vector payloads are rejected",
            path
        ),
    })?;
    let required_string = |name: &str| -> Result<&str, RunError> {
        object
            .get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| RunError {
                message: format!(
                    "equilibrium artifact '{}' is missing required v7 field '{}'",
                    path, name
                ),
            })
    };
    let schema_version = required_string("schema_version")?;
    if schema_version == "equilibrium_artifact.v6" {
        return Err(RunError {
            message: "equilibrium_artifact_v6_uncertified: rerun relaxation or migrate with source completion evidence"
                .to_string(),
        });
    }
    if schema_version != "equilibrium_artifact.v7" {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' must use schema equilibrium_artifact.v7",
                path
            ),
        });
    }
    if object
        .get("accepted_for_linearization")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' is not accepted for linearization",
                path
            ),
        });
    }
    for name in [
        "producer_run_id",
        "content_sha256",
        "equilibrium_id",
        "mesh_signature",
        "material_signature",
        "physics_signature",
        "boundary_signature",
        "static_demag_signature",
    ] {
        required_string(name)?;
    }
    let declared_content_sha256 = required_string("content_sha256")?.to_string();
    let declared_equilibrium_id = required_string("equilibrium_id")?.to_string();
    let mut digest_payload = value.clone();
    let digest_object = digest_payload
        .as_object_mut()
        .expect("the equilibrium artifact object was validated above");
    digest_object.remove("content_sha256");
    digest_object.remove("equilibrium_id");
    let recomputed_content_sha256 =
        shared_domain_content_digest("equilibrium_artifact_v7", &digest_payload)?;
    let expected_equilibrium_id = format!(
        "equilibrium_artifact.v7:{}",
        recomputed_content_sha256
            .strip_prefix("sha256:")
            .unwrap_or(&recomputed_content_sha256)
    );
    if declared_content_sha256 != recomputed_content_sha256
        || declared_equilibrium_id != expected_equilibrium_id
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has mismatched content_sha256 or equilibrium_id",
                path
            ),
        });
    }
    let acceptance_object = object
        .get("acceptance_certificate")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' is missing acceptance_certificate",
                path
            ),
        })?;
    let certificate_string = |name: &str| -> Result<&str, RunError> {
        acceptance_object
            .get(name)
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| RunError {
                message: format!(
                    "equilibrium artifact '{}' has invalid acceptance_certificate.{}",
                    path, name
                ),
            })
    };
    let criterion = certificate_string("criterion")?;
    let metric_kind = certificate_string("metric_kind")?;
    let unit = certificate_string("unit")?;
    let stop_reason = certificate_string("stop_reason")?;
    let coherent_certificate = matches!(
        (criterion, metric_kind, unit, stop_reason),
        ("torque", "max_torque_apm", "A/m", "torque")
            | ("energy", "total_energy_plateau_range_j", "J", "energy")
    );
    let metric_value = acceptance_object
        .get("metric_value")
        .and_then(serde_json::Value::as_f64);
    let threshold = acceptance_object
        .get("threshold")
        .and_then(serde_json::Value::as_f64);
    if !coherent_certificate
        || acceptance_object
            .get("status")
            .and_then(serde_json::Value::as_str)
            != Some("completed")
        || acceptance_object
            .get("converged")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
        || !matches!((metric_value, threshold), (Some(value), Some(limit)) if value.is_finite() && limit.is_finite() && limit >= 0.0 && value <= limit)
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has an invalid or unsatisfied acceptance_certificate",
                path
            ),
        });
    }
    let completion_sha256 = certificate_string("completion_sha256")?;
    if !is_sha256_digest(completion_sha256)
        || object
            .get("completion_sha256")
            .and_then(serde_json::Value::as_str)
            != Some(completion_sha256)
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has mismatched completion_sha256",
                path
            ),
        });
    }
    let acceptance_certificate: AcceptedEquilibriumCriterion = serde_json::from_value(
        serde_json::Value::Object(acceptance_object.clone()),
    )
    .map_err(|error| RunError {
        message: format!(
            "equilibrium artifact '{}' has invalid acceptance_certificate: {}",
            path, error
        ),
    })?;
    let observables = object
        .get("observables")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: format!("equilibrium artifact '{}' is missing observables", path),
        })?;
    for name in ["max_torque_Apm", "max_torque_T", "max_torque_relative"] {
        if observables
            .get(name)
            .and_then(serde_json::Value::as_f64)
            .is_none_or(|value| !value.is_finite())
        {
            return Err(RunError {
                message: format!(
                    "equilibrium artifact '{}' has invalid observable '{}'",
                    path, name
                ),
            });
        }
    }
    let representation_integrity = object
        .get("representation_integrity")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' is missing representation_integrity",
                path
            ),
        })?;
    let m0_norm_tolerance = representation_integrity
        .get("m0_norm_tolerance")
        .and_then(serde_json::Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' has invalid representation_integrity.m0_norm_tolerance",
                path
            ),
        })?;
    let parse_vector_field = |name: &str| -> Result<Vec<Vector3>, RunError> {
        let values = object
            .get(name)
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| RunError {
                message: format!(
                    "equilibrium artifact '{}' is missing required v7 field '{}'",
                    path, name
                ),
            })?;
        if values.len() != expected_len {
            return Err(RunError {
                message: format!(
                    "equilibrium artifact '{}' has invalid '{}' vector field",
                    path, name
                ),
            });
        }
        values
            .iter()
            .map(|entry| {
                let vector = entry.as_array().ok_or_else(|| RunError {
                    message: format!(
                        "equilibrium artifact '{}' has invalid '{}' vector field",
                        path, name
                    ),
                })?;
                if vector.len() != 3
                    || vector
                        .iter()
                        .any(|value| value.as_f64().is_none_or(|value| !value.is_finite()))
                {
                    return Err(RunError {
                        message: format!(
                            "equilibrium artifact '{}' has invalid '{}' vector field",
                            path, name
                        ),
                    });
                }
                Ok([
                    vector[0].as_f64().unwrap(),
                    vector[1].as_f64().unwrap(),
                    vector[2].as_f64().unwrap(),
                ])
            })
            .collect()
    };
    let h_eff0 = parse_vector_field("h_eff0_a_per_m")?;
    let h_demag0 = parse_vector_field("h_demag0_a_per_m")?;
    let phi0_requirement = required_string("phi0_requirement")?;
    if phi0_requirement != "required_for_restart_or_provenance" {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has unsupported phi0_requirement '{}'",
                path, phi0_requirement
            ),
        });
    }
    let phi0_values = object
        .get("phi0")
        .or_else(|| object.get("phi0_a"))
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' is missing required v6 phi0",
                path
            ),
        })?;
    if phi0_values.is_empty()
        || phi0_values
            .iter()
            .any(|value| value.as_f64().is_none_or(|value| !value.is_finite()))
    {
        return Err(RunError {
            message: format!("equilibrium artifact '{}' has invalid phi0", path),
        });
    }
    let certificate = object
        .get("periodic_mesh_certificate")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' is missing periodic mesh certificate",
                path
            ),
        })?;
    for name in ["certificate_id", "content_sha256"] {
        if certificate
            .get(name)
            .and_then(serde_json::Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(RunError {
                message: format!(
                    "equilibrium artifact '{}' has incomplete periodic mesh certificate",
                    path
                ),
            });
        }
    }
    if certificate
        .get("schema_version")
        .and_then(serde_json::Value::as_str)
        != Some("periodic_mesh_certificate.v6")
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' requires periodic_mesh_certificate.v6",
                path
            ),
        });
    }
    if certificate
        .get("certificate")
        .and_then(serde_json::Value::as_object)
        .is_none()
    {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has no complete periodic mesh certificate payload",
                path
            ),
        });
    }
    let certificate_id = certificate["certificate_id"].as_str().unwrap();
    let certificate_hash = certificate["content_sha256"].as_str().unwrap();
    let expected_certificate_id = format!(
        "periodic_mesh_certificate.v6:{}",
        certificate_hash.strip_prefix("sha256:").unwrap_or("")
    );
    if certificate_id != expected_certificate_id {
        return Err(RunError {
            message: format!(
                "equilibrium artifact '{}' has mismatched periodic mesh certificate identity",
                path
            ),
        });
    }
    let m0 = parse_vector_field("m0")?;
    let phi0 = phi0_values
        .iter()
        .map(|value| value.as_f64().unwrap())
        .collect::<Vec<_>>();
    let required_string_owned = |name: &str| required_string(name).map(str::to_string);
    let periodic_mesh_certificate = object
        .get("periodic_mesh_certificate")
        .cloned()
        .ok_or_else(|| RunError {
            message: format!(
                "equilibrium artifact '{}' is missing periodic mesh certificate",
                path
            ),
        })?;
    Ok(LoadedEquilibriumArtifactV7 {
        value: value.clone(),
        m0,
        h_eff0,
        h_demag0,
        phi0,
        equilibrium_id: required_string_owned("equilibrium_id")?,
        producer_run_id: required_string_owned("producer_run_id")?,
        content_sha256: required_string_owned("content_sha256")?,
        mesh_signature: required_string_owned("mesh_signature")?,
        material_signature: required_string_owned("material_signature")?,
        physics_signature: required_string_owned("physics_signature")?,
        boundary_signature: required_string_owned("boundary_signature")?,
        static_demag_signature: required_string_owned("static_demag_signature")?,
        demag_model: object
            .get("demag_model")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
            .unwrap_or("poisson_robin")
            .to_string(),
        m0_norm_tolerance,
        phi0_requirement: phi0_requirement.to_string(),
        periodic_mesh_certificate,
        acceptance_certificate,
        completion_sha256: completion_sha256.to_string(),
    })
}

fn load_equilibrium_artifact(path: &str, expected_len: usize) -> Result<Vec<Vector3>, RunError> {
    Ok(load_equilibrium_artifact_v7(path, expected_len)?.m0)
}
