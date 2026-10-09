//! Private FEM eigen-path manifest helpers.

use super::*;

pub(super) fn build_eigen_path_frequency_domain_manifest(
    engine: FemEngine,
    result: &crate::eigen::PathSolveResult,
    mode_artifacts: &[crate::types::AuxiliaryArtifact],
    plan: &FemEigenPlanIR,
    outputs: &[OutputIR],
) -> serde_json::Value {
    let wants_dispersion = eigen_path_wants_dispersion(outputs);
    let wants_branches = outputs.iter().any(|output| {
        matches!(
            output,
            OutputIR::DispersionCurve {
                include_branch_table: true,
                ..
            }
        )
    });
    let mut requested_outputs = Vec::new();
    if outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenSpectrum { .. }))
    {
        requested_outputs.push("spectrum");
    }
    if wants_branches {
        requested_outputs.push("branches");
    }
    if wants_dispersion {
        requested_outputs.push("dispersion");
    }
    if outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenMode { .. }))
    {
        requested_outputs.push("mode_fields");
    }
    if outputs
        .iter()
        .any(|output| matches!(output, OutputIR::EigenDiagnostics { .. }))
    {
        requested_outputs.push("diagnostics");
    }
    let mode_metadata_paths = eigen_path_mode_metadata_paths(mode_artifacts);
    let computed_sample_indices = result
        .samples
        .iter()
        .map(|sample| sample.sample.sample_index)
        .collect::<Vec<_>>();
    let r4_coverage = crate::fem::eigen_output::inspect_r4_sidecars(
        mode_artifacts,
        &computed_sample_indices,
    );
    let nonshared_floquet_coverage =
        crate::fem::eigen_output::inspect_nonshared_floquet_sidecars(
            mode_artifacts,
            &computed_sample_indices,
        );
    let nonshared_floquet_native_input_diagnostics_coverage =
        crate::fem::eigen_output::inspect_nonshared_floquet_native_input_diagnostics_sidecars(
            mode_artifacts,
            &computed_sample_indices,
        );
    let producer_provenance_v1_paths =
        crate::fem::eigen_output::sample_scoped_producer_provenance_paths(mode_artifacts);
    let producer_provenance_v1_path =
        (computed_sample_indices.len() == 1 && producer_provenance_v1_paths.len() == 1)
        .then(|| producer_provenance_v1_paths[0].clone());
    let equilibrium_artifact_v7_paths =
        eigen_path_state_metadata_paths(mode_artifacts, "equilibrium_artifact.v7.json");
    let linearization_state_v6_paths =
        eigen_path_state_metadata_paths(mode_artifacts, "linearization_state.v6.json");
    let equilibrium_artifact_v8_paths =
        eigen_path_state_metadata_paths(mode_artifacts, "equilibrium_artifact.v8.json");
    let linearization_state_v7_paths =
        eigen_path_state_metadata_paths(mode_artifacts, "linearization_state.v7.json");
    let r4_paths = |key: &str| {
        r4_coverage
            .paths_by_key
            .get(key)
            .cloned()
            .unwrap_or_default()
    };
    let accepted_fem_equilibrium_fields_v1_paths =
        r4_paths("accepted_fem_equilibrium_fields_v1_paths");
    let accepted_fem_equilibrium_fields_v2_paths =
        r4_paths("accepted_fem_equilibrium_fields_v2_paths");
    let linearization_identity_v2_paths = r4_paths("linearization_identity_v2_paths");
    let linearization_identity_preimage_v1_paths =
        r4_paths("linearization_identity_preimage_v1_paths");
    let certified_fem_equilibrium_fields_v1_paths =
        r4_paths("certified_fem_equilibrium_fields_v1_paths");
    let certified_fem_equilibrium_fields_v2_paths =
        r4_paths("certified_fem_equilibrium_fields_v2_paths");
    let recomputed_fem_linearization_certificate_v1_paths =
        r4_paths("recomputed_fem_linearization_certificate_v1_paths");
    let recomputed_fem_linearization_certificate_v2_paths =
        r4_paths("recomputed_fem_linearization_certificate_v2_paths");
    let mode_field_resources = mode_metadata_paths
        .iter()
        .filter_map(|path| parse_eigen_path_mode_metadata_path(path))
        .map(|(sample_index, raw_mode_index)| {
            format!(
                "/v2/sessions/current/analysis/frequency-domain/eigen/mode-field/{sample_index}/{raw_mode_index}/meta"
            )
        })
        .collect::<Vec<_>>();
    let sample_count = result.samples.len();
    let calculation_mode = eigen_path_calculation_mode(result);
    let (tracking_score_source, modal_overlap_available) =
        eigen_path_tracking_score_summary(result);
    let modal_overlap_unavailable_reason = if modal_overlap_available {
        serde_json::Value::Null
    } else {
        serde_json::json!("mode_vectors_not_carried_by_multi_k_orchestrator")
    };
    let mode_field_storage_format = eigen_path_mode_field_storage_format(mode_artifacts);
    let mode_zarr_available = mode_field_storage_format == "zarr";
    let mode_field_zarr_store_path = if mode_zarr_available {
        serde_json::json!("eigen/mode_fields.zarr")
    } else {
        serde_json::Value::Null
    };
    let device = match engine {
        FemEngine::CpuNative => "cpu",
        FemEngine::NativeGpu => "gpu",
    };
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
    let production_periodic_airbox_cpu =
        production_periodic_airbox_k0 && engine == FemEngine::CpuNative;
    let production_native_solver =
        production_shift_invert || production_gpu_k0_kittel || production_periodic_airbox_k0;
    let execution_provenance = eigen_path_sample_execution_provenance(result);
    let native_diagnostics = Some(&execution_provenance.common_diagnostics);
    let orchestrator_only_reference =
        execution_provenance.status == "orchestrator_only_reference";
    let orchestrator_reference_solver = result
        .samples
        .first()
        .map(|sample| sample.solver_model)
        .unwrap_or(result.solver_model);
    let requested_solver_method =
        eigen_path_nested_string(native_diagnostics, "requested_execution", "solver_method")
            .or_else(|| {
                (!execution_provenance.requested_solver_method_present).then(|| {
                    if production_periodic_airbox_k0 || production_shift_invert {
                        "targeted_spectrum".to_string()
                    } else {
                        "auto".to_string()
                    }
                })
            });
    let requested_preconditioner =
        eigen_path_nested_string(native_diagnostics, "requested_execution", "preconditioner")
            .or_else(|| {
                (!execution_provenance.requested_preconditioner_present)
                    .then(|| "not_applicable".to_string())
            });
    let requested_magnetostatic_bc = eigen_path_nested_string(
        native_diagnostics,
        "requested_execution",
        "magnetostatic_bc",
    )
    .or_else(|| {
        (!execution_provenance.requested_magnetostatic_bc_present).then(|| {
            if plan.operator.include_demag {
                fem_eigen::eigen_native_window::planned_magnetostatic_bc(plan).to_string()
            } else {
                "not_applicable".to_string()
            }
        })
    });
    let resolved_device =
        eigen_path_nested_string(native_diagnostics, "resolved_execution", "device")
            .or_else(|| orchestrator_only_reference.then(|| device.to_string()));
    let resolved_precision =
        eigen_path_nested_string(native_diagnostics, "resolved_execution", "precision")
            .or_else(|| orchestrator_only_reference.then(|| "double".to_string()));
    let resolved_engine =
        eigen_path_nested_string(native_diagnostics, "resolved_execution", "engine").or_else(|| {
            orchestrator_only_reference.then(|| {
                format!(
                    "multi_k_orchestrator/{}",
                    orchestrator_reference_solver.as_str()
                )
            })
        });
    let resolved_native_backend =
        eigen_path_nested_string(native_diagnostics, "resolved_execution", "native_backend")
            .or_else(|| orchestrator_only_reference.then(|| "runner_validation".to_string()));
    let resolved_reference_or_production = eigen_path_nested_string(
        native_diagnostics,
        "resolved_execution",
        "reference_or_production",
    )
    .or_else(|| orchestrator_only_reference.then(|| "reference".to_string()));
    let resolved_demag_realization =
        eigen_path_nested_string(native_diagnostics, "resolved_execution", "demag_realization")
            .or_else(|| {
                orchestrator_only_reference.then(|| {
                    if plan.operator.include_demag {
                        "requested".to_string()
                    } else {
                        "none".to_string()
                    }
                })
            });
    let resolved_solver_library =
        eigen_path_nested_string(native_diagnostics, "resolved_execution", "solver_library")
            .or_else(|| orchestrator_only_reference.then(|| "nalgebra".to_string()));
    let resolved_solver_algorithm = eigen_path_nested_string(
        native_diagnostics,
        "resolved_execution",
        "solver_algorithm",
    )
    .or_else(|| {
        orchestrator_only_reference
            .then(|| orchestrator_reference_solver.as_str().to_string())
    });
    let resolved_status =
        eigen_path_nested_string(native_diagnostics, "resolved_execution", "status");
    let resolved_implementation_id = eigen_path_nested_string(
        native_diagnostics,
        "resolved_execution",
        "implementation_id",
    );
    let resolved_device_residency = eigen_path_nested_string(
        native_diagnostics,
        "resolved_execution",
        "device_residency",
    )
    .or_else(|| {
        orchestrator_only_reference.then(|| {
            if engine == FemEngine::NativeGpu {
                "gpu_requested".to_string()
            } else {
                "host".to_string()
            }
        })
    });
    let resolved_operator_residency = eigen_path_nested_string(
        native_diagnostics,
        "resolved_execution",
        "operator_residency",
    );
    let resolved_vector_residency =
        eigen_path_nested_string(native_diagnostics, "resolved_execution", "vector_residency");
    let resolved_krylov_residency =
        eigen_path_nested_string(native_diagnostics, "resolved_execution", "krylov_residency");
    let resolved_preconditioner_residency = eigen_path_nested_string(
        native_diagnostics,
        "resolved_execution",
        "preconditioner_residency",
    );
    let resolved_fallback_used =
        eigen_path_nested_bool(native_diagnostics, "resolved_execution", "fallback_used");
    let resolved_fallback_reason =
        eigen_path_nested_string(native_diagnostics, "resolved_execution", "fallback_reason");
    let resolved_fallback_from_engine = eigen_path_nested_string(
        native_diagnostics,
        "resolved_execution",
        "fallback_from_engine",
    );
    let resolved_fallback_to_engine = eigen_path_nested_string(
        native_diagnostics,
        "resolved_execution",
        "fallback_to_engine",
    );
    let hardened_validation_state =
        eigen_path_diag_string(native_diagnostics, "validation_state");
    // An unvalidated scope token is not a validated scope in the manifest.
    let hardened_validated_scope = eigen_path_diag_string(native_diagnostics, "validated_scope");
    let hardened_boundary_gauge = eigen_path_known_object(native_diagnostics, "boundary_gauge");
    let hardened_spectral = eigen_path_known_object(native_diagnostics, "spectral");
    let mut manifest = serde_json::json!({
        "schema_version": "frequency_domain_manifest.v1",
        "analysis_family": "magnetic_frequency_domain",
        "study_product": "modal_eigen",
        "revision": format!(
            "eigen:{}:{}:{}",
            result.solver_model.as_str(),
            sample_count,
            mode_metadata_paths.len()
        ),
        "session_id": "current",
        "run_id": "current",
        "stage_id": "eigenmodes",
        "stage_kind": "eigenmodes",
        "created_at": eigen_path_created_at_label(),
        "requested_execution": {
            "calculation_mode": calculation_mode,
            "backend": "fem",
            "device": device,
            "precision": "double",
            "execution_mode": "extended",
            "ui_mode": "auto",
            "operator": "linearized_llg",
            "solver_family": "modal_eigen",
            "solve_equation": if production_periodic_airbox_k0 { "L_eff q = lambda B_qq q; phi(q) = -P^-1 A_phiq q" } else if production_native_solver { "A q = lambda B q; lambda = i omega" } else { "K u = lambda M u; omega_rad_s = gamma0 * max(lambda, 0)" },
            "include_demag": plan.operator.include_demag,
            "damping_policy": format!("{:?}", plan.damping_policy).to_lowercase(),
            "equilibrium_source": format!("{:?}", plan.equilibrium).to_lowercase(),
            // A multi-sample k=0 bias-field sweep is not a Bloch/Floquet path.
            "k_sampling": if calculation_mode == "dispersion_modal" { "path" } else { "single" },
            "outputs": requested_outputs,
            "solver_method": requested_solver_method,
            "preconditioner": requested_preconditioner,
            "magnetostatic_bc": requested_magnetostatic_bc,
        },
        "resolved_execution": {
            "backend": "fem",
            "device": resolved_device,
            "precision": resolved_precision,
            "engine": resolved_engine,
            "native_backend": resolved_native_backend,
            "reference_or_production": resolved_reference_or_production,
            "container_image": null,
            "build_features": [],
            "demag_realization": resolved_demag_realization,
            "solver_library": resolved_solver_library,
            "solver_algorithm": resolved_solver_algorithm,
            "solve_kind": "modal_eigen",
            "device_residency": resolved_device_residency,
        },
        "sample_execution_provenance": execution_provenance.manifest_value.clone(),
        "physics": {
            "analysis_family": "magnetic_frequency_domain",
            "llg_gamma0_si": null,
            "llg_alpha": null,
            "phase_convention": eigen_path_diag_string(native_diagnostics, "phasor_convention"),
            "frequency_units": "Hz",
            "field_units": "dimensionless_delta_m",
            "normalization": format!("{:?}", plan.normalization).to_lowercase(),
            "spin_wave_bc": format!("{:?}", plan.spin_wave_bc.kind()).to_lowercase(),
            "periodic_or_floquet": if calculation_mode == "dispersion_modal" { "bloch_or_path_sampling" } else { "none" },
            "equilibrium_residual_summary": null,
            "response_map_axes": [],
        },
        "artifacts": {
            "solver_diagnostics_path": "eigen/diagnostics/solver.v1.json",
            "spectrum_v2_path": "eigen/spectrum.v2.json",
            "branches_v2_path": if wants_branches { serde_json::json!("eigen/branches.v2.json") } else { serde_json::Value::Null },
            "dispersion_csv_path": if wants_dispersion { serde_json::json!("eigen/dispersion.csv") } else { serde_json::Value::Null },
            "eigen_diagnostics_v2_path": "eigen/diagnostics.v2.json",
            "response_sweep_v1_path": null,
            "response_sweep_v2_path": null,
            "response_map_v1_path": null,
            "response_map_v2_path": null,
            "response_diagnostics_v1_path": null,
            "response_progress_v1_path": null,
            "response_cancel_requested_v1_path": null,
            "mode_field_zarr_store_path": mode_field_zarr_store_path,
            "mode_field_storage_format": mode_field_storage_format,
            "mode_metadata_paths": mode_metadata_paths,
            "equilibrium_artifact_v7_paths": equilibrium_artifact_v7_paths,
            "linearization_state_v6_paths": linearization_state_v6_paths,
            "accepted_fem_equilibrium_fields_v1_paths": accepted_fem_equilibrium_fields_v1_paths,
            "accepted_fem_equilibrium_fields_v2_paths": accepted_fem_equilibrium_fields_v2_paths,
            "linearization_identity_v2_paths": linearization_identity_v2_paths,
            "linearization_identity_preimage_v1_paths": linearization_identity_preimage_v1_paths,
            "linearization_identity_sha256_by_sample": r4_coverage.identity_content_sha256_by_sample.clone(),
            "producer_provenance_v1_path": producer_provenance_v1_path,
            "producer_provenance_v1_paths": producer_provenance_v1_paths,
            "certified_fem_equilibrium_fields_v1_paths": certified_fem_equilibrium_fields_v1_paths,
            "certified_fem_equilibrium_fields_v2_paths": certified_fem_equilibrium_fields_v2_paths,
            "recomputed_fem_linearization_certificate_v1_paths": recomputed_fem_linearization_certificate_v1_paths,
            "recomputed_fem_linearization_certificate_v2_paths": recomputed_fem_linearization_certificate_v2_paths,
            "frequency_point_paths": [],
        },
        "resources": {
            "spectrum_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/spectrum.v2",
            "branches_resource_key": if wants_branches { serde_json::json!("/v2/sessions/current/analysis/frequency-domain/eigen/branches.v2") } else { serde_json::Value::Null },
            "dispersion_resource_key": if wants_dispersion { serde_json::json!("/v2/sessions/current/analysis/frequency-domain/eigen/dispersion") } else { serde_json::Value::Null },
            "diagnostics_resource_key": null,
            "eigen_diagnostics_resource_key": "/v2/sessions/current/analysis/frequency-domain/eigen/diagnostics.v2",
            "response_sweep_resource_key": null,
            "response_map_resource_key": null,
            "response_progress_resource_key": null,
            "response_cancel_requested_resource_key": null,
            "response_diagnostics_resource_key": null,
            "mode_field_resources": mode_field_resources,
            "response_field_resources": [],
        },
        "validation": {
            "dispersion_validation": if calculation_mode == "dispersion_modal" { result.dispersion_validation.as_ref() } else { None },
            "k0_kittel_validation": result.k0_kittel_validation.as_ref(),
            "dispersion_frequency_source": if calculation_mode == "dispersion_modal" { eigen_path_dispersion_frequency_source(result) } else { serde_json::Value::Null },
            "dispersion_reference_model": if calculation_mode == "dispersion_modal" { eigen_path_dispersion_reference_model(result) } else { serde_json::Value::Null },
            "dynamic_demag_operator_source": if calculation_mode == "dispersion_modal" { eigen_path_dynamic_demag_operator_source(result) } else { serde_json::Value::Null },
        },
        "diagnostics": {
            "status": "ready",
            "complete": true,
            "requested_frequency_point_count": sample_count,
            "completed_frequency_point_count": sample_count,
            "written_frequency_point_artifacts": 0,
            "tracking_score_source": tracking_score_source,
            "modal_overlap_available": modal_overlap_available,
            "modal_overlap_unavailable_reason": modal_overlap_unavailable_reason,
            "interrupted": false,
            "r4_replay": r4_coverage.manifest_value(),
            "nonshared_floquet_replay": nonshared_floquet_coverage.manifest_value(),
            "nonshared_floquet_native_input_diagnostics_replay": nonshared_floquet_native_input_diagnostics_coverage.manifest_value(),
        },
        "capabilities": {
            "driven_response_artifact_available": false,
            "modal_artifact_available": true,
            "production_native_solver_available": production_native_solver,
            "validation_artifact": !production_native_solver && engine == FemEngine::CpuNative,
            "dispersion": eigen_path_dispersion_capabilities(
                production_shift_invert || production_periodic_airbox_cpu,
                production_gpu_k0_kittel || production_periodic_airbox_gpu,
                production_periodic_airbox_k0,
            ),
        },
    });
    if let Some(artifacts) = manifest
        .get_mut("artifacts")
        .and_then(Value::as_object_mut)
    {
        if !r4_coverage.has_any_sidecars {
            for (key, _, _) in crate::fem::eigen_output::R4_SIDECAR_DEFINITIONS {
                artifacts.remove(key);
            }
            artifacts.remove("linearization_identity_sha256_by_sample");
        } else {
            for (key, _, _) in crate::fem::eigen_output::R4_SIDECAR_DEFINITIONS {
                let paths = r4_coverage
                    .paths_by_key
                    .get(key)
                    .cloned()
                    .unwrap_or_default();
                artifacts.insert(key.to_string(), serde_json::json!(paths));
            }
            let consumer_plan_paths = r4_coverage
                .paths_by_key
                .get("consumer_plan_snapshot_v1_paths")
                .cloned()
                .unwrap_or_default();
            artifacts.insert(
                "consumer_plan_snapshot_v1_path".to_string(),
                consumer_plan_paths
                    .first()
                    .filter(|_| consumer_plan_paths.len() == 1)
                    .map_or(serde_json::Value::Null, |path| serde_json::json!(path)),
            );
            artifacts.insert(
                "linearization_identity_sha256_by_sample".to_string(),
                serde_json::json!(r4_coverage.identity_content_sha256_by_sample.clone()),
            );
        }
        if nonshared_floquet_coverage.has_any_sidecars {
            // Preserve the historical three-sidecar selector and aliases.
            for (key, _, alias) in
                crate::fem::eigen_output::NONSHARED_FLOQUET_SIDECAR_DEFINITIONS
            {
                let paths = nonshared_floquet_coverage
                    .paths_by_key
                    .get(key)
                    .cloned()
                    .unwrap_or_default();
                artifacts.insert(key.to_string(), serde_json::json!(paths));
                artifacts.insert(
                    alias.to_string(),
                    paths
                        .first()
                        .filter(|_| {
                            nonshared_floquet_coverage.structural_complete && paths.len() == 1
                        })
                        .map_or(serde_json::Value::Null, |path| serde_json::json!(path)),
                );
            }
        }
        if nonshared_floquet_native_input_diagnostics_coverage.has_any_sidecars {
            // The final C ABI diagnostic pair is additive structural evidence;
            // it is kept separate from historical three-sidecar coverage.
            for (key, _, alias) in crate::fem::eigen_output::
                NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SIDECAR_DEFINITIONS
            {
                let paths = nonshared_floquet_native_input_diagnostics_coverage
                    .paths_by_key
                    .get(key)
                    .cloned()
                    .unwrap_or_default();
                artifacts.insert(key.to_string(), serde_json::json!(paths));
                artifacts.insert(
                    alias.to_string(),
                    paths
                        .first()
                        .filter(|_| {
                            nonshared_floquet_native_input_diagnostics_coverage
                                .structural_complete
                                && paths.len() == 1
                        })
                        .map_or(serde_json::Value::Null, |path| serde_json::json!(path)),
                );
            }
        }
    }
    if let Some(resolved) = manifest
        .get_mut("resolved_execution")
        .and_then(Value::as_object_mut)
    {
        let optional_fields = [
            ("status", resolved_status.map(Value::String)),
            (
                "implementation_id",
                resolved_implementation_id.map(Value::String),
            ),
            (
                "operator_residency",
                resolved_operator_residency.map(Value::String),
            ),
            (
                "vector_residency",
                resolved_vector_residency.map(Value::String),
            ),
            (
                "krylov_residency",
                resolved_krylov_residency.map(Value::String),
            ),
            (
                "preconditioner_residency",
                resolved_preconditioner_residency.map(Value::String),
            ),
            ("fallback_used", resolved_fallback_used.map(Value::Bool)),
            (
                "fallback_reason",
                resolved_fallback_reason.map(Value::String),
            ),
            (
                "fallback_from_engine",
                resolved_fallback_from_engine.map(Value::String),
            ),
            (
                "fallback_to_engine",
                resolved_fallback_to_engine.map(Value::String),
            ),
        ];
        for (key, value) in optional_fields {
            resolved.insert(key.to_string(), value.unwrap_or(Value::Null));
        }
    }
    let hardened_fields = [
        (
            "physics_contract_version",
            eigen_path_diag_string(native_diagnostics, "physics_contract_version")
                .map(Value::String),
        ),
        (
            "operator_dictionary_version",
            eigen_path_diag_string(native_diagnostics, "operator_dictionary_version")
                .map(Value::String),
        ),
        (
            "implementation_state",
            eigen_path_diag_string(native_diagnostics, "implementation_state").map(Value::String),
        ),
        (
            "validation_state",
            hardened_validation_state.clone().map(Value::String),
        ),
        (
            "validated_scope",
            hardened_validated_scope.map(Value::String),
        ),
        (
            "assembly_kind",
            eigen_path_diag_string(native_diagnostics, "assembly_kind").map(Value::String),
        ),
        (
            "operator_input_signature_sha256",
            eigen_path_diag_string(native_diagnostics, "operator_input_signature_sha256")
                .map(Value::String),
        ),
        ("boundary_gauge", hardened_boundary_gauge),
        ("spectral", hardened_spectral),
        (
            "phase_constraint_sha256",
            eigen_path_diag_string(native_diagnostics, "phase_constraint_sha256")
                .map(Value::String),
        ),
        (
            "equilibrium_artifact_sha256",
            eigen_path_diag_string(native_diagnostics, "equilibrium_artifact_sha256")
                .map(Value::String),
        ),
        (
            "linearization_state_sha256",
            eigen_path_diag_string(native_diagnostics, "linearization_state_sha256")
                .map(Value::String),
        ),
        (
            "periodic_mesh_certificate_sha256",
            eigen_path_diag_string(native_diagnostics, "periodic_mesh_certificate_sha256")
                .map(Value::String),
        ),
    ];
    if let Some(manifest_object) = manifest.as_object_mut() {
        for (key, value) in hardened_fields {
            manifest_object.insert(key.to_string(), value.unwrap_or(Value::Null));
        }
    }
    if !production_shift_invert {
        if let (Some(reason), Some(diagnostics)) = (
            native_cpu_modal_window_rejection_reason,
            manifest
                .get_mut("diagnostics")
                .and_then(serde_json::Value::as_object_mut),
        ) {
            diagnostics.insert(
                "production_cpu_rejection_reason".to_string(),
                serde_json::json!(reason),
            );
            diagnostics.insert(
                "production_cpu_rejection_scope".to_string(),
                serde_json::json!(fem_eigen::native_cpu_modal_window_rejection_scope(reason)),
            );
            fem_eigen::insert_native_cpu_modal_window_rejection_contract(diagnostics, reason);
        }
    } else if let Some(diagnostics) = manifest
        .get_mut("diagnostics")
        .and_then(serde_json::Value::as_object_mut)
    {
        if let Some(certificate) = eigen_path_floquet_periodic_mesh_certificate(plan) {
            diagnostics.insert("periodic_mesh_certificate".to_string(), certificate);
        }
    }
    if !equilibrium_artifact_v8_paths.is_empty() || !linearization_state_v7_paths.is_empty() {
        manifest["artifacts"]["equilibrium_artifact_v8_paths"] =
            serde_json::json!(equilibrium_artifact_v8_paths);
        manifest["artifacts"]["linearization_state_v7_paths"] =
            serde_json::json!(linearization_state_v7_paths);
    }
    manifest
}

pub(super) fn eigen_path_periodic_airbox_k0_metrics_from_single_k_artifacts(
    plan: &FemEigenPlanIR,
    artifacts: &[AuxiliaryArtifact],
) -> Result<Option<crate::eigen::K0KittelPeriodicAirboxDemagMetrics>, RunError> {
    let Some(input) = eigen_path_periodic_airbox_k0_metrics_input_from_plan(plan)? else {
        return Ok(None);
    };
    let diagnostics = artifacts
        .iter()
        .find(|artifact| artifact.relative_path == "eigen/diagnostics/solver.v1.json")
        .ok_or_else(|| RunError {
            message: "K0-3 periodic_airbox_k0 validation requires native solver diagnostics"
                .to_string(),
        })?;
    let raw = std::str::from_utf8(&diagnostics.bytes).map_err(|error| RunError {
        message: format!("native solver diagnostics are not valid UTF-8: {error}"),
    })?;
    fem_eigen::native_poisson_airbox_k0_metrics_from_result_json(raw, input).map(Some)
}

pub(super) fn eigen_path_merge_periodic_airbox_k0_metrics(
    slot: &mut Option<crate::eigen::K0KittelPeriodicAirboxDemagMetrics>,
    metrics: crate::eigen::K0KittelPeriodicAirboxDemagMetrics,
) -> Result<(), RunError> {
    let Some(existing) = slot.as_mut() else {
        *slot = Some(metrics);
        return Ok(());
    };
    if existing.phi_dof_count != metrics.phi_dof_count
        || existing.augmented_phi_dof_count != metrics.augmented_phi_dof_count
        || existing.magnetic_pair_count != metrics.magnetic_pair_count
        || existing.airbox_pair_count != metrics.airbox_pair_count
    {
        return Err(RunError {
            message: "K0-3 periodic_airbox_k0 sweep produced inconsistent Poisson-airbox DOF or pair counts".to_string(),
        });
    }
    if relative_difference(existing.mesh_resolution_m, metrics.mesh_resolution_m) > 1.0e-12
        || relative_difference(existing.airbox_size_m, metrics.airbox_size_m) > 1.0e-12
        || relative_difference(
            existing.effective_magnetisation_a_per_m,
            metrics.effective_magnetisation_a_per_m,
        ) > 1.0e-12
    {
        return Err(RunError {
            message: "K0-3 periodic_airbox_k0 sweep produced inconsistent mesh, airbox, or effective magnetisation metrics".to_string(),
        });
    }
    existing.poisson_constraint_relative_residual = existing
        .poisson_constraint_relative_residual
        .max(metrics.poisson_constraint_relative_residual);
    existing.relative_kittel_frequency_error = existing
        .relative_kittel_frequency_error
        .max(metrics.relative_kittel_frequency_error);
    Ok(())
}

fn relative_difference(lhs: f64, rhs: f64) -> f64 {
    (lhs - rhs).abs() / lhs.abs().max(rhs.abs()).max(f64::MIN_POSITIVE)
}

pub(super) fn eigen_path_periodic_airbox_k0_metrics_input_from_plan(
    plan: &FemEigenPlanIR,
) -> Result<Option<fem_eigen::NativePoissonAirboxK0MetricsInput>, RunError> {
    let Some(validation) = plan.k0_kittel_validation.as_ref() else {
        return Ok(None);
    };
    if validation.case_id.as_deref() != Some("K0-3")
        || validation.demag_kind.as_deref() != Some("periodic_airbox_k0")
    {
        return Ok(None);
    }
    let effective_magnetisation = validation
        .material
        .effective_magnetisation
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| RunError {
            message: "K0-3 periodic_airbox_k0 validation requires positive effective_magnetisation"
                .to_string(),
        })?;
    let airbox_size_m = eigen_path_airbox_size_m(plan)?;
    let (magnetic_pair_count, airbox_pair_count) =
        eigen_path_periodic_domain_node_pair_counts(&plan.mesh);
    Ok(Some(fem_eigen::NativePoissonAirboxK0MetricsInput {
        mesh_resolution_m: plan.hmax,
        airbox_size_m,
        magnetic_pair_count,
        airbox_pair_count,
        effective_magnetisation_a_per_m: effective_magnetisation,
    }))
}

pub(super) fn eigen_path_airbox_size_m(plan: &FemEigenPlanIR) -> Result<f64, RunError> {
    let factor = plan
        .air_box_config
        .as_ref()
        .map(|config| config.factor)
        .filter(|value| value.is_finite() && *value > 0.0)
        .ok_or_else(|| RunError {
            message: "K0-3 periodic_airbox_k0 validation requires positive air_box_config.factor"
                .to_string(),
        })?;
    let mut min_corner = [f64::INFINITY; 3];
    let mut max_corner = [f64::NEG_INFINITY; 3];
    for node in &plan.mesh.nodes {
        for axis in 0..3 {
            min_corner[axis] = min_corner[axis].min(node[axis]);
            max_corner[axis] = max_corner[axis].max(node[axis]);
        }
    }
    let max_extent = (0..3)
        .map(|axis| max_corner[axis] - min_corner[axis])
        .filter(|extent| extent.is_finite() && *extent > 0.0)
        .fold(0.0_f64, f64::max);
    if !(max_extent.is_finite() && max_extent > 0.0) {
        return Err(RunError {
            message: "K0-3 periodic_airbox_k0 validation requires positive mesh extent".to_string(),
        });
    }
    Ok(max_extent * factor)
}

pub(super) fn eigen_path_periodic_domain_node_pair_counts(mesh: &fullmag_ir::MeshIR) -> (u64, u64) {
    let mut magnetic_nodes = BTreeSet::new();
    let mut airbox_nodes = BTreeSet::new();
    for cell in mesh.cells.iter() {
        let marker = mesh.element_markers.get(cell.ordinal).copied().unwrap_or(1);
        let target = if marker == 0 {
            &mut airbox_nodes
        } else {
            &mut magnetic_nodes
        };
        target.extend(cell.nodes.iter().copied());
    }
    let mut magnetic_count = 0_u64;
    let mut airbox_count = 0_u64;
    for pair in &mesh.periodic_node_pairs {
        let a_magnetic = magnetic_nodes.contains(&pair.node_a);
        let b_magnetic = magnetic_nodes.contains(&pair.node_b);
        let a_airbox = airbox_nodes.contains(&pair.node_a);
        let b_airbox = airbox_nodes.contains(&pair.node_b);
        if a_magnetic && b_magnetic {
            magnetic_count += 1;
        } else if !a_magnetic && !b_magnetic && (a_airbox || b_airbox) {
            airbox_count += 1;
        }
    }
    (magnetic_count, airbox_count)
}

pub(super) fn append_eigen_path_k0_kittel_validation_artifacts(
    auxiliary_artifacts: &mut Vec<AuxiliaryArtifact>,
    result: &crate::eigen::PathSolveResult,
) -> Result<(), RunError> {
    let artifacts = crate::eigen::artifacts::k0_kittel_validation_auxiliary_artifacts(result)
        .map_err(|error| RunError {
            message: format!("failed to build k0 Kittel validation artifacts: {error}"),
        })?;
    auxiliary_artifacts.extend(artifacts);
    Ok(())
}

pub(super) fn eigen_path_dispersion_frequency_source(
    result: &crate::eigen::PathSolveResult,
) -> serde_json::Value {
    let native_production = matches!(
        result.solver_model,
        crate::eigen::EigenSolverModel::ProductionCpuShiftInvert
            | crate::eigen::EigenSolverModel::ProductionGpuDenseK0Macrospin
            | crate::eigen::EigenSolverModel::ProductionGpuModalDeviceKrylov
    );
    // Validation metadata is postsolve comparison intent. It must never select
    // an analytic solver or change the native FEM execution path.
    if result.dispersion_validation.is_some() {
        return serde_json::json!("numeric_modal_solver_with_analytic_comparison");
    }
    if native_production {
        return serde_json::json!("numeric_modal_solver");
    }
    serde_json::Value::Null
}

pub(super) fn eigen_path_dispersion_reference_model(
    result: &crate::eigen::PathSolveResult,
) -> serde_json::Value {
    if result.dispersion_validation.is_none() {
        return serde_json::Value::Null;
    }
    result
        .dispersion_validation
        .as_ref()
        .map(|validation| serde_json::json!(validation.analytic_model))
        .unwrap_or(serde_json::Value::Null)
}

pub(super) fn eigen_path_dynamic_demag_operator_source(
    result: &crate::eigen::PathSolveResult,
) -> serde_json::Value {
    let native_production = matches!(
        result.solver_model,
        crate::eigen::EigenSolverModel::ProductionCpuShiftInvert
            | crate::eigen::EigenSolverModel::ProductionGpuModalDeviceKrylov
    );
    if result.dispersion_validation.is_none() && !(result.include_demag && native_production) {
        return serde_json::Value::Null;
    }
    serde_json::json!("numeric_modal_solver")
}

pub(super) fn eigen_path_capability(status: &str, reason: &str) -> serde_json::Value {
    serde_json::json!({
        "status": status,
        "reason": reason,
    })
}

pub(super) fn eigen_path_dispersion_capabilities(
    production_shift_invert: bool,
    production_gpu: bool,
    production_periodic_airbox_k0: bool,
) -> serde_json::Value {
    let reference_reason =
        "reference/MVP FEM modal k-path dispersion emits spectrum, branches, dispersion.csv, and mode-field artifacts on the CPU reference lane";
    let production_cpu_reason = if production_periodic_airbox_k0 && production_shift_invert {
        "managed native CPU K0 periodic-airbox selected-spectrum lane is executable for the bounded K0-3 field-sweep scope"
    } else if production_shift_invert {
        "managed native CPU selected-spectrum no-demag Full2x2 Floquet k-path dispersion is executable for the labelled Bloch/Floquet tangent payload slice; dynamic demag-k, broader sparse/matrix-free validation, and production GPU remain gated"
    } else {
        "native CPU selected-spectrum modal k-path is not the resolved lane for this artifact; production evidence must come from the managed selected-spectrum gate"
    };
    let production_gpu_reason = if production_periodic_airbox_k0 && production_gpu {
        "managed native GPU K0 periodic-airbox modal lane uses the device-resident Arnoldi shift-invert engine; executed-device physics and parity qualification remain evidence-gated"
    } else if production_gpu {
        "managed native GPU K0 no-demag macrospin/Kittel modal slice is executable through cuSolverDN dense generalized solve; nonzero-k Floquet, demag-k, and broad sparse/matrix-free GPU modal eigensolve remain gated"
    } else {
        "native modal GPU dispersion is unavailable until a real modal GPU eigensolver and matching Floquet operator exist; driven-response GPU Floquet smoke must not be reused as modal dispersion"
    };
    serde_json::json!({
        "reference_cpu": eigen_path_capability("reference_executable", reference_reason),
        "production_cpu": eigen_path_capability(
            if production_shift_invert { "partial_production_executable" } else { "unsupported" },
            production_cpu_reason,
        ),
        "production_cpu_gamma_k_path": eigen_path_capability(
            "partial_production_executable",
            "managed production CPU selected-spectrum adapter is validated for gamma-equivalent k-path samples; this is a provenance bridge and not nonzero-k Bloch/Floquet dispersion",
        ),
        "production_gpu": eigen_path_capability(
            if production_gpu { "partial_production_executable" } else { "unsupported" },
            production_gpu_reason,
        ),
        "k_path": eigen_path_capability("reference_executable", "runner FEM eigen path emits dispersion.csv"),
        "branch_tracking": eigen_path_capability("reference_executable", "runner FEM eigen path emits branches.v2 artifacts"),
    })
}

pub(super) fn eigen_path_mode_field_storage_format(
    artifacts: &[crate::types::AuxiliaryArtifact],
) -> &'static str {
    if artifacts.iter().any(|artifact| {
        artifact.relative_path == "eigen/mode_fields.zarr/.zgroup" && !artifact.bytes.is_empty()
    }) {
        "zarr"
    } else if artifacts.iter().any(|artifact| {
        artifact.relative_path.starts_with("eigen/mode_fields/sample_")
            && artifact.relative_path.ends_with("/vector.bin")
            && !artifact.bytes.is_empty()
    }) {
        "binary_compatibility_exports"
    } else {
        "none"
    }
}

pub(super) fn eigen_path_mode_metadata_paths(
    mode_artifacts: &[crate::types::AuxiliaryArtifact],
) -> Vec<String> {
    let mut paths = mode_artifacts
        .iter()
        .filter_map(|artifact| {
            parse_eigen_path_mode_metadata_path(&artifact.relative_path)
                .map(|_| artifact.relative_path.clone())
        })
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

pub(super) fn eigen_path_state_metadata_paths(
    mode_artifacts: &[crate::types::AuxiliaryArtifact],
    state_name: &str,
) -> Vec<String> {
    let mut paths = mode_artifacts
        .iter()
        .filter_map(|artifact| {
            crate::fem::eigen_output::canonical_sample_scoped_index(
                &artifact.relative_path,
                state_name,
            )
            .map(|_| artifact.relative_path.clone())
        })
        .collect::<Vec<_>>();
    paths.sort_by_key(|path| {
        crate::fem::eigen_output::canonical_sample_scoped_index(path, state_name)
            .unwrap_or(usize::MAX)
    });
    paths
}

fn parse_eigen_path_mode_metadata_path(relative_path: &str) -> Option<(usize, usize)> {
    let rest = relative_path.strip_prefix("eigen/modes/")?;
    let (sample_part, mode_part) = rest.split_once('/')?;
    let sample_index = sample_part.strip_prefix("sample_")?.parse().ok()?;
    let raw_mode_index = mode_part
        .strip_prefix("mode_")?
        .strip_suffix(".json")?
        .parse()
        .ok()?;
    Some((sample_index, raw_mode_index))
}

pub(super) fn eigen_path_calculation_mode(result: &crate::eigen::PathSolveResult) -> &'static str {
    // `path_s` can be the coordinate of a bias-field sweep.  Dispersion is
    // published only when the solved samples contain a non-zero k vector.
    if result.samples.iter().any(|sample| {
        sample
            .sample
            .k_vector
            .iter()
            .any(|component| *component != 0.0)
    }) {
        "dispersion_modal"
    } else {
        "free_modes"
    }
}

pub(super) fn eigen_path_created_at_label() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| format!("unix:{}", duration.as_secs()))
        .unwrap_or_else(|_| "unix:0".to_string())
}

struct EigenPathSampleExecutionProvenance {
    common_diagnostics: Value,
    manifest_value: Value,
    status: &'static str,
    requested_solver_method_present: bool,
    requested_preconditioner_present: bool,
    requested_magnetostatic_bc_present: bool,
}

fn eigen_path_sample_execution_provenance(
    result: &crate::eigen::PathSolveResult,
) -> EigenPathSampleExecutionProvenance {
    let diagnostics = result
        .samples
        .iter()
        .map(eigen_path_sample_native_modal_diagnostics)
        .collect::<Vec<_>>();
    let diagnostics_available_count = diagnostics.iter().filter(|entry| entry.is_some()).count();
    let sample_records = result
        .samples
        .iter()
        .zip(diagnostics.iter().copied())
        .map(|(sample, diagnostics)| {
            let validation_state = eigen_path_diag_string(diagnostics, "validation_state");
            let validated_scope = validation_state
                .as_deref()
                .filter(|state| *state != "unvalidated")
                .and_then(|_| eigen_path_diag_string(diagnostics, "validated_scope"));
            let source = if diagnostics.is_some() {
                "sample_solver_diagnostics"
            } else if eigen_path_is_reference_solver_model(sample.solver_model) {
                "orchestrator_only_reference"
            } else {
                "missing"
            };
            let root_diagnostics = sample.solver_diagnostics.as_ref();
            let binding_value = |key| {
                eigen_path_diag_string(diagnostics, key)
                    .or_else(|| eigen_path_diag_string(root_diagnostics, key))
            };
            serde_json::json!({
                "sample_index": sample.sample.sample_index,
                "label": sample.sample.label,
                "k_vector": sample.sample.k_vector,
                "solver_model": sample.solver_model.as_str(),
                "diagnostics_available": diagnostics.is_some(),
                "source": source,
                "sample_binding": {
                    "relax_to_eigen_handoff_sha256": binding_value("relax_to_eigen_handoff_sha256"),
                    "relax_to_eigen_source_mesh_topology_sha256": binding_value("relax_to_eigen_source_mesh_topology_sha256"),
                    "source_mesh_topology_sha256": binding_value("source_mesh_topology_sha256"),
                },
                "solver_adapter": eigen_path_diag_string(diagnostics, "solver_adapter"),
                "execution_lane": eigen_path_diag_string(diagnostics, "execution_lane"),
                "requested_execution": {
                    "solver_method": eigen_path_nested_string(diagnostics, "requested_execution", "solver_method"),
                    "preconditioner": eigen_path_nested_string(diagnostics, "requested_execution", "preconditioner"),
                    "magnetostatic_bc": eigen_path_nested_string(diagnostics, "requested_execution", "magnetostatic_bc"),
                },
                "resolved_execution": {
                    "device": eigen_path_nested_string(diagnostics, "resolved_execution", "device"),
                    "precision": eigen_path_nested_string(diagnostics, "resolved_execution", "precision"),
                    "engine": eigen_path_nested_string(diagnostics, "resolved_execution", "engine"),
                    "native_backend": eigen_path_nested_string(diagnostics, "resolved_execution", "native_backend"),
                    "reference_or_production": eigen_path_nested_string(diagnostics, "resolved_execution", "reference_or_production"),
                    "demag_realization": eigen_path_nested_string(diagnostics, "resolved_execution", "demag_realization"),
                    "solver_library": eigen_path_nested_string(diagnostics, "resolved_execution", "solver_library"),
                    "solver_algorithm": eigen_path_sample_solver_algorithm(diagnostics),
                    "implementation_id": eigen_path_nested_string(diagnostics, "resolved_execution", "implementation_id"),
                    "status": eigen_path_nested_string(diagnostics, "resolved_execution", "status"),
                    "device_residency": eigen_path_nested_string(diagnostics, "resolved_execution", "device_residency"),
                    "operator_residency": eigen_path_nested_string(diagnostics, "resolved_execution", "operator_residency"),
                    "vector_residency": eigen_path_nested_string(diagnostics, "resolved_execution", "vector_residency"),
                    "krylov_residency": eigen_path_nested_string(diagnostics, "resolved_execution", "krylov_residency"),
                    "preconditioner_residency": eigen_path_nested_string(diagnostics, "resolved_execution", "preconditioner_residency"),
                    "fallback_used": eigen_path_nested_bool(diagnostics, "resolved_execution", "fallback_used"),
                    "fallback_reason": eigen_path_nested_string(diagnostics, "resolved_execution", "fallback_reason"),
                    "fallback_from_engine": eigen_path_nested_string(diagnostics, "resolved_execution", "fallback_from_engine"),
                    "fallback_to_engine": eigen_path_nested_string(diagnostics, "resolved_execution", "fallback_to_engine"),
                },
                "phasor_convention": eigen_path_diag_string(diagnostics, "phasor_convention"),
                "spin_wave_phase_convention": eigen_path_diag_string(diagnostics, "phase_convention"),
                "validation": {
                    "physics_contract_version": eigen_path_diag_string(diagnostics, "physics_contract_version"),
                    "operator_dictionary_version": eigen_path_diag_string(diagnostics, "operator_dictionary_version"),
                    "implementation_state": eigen_path_diag_string(diagnostics, "implementation_state"),
                    "validation_state": validation_state,
                    "validated_scope": validated_scope,
                    "assembly_kind": eigen_path_diag_string(diagnostics, "assembly_kind"),
                    "operator_input_signature_sha256": eigen_path_diag_string(diagnostics, "operator_input_signature_sha256"),
                    "boundary_gauge": eigen_path_known_object(diagnostics, "boundary_gauge"),
                    "spectral": eigen_path_known_object(diagnostics, "spectral"),
                    "phase_constraint_sha256": eigen_path_diag_string(diagnostics, "phase_constraint_sha256"),
                    "equilibrium_artifact_sha256": eigen_path_diag_string(diagnostics, "equilibrium_artifact_sha256"),
                    "linearization_state_sha256": eigen_path_diag_string(diagnostics, "linearization_state_sha256"),
                    "periodic_mesh_certificate_sha256": eigen_path_diag_string(diagnostics, "periodic_mesh_certificate_sha256"),
                },
            })
        })
        .collect::<Vec<_>>();

    // Homogeneity compares execution descriptors, not per-k coordinates or
    // identity hashes that are expected to vary along a path.
    const EXECUTION_FIELDS: &[&[&str]] = &[
        &["solver_adapter"],
        &["execution_lane"],
        &["requested_execution", "solver_method"],
        &["requested_execution", "preconditioner"],
        &["requested_execution", "magnetostatic_bc"],
        &["resolved_execution", "device"],
        &["resolved_execution", "precision"],
        &["resolved_execution", "engine"],
        &["resolved_execution", "native_backend"],
        &["resolved_execution", "reference_or_production"],
        &["resolved_execution", "demag_realization"],
        &["resolved_execution", "solver_library"],
        &["resolved_execution", "solver_algorithm"],
        &["resolved_execution", "implementation_id"],
        &["resolved_execution", "status"],
        &["resolved_execution", "device_residency"],
        &["resolved_execution", "operator_residency"],
        &["resolved_execution", "vector_residency"],
        &["resolved_execution", "krylov_residency"],
        &["resolved_execution", "preconditioner_residency"],
        &["resolved_execution", "fallback_used"],
        &["resolved_execution", "fallback_reason"],
        &["resolved_execution", "fallback_from_engine"],
        &["resolved_execution", "fallback_to_engine"],
        &["phasor_convention"],
        &["spin_wave_phase_convention"],
        &["validation", "physics_contract_version"],
        &["validation", "operator_dictionary_version"],
        &["validation", "implementation_state"],
        &["validation", "validation_state"],
        &["validation", "validated_scope"],
        &["validation", "assembly_kind"],
        &["validation", "boundary_gauge"],
        &["validation", "spectral"],
    ];
    const EXECUTION_METADATA_FIELDS: &[&[&str]] = &[
        &["solver_adapter"],
        &["execution_lane"],
        &["resolved_execution", "device"],
        &["resolved_execution", "engine"],
        &["resolved_execution", "native_backend"],
        &["resolved_execution", "solver_library"],
        &["resolved_execution", "solver_algorithm"],
        &["resolved_execution", "implementation_id"],
        &["phasor_convention"],
        &["validation", "validation_state"],
    ];
    let has_mixed_values = EXECUTION_FIELDS
        .iter()
        .any(|path| eigen_path_record_values_differ(&sample_records, path));
    let has_partial_values = EXECUTION_FIELDS
        .iter()
        .any(|path| eigen_path_record_value_is_partial(&sample_records, path));
    let has_execution_metadata = EXECUTION_METADATA_FIELDS
        .iter()
        .any(|path| eigen_path_record_has_value(&sample_records, path));
    let same_reference_model_without_diagnostics = diagnostics_available_count == 0
        && result.samples.first().is_some_and(|first| {
            eigen_path_is_reference_solver_model(first.solver_model)
                && result
                    .samples
                    .iter()
                    .all(|sample| sample.solver_model == first.solver_model)
        });
    let status = if same_reference_model_without_diagnostics {
        "orchestrator_only_reference"
    } else if has_mixed_values {
        "mixed"
    } else if diagnostics_available_count == 0 || !has_execution_metadata {
        "missing"
    } else if diagnostics_available_count < result.samples.len() || has_partial_values {
        "partial"
    } else {
        "homogeneous"
    };

    let requested_solver_method_present =
        eigen_path_record_has_value(&sample_records, &["requested_execution", "solver_method"]);
    let requested_preconditioner_present =
        eigen_path_record_has_value(&sample_records, &["requested_execution", "preconditioner"]);
    let requested_magnetostatic_bc_present =
        eigen_path_record_has_value(&sample_records, &["requested_execution", "magnetostatic_bc"]);
    let common_diagnostics = serde_json::json!({
        "requested_execution": {
            "solver_method": eigen_path_common_record_value(&sample_records, &["requested_execution", "solver_method"]),
            "preconditioner": eigen_path_common_record_value(&sample_records, &["requested_execution", "preconditioner"]),
            "magnetostatic_bc": eigen_path_common_record_value(&sample_records, &["requested_execution", "magnetostatic_bc"]),
        },
        "resolved_execution": {
            "device": eigen_path_common_record_value(&sample_records, &["resolved_execution", "device"]),
            "precision": eigen_path_common_record_value(&sample_records, &["resolved_execution", "precision"]),
            "engine": eigen_path_common_record_value(&sample_records, &["resolved_execution", "engine"]),
            "native_backend": eigen_path_common_record_value(&sample_records, &["resolved_execution", "native_backend"]),
            "reference_or_production": eigen_path_common_record_value(&sample_records, &["resolved_execution", "reference_or_production"]),
            "demag_realization": eigen_path_common_record_value(&sample_records, &["resolved_execution", "demag_realization"]),
            "solver_library": eigen_path_common_record_value(&sample_records, &["resolved_execution", "solver_library"]),
            "solver_algorithm": eigen_path_common_record_value(&sample_records, &["resolved_execution", "solver_algorithm"]),
            "implementation_id": eigen_path_common_record_value(&sample_records, &["resolved_execution", "implementation_id"]),
            "status": eigen_path_common_record_value(&sample_records, &["resolved_execution", "status"]),
            "device_residency": eigen_path_common_record_value(&sample_records, &["resolved_execution", "device_residency"]),
            "operator_residency": eigen_path_common_record_value(&sample_records, &["resolved_execution", "operator_residency"]),
            "vector_residency": eigen_path_common_record_value(&sample_records, &["resolved_execution", "vector_residency"]),
            "krylov_residency": eigen_path_common_record_value(&sample_records, &["resolved_execution", "krylov_residency"]),
            "preconditioner_residency": eigen_path_common_record_value(&sample_records, &["resolved_execution", "preconditioner_residency"]),
            "fallback_used": eigen_path_common_record_value(&sample_records, &["resolved_execution", "fallback_used"]),
            "fallback_reason": eigen_path_common_record_value(&sample_records, &["resolved_execution", "fallback_reason"]),
            "fallback_from_engine": eigen_path_common_record_value(&sample_records, &["resolved_execution", "fallback_from_engine"]),
            "fallback_to_engine": eigen_path_common_record_value(&sample_records, &["resolved_execution", "fallback_to_engine"]),
        },
        "phasor_convention": eigen_path_common_record_value(&sample_records, &["phasor_convention"]),
        "validation_state": eigen_path_common_record_value(&sample_records, &["validation", "validation_state"]),
        "validated_scope": eigen_path_common_record_value(&sample_records, &["validation", "validated_scope"]),
        "physics_contract_version": eigen_path_common_record_value(&sample_records, &["validation", "physics_contract_version"]),
        "operator_dictionary_version": eigen_path_common_record_value(&sample_records, &["validation", "operator_dictionary_version"]),
        "implementation_state": eigen_path_common_record_value(&sample_records, &["validation", "implementation_state"]),
        "assembly_kind": eigen_path_common_record_value(&sample_records, &["validation", "assembly_kind"]),
        "operator_input_signature_sha256": eigen_path_common_record_value(&sample_records, &["validation", "operator_input_signature_sha256"]),
        "boundary_gauge": eigen_path_common_record_value(&sample_records, &["validation", "boundary_gauge"]),
        "spectral": eigen_path_common_record_value(&sample_records, &["validation", "spectral"]),
        "phase_constraint_sha256": eigen_path_common_record_value(&sample_records, &["validation", "phase_constraint_sha256"]),
        "equilibrium_artifact_sha256": eigen_path_common_record_value(&sample_records, &["validation", "equilibrium_artifact_sha256"]),
        "linearization_state_sha256": eigen_path_common_record_value(&sample_records, &["validation", "linearization_state_sha256"]),
        "periodic_mesh_certificate_sha256": eigen_path_common_record_value(&sample_records, &["validation", "periodic_mesh_certificate_sha256"]),
    });
    let manifest_value = serde_json::json!({
        "schema_version": "frequency_domain_sample_execution_provenance.v1",
        "status": status,
        "sample_count": sample_records.len(),
        "diagnostics_available_count": diagnostics_available_count,
        "diagnostics_missing_count": sample_records.len().saturating_sub(diagnostics_available_count),
        "samples": sample_records,
    });
    EigenPathSampleExecutionProvenance {
        common_diagnostics,
        manifest_value,
        status,
        requested_solver_method_present,
        requested_preconditioner_present,
        requested_magnetostatic_bc_present,
    }
}

fn eigen_path_sample_native_modal_diagnostics(
    sample: &crate::eigen::SingleKSolveResult,
) -> Option<&Value> {
    let root = sample.solver_diagnostics.as_ref()?;
    if let Some(sample_records) = root.get("sample_solver_diagnostics") {
        let entries = sample_records.as_array()?;
        let mut matches = entries.iter().filter(|entry| {
            entry.get("sample_index").and_then(Value::as_u64)
                == Some(sample.sample.sample_index as u64)
        });
        let selected = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        return selected.get("diagnostics").filter(|value| value.is_object());
    }
    [
        "resolved_execution",
        "solver_adapter",
        "assembly_kind",
        "requested_execution",
        "phasor_convention",
        "phase_convention",
        "validation_state",
        "boundary_gauge",
        "spectral",
    ]
    .iter()
    .any(|key| root.get(*key).is_some())
    .then_some(root)
}

fn eigen_path_is_reference_solver_model(model: crate::eigen::EigenSolverModel) -> bool {
    matches!(
        model,
        crate::eigen::EigenSolverModel::ReferenceScalarTangent
            | crate::eigen::EigenSolverModel::ReferenceFull2x2Tangent
            | crate::eigen::EigenSolverModel::ReferenceK0KittelSyntheticDemagFactor
    )
}

fn eigen_path_sample_solver_algorithm(diagnostics: Option<&Value>) -> Option<String> {
    eigen_path_nested_string(diagnostics, "resolved_execution", "solver_algorithm")
        .or_else(|| {
            eigen_path_nested_string(diagnostics, "resolved_execution", "implementation_id")
        })
        .or_else(|| eigen_path_nested_string(diagnostics, "resolved_execution", "engine"))
}

fn eigen_path_record_value<'a>(record: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(record, |value, key| value.get(*key))
}

fn eigen_path_common_record_value(records: &[Value], path: &[&str]) -> Option<Value> {
    let mut common: Option<&Value> = None;
    for record in records {
        let value = eigen_path_record_value(record, path).filter(|value| !value.is_null())?;
        if common.is_some_and(|existing| existing != value) {
            return None;
        }
        common = Some(value);
    }
    common.cloned()
}

fn eigen_path_record_has_value(records: &[Value], path: &[&str]) -> bool {
    records.iter().any(|record| {
        eigen_path_record_value(record, path).is_some_and(|value| !value.is_null())
    })
}

fn eigen_path_record_values_differ(records: &[Value], path: &[&str]) -> bool {
    let mut first: Option<&Value> = None;
    for record in records {
        let Some(value) = eigen_path_record_value(record, path).filter(|value| !value.is_null())
        else {
            continue;
        };
        if first.is_some_and(|existing| existing != value) {
            return true;
        }
        first = Some(value);
    }
    false
}

fn eigen_path_record_value_is_partial(records: &[Value], path: &[&str]) -> bool {
    if records.is_empty() {
        return false;
    }
    let present = records
        .iter()
        .filter(|record| {
            eigen_path_record_value(record, path).is_some_and(|value| !value.is_null())
        })
        .count();
    present > 0 && present < records.len()
}

pub(super) fn eigen_path_diag_string(diagnostics: Option<&Value>, key: &str) -> Option<String> {
    diagnostics
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(super) fn eigen_path_nested_string(
    diagnostics: Option<&Value>,
    object_key: &str,
    key: &str,
) -> Option<String> {
    diagnostics
        .and_then(|value| value.get(object_key))
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

pub(super) fn eigen_path_nested_bool(
    diagnostics: Option<&Value>,
    object_key: &str,
    key: &str,
) -> Option<bool> {
    diagnostics
        .and_then(|value| value.get(object_key))
        .and_then(|value| value.get(key))
        .and_then(Value::as_bool)
}

pub(super) fn eigen_path_known_object(diagnostics: Option<&Value>, key: &str) -> Option<Value> {
    let value = diagnostics.and_then(|value| value.get(key))?;
    let object = value.as_object()?;
    if object
        .values()
        .any(|child| child.as_str() == Some("unknown"))
    {
        return None;
    }
    Some(value.clone())
}
